"""
Convierte los CSV crudos del scraper en Parquet (un archivo por lote), con tipos.

Los CSV tienen hasta 3 esquemas (los viejos no traen department_real ni run_started_at): se unen
por nombre y las columnas que faltan quedan vacias. Se conservan TODAS las observaciones y todas las
columnas, incluidas las personales, asi que el resultado va solo al dataset privado. Cada fila lleva
source_file, el nombre del CSV de origen.

Parquet permite que DuckDB lea solo las columnas que necesita (incluso desde Hugging Face), en vez de
bajar todos los CSV.

    from src.pipelines.consolidate_raw import csv_to_parquet
    csv_to_parquet(lista_de_csv, "salida.parquet")
"""

import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import duckdb

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

HF_REPO = "fchaparro/inmostats-data"  # dataset privado con raw/ (CSV) y consolidated/ (Parquet)
CONSOLIDATED_PREFIX = "consolidated"  # base.parquet (historial) + delta/*.parquet (un lote por actualizacion)

TEXT_COLUMNS = [
    "title", "description", "address", "detail_url", "department_slug", "department", "department_real",
    "city", "neighborhood", "locality", "zone", "amenities", "owner_type", "owner_name", "main_image_url",
    "listing_created_at", "listing_updated_at",
]
INT_COLUMNS = [
    "listing_id", "price_cop", "admin_fee_cop", "bedrooms", "bathrooms", "stratum", "floor", "floors_count",
    "antiquity", "construction_year", "garages", "image_count", "source_page",
]
FLOAT_COLUMNS = ["latitude", "longitude", "area_m2", "area_built_m2"]
TIMESTAMP_COLUMNS = ["scraped_at", "run_started_at"]
BOOL_COLUMNS = ["is_new_project"]


def _select_list() -> str:
    parts = [f"{c}" for c in TEXT_COLUMNS]
    # Algunos CSV viejos escribieron enteros como "3.0": se pasa por DOUBLE antes de BIGINT.
    parts += [f"TRY_CAST(TRY_CAST({c} AS DOUBLE) AS BIGINT) AS {c}" for c in INT_COLUMNS]
    parts += [f"TRY_CAST({c} AS DOUBLE) AS {c}" for c in FLOAT_COLUMNS]
    parts += [f"TRY_CAST({c} AS TIMESTAMPTZ) AS {c}" for c in TIMESTAMP_COLUMNS]
    parts += [f"TRY_CAST({c} AS BOOLEAN) AS {c}" for c in BOOL_COLUMNS]
    parts.append("regexp_extract(filename, '[^/\\\\]+$') AS source_file")
    return ", ".join(parts)


def load_observations(sources: Iterable[str], columns: Iterable[str], token: str | None = None):
    """DataFrame con la observacion mas reciente de cada anuncio, leyendo solo `columns`.

    `sources` son rutas o URL de Parquet (por ejemplo hf://datasets/usuario/dataset/consolidated/*.parquet).
    DuckDB lee unicamente esas columnas, asi que desde Hugging Face baja una fraccion del archivo.
    Equivale a load_raw_data (ordenar por scraped_at y quedarse con la ultima fila por listing_id)."""
    cols = list(dict.fromkeys(["listing_id", "scraped_at", *columns]))
    con = duckdb.connect()
    try:
        if token:
            con.execute("CREATE SECRET hf_secret (TYPE HUGGINGFACE, TOKEN ?)", [token])
        return con.execute(
            f"""
            SELECT {', '.join(cols)}
            FROM read_parquet(?, union_by_name = true)
            QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY scraped_at DESC) = 1
            """,
            [list(sources)],
        ).df()
    finally:
        con.close()


def csv_to_parquet(csv_files: Iterable[Path | str], output_path: Path | str) -> int:
    """Escribe el Parquet y devuelve el numero de filas."""
    files = [Path(f).as_posix() for f in csv_files]
    if not files:
        raise ValueError("No hay CSV que convertir")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    out_sql = output.as_posix().replace("'", "''")

    con = duckdb.connect()
    try:
        con.execute(
            f"""
            COPY (
                SELECT {_select_list()}
                FROM read_csv(?, header = true, all_varchar = true, union_by_name = true, filename = true)
                ORDER BY listing_id, scraped_at
            ) TO '{out_sql}' (FORMAT PARQUET, COMPRESSION ZSTD)
            """,
            [files],
        )
        rows = con.execute(f"SELECT count(*) FROM read_parquet('{out_sql}')").fetchone()[0]
    finally:
        con.close()
    logger.info("%d CSV -> %s (%d filas, %.1f MB)", len(files), output, rows, output.stat().st_size / 1e6)
    return rows


def consolidated_sources(token: str, prefix: str = CONSOLIDATED_PREFIX) -> list[str]:
    """URL hf:// de todos los Parquet del consolidado (base y lotes)."""
    from huggingface_hub import HfApi

    files = HfApi(token=token).list_repo_files(HF_REPO, repo_type="dataset")
    return [f"hf://datasets/{HF_REPO}/{f}" for f in sorted(files) if f.startswith(f"{prefix}/") and f.endswith(".parquet")]


def update_consolidated(token: str, prefix: str = CONSOLIDATED_PREFIX) -> int:
    """Agrega al consolidado los CSV de raw/ que aun no estan (se comparan por nombre de archivo).

    Cada actualizacion sube un lote nuevo, consolidated/delta/delta_<fecha>.parquet, sin reescribir
    lo anterior. Devuelve cuantos CSV nuevos agrego."""
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi(token=token)
    repo_files = api.list_repo_files(HF_REPO, repo_type="dataset")
    csvs = {
        Path(f).name: f
        for f in repo_files
        if f.startswith("raw/") and f.endswith(".csv") and Path(f).name.startswith("fincaraiz_apartamentos_")
    }
    sources = consolidated_sources(token, prefix)
    if not sources:
        raise RuntimeError(f"No hay Parquet en {prefix}/: falta construir el consolidado base")

    con = duckdb.connect()
    try:
        con.execute("CREATE SECRET hf_secret (TYPE HUGGINGFACE, TOKEN ?)", [token])
        known = {r[0] for r in con.execute("SELECT DISTINCT source_file FROM read_parquet(?, union_by_name = true)", [sources]).fetchall()}
    finally:
        con.close()

    new = [name for name in sorted(csvs) if name not in known]
    if not new:
        logger.info("Consolidado al dia: sin CSV nuevos (%d conocidos)", len(known))
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        local = [hf_hub_download(HF_REPO, csvs[name], repo_type="dataset", token=token, local_dir=tmp) for name in new]
        batch = Path(tmp) / "delta.parquet"
        rows = csv_to_parquet(local, batch)
        target = f"{prefix}/delta/delta_{datetime.now(timezone.utc):%Y%m%dT%H%M%S}.parquet"
        api.upload_file(
            path_or_fileobj=str(batch),
            path_in_repo=target,
            repo_id=HF_REPO,
            repo_type="dataset",
            commit_message=f"Consolidado: {len(new)} CSV nuevo(s), {rows} filas",
        )
    logger.info("Consolidado: %d CSV nuevos (%d filas) en %s", len(new), rows, target)
    return len(new)
