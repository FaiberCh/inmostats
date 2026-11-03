"""
Genera el dataset limpio y anonimizado (Parquet) a partir de los CSV crudos.

Pensado para publicarse: sin nombre del anunciante, sin direccion, sin texto
libre ni enlaces, con coordenadas redondeadas y con los valores imposibles
corregidos o marcados como vacios. El nombre solo se usa aqui, para calcular la
categoria del anunciante (owner_group), y no sale del proceso.

    python -X utf8 -m src.pipelines.build_clean_dataset
"""

import hashlib
import hmac
import logging
import os
import re
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

from src.pipelines.clean_data import clean, engineer_features, load_raw_data
from src.pipelines.owner_groups import OWNER_LABELS, owner_codes

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = ROOT / "data" / "clean" / "apartamentos_limpio.parquet"

# Colombia continental e insular (San Andres, Leticia): fuera de esta caja la coordenada es un error
LAT_RANGE = (-4.5, 13.6)
LON_RANGE = (-82.5, -66.7)
COORD_DECIMALS = 3  # unos 100 m

MAX_ADMIN_FEE_COP = 10_000_000  # al mes; por encima no es verosimil para un apartamento
BUILT_AREA_RATIO = (0.5, 3.0)  # area construida frente al area: fuera de este rango es error de captura
MAX_FLOORS = 60
MIN_AMENITY_SHARE = 0.20  # solo se crean columnas para comodidades presentes en al menos 20% de los anuncios
# (las demas quedan resumidas en amenidades_total)

# Banderas del texto libre: solo "menciona X", nunca se copia texto
TEXT_FLAGS = {
    "menciona_remodelado": r"remodelad|renovad|reformad",
    "menciona_vista": r"\bvista\b|panoramic",
    "menciona_balcon_terraza": r"balcon|terraza",
    "menciona_negociable": r"negociable|negocio el precio|recibo oferta",
    "menciona_amoblado": r"amoblad|amueblad",
}

DROP_COLUMNS = [
    "listing_id",
    "title", "description", "address", "detail_url", "main_image_url", "owner_name", "amenities",
    "department_slug", "department_real", "source_page", "run_started_at", "construction_year",
]


