"""
Re-scrapea "Resto de Colombia" desde cero, completa, guardando en su
propia carpeta (data/raw/resto_de_colombia_backfill/) con su propio
checkpoint - totalmente aislado del checkpoint nacional principal, que
no se toca. Corre hasta terminar la zona (puede tardar varias horas).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.scraper import fincaraiz_scraper as scraper

OUTPUT_DIR = Path(__file__).resolve().parents[1] / "data" / "raw" / "resto_de_colombia_backfill"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

scraper.LOCATIONS = [("resto-de-colombia", "Resto de Colombia")]
scraper.CHECKPOINT_PATH = OUTPUT_DIR / ".checkpoint_resto_backfill.json"
scraper.MAX_RUNTIME_SECONDS = None

while True:
    result = scraper.scrape_national(output_dir=OUTPUT_DIR)
    checkpoint = scraper._load_checkpoint_raw()
    if result is None or (checkpoint and checkpoint.get("done")):
        print("BACKFILL TERMINADO:", checkpoint.get("finished_at") if checkpoint else None)
        break
