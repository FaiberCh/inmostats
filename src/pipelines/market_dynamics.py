"""
Dinamica del mercado a partir de las capturas repetidas de data/raw/.

El scraper nacional corre varias veces y data/raw/ conserva todas las
corridas (nombre de archivo con run<fecha>), asi que un mismo anuncio se
puede seguir entre corridas. Este modulo calcula rotacion, cambios de
precio y deriva del nivel de precios; lo usan el notebook
02_dinamica_mercado.ipynb (carga) y el exportador del dashboard web
(src/pipelines/export_dashboard_data.py), para que haya una sola
implementacion y los numeros se recalculen solos con cada corrida nueva.
"""

import logging
import re
from pathlib import Path

import numpy as np
import pandas as pd

from src.pipelines.clean_data import (
    MAX_AREA_M2,
    MAX_PRICE_COP,
    MIN_AREA_M2,
    MIN_PRICE_COP,
    RAW_DIR,
)

logger = logging.getLogger(__name__)

RUN_PATTERN = re.compile(r"run(\d{8}T\d{6})")
COLUMNS = {
    "listing_id", "price_cop", "area_m2", "department", "department_real",
    "listing_created_at", "scraped_at",
}
# Los cambios extremos suelen ser errores de captura. No se usan percentiles
# para recortar porque casi todos los cambios son exactamente 0.
CHANGE_CLIP = 0.3
HISTOGRAM_BINS = 60
TOP_DEPARTMENTS = 8


def load_snapshots(raw_dir: Path = RAW_DIR) -> tuple[pd.DataFrame, int]:
    """Lee solo las corridas completas (archivos con run<fecha>); el backfill
    de "resto de Colombia" es una captura aparte y se excluye. Dentro de una
    misma corrida un anuncio puede aparecer varias veces (el sitio reordena
    resultados mientras se pagina), asi que se conserva la observacion mas
    reciente por corrida. Devuelve (snapshots, filas_validas_antes_de_deduplicar)."""
    frames = []
    for path in sorted(raw_dir.glob("*.csv")):
        match = RUN_PATTERN.search(path.name)
        if not match:
            continue
        part = pd.read_csv(path, encoding="utf-8-sig", usecols=lambda c: c in COLUMNS, low_memory=False)
        part["run"] = match.group(1)
        frames.append(part)
    if not frames:
        raise FileNotFoundError(f"No hay CSV de corridas (run<fecha>) en {raw_dir}")

    raw = pd.concat(frames, ignore_index=True)
    raw["scraped_at"] = pd.to_datetime(raw["scraped_at"], utc=True, errors="coerce")
    raw["listing_created_at"] = pd.to_datetime(raw["listing_created_at"], utc=True, errors="coerce")
    raw["department_final"] = raw["department_real"].fillna(raw["department"])

    raw = raw[
        raw["price_cop"].between(MIN_PRICE_COP, MAX_PRICE_COP)
        & raw["area_m2"].between(MIN_AREA_M2, MAX_AREA_M2)
    ]
    snap = raw.sort_values("scraped_at").drop_duplicates(["run", "listing_id"], keep="last")
    logger.info("Capturas: %d filas validas, %d tras una observacion por anuncio y corrida", len(raw), len(snap))
    return snap, len(raw)


def _clip(series: pd.Series) -> pd.Series:
    return series.clip(-CHANGE_CLIP, CHANGE_CLIP)


