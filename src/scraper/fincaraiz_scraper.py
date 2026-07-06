"""
Scraper nacional de apartamentos en venta - fincaraiz.com.co

Recorre las 14 zonas (13 departamentos + el bucket "resto-de-colombia") que
el propio sitemap de fincaraiz reconoce como zonas con oferta de apartamentos
en venta, pagina cada una hasta el final real (segun la metadata de
paginacion que el sitio embebe en cada pagina) y guarda todo en un CSV
crudo en data/raw/.

Notas de implementacion:
- fincaraiz.com.co redirige las URLs con query string (?pagina=N) a rutas
  amigables del tipo /venta/apartamentos/{zona}/paginaN, que es lo que este
  script consume directamente.
- Las 14 zonas se obtuvieron de https://www.fincaraiz.com.co/cde-sitemap-
  listings-index.xml (filtrando los sitemaps "apartamento-en-venta-*"), no
  fueron adivinadas: son las unicas zonas para las que el sitio publica un
  sitemap de apartamentos en venta.
- Los datos NO se leen de las tarjetas HTML visibles: la pagina es un sitio
  Next.js que embebe, para hidratacion, un bloque JSON completo con cada
  anuncio ya limpio y tipado (script#__NEXT_DATA__ ->
  props.pageProps.fetchResult.searchFast). Ese JSON trae muchos mas campos
  que los visibles en la tarjeta (estrato, piso, antiguedad, parqueaderos,
  coordenadas, amenidades, fechas de publicacion, etc.) y evita tener que
  parsear texto con regex; tambien trae la metadata de paginacion real
  (paginatorInfo.lastPage/total) en vez de tener que adivinar cuando parar.
- Dado el volumen (algunas zonas superan las 1000 paginas), el scraping es
  incremental: cada pagina se escribe al CSV y se marca en un checkpoint
  apenas se procesa, para poder interrumpir el proceso y reanudarlo despues
  sin perder trabajo ni repetir peticiones ya hechas.
"""

import csv
import json
import logging
import os
import random
import time
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.fincaraiz.com.co"
SEARCH_PATH = "/venta/apartamentos"

# Zonas confirmadas via el sitemap oficial de fincaraiz para
# "apartamento-en-venta-*" (cde-sitemap-listings-index.xml). El orden no
# importa; se procesan de la mas pequena a la mas grande para tener
# resultados de varias zonas rapido en vez de quedarse horas en la primera.
LOCATIONS = [
    ("tolima", "Tolima"),
    ("norte-de-santander", "Norte de Santander"),
    ("quindio", "Quindío"),
    ("magdalena", "Magdalena"),
    ("caldas", "Caldas"),
    ("santander", "Santander"),
    ("bolivar", "Bolívar"),
    ("risaralda", "Risaralda"),
    ("cundinamarca", "Cundinamarca"),
    ("atlantico", "Atlántico"),
    ("valle-del-cauca", "Valle del Cauca"),
    ("bogota-dc", "Bogotá D.C."),
    ("antioquia", "Antioquia"),
    ("resto-de-colombia", "Resto de Colombia"),
]

REQUEST_TIMEOUT = 15
MIN_DELAY_SECONDS = 2.0
MAX_DELAY_SECONDS = 4.5
MAX_RETRIES_PER_PAGE = 3

# Corta la corrida limpiamente (checkpoint ya guardado) al superar este
# tiempo, en vez de intentar terminar todas las zonas de una sola vez.
# Pensado para correr en trozos acotados (ej. un job de GitHub Actions)
# que se van encadenando via el checkpoint. None = sin limite.
MAX_RUNTIME_SECONDS = int(os.environ["MAX_RUNTIME_SECONDS"]) if os.environ.get("MAX_RUNTIME_SECONDS") else None

# Una vez una corrida nacional completa termina, cuanto esperar antes de
# arrancar la siguiente desde cero. Evita que un scheduler frecuente (ej.
# cron cada 30 min) dispare re-scrapes completos sin parar.
MIN_HOURS_BETWEEN_RUNS = int(os.environ.get("MIN_HOURS_BETWEEN_RUNS", "24"))

# Red de seguridad adicional: GitHub rechaza archivos de mas de 100MB en
# commits normales (sin Git LFS). Cada invocacion ya escribe su propio CSV
# nuevo (no se re-abre uno viejo para seguir anexando), pero por si acaso
# se corre con un MAX_RUNTIME_SECONDS muy alto, cortamos antes de acercarnos
# al limite real.
MAX_FILE_SIZE_BYTES = 80 * 1024 * 1024

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36",
]

