"""
Lectura del consolidado de Hugging Face para el exportador del dashboard.

Reemplaza a load_raw_data (CSV locales) y a market_dynamics.load_snapshots con lecturas del Parquet
consolidado, asi el tablero se regenera sin tener los CSV en el equipo (los de las corridas nuevas solo
viven en el dataset privado). Devuelve los mismos DataFrame que las funciones originales, mas dos cosas
nuevas:

- vigente: el anuncio aparecio en la ultima corrida COMPLETA, o sea que sigue publicado (con un margen de
  error: un anuncio que el scraper no alcanzo a capturar en esa corrida cuenta como no vigente).
- last_run: la corrida (run<fecha>) de la ultima vez que se vio.

Una corrida esta completa si no es la que el checkpoint marca como en curso. Hace falta porque a mitad de
una corrida nueva la mayoria de los anuncios todavia no se ha vuelto a ver.
"""

import json
import logging
import os
from pathlib import Path

import duckdb
import pandas as pd

from src.pipelines.clean_data import (
    MAX_AREA_M2,
    MAX_PRICE_COP,
    MIN_AREA_M2,
    MIN_PRICE_COP,
    RAW_DIR,
)
from src.pipelines.consolidate_raw import consolidated_sources

logger = logging.getLogger(__name__)

CHECKPOINT_PATH = RAW_DIR / ".checkpoint_national.json"
# Una corrida con menos anuncios que esto es un ensayo o un re-scrape puntual, no una pasada nacional.
MIN_LISTINGS_FULL_RUN = 20_000
RUN_REGEX = r"run(\d{8}T\d{6})"


def _token() -> str:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HF_DATA_TOKEN")
    if not token:
        env = Path(__file__).resolve().parents[2] / ".env"
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                key, _, value = line.partition("=")
                if key.strip() in ("HF_DATA_TOKEN", "HF_TOKEN") and value.strip():
                    token = value.strip().strip("'\"")
                    break
    if not token:
        raise RuntimeError("Falta HF_TOKEN (o HF_DATA_TOKEN) para leer el consolidado")
    return token


def _connect(token: str):
    con = duckdb.connect()
    con.execute("CREATE SECRET hf_secret (TYPE HUGGINGFACE, TOKEN ?)", [token])
    return con


def in_progress_run_tag(checkpoint_path: Path = CHECKPOINT_PATH) -> str | None:
    """Etiqueta run<fecha> de la corrida que el checkpoint marca como en curso, o None si esta terminada."""
    if not checkpoint_path.exists():
        return None
    checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    if checkpoint.get("done"):
        return None
    from src.scraper.fincaraiz_scraper import run_started_at_tag

    return run_started_at_tag(checkpoint["started_at"]).removeprefix("run")


def complete_run_tags(runs: pd.DataFrame, in_progress: str | None) -> list[str]:
    """Corridas completas, de la mas vieja a la mas nueva. `runs` trae las columnas run y listings."""
    ok = runs[(runs["listings"] >= MIN_LISTINGS_FULL_RUN) & (runs["run"] != in_progress)]
    return sorted(ok["run"])


def _runs_table(con, sources: list[str]) -> pd.DataFrame:
    return con.execute(
        f"""
        SELECT regexp_extract(source_file, '{RUN_REGEX}', 1) AS run, count(DISTINCT listing_id) AS listings
        FROM read_parquet(?, union_by_name = true)
        WHERE regexp_matches(source_file, '{RUN_REGEX}')
        GROUP BY 1
        """,
        [sources],
    ).df()


def load_listings(checkpoint_path: Path = CHECKPOINT_PATH) -> pd.DataFrame:
    """Ultima observacion de cada anuncio (todas las columnas), con vigente y last_run.
    Equivale a clean_data.load_raw_data, pero desde el consolidado."""
    token = _token()
    sources = consolidated_sources(token)
    con = _connect(token)
    try:
        runs = _runs_table(con, sources)
        complete = complete_run_tags(runs, in_progress_run_tag(checkpoint_path))
        if not complete:
            raise RuntimeError("El consolidado no tiene ninguna corrida completa")
        latest = complete[-1]
        logger.info("Corridas completas: %d; la ultima es run%s", len(complete), latest)
        df = con.execute(
            f"""
            SELECT * EXCLUDE (source_file),
                   regexp_extract(source_file, '{RUN_REGEX}', 1) AS last_run
            FROM read_parquet(?, union_by_name = true)
            QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY scraped_at DESC) = 1
            """,
            [sources],
        ).df()
    finally:
        con.close()
    # La ultima observacion puede venir de un re-scrape sin etiqueta de corrida (backfill): se mira si el
    # anuncio aparecio EN ALGUN MOMENTO en la ultima corrida completa, no solo en su ultima fila.
    con = _connect(token)
    try:
        seen_latest = con.execute(
            f"""
            SELECT DISTINCT listing_id FROM read_parquet(?, union_by_name = true)
            WHERE regexp_extract(source_file, '{RUN_REGEX}', 1) = ?
            """,
            [sources, latest],
        ).df()["listing_id"]
    finally:
        con.close()
    df["vigente"] = df["listing_id"].isin(set(seen_latest))
    df["latest_run"] = latest
    df["scraped_at"] = pd.to_datetime(df["scraped_at"], utc=True, errors="coerce")
    logger.info(
        "Consolidado: %d anuncios, %d vigentes (vistos en run%s)", len(df), int(df["vigente"].sum()), latest
    )
    return df


def load_snapshots(checkpoint_path: Path = CHECKPOINT_PATH) -> tuple[pd.DataFrame, int]:
    """Equivale a market_dynamics.load_snapshots: una observacion por anuncio y corrida completa."""
    token = _token()
    sources = consolidated_sources(token)
    con = _connect(token)
    try:
        runs = _runs_table(con, sources)
        complete = complete_run_tags(runs, in_progress_run_tag(checkpoint_path))
        raw = con.execute(
            f"""
            SELECT listing_id, price_cop, area_m2, department, department_real, listing_created_at, scraped_at,
                   regexp_extract(source_file, '{RUN_REGEX}', 1) AS run
            FROM read_parquet(?, union_by_name = true)
            WHERE regexp_extract(source_file, '{RUN_REGEX}', 1) IN (SELECT unnest(?::VARCHAR[]))
              AND price_cop BETWEEN ? AND ? AND area_m2 BETWEEN ? AND ?
            """,
            [sources, complete, MIN_PRICE_COP, MAX_PRICE_COP, MIN_AREA_M2, MAX_AREA_M2],
        ).df()
    finally:
        con.close()
    raw["scraped_at"] = pd.to_datetime(raw["scraped_at"], utc=True, errors="coerce")
    raw["listing_created_at"] = pd.to_datetime(raw["listing_created_at"], utc=True, errors="coerce")
    raw["department_final"] = raw["department_real"].fillna(raw["department"])
    snap = raw.sort_values("scraped_at").drop_duplicates(["run", "listing_id"], keep="last")
    logger.info("Capturas: %d filas validas, %d tras una observacion por anuncio y corrida", len(raw), len(snap))
    return snap, len(raw)
