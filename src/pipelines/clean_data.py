"""
Pipeline de limpieza y feature engineering para InmoStats.

Toma todos los CSV crudos generados por el scraper en data/raw/, los
consolida, limpia y enriquece con features derivadas, y guarda un unico
dataset listo para EDA/modelado en data/processed/.
"""

import logging
import unicodedata
from pathlib import Path
from typing import Optional

import pandas as pd

from src.scraper.fincaraiz_scraper import run_started_at_tag

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

# department_real viene tal cual lo entrega fincaraiz (locations.state del
# propio anuncio), y no siempre trae tildes/formato consistente (ej.
# "Atlantico" vs "Atlántico", "Bogotá, d.c." vs "Bogotá D.C."). Normalizamos
# a un nombre canonico por departamento para no contar el mismo lugar dos
# veces al agrupar.
CANONICAL_DEPARTMENTS = [
    "Amazonas", "Antioquia", "Arauca", "Atlántico", "Bogotá D.C.", "Bolívar",
    "Boyacá", "Caldas", "Caquetá", "Casanare", "Cauca", "Cesar", "Chocó",
    "Córdoba", "Cundinamarca", "Guainía", "Guaviare", "Huila", "La Guajira",
    "Magdalena", "Meta", "Nariño", "Norte de Santander", "Putumayo",
    "Quindío", "Risaralda", "San Andrés y Providencia", "Santander",
    "Sucre", "Tolima", "Valle del Cauca", "Vaupés", "Vichada",
]


def _normalize_key(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace(",", " ").replace(".", " ")
    return " ".join(text.split())


DEPARTMENT_NAME_LOOKUP = {_normalize_key(name): name for name in CANONICAL_DEPARTMENTS}
DEPARTMENT_NAME_LOOKUP[_normalize_key("Archipielago de San Andres")] = "San Andrés y Providencia"


def normalize_department(name):
    if not isinstance(name, str) or not name.strip():
        return name
    return DEPARTMENT_NAME_LOOKUP.get(_normalize_key(name), name)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def load_raw_data(raw_dir: Path = RAW_DIR, run_started_at: Optional[str] = None) -> pd.DataFrame:
    """Carga y consolida los CSV crudos. Si se pasa run_started_at (el
    started_at de una corrida nacional, ej. del checkpoint), solo carga los
    archivos de esa corrida especifica -sin abrir el resto- gracias al tag
    de corrida que el scraper ya incluye en cada nombre de archivo."""
    # rglob (no glob) para tambien recoger CSV dentro de subcarpetas, como
    # data/raw/resto_de_colombia_backfill/ (re-scrapes puntuales de una
    # zona especifica se guardan aparte para no mezclarse con el historial
    # principal, pero igual deben consolidarse aqui).
    if run_started_at:
        pattern = f"fincaraiz_apartamentos_*_{run_started_at_tag(run_started_at)}_*.csv"
    else:
        pattern = "fincaraiz_apartamentos_*.csv"
    csv_files = sorted(raw_dir.rglob(pattern))
    if not csv_files:
        raise FileNotFoundError(f"No se encontraron CSV crudos en {raw_dir} (patron: {pattern})")

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
    df["department_final"] = df["department_final"].apply(normalize_department)
    df = infer_department_from_city(df)

    return df


# Filas cuyo department_final no es un departamento real (son el fallback
# de la zona de busqueda "resto-de-colombia", scrapeada antes de que
# department_real existiera, o filas de esquemas viejos sin ese campo).
UNKNOWN_DEPARTMENT_LABELS = {"Resto de Colombia", "sin especificar"}


def infer_department_from_city(df: pd.DataFrame) -> pd.DataFrame:
    """Para filas sin departamento real, infiere el departamento a partir de
    la ciudad, usando como referencia las propias filas del dataset que ya
    tienen un departamento confiable (en vez de una tabla externa de
    ciudades de Colombia armada de memoria, con riesgo de errores)."""
    unknown_mask = df["department_final"].isin(UNKNOWN_DEPARTMENT_LABELS)
    known = df[~unknown_mask]
    if known.empty or not unknown_mask.any():
        return df

    city_to_department = known.groupby("city")["department_final"].agg(
        lambda s: s.mode().iat[0]
    )

    mapped = df["city"].map(city_to_department)
    fillable = unknown_mask & mapped.notna()
    df.loc[fillable, "department_final"] = mapped[fillable]
    logger.info(
        "department_final inferido por ciudad para %d/%d filas sin departamento real",
        fillable.sum(), unknown_mask.sum(),
    )
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
