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
  script consume directamente. El listado es server-side rendered (el HTML
  ya trae los datos), por lo que requests + BeautifulSoup son suficientes.
- Las 14 zonas se obtuvieron de https://www.fincaraiz.com.co/cde-sitemap-
  listings-index.xml (filtrando los sitemaps "apartamento-en-venta-*"), no
  fueron adivinadas: son las unicas zonas para las que el sitio publica un
  sitemap de apartamentos en venta.
- Cada pagina trae su propia metadata de paginacion embebida (lastPage,
  total) en el JSON de Next.js (__NEXT_DATA__), lo que evita tener que
  adivinar cuando parar o confiar en que una pagina vacia significa "fin
  del listado" (en la practica el sitio nunca devuelve una pagina vacia:
  mas alla del ultimo resultado real sigue sirviendo tarjetas).
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
import re
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

# Metadata de paginacion embebida por Next.js en cada pagina, ej.:
# ..."lastPage":22,"perPage":21,"total":457}}}
PAGINATION_PATTERN = re.compile(r'"lastPage":(\d+),"perPage":\d+,"total":(\d+)')

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
    listing_id: Optional[str]
    title: Optional[str]
    location: Optional[str]
    department_slug: str
    department: str
    price_cop: Optional[int]
    price_raw: Optional[str]
    admin_fee_cop: Optional[int]
    bedrooms: Optional[int]
    bathrooms: Optional[int]
    area_m2: Optional[float]
    detail_url: Optional[str]
    source_page: int
    scraped_at: str


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


def extract_pagination_info(html: str) -> tuple[Optional[int], Optional[int]]:
    match = PAGINATION_PATTERN.search(html)
    if not match:
        return None, None
    last_page, total = match.groups()
    return int(last_page), int(total)


def _parse_int(text: str) -> Optional[int]:
    digits = re.sub(r"[^\d]", "", text)
    return int(digits) if digits else None


def _parse_float(text: str) -> Optional[float]:
    """Parse an area like '26.25 m²' or '120,5 m²' (both '.' and ',' can act
    as the decimal separator here; areas are small enough that neither is
    ever a thousands separator in practice)."""
    match = re.search(r"[\d.,]+", text)
    if not match:
        return None
    number = match.group(0)
    if "." in number and "," in number:
        number = number.replace(".", "").replace(",", ".")
    else:
        number = number.replace(",", ".")
    try:
        return float(number)
    except ValueError:
        return None


def _parse_typology(card, listing: dict) -> None:
    for item in card.select(".lc-typologyTag__item"):
        text = item.get_text(separator=" ", strip=True).lower()
        if "hab" in text:
            listing["bedrooms"] = _parse_int(text)
        elif "ba" in text and ("bano" in text or "baño" in text):
            listing["bathrooms"] = _parse_int(text)
        elif "m" in text:
            listing["area_m2"] = _parse_float(text)


def parse_listing_card(card, page: int, department_slug: str, department: str) -> Listing:
    data = {
        "listing_id": None,
        "title": None,
        "location": None,
        "department_slug": department_slug,
        "department": department,
        "price_cop": None,
        "price_raw": None,
        "admin_fee_cop": None,
        "bedrooms": None,
        "bathrooms": None,
        "area_m2": None,
        "detail_url": None,
        "source_page": page,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }

    title_el = card.select_one(".lc-title")
    if title_el:
        data["title"] = title_el.get_text(strip=True)

    location_el = card.select_one(".lc-location")
    if location_el:
        data["location"] = location_el.get_text(separator=" ", strip=True)

    price_el = card.select_one(".main-price")
    if price_el:
        data["price_raw"] = price_el.get_text(strip=True)
        data["price_cop"] = _parse_int(data["price_raw"])

    admin_el = card.select_one(".commonExpenses")
    if admin_el and admin_el.get_text(strip=True):
        data["admin_fee_cop"] = _parse_int(admin_el.get_text(strip=True))

    _parse_typology(card, data)

    link_el = card.find("a", href=True)
    if link_el:
        detail_url = urljoin(BASE_URL, link_el["href"])
        data["detail_url"] = detail_url
        data["listing_id"] = detail_url.rstrip("/").split("/")[-1]

    return Listing(**data)


