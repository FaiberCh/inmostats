"""
Pipeline de limpieza y feature engineering para InmoStats.

Toma todos los CSV crudos generados por el scraper en data/raw/, los
consolida, limpia y enriquece con features derivadas, y guarda un unico
dataset listo para EDA/modelado en data/processed/.
"""

import logging
import re
from pathlib import Path

import numpy as np
import pandas as pd

RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "raw"
PROCESSED_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"

# Limites de dominio para descartar outliers evidentes / errores de scraping.
MIN_PRICE_COP = 50_000_000
MAX_PRICE_COP = 10_000_000_000
MIN_AREA_M2 = 15
MAX_AREA_M2 = 1_000
MAX_BEDROOMS = 10
MAX_BATHROOMS = 10

# Los titulos siguen el patron "... en venta en {barrio}, {ciudad}" (a veces
# sin barrio: "... en venta en {ciudad}"). La ciudad es siempre el ultimo
# segmento separado por coma.
NEIGHBORHOOD_AND_CITY_PATTERN = re.compile(
    r"en\s+venta\s+en\s+(.+?),\s*([^,]+)$", re.IGNORECASE
)
CITY_ONLY_PATTERN = re.compile(r"en\s+venta\s+en\s+([^,]+)$", re.IGNORECASE)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def load_raw_data(raw_dir: Path = RAW_DIR) -> pd.DataFrame:
    csv_files = sorted(raw_dir.glob("fincaraiz_apartamentos_*.csv"))
    if not csv_files:
        raise FileNotFoundError(f"No se encontraron CSV crudos en {raw_dir}")

    logger.info("Cargando %d archivo(s) crudo(s)", len(csv_files))
    frames = [pd.read_csv(f, encoding="utf-8-sig") for f in csv_files]
    df = pd.concat(frames, ignore_index=True)

    df["scraped_at"] = pd.to_datetime(df["scraped_at"])
    df = df.sort_values("scraped_at").drop_duplicates(subset="listing_id", keep="last")
    logger.info("Registros tras deduplicar por listing_id: %d", len(df))
    return df


def extract_neighborhood_and_city(title: str) -> tuple[str, str]:
    if not isinstance(title, str):
        return "sin especificar", "sin especificar"

    match = NEIGHBORHOOD_AND_CITY_PATTERN.search(title)
    if match:
        return match.group(1).strip().lower(), match.group(2).strip().lower()

    match = CITY_ONLY_PATTERN.search(title)
    if match:
        return "sin especificar", match.group(1).strip().lower()

    return "sin especificar", "sin especificar"


def clean(df: pd.DataFrame) -> pd.DataFrame:
    before = len(df)

    df = df.dropna(subset=["price_cop", "area_m2", "bedrooms", "bathrooms"]).copy()

    df = df[df["price_cop"].between(MIN_PRICE_COP, MAX_PRICE_COP)]
    df = df[df["area_m2"].between(MIN_AREA_M2, MAX_AREA_M2)]
    df = df[df["bedrooms"].between(1, MAX_BEDROOMS)]
    df = df[df["bathrooms"].between(1, MAX_BATHROOMS)]

    logger.info("Registros descartados por limpieza: %d (de %d)", before - len(df), before)
    return df


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df[["neighborhood", "city"]] = df["title"].apply(
        lambda t: pd.Series(extract_neighborhood_and_city(t))
    )
    df["is_new_project"] = df["detail_url"].str.contains("/proyectos-vivienda/", na=False)
    df["price_per_m2"] = (df["price_cop"] / df["area_m2"]).round(0)
    df["admin_fee_cop"] = df["admin_fee_cop"].fillna(0)
    if "department" in df.columns:
        df["department"] = df["department"].fillna("sin especificar")
    return df


def save_processed(df: pd.DataFrame, output_dir: Path = PROCESSED_DIR) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "apartamentos_colombia_processed.csv"
    df.to_csv(output_path, index=False, encoding="utf-8-sig")
    logger.info("Guardado dataset procesado (%d filas) en %s", len(df), output_path)
    return output_path


def main() -> None:
    df = load_raw_data()
    df = clean(df)
    df = engineer_features(df)
    save_processed(df)


if __name__ == "__main__":
    main()
