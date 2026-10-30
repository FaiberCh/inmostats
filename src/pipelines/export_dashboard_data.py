"""
Exporta los agregados del dashboard web a web/public/data/ como JSON chicos
y GeoJSON simplificados. El frontend (Next.js en Vercel) los lee como
archivos estaticos, asi que el tablero no depende de ningun servidor Python
(solo el estimador de precio llama a la API).

    python -m src.pipelines.export_dashboard_data
    python -m src.pipelines.export_dashboard_data --skip-dynamics   # sin recalcular la dinamica (tarda ~20 s)

Los JSON se versionan en el repo: Vercel construye desde GitHub y no tiene
data/processed/*.csv (gitignored).
"""

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from src.pipelines.clean_data import (
    PROCESSED_DIR,
    UNKNOWN_DEPARTMENT_LABELS,
    _normalize_key,
    clean,
    engineer_features,
    load_raw_data,
    save_processed,
)
from src.pipelines.geo import load_department_geojson, match_city_features
from src.pipelines.market_dynamics import compute_dynamics, load_snapshots

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "web" / "public" / "data"
PROCESSED_PATH = PROCESSED_DIR / "apartamentos_colombia_processed.csv"
CONFIG_PATH = ROOT / "models" / "feature_config.json"

MIN_CITY_LISTINGS = 30
TOP_N = 15
HISTOGRAM_BINS = 60
# Tolerancias de simplificacion (grados). 0.001 grado son ~110 m.
DEPARTMENT_TOLERANCE = 0.004
CITY_TOLERANCE = 0.0015
COORD_DECIMALS = 4
UNKNOWN_PLACE = "sin especificar"


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    logger.info("%-28s %8.1f KB", path.relative_to(OUTPUT_DIR).as_posix(), path.stat().st_size / 1024)


def slugify(text: str) -> str:
    return _normalize_key(text).replace(" ", "-")


def load_processed() -> pd.DataFrame:
    if not PROCESSED_PATH.exists():
        logger.info("No existe %s, se genera desde data/raw/", PROCESSED_PATH.name)
        save_processed(engineer_features(clean(load_raw_data())))
    return pd.read_csv(PROCESSED_PATH, encoding="utf-8-sig")


# --- Simplificacion de geometrias (Douglas-Peucker, sin dependencias) ---------

def _douglas_peucker(points: np.ndarray, tolerance: float) -> np.ndarray:
    n = len(points)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = points[i], points[j]
        segment = points[i + 1 : j]
        ab = b - a
        norm = float(np.hypot(ab[0], ab[1]))
        if norm == 0:
            distances = np.hypot(segment[:, 0] - a[0], segment[:, 1] - a[1])
        else:
            distances = np.abs(ab[0] * (segment[:, 1] - a[1]) - ab[1] * (segment[:, 0] - a[0])) / norm
        k = int(np.argmax(distances))
        if distances[k] > tolerance:
            mid = i + 1 + k
            keep[mid] = True
            stack.append((i, mid))
            stack.append((mid, j))
    return points[keep]


def _simplify_ring(ring: list, tolerance: float) -> list:
    points = np.asarray(ring, dtype=float)
    simplified = _douglas_peucker(points, tolerance)
    # Un anillo necesita 4 puntos (cerrado); si la simplificacion lo deja
    # por debajo (islas diminutas) se conserva el original.
    if len(simplified) < 4:
        simplified = points
    return [[round(float(x), COORD_DECIMALS), round(float(y), COORD_DECIMALS)] for x, y in simplified]


def simplify_geometry(geometry: dict, tolerance: float) -> dict:
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        polygons = geometry["coordinates"]
    else:
        raise ValueError(f"Geometria no soportada: {geometry['type']}")
    simplified = [[_simplify_ring(ring, tolerance) for ring in polygon] for polygon in polygons]
    if geometry["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": simplified[0]}
    return {"type": "MultiPolygon", "coordinates": simplified}


def simplified_collection(features: list, keep_property: str, rename_to: str, tolerance: float) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {rename_to: f["properties"][keep_property]},
                "geometry": simplify_geometry(f["geometry"], tolerance),
            }
            for f in features
        ],
    }


# --- Agregados ---------------------------------------------------------------

def export_summary(df: pd.DataFrame) -> None:
    price_p99 = float(df["price_cop"].quantile(0.99))
    counts, edges = np.histogram(df.loc[df["price_cop"] < price_p99, "price_cop"], bins=HISTOGRAM_BINS)

    write_json(OUTPUT_DIR / "kpis.json", {
        "listings": int(len(df)),
        "price_mean_cop": int(round(df["price_cop"].mean())),
        "price_median_cop": int(round(df["price_cop"].median())),
        "area_mean_m2": round(float(df["area_m2"].mean()), 1),
        "price_m2_median_cop": int(round(df["price_per_m2"].median())),
    })
    write_json(OUTPUT_DIR / "histogram.json", {
        "edges_cop": [int(round(e)) for e in edges],
        "counts": [int(c) for c in counts],
        "p99_cop": int(round(price_p99)),
    })

    top_cities = df["city"].value_counts().head(TOP_N)
    write_json(OUTPUT_DIR / "top_cities.json", [
        {"city": city, "listings": int(count)} for city, count in top_cities.items()
    ])

    amenities = df["amenities"].dropna().str.split("; ").explode().str.strip().value_counts().head(TOP_N)
    write_json(OUTPUT_DIR / "amenities.json", [
        {"amenity": name, "listings": int(count), "share_pct": round(100 * count / len(df), 1)}
        for name, count in amenities.items()
    ])

    # Caja por estrato: cuartiles y bigotes de Tukey (1,5 x IQR), como la caja de Plotly.
    strata = []
    for stratum, values in df.dropna(subset=["stratum"]).groupby("stratum")["price_cop"]:
        q1, median, q3 = (float(values.quantile(q)) for q in (0.25, 0.5, 0.75))
        iqr = q3 - q1
        inside = values[(values >= q1 - 1.5 * iqr) & (values <= q3 + 1.5 * iqr)]
        strata.append({
            "stratum": int(stratum),
            "listings": int(len(values)),
            "whisker_low": int(inside.min()),
            "q1": int(round(q1)),
            "median": int(round(median)),
            "q3": int(round(q3)),
            "whisker_high": int(inside.max()),
            "outliers": int(len(values) - len(inside)),
        })
    write_json(OUTPUT_DIR / "by_stratum.json", strata)