def _ascii(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", _ascii(text)).strip("_")


def id_key() -> bytes:
    """Clave secreta con la que se anonimizan los ids (DATASET_ID_KEY, en el entorno o en .env).
    Debe ser siempre la misma: si cambia, los ids de una publicacion nueva no coinciden con los anteriores."""
    key = os.environ.get("DATASET_ID_KEY")
    if not key and (ROOT / ".env").exists():
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith("DATASET_ID_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        raise RuntimeError("Falta DATASET_ID_KEY (variable de entorno o linea en .env)")
    return key.encode()


def anonymize_ids(ids: pd.Series) -> pd.Series:
    """id estable e irreversible: HMAC-SHA256 del listing_id con clave secreta, 16 caracteres hex."""
    key = id_key()
    return ids.map(lambda i: hmac.new(key, str(int(i)).encode(), hashlib.sha256).hexdigest()[:16])


def fix_coordinates(df: pd.DataFrame) -> pd.DataFrame:
    lat, lon = df["latitude"], df["longitude"]
    inside = lambda a, o: a.between(*LAT_RANGE) & o.between(*LON_RANGE)
    ok = inside(lat, lon)
    swapped = ~ok & inside(lon, lat)
    new_lat = lat.where(~swapped, lon)
    new_lon = lon.where(~swapped, lat)
    bad = ~ok & ~swapped
    new_lat, new_lon = new_lat.mask(bad), new_lon.mask(bad)
    logger.info("Coordenadas: %d validas, %d invertidas corregidas, %d invalidas a vacio", ok.sum(), swapped.sum(), bad.sum())
    df["latitude"] = new_lat.round(COORD_DECIMALS)
    df["longitude"] = new_lon.round(COORD_DECIMALS)
    return df


def fix_numeric_columns(df: pd.DataFrame) -> pd.DataFrame:
    admin = df["admin_fee_cop"]
    bad_admin = (admin < 0) | (admin > MAX_ADMIN_FEE_COP)
    df["admin_fee_cop"] = admin.mask(bad_admin)
    logger.info("Administracion: %d valores imposibles a vacio (el 0 se conserva tal como viene)", int(bad_admin.sum()))

    built, area = df["area_built_m2"], df["area_m2"]
    ratio = built / area
    bad_built = built.notna() & ((built <= 0) | (ratio < BUILT_AREA_RATIO[0]) | (ratio > BUILT_AREA_RATIO[1]))
    df["area_built_m2"] = built.mask(bad_built)
    logger.info("Area construida: %d valores imposibles a vacio", int(bad_built.sum()))

    floors = df["floors_count"]
    bad_floors = floors.notna() & ((floors <= 0) | (floors > MAX_FLOORS))
    df["floors_count"] = floors.mask(bad_floors)
    logger.info("Pisos del edificio: %d sin dato (0) o imposibles a vacio", int(bad_floors.sum()))
    return df


def add_amenity_columns(df: pd.DataFrame) -> pd.DataFrame:
    lists = df["amenities"].fillna("").map(lambda s: {_slug(a) for a in s.split(";") if a.strip()})
    counts = pd.Series([a for s in lists for a in s]).value_counts()
    frequent = counts[counts >= MIN_AMENITY_SHARE * len(df)].index
    columns = {f"amenidad_{name}": lists.map(lambda s, n=name: n in s).astype("int8") for name in frequent}
    columns["amenidades_total"] = lists.map(len).astype("int16")
    df = pd.concat([df, pd.DataFrame(columns, index=df.index)], axis=1)
    logger.info("Comodidades: %d columnas 0/1 (de %d distintas)", len(frequent), len(counts))
    return df


def add_text_flags(df: pd.DataFrame) -> pd.DataFrame:
    text = (df["title"].fillna("") + " " + df["description"].fillna("")).map(_ascii)
    for name, pattern in TEXT_FLAGS.items():
        df[name] = text.str.contains(pattern, regex=True).astype("int8")
    return df


def check_no_personal_data(df: pd.DataFrame) -> None:
    """Falla si queda un correo o un numero de telefono en alguna columna de texto."""
    email, phone = re.compile(r"@|\.com\b"), re.compile(r"\d{7,}")
    for col in df.select_dtypes(include=["object", "string", "category"]).columns:
        if col == "anuncio_id":  # hash hexadecimal: sus secuencias de digitos no son telefonos
            continue
        values = df[col].dropna().astype(str)
        hits = int(values.str.contains(email).sum() + values.str.contains(phone).sum())
        if hits:
            raise ValueError(f"Columna {col}: {hits} valores parecen correo o telefono")
    logger.info("Revision de datos personales: sin correos ni telefonos en las columnas de texto")


def build() -> pd.DataFrame:
    df = load_raw_data()
    df = engineer_features(clean(df))
    df.insert(0, "anuncio_id", anonymize_ids(df["listing_id"]))
    if df["anuncio_id"].duplicated().any():
        raise ValueError("Colision de ids anonimos")

    codes = owner_codes(df)
    df["owner_group"] = pd.Categorical.from_codes(codes, categories=OWNER_LABELS)

    df = add_text_flags(df)
    df = add_amenity_columns(df)
    df = fix_coordinates(df)
    df = fix_numeric_columns(df)

    # department_final (el departamento real del anuncio) pasa a llamarse department
    df = df.drop(columns=["department"]).rename(columns={"department_final": "department"})
    df = df.drop(columns=[c for c in DROP_COLUMNS if c in df.columns])

    for col in ("scraped_at",):
        df[col] = pd.to_datetime(df[col]).dt.tz_localize(None).dt.date
    for col in ("listing_created_at", "listing_updated_at"):
        df[col] = pd.to_datetime(df[col], errors="coerce").dt.date
    for col in ("department", "city", "neighborhood", "locality", "zone", "owner_type"):
        df[col] = df[col].astype("category")

    check_no_personal_data(df)
    # Se ordena por el id anonimo: ordenar por el original dejaria la secuencia de publicacion a la vista
    return df.sort_values("anuncio_id").reset_index(drop=True)


def main(output_path: Path = OUTPUT_PATH) -> Path:
    df = build()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(output_path, index=False)
    logger.info("Guardado %s (%d filas, %d columnas, %.1f MB)", output_path, len(df), df.shape[1], output_path.stat().st_size / 1e6)
    return output_path


if __name__ == "__main__":
    main()