def compute_dynamics(snap: pd.DataFrame, raw_rows: int | None = None) -> dict:
    runs = sorted(snap["run"].unique())
    run_date = {r: pd.to_datetime(r, format="%Y%m%dT%H%M%S", utc=True) for r in runs}
    label = {r: run_date[r].strftime("%Y-%m-%d") for r in runs}
    sets = {r: set(snap.loc[snap["run"] == r, "listing_id"]) for r in runs}
    ppm2 = (snap["price_cop"] / snap["area_m2"]).groupby(snap["run"]).median()

    result: dict = {
        "n_runs": len(runs),
        "date_from": label[runs[0]],
        "date_to": label[runs[-1]],
        "unique_listings": int(snap["listing_id"].nunique()),
        "repeat_within_run_pct": (
            round(100 * (1 - len(snap) / raw_rows), 1) if raw_rows else None
        ),
        "runs": [
            {"date": label[r], "listings": len(sets[r]), "median_price_m2": int(round(ppm2[r]))}
            for r in runs
        ],
    }
    if len(runs) < 2:
        return result

    # --- Rotacion entre corridas consecutivas -----------------------------
    pairs = []
    for a, b in zip(runs, runs[1:]):
        pairs.append({
            "from": label[a],
            "to": label[b],
            "persist_pct": round(100 * len(sets[a] & sets[b]) / len(sets[a]), 1),
            "new_pct": round(100 * len(sets[b] - sets[a]) / len(sets[b]), 1),
        })
    first = sets[runs[0]]
    survival = [
        {"date": label[r], "pct": round(100 * len(first & sets[r]) / len(first), 1)} for r in runs
    ]
    never_return = 100 * len(first - set().union(*(sets[r] for r in runs[1:]))) / len(first)

    # Reapariciones: de los ausentes en una corrida, cuantos vuelven en la
    # siguiente (si vuelven, el scraper simplemente no los vio).
    reappear = [
        100 * len((sets[a] - sets[b]) & sets[c]) / len(sets[a] - sets[b])
        for a, b, c in zip(runs, runs[1:], runs[2:])
        if sets[a] - sets[b]
    ]
    # Entradas reales: de los "nuevos" de una corrida, cuantos fueron creados
    # despues de la corrida anterior (listing_created_at).
    created = snap.drop_duplicates("listing_id").set_index("listing_id")["listing_created_at"]
    truly_new = []
    for a, b in zip(runs, runs[1:]):
        new_ids = list(sets[b] - sets[a])
        if new_ids:
            truly_new.append(100 * (created.reindex(new_ids) > run_date[a]).mean())

    result["turnover"] = {
        "pairs": pairs,
        "persist_pct_mean": round(float(np.mean([p["persist_pct"] for p in pairs])), 1),
        "new_pct_mean": round(float(np.mean([p["new_pct"] for p in pairs])), 1),
        "reappear_pct_mean": round(float(np.mean(reappear)), 1) if reappear else None,
        "truly_new_pct_mean": round(float(np.mean(truly_new)), 1) if truly_new else None,
        "never_return_pct_upper_bound": round(float(never_return), 1),
        "survival": survival,
    }

    # --- Cambios de precio de un mismo anuncio ----------------------------
    price = snap.pivot(index="listing_id", columns="run", values="price_cop")
    dept = snap.drop_duplicates("listing_id").set_index("listing_id")["department_final"]
    changes = []
    for a, b in zip(runs, runs[1:]):
        both = price[[a, b]].dropna()
        changes.append(pd.DataFrame({"change": both[b] / both[a] - 1}).reset_index())
    changes = pd.concat(changes, ignore_index=True)
    changes["department"] = changes["listing_id"].map(dept)
    changed = changes[changes["change"].abs() > 1e-9]

    counts, edges = np.histogram(
        _clip(changed["change"]) * 100, bins=HISTOGRAM_BINS, range=(-CHANGE_CLIP * 100, CHANGE_CLIP * 100)
    )
    top = changes["department"].value_counts().head(TOP_DEPARTMENTS).index
    by_department = []
    for name in top:
        sub = changes[changes["department"] == name]
        sub_changed = sub[sub["change"].abs() > 1e-9]
        by_department.append({
            "department": name,
            "comparisons": int(len(sub)),
            "changed_pct": round(100 * len(sub_changed) / len(sub), 2),
            "median_change_pct": round(float(sub_changed["change"].median() * 100), 2) if len(sub_changed) else None,
        })

    result["price_changes"] = {
        "comparisons": int(len(changes)),
        "changed": int(len(changed)),
        "changed_pct": round(100 * len(changed) / len(changes), 2),
        "down_pct": round(100 * float((changed["change"] < 0).mean()), 1) if len(changed) else None,
        "up_pct": round(100 * float((changed["change"] > 0).mean()), 1) if len(changed) else None,
        "median_abs_change_pct": round(100 * float(changed["change"].abs().median()), 1) if len(changed) else None,
        "p10_pct": round(100 * float(changed["change"].quantile(0.1)), 1) if len(changed) else None,
        "p90_pct": round(100 * float(changed["change"].quantile(0.9)), 1) if len(changed) else None,
        "histogram": {"edges_pct": [round(float(e), 2) for e in edges], "counts": [int(c) for c in counts]},
        "by_department": by_department,
    }

    # --- Nivel de precios (base 100 en la primera corrida) ----------------
    chained = [1.0]
    for a, b in zip(runs, runs[1:]):
        both = price[[a, b]].dropna()
        step = _clip(np.log(both[b] / both[a])).mean()
        chained.append(chained[-1] * float(np.exp(step)))

    balanced = price.dropna()
    balanced_index = None
    if len(balanced):
        base = balanced[runs[0]]
        balanced_index = [float(np.exp(_clip(np.log(balanced[r] / base)).mean())) for r in runs]

    result["price_level"] = {
        "dates": [label[r] for r in runs],
        "median_price_m2": [round(100 * float(v), 2) for v in ppm2 / ppm2.iloc[0]],
        "chained": [round(100 * v, 2) for v in chained],
        "balanced": [round(100 * v, 2) for v in balanced_index] if balanced_index else None,
        "balanced_listings": int(len(balanced)),
    }
    return result
