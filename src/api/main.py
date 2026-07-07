"""
API de InmoStats: sirve el modelo de prediccion de precio de apartamentos
entrenado en src/training/train_baseline.py.

Correr localmente: uvicorn src.api.main:app --reload
"""

from fastapi import FastAPI, HTTPException

from src.api.model_service import ModelService, get_model_service
from src.api.schemas import ApartmentInput, ModelInfo, PredictionResponse

app = FastAPI(
    title="InmoStats API",
    description="Prediccion de precio de apartamentos en Colombia a partir de datos de fincaraiz.com.co",
    version="1.0.0",
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/model-info", response_model=ModelInfo)
def model_info() -> ModelInfo:
    try:
        service = get_model_service()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    config = service.config
    return ModelInfo(
        model_name=config["model_name"],
        trained_at=config["trained_at"],
        n_rows=config["n_rows"],
        metrics_holdout=config["metrics_holdout"],
        metrics_cv=config["metrics_cv"],
        known_amenities=config["amenities"],
    )


@app.get("/amenities")
def amenities() -> list[str]:
    try:
        service = get_model_service()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return service.config["amenities"]


@app.post("/predict", response_model=PredictionResponse)
def predict(apartment: ApartmentInput) -> PredictionResponse:
    try:
        service: ModelService = get_model_service()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    predicted_price = service.predict(apartment)
    return PredictionResponse(
        predicted_price_cop=round(predicted_price, 0),
        price_per_m2_cop=round(predicted_price / apartment.area_m2, 0),
        model_name=service.config["model_name"],
        model_trained_at=service.config["trained_at"],
    )
