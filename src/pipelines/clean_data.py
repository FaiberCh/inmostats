"""
Pipeline de limpieza y feature engineering para InmoStats.

Toma todos los CSV crudos generados por el scraper en data/raw/, los
consolida, limpia y enriquece con features derivadas, y guarda un unico
dataset listo para EDA/modelado en data/processed/.
"""

import logging
from pathlib import Path

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
VALID_STRATUM_RANGE = (1, 6)

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


def clean(df: pd.DataFrame) -> pd.DataFrame:
    before = len(df)

    df = df.dropna(subset=["price_cop", "area_m2", "bedrooms", "bathrooms"]).copy()

    df = df[df["price_cop"].between(MIN_PRICE_COP, MAX_PRICE_COP)]
    df = df[df["area_m2"].between(MIN_AREA_M2, MAX_AREA_M2)]
    df = df[df["bedrooms"].between(1, MAX_BEDROOMS)]
    df = df[df["bathrooms"].between(1, MAX_BATHROOMS)]

    if "stratum" in df.columns:
        invalid_stratum = ~df["stratum"].between(*VALID_STRATUM_RANGE) & df["stratum"].notna()
        df.loc[invalid_stratum, "stratum"] = None

    logger.info("Registros descartados por limpieza: %d (de %d)", before - len(df), before)
    return df


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["price_per_m2"] = (df["price_cop"] / df["area_m2"]).round(0)
    df["admin_fee_cop"] = df["admin_fee_cop"].fillna(0)

    # neighborhood/city/department/is_new_project ya vienen limpios del
    # scraper (extraidos del JSON estructurado de la pagina, no de texto
    # libre); solo rellenamos huecos que puedan venir de corridas viejas
    # con un esquema mas chico (ver data/raw/fincaraiz_apartamentos_bogota_*).
    for col in ("department", "department_real", "city", "neighborhood", "locality", "zone", "owner_type"):
        if col in df.columns:
            df[col] = df[col].fillna("sin especificar")
    if "is_new_project" in df.columns:
        df["is_new_project"] = df["is_new_project"].fillna(False)

    # "department" es la zona de busqueda; para el bucket "resto-de-colombia"
    # eso NO es un departamento real (trae anuncios de cualquier parte del
    # pais). department_final usa el departamento real del anuncio
    # (department_real) cuando se conoce, y cae de vuelta a "department"
    # solo si no hay dato real disponible - esta es la columna que conviene
    # usar para agrupar/analizar por departamento.
    if "department_real" in df.columns:
        df["department_final"] = df["department_real"].where(
            df["department_real"] != "sin especificar", df["department"]
        )
    else:
        df["department_final"] = df["department"]

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
