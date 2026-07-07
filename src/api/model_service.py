"""
Carga el pipeline entrenado (src/training/train_baseline.py) y la
configuracion de features que lo acompania, y reconstruye para cada
request el mismo layout de columnas que el pipeline espera -incluyendo
las columnas amenity_*/txt_* que no vienen directo del request sino que
se derivan de "amenities" y "description" siguiendo la misma logica que
add_amenity_flags()/add_text_keyword_flags() en train_baseline.py.
"""

import json
import unicodedata
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from src.api.schemas import ApartmentInput
from src.pipelines.clean_data import normalize_department

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"
MODEL_PATH = MODELS_DIR / "price_model.joblib"
CONFIG_PATH = MODELS_DIR / "feature_config.json"


def _slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return "".join(c if c.isalnum() else "_" for c in text.lower()).strip("_")


def _normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.lower()


class ModelService:
    def __init__(self, model_path: Path = MODEL_PATH, config_path: Path = CONFIG_PATH):
        if not model_path.exists() or not config_path.exists():
            raise FileNotFoundError(
                f"No se encontro el modelo entrenado ({model_path}) o su configuracion "
                f"({config_path}). Corre 'python -m src.training.train_baseline' primero."
            )
        self.pipeline = joblib.load(model_path)
        self.config = json.loads(config_path.read_text(encoding="utf-8"))

    def build_feature_row(self, apartment: ApartmentInput) -> pd.DataFrame:
        # SimpleImputer espera NaN, no None de Python, para las columnas
        # numericas opcionales (stratum/floor/antiquity/garages/lat/lon).
        def _num(value):
            return value if value is not None else np.nan

        row = {
            "area_m2": apartment.area_m2,
            "bedrooms": apartment.bedrooms,
            "bathrooms": apartment.bathrooms,
            "stratum": _num(apartment.stratum),
            "floor": _num(apartment.floor),
            "antiquity": _num(apartment.antiquity),
            "garages": _num(apartment.garages),
            "latitude": _num(apartment.latitude),
            "longitude": _num(apartment.longitude),
            "department_final": normalize_department(apartment.department) or apartment.department,
            "owner_type": apartment.owner_type,
            "city": apartment.city,
            "neighborhood": apartment.neighborhood or "sin especificar",
            "is_new_project": int(apartment.is_new_project),
        }

        requested_amenities = {_normalize_text(a) for a in apartment.amenities}
        for amenity in self.config["amenities"]:
            col = "amenity_" + _slugify(amenity)
            row[col] = int(_normalize_text(amenity) in requested_amenities)

        text = _normalize_text(apartment.description or "")
        for keyword in self.config["luxury_keywords"]:
            col = "txt_" + _slugify(keyword)
            row[col] = int(keyword in text)

        return pd.DataFrame([row])

    def predict(self, apartment: ApartmentInput) -> float:
        X = self.build_feature_row(apartment)
        pred_log = self.pipeline.predict(X)[0]
        return float(np.expm1(pred_log))


_service: ModelService | None = None


def get_model_service() -> ModelService:
    global _service
    if _service is None:
        _service = ModelService()
    return _service