def parse_page(html: str, page: int, department_slug: str, department: str) -> list[Listing]:
    soup = BeautifulSoup(html, "lxml")
    cards = soup.select(".listingCard")
    listings = [parse_listing_card(c, page, department_slug, department) for c in cards]
    # Las busquedas de "apartamentos" a veces incluyen anuncios de otro tipo
    # (casas, lotes) mezclados en proyectos de vivienda; nos quedamos solo
    # con lo que el propio titulo describe como apartamento.
    return [l for l in listings if l.title and "apartamento" in l.title.lower()]


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


def save_checkpoint(checkpoint: dict) -> None:
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CHECKPOINT_PATH.open("w", encoding="utf-8") as f:
        json.dump(checkpoint, f, ensure_ascii=False, indent=2)


def new_checkpoint() -> dict:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return {
        "output_file": f"fincaraiz_apartamentos_colombia_{timestamp}.csv",
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
    logger.info(
        "%s -> %s",
        "Iniciando corrida nueva" if is_fresh else "Reanudando corrida existente",
        checkpoint["output_file"],
    )

    output_path = output_dir / checkpoint["output_file"]
    is_new_file = not output_path.exists()
    fieldnames = [f.name for f in fields(Listing)]
    start_time = time.monotonic()
    rows_written = 0

    def time_budget_exceeded() -> bool:
        return MAX_RUNTIME_SECONDS is not None and (time.monotonic() - start_time) >= MAX_RUNTIME_SECONDS

    with output_path.open("a", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if is_new_file:
            writer.writeheader()

        for slug, name in LOCATIONS:
            if time_budget_exceeded():
                logger.info("Tiempo maximo (%ds) alcanzado; se detiene aqui.", MAX_RUNTIME_SECONDS)
                break

            dept_state = checkpoint["departments"][slug]
            if dept_state["done"]:
                logger.info("Zona %s ya completada, se omite.", name)
                continue

            page = dept_state["next_page"]
            while dept_state["last_page"] is None or page <= dept_state["last_page"]:
                if time_budget_exceeded():
                    logger.info("Tiempo maximo (%ds) alcanzado; se detiene aqui.", MAX_RUNTIME_SECONDS)
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

                rows = parse_page(html, page, slug, name)
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


def build_summary_message(checkpoint: dict, output_path: Path, rows_written: int) -> str:
    departments = checkpoint["departments"]
    done_count = sum(1 for d in departments.values() if d["done"])
    total_count = len(departments)
    divider = "━" * 21

    if checkpoint["done"]:
        return (
            f"🎉 <b>InmoStats</b> — ¡Corrida nacional completa!\n"
            f"{divider}\n"
            f"✅ {done_count}/{total_count} zonas cubiertas\n"
            f"🆕 {rows_written} anuncios nuevos en esta corrida\n"
            f"🗂 <code>{output_path.name}</code>\n"
            f"{divider}\n"
            f"😴 Cooldown de {MIN_HOURS_BETWEEN_RUNS}h antes de la proxima corrida"
        )

    current = next((d for d in departments.values() if not d["done"]), None)
    if current and current["last_page"]:
        pages_done = current["next_page"] - 1
        zona_linea = f"📍 Zona actual: <b>{current['name']}</b> (pag. {pages_done}/{current['last_page']})\n"
    elif current:
        zona_linea = f"📍 Zona actual: <b>{current['name']}</b>\n"
    else:
        zona_linea = ""

    return (
        f"🏗️ <b>InmoStats</b> — Scraping en progreso\n"
        f"{divider}\n"
        f"{zona_linea}"
        f"📊 Zonas completadas: {_progress_bar(done_count, total_count)} {done_count}/{total_count}\n"
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