DATA_RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "raw"
CHECKPOINT_PATH = DATA_RAW_DIR / ".checkpoint_national.json"

# Notificaciones opcionales por Telegram (ver README para como crear el bot
# y obtener estos valores). Si no estan configuradas, send_telegram_message
# simplemente no hace nada.
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def send_telegram_message(text: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        requests.post(
            url,
            data={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
    except requests.RequestException as exc:
        logger.warning("No se pudo enviar la notificacion a Telegram: %s", exc)


@dataclass
class Listing:
    listing_id: Optional[int]
    title: Optional[str]
    description: Optional[str]
    address: Optional[str]
    detail_url: Optional[str]
    department_slug: str
    department: str
    department_real: Optional[str]
    city: Optional[str]
    neighborhood: Optional[str]
    locality: Optional[str]
    zone: Optional[str]
    latitude: Optional[float]
    longitude: Optional[float]
    price_cop: Optional[int]
    admin_fee_cop: Optional[int]
    bedrooms: Optional[int]
    bathrooms: Optional[int]
    area_m2: Optional[float]
    area_built_m2: Optional[float]
    stratum: Optional[int]
    floor: Optional[int]
    floors_count: Optional[int]
    antiquity: Optional[int]
    construction_year: Optional[int]
    garages: Optional[int]
    amenities: Optional[str]
    is_new_project: Optional[bool]
    owner_type: Optional[str]
    owner_name: Optional[str]
    image_count: Optional[int]
    main_image_url: Optional[str]
    listing_created_at: Optional[str]
    listing_updated_at: Optional[str]
    source_page: int
    scraped_at: str
    run_started_at: str


def build_page_url(department_slug: str, page: int) -> str:
    return f"{BASE_URL}{SEARCH_PATH}/{department_slug}/pagina{page}"


def fetch_page(url: str) -> Optional[str]:
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept-Language": "es-CO,es;q=0.9",
    }
    for attempt in range(1, MAX_RETRIES_PER_PAGE + 1):
        try:
            response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            return response.text
        except requests.RequestException as exc:
            logger.warning(
                "Intento %d/%d fallo para %s: %s", attempt, MAX_RETRIES_PER_PAGE, url, exc
            )
            if attempt < MAX_RETRIES_PER_PAGE:
                time.sleep(random.uniform(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS))
    logger.error("Se agotaron los reintentos para %s; se omite.", url)
    return None


def extract_next_data(html: str) -> Optional[dict]:
    soup = BeautifulSoup(html, "lxml")
    script = soup.find("script", id="__NEXT_DATA__")
    if not script or not script.string:
        return None
    try:
        return json.loads(script.string)
    except json.JSONDecodeError:
        return None


def _first_location_name(locations: dict, key: str) -> Optional[str]:
    entries = locations.get(key) or []
    return entries[0]["name"].strip() if entries else None


def _amenities_string(facilities: list) -> Optional[str]:
    names = [f["name"] for f in (facilities or []) if f.get("name")]
    return "; ".join(names) if names else None


def parse_listing(
    raw: dict, page: int, department_slug: str, department: str, run_started_at: str
) -> Listing:
    locations = raw.get("locations") or {}
    price = raw.get("price") or {}
    common_expenses = raw.get("commonExpenses") or {}
    owner = raw.get("owner") or {}
    location_main = locations.get("location_main") or {}

    link = raw.get("link")
    detail_url = urljoin(BASE_URL, link) if link else None

    return Listing(
        listing_id=raw.get("id"),
        title=raw.get("title"),
        description=raw.get("description"),
        address=raw.get("address"),
        detail_url=detail_url,
        department_slug=department_slug,
        department=department,
        # "department" es la zona de busqueda (fija segun la URL scrapeada);
        # para la mayoria de zonas coincide con el departamento real del
        # anuncio, pero "resto-de-colombia" es un bucket mixto que en la
        # practica trae anuncios de CUALQUIER departamento (Bogota,
        # Cundinamarca, Santander, etc.) etiquetados como "Resto de
        # Colombia". department_real usa el dato propio del anuncio
        # (locations.state) para saber su ubicacion real sin importar bajo
        # que zona de busqueda se encontro.
        department_real=_first_location_name(locations, "state"),
        city=_first_location_name(locations, "city"),
        neighborhood=location_main.get("name"),
        locality=_first_location_name(locations, "locality"),
        zone=_first_location_name(locations, "zone"),
        latitude=raw.get("latitude"),
        longitude=raw.get("longitude"),
        price_cop=price.get("amount"),
        admin_fee_cop=common_expenses.get("amount"),
        bedrooms=raw.get("bedrooms"),
        bathrooms=raw.get("bathrooms"),
        area_m2=raw.get("m2"),
        area_built_m2=raw.get("m2Built"),
        stratum=raw.get("stratum"),
        floor=raw.get("floor"),
        floors_count=raw.get("floorsCount"),
        antiquity=raw.get("antiquity"),
        construction_year=raw.get("construction_year"),
        garages=raw.get("garage"),
        amenities=_amenities_string(raw.get("facilities")),
        is_new_project=bool(raw.get("isProject") or raw.get("isProjectUnit")),
        owner_type=owner.get("type"),
        owner_name=owner.get("name"),
        image_count=raw.get("image_count"),
        main_image_url=raw.get("img"),
        listing_created_at=raw.get("created_at"),
        listing_updated_at=raw.get("updated_at"),
        source_page=page,
        scraped_at=datetime.now(timezone.utc).isoformat(),
        run_started_at=run_started_at,
    )


def parse_page(
    html: str, page: int, department_slug: str, department: str, run_started_at: str
) -> list[Listing]:
    next_data = extract_next_data(html)
    if next_data is None:
        logger.warning("No se encontro __NEXT_DATA__ en la pagina %d de %s", page, department)
        return []

    try:
        search_fast = next_data["props"]["pageProps"]["fetchResult"]["searchFast"]
        raw_listings = search_fast["data"]
    except (KeyError, TypeError):
        logger.warning("Estructura inesperada de datos en la pagina %d de %s", page, department)
        return []

    listings = [
        parse_listing(r, page, department_slug, department, run_started_at) for r in raw_listings
    ]
    # Las busquedas de "apartamentos" a veces incluyen anuncios de otro tipo
    # (casas, lotes) mezclados en proyectos de vivienda; el propio dato de
    # tipo de propiedad nos deja filtrar con precision, sin depender de
    # texto libre del titulo.
    return [
        listing
        for listing, raw in zip(listings, raw_listings)
        if (raw.get("property_type") or {}).get("name", "").strip().lower() == "apartamento"
    ]


def extract_pagination_info(html: str) -> tuple[Optional[int], Optional[int]]:
    next_data = extract_next_data(html)
    if next_data is None:
        return None, None
    try:
        paginator = next_data["props"]["pageProps"]["fetchResult"]["searchFast"]["paginatorInfo"]
        return paginator.get("lastPage"), paginator.get("total")
    except (KeyError, TypeError):
        return None, None


def _load_checkpoint_raw() -> Optional[dict]:
    if not CHECKPOINT_PATH.exists():
        return None
    with CHECKPOINT_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def get_or_create_checkpoint() -> Optional[dict]:
    """Resume an in-progress checkpoint, start a new run, or (if the last
    full run finished less than MIN_HOURS_BETWEEN_RUNS ago) signal that
    there is nothing to do yet by returning None.

    Without this cooldown, a scheduler that fires every N minutes (e.g. the
    GitHub Actions cron) would kick off a brand new multi-hour national
    crawl immediately after the previous one finishes, forever."""
    checkpoint = _load_checkpoint_raw()
    if checkpoint is None:
        return new_checkpoint()

    if not checkpoint.get("done"):
        return checkpoint

    finished_at = checkpoint.get("finished_at")
    if finished_at:
        elapsed_hours = (
            datetime.now(timezone.utc) - datetime.fromisoformat(finished_at)
        ).total_seconds() / 3600
        if elapsed_hours < MIN_HOURS_BETWEEN_RUNS:
            logger.info(
                "Ultima corrida completada hace %.1fh (< %dh de espera); nada que hacer todavia.",
                elapsed_hours, MIN_HOURS_BETWEEN_RUNS,
            )
            return None

    return new_checkpoint()


def run_started_at_tag(started_at: str) -> str:
    """Version compacta y apta para nombre de archivo de un started_at ISO,
    ej. '2026-07-03T17:36:47.742614+00:00' -> 'run20260703T173647'."""
    return "run" + datetime.fromisoformat(started_at).strftime("%Y%m%dT%H%M%S")


def save_checkpoint(checkpoint: dict) -> None:
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CHECKPOINT_PATH.open("w", encoding="utf-8") as f:
        json.dump(checkpoint, f, ensure_ascii=False, indent=2)


def new_checkpoint() -> dict:
    return {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "done": False,
        "departments": {
            slug: {"name": name, "next_page": 1, "last_page": None, "done": False}
            for slug, name in LOCATIONS
        },
    }


def scrape_national(output_dir: Path = DATA_RAW_DIR) -> Optional[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)

    checkpoint = get_or_create_checkpoint()
    if checkpoint is None:
        return None

    is_fresh = all(
        d["next_page"] == 1 and d["last_page"] is None and not d["done"]
        for d in checkpoint["departments"].values()
    )

    if is_fresh:
        divider = "━" * 21
        send_telegram_message(
            f"🚀 <b>InmoStats</b> — Corrida nacional iniciada\n"
            f"{divider}\n"
            f"🗺 {len(checkpoint['departments'])} zonas por cubrir\n"
            f"{divider}\n"
            f"Te aviso el progreso cada ~30 min y el tiempo total cuando termine."
        )

    # Cada invocacion escribe su propio CSV nuevo (nunca se re-abre uno viejo
    # para seguir anexando). Antes se reusaba un solo archivo por toda la
    # corrida nacional (dias de ejecucion, encadenados via checkpoint) y
    # termino superando el limite de 100MB de GitHub para archivos normales,
    # lo que tumbaba el push en cada corrida siguiente sin poder recuperarse.
    #
    # El nombre incluye el tag de la corrida (run_tag, derivado de
    # started_at) ademas del timestamp del propio archivo, para poder
    # filtrar por corrida via un glob simple sin tener que abrir ningun
    # archivo (ver clean_data.load_raw_data(run_started_at=...)).
    run_tag = run_started_at_tag(checkpoint["started_at"])
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    output_path = output_dir / f"fincaraiz_apartamentos_colombia_{run_tag}_{timestamp}.csv"
    logger.info(
        "%s -> %s",
        "Iniciando corrida nueva" if is_fresh else "Reanudando corrida existente",
        output_path.name,
    )
    fieldnames = [f.name for f in fields(Listing)]
    start_time = time.monotonic()
    rows_written = 0

    def time_budget_exceeded() -> bool:
        return MAX_RUNTIME_SECONDS is not None and (time.monotonic() - start_time) >= MAX_RUNTIME_SECONDS

    def file_too_big() -> bool:
        return output_path.exists() and output_path.stat().st_size >= MAX_FILE_SIZE_BYTES

    with output_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for slug, name in LOCATIONS:
            if time_budget_exceeded() or file_too_big():
                logger.info("Tiempo maximo o tamano maximo alcanzado; se detiene aqui.")
                break

            dept_state = checkpoint["departments"][slug]
            if dept_state["done"]:
                logger.info("Zona %s ya completada, se omite.", name)
                continue

            page = dept_state["next_page"]
            while dept_state["last_page"] is None or page <= dept_state["last_page"]:
                if time_budget_exceeded() or file_too_big():
                    logger.info("Tiempo maximo o tamano maximo alcanzado; se detiene aqui.")
                    break

                url = build_page_url(slug, page)
                logger.info("[%s] Descargando pagina %d/%s: %s",
                            name, page, dept_state["last_page"] or "?", url)
                html = fetch_page(url)

                if html is None:
                    logger.warning("Se omite %s pagina %d tras fallos repetidos.", name, page)
                    dept_state["next_page"] = page + 1
                    save_checkpoint(checkpoint)
                    page += 1
                    continue

                if dept_state["last_page"] is None:
                    last_page, total = extract_pagination_info(html)
                    dept_state["last_page"] = last_page or 1
                    logger.info("[%s] total anuncios: %s, paginas: %s",
                                name, total, dept_state["last_page"])

                rows = parse_page(html, page, slug, name, checkpoint["started_at"])
                for row in rows:
                    writer.writerow(asdict(row))
                rows_written += len(rows)
                f.flush()

                dept_state["next_page"] = page + 1
                save_checkpoint(checkpoint)

                if page >= dept_state["last_page"]:
                    dept_state["done"] = True
                    logger.info("Zona %s completada (%d paginas).", name, page)
                    break

                page += 1
                delay = random.uniform(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS)
                time.sleep(delay)

        checkpoint["done"] = all(d["done"] for d in checkpoint["departments"].values())
        checkpoint["finished_at"] = datetime.now(timezone.utc).isoformat() if checkpoint["done"] else None
        save_checkpoint(checkpoint)

    logger.info("Corrida %s. Archivo: %s",
                "completa" if checkpoint["done"] else "interrumpida (reanudable)", output_path)

    send_telegram_message(build_summary_message(checkpoint, output_path, rows_written))
    return output_path


def _progress_bar(done: int, total: int, length: int = 10) -> str:
    filled = round(length * done / total) if total else 0
    return "▓" * filled + "░" * (length - filled)


def _format_duration(start_iso: str, end_iso: str) -> str:
    start = datetime.fromisoformat(start_iso)
    end = datetime.fromisoformat(end_iso)
    total_seconds = int((end - start).total_seconds())
    days, rem = divmod(total_seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if days or hours:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


def build_summary_message(checkpoint: dict, output_path: Path, rows_written: int) -> str:
    departments = checkpoint["departments"]
    done_count = sum(1 for d in departments.values() if d["done"])
    total_count = len(departments)
    divider = "━" * 21

    if checkpoint["done"]:
        duration = _format_duration(checkpoint["started_at"], checkpoint["finished_at"])
        return (
            f"🎉 <b>InmoStats</b> — ¡Corrida nacional completa!\n"
            f"{divider}\n"
            f"✅ {done_count}/{total_count} zonas cubiertas\n"
            f"⏱ Tiempo total: {duration}\n"
            f"🆕 {rows_written} anuncios nuevos en esta corrida\n"
            f"🗂 <code>{output_path.name}</code>\n"
            f"{divider}\n"
            f"😴 Cooldown de {MIN_HOURS_BETWEEN_RUNS}h antes de la proxima corrida"
        )

    current = next((d for d in departments.values() if not d["done"]), None)
    if current and current["last_page"]:
        pages_done = current["next_page"] - 1
        pct = round(pages_done / current["last_page"] * 100)
        zona_linea = (
            f"📍 Zona actual: <b>{current['name']}</b> "
            f"(pag. {pages_done}/{current['last_page']} — {pct}%)\n"
        )
    elif current:
        zona_linea = f"📍 Zona actual: <b>{current['name']}</b> (aun sin iniciar)\n"
    else:
        zona_linea = ""

    # Avance nacional por paginas (mas representativo que el conteo de
    # zonas, ya que algunas zonas son muchisimo mas grandes que otras).
    # Solo cuenta zonas cuyo total de paginas ya se conoce.
    known = [d for d in departments.values() if d["last_page"]]
    total_pages = sum(d["last_page"] for d in known)
    done_pages = sum(d["last_page"] if d["done"] else d["next_page"] - 1 for d in known)
    not_started = sum(1 for d in departments.values() if not d["done"] and not d["last_page"])
    national_pct = round(done_pages / total_pages * 100) if total_pages else 0
    national_note = f" (sin contar {not_started} zona(s) aun sin iniciar)" if not_started else ""
    zones_pct = round(done_count / total_count * 100) if total_count else 0

    return (
        f"🏗️ <b>InmoStats</b> — Scraping en progreso\n"
        f"{divider}\n"
        f"{zona_linea}"
        f"📊 Zonas completadas: {_progress_bar(done_count, total_count)} {done_count}/{total_count} ({zones_pct}%)\n"
        f"📈 Avance nacional por paginas: {national_pct}%{national_note}\n"
        f"🆕 {rows_written} anuncios nuevos en esta corrida\n"
        f"🗂 <code>{output_path.name}</code>\n"
        f"{divider}\n"
        f"🔁 Continua en la proxima corrida programada"
    )


def main() -> None:
    try:
        scrape_national()
    except Exception as exc:
        send_telegram_message(
            f"🚨 <b>InmoStats</b> — Algo fallo en el scraping\n"
            f"{'━' * 21}\n"
            f"⚠️ <code>{exc}</code>\n"
            f"{'━' * 21}\n"
            f"Revisa los logs en GitHub Actions."
        )
        raise


if __name__ == "__main__":
    main()
