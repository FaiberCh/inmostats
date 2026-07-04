"""
Calcula estadisticas agregadas del dataset scrapeado hasta el momento y las
guarda en data/processed/stats_summary.json (JSON chico, se commitea al repo
para que el bot de Telegram lo pueda leer via raw.githubusercontent.com sin
tener que descargar y parsear los CSV crudos completos).
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from src.pipelines.clean_data import PROCESSED_DIR, clean, engineer_features, load_raw_data

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

STATS_PATH = PROCESSED_DIR / "stats_summary.json"


def compute_stats(df: pd.DataFrame) -> dict:
    # department_final resuelve el departamento real del anuncio (en vez de
    # la zona de busqueda) - importante porque "resto-de-colombia" mezcla
    # anuncios de cualquier departamento. Cae de vuelta a "department" para
    # CSV viejos que no tengan la columna.
    group_col = "department_final" if "department_final" in df.columns else "department"

    by_department = (
        df.groupby(group_col)
        .agg(
            listings=("listing_id", "count"),
            avg_price_cop=("price_cop", "mean"),
            avg_price_per_m2=("price_per_m2", "mean"),
        )
        .round(0)
        .sort_values("listings", ascending=False)
    )
    by_department = {
        dept: {k: (int(v) if pd.notna(v) else None) for k, v in row.items()}
        for dept, row in by_department.to_dict(orient="index").items()
    }

    def safe_round(series: pd.Series, ndigits: int = 0):
        value = series.mean()
        return round(float(value), ndigits) if pd.notna(value) else None

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_listings": int(len(df)),
        "zones_with_data": int(df[group_col].nunique()),
        "avg_price_cop": safe_round(df["price_cop"]),
        "avg_price_per_m2": safe_round(df["price_per_m2"]),
        "avg_area_m2": safe_round(df["area_m2"], 1),
        "avg_bedrooms": safe_round(df["bedrooms"], 1),
        "avg_bathrooms": safe_round(df["bathrooms"], 1),
        "avg_stratum": safe_round(df["stratum"], 1) if "stratum" in df.columns else None,
        "by_department": by_department,
    }


def save_stats(stats: dict, output_path: Path = STATS_PATH) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    logger.info("Guardado resumen de estadisticas en %s", output_path)
    return output_path


def main() -> None:
    df = load_raw_data()
    df = clean(df)
    df = engineer_features(df)
    stats = compute_stats(df)
    save_stats(stats)


if __name__ == "__main__":
    main()
