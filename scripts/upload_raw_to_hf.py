"""Sube a Hugging Face los CSV crudos que aun no estan en el dataset privado.

Compara por nombre contra lo que ya hay en `raw/` del dataset, asi que se puede
repetir sin riesgo: solo sube lo que falta. Lo usa el workflow del scraper
despues de cada corrida. Requiere la variable de entorno HF_TOKEN (token de
grano fino con escritura sobre el dataset).

    HF_TOKEN=... python scripts/upload_raw_to_hf.py
"""

import os
import sys
from pathlib import Path

from huggingface_hub import HfApi

REPO = "fchaparro/inmostats-data"
DATA_DIR = Path(__file__).resolve().parents[1] / "data"


def main() -> int:
    api = HfApi(token=os.environ["HF_TOKEN"])
    remote = set(api.list_repo_files(REPO, repo_type="dataset"))
    new = [p for p in sorted((DATA_DIR / "raw").glob("*.csv")) if f"raw/{p.name}" not in remote]
    if not new:
        print("Sin CSV nuevos que subir.")
        return 0
    api.upload_folder(
        repo_id=REPO,
        repo_type="dataset",
        folder_path=str(DATA_DIR),
        allow_patterns=[f"raw/{p.name}" for p in new],
        commit_message=f"scrape: {len(new)} CSV nuevo(s)",
    )
    print(f"Subidos {len(new)} CSV: {', '.join(p.name for p in new)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