def export_maps(df: pd.DataFrame) -> int:
    by_department = (
        df.groupby("department_final")
        .agg(listings=("listing_id", "count"), price_m2_median=("price_per_m2", "median"),
             price_median=("price_cop", "median"))
        .reset_index()
        .sort_values("listings", ascending=False)
    )
    write_json(OUTPUT_DIR / "by_department.json", [
        {"department": row.department_final, "listings": int(row.listings),
         "price_m2_median": int(round(row.price_m2_median)), "price_median": int(round(row.price_median))}
        for row in by_department.itertuples()
    ])
    write_json(OUTPUT_DIR / "geo" / "departments.json", simplified_collection(
        load_department_geojson()["features"], "department_final", "department", DEPARTMENT_TOLERANCE,
    ))

    city_stats = df.groupby("city").agg(
        listings=("listing_id", "count"),
        price_m2_median=("price_per_m2", "median"),
        price_median=("price_cop", "median"),
        lat_mediana=("latitude", "median"),
        lon_mediana=("longitude", "median"),
        department=("department_final", lambda s: s.mode().iat[0]),
    ).query("listings >= @MIN_CITY_LISTINGS")
    city_geojson, matched, unmatched = match_city_features(city_stats)
    if unmatched:
        logger.warning("Ciudades sin poligono (no salen en el mapa): %s", ", ".join(unmatched))
    plot_df = city_stats.loc[matched].sort_values("listings", ascending=False)
    write_json(OUTPUT_DIR / "by_city.json", [
        {"city": city, "department": row.department, "listings": int(row.listings),
         "price_m2_median": int(round(row.price_m2_median)), "price_median": int(round(row.price_median))}
        for city, row in plot_df.iterrows()
    ])
    write_json(OUTPUT_DIR / "geo" / "cities.json", simplified_collection(
        city_geojson["features"], "city_matched", "city", CITY_TOLERANCE,
    ))
    return len(plot_df)


def export_places(df: pd.DataFrame) -> None:
    """Listas en cascada del formulario: un indice liviano de departamentos y
    ciudades, y un archivo por departamento con sus barrios (el frontend pide
    solo el del departamento elegido, para no cargar todo en el telefono)."""
    known = df[
        ~df["department_final"].isin(UNKNOWN_DEPARTMENT_LABELS)
        & df["department_final"].notna()
        & (df["city"] != UNKNOWN_PLACE)
        & df["city"].notna()
    ]
    order = lambda names: sorted(names, key=_normalize_key)

    index = []
    for department, group in known.groupby("department_final"):
        cities = order(group["city"].unique())
        neighborhoods = {
            city: order(
                n for n in sub["neighborhood"].dropna().unique() if n != UNKNOWN_PLACE
            )
            for city, sub in group.groupby("city")
        }
        slug = slugify(department)
        write_json(OUTPUT_DIR / "places" / f"{slug}.json", {"department": department, "neighborhoods": neighborhoods})
        index.append({"department": department, "slug": slug, "listings": int(len(group)), "cities": cities})
    index.sort(key=lambda d: _normalize_key(d["department"]))
    write_json(OUTPUT_DIR / "places" / "index.json", index)


def export_model() -> dict | None:
    if not CONFIG_PATH.exists():
        logger.warning("No existe %s: se omite model.json (corre train_baseline primero)", CONFIG_PATH)
        return None
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    keys = ("model_name", "trained_at", "n_rows", "metrics_cv", "metrics_holdout",
            "hyperparameters", "top_features", "amenities")
    model = {k: config[k] for k in keys if k in config}
    write_json(OUTPUT_DIR / "model.json", model)
    return model


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-dynamics", action="store_true", help="no recalcula dynamics.json")
    args = parser.parse_args()

    df = load_processed()
    logger.info("Dataset procesado: %d anuncios", len(df))

    export_summary(df)
    n_cities = export_maps(df)
    export_places(df)
    export_model()

    if args.skip_dynamics:
        logger.info("Se omite dynamics.json (--skip-dynamics)")
    else:
        snap, raw_rows = load_snapshots()
        write_json(OUTPUT_DIR / "dynamics.json", compute_dynamics(snap, raw_rows))

    scraped = pd.to_datetime(df["scraped_at"], utc=True, errors="coerce")
    write_json(OUTPUT_DIR / "meta.json", {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "listings": int(len(df)),
        "data_from": scraped.min().strftime("%Y-%m-%d"),
        "data_to": scraped.max().strftime("%Y-%m-%d"),
        "departments": int(df["department_final"].nunique()),
        "cities_on_map": n_cities,
    })


if __name__ == "__main__":
    main()
