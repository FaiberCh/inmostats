"""
Esquemas de request/response de la API. Los nombres de campo son los que
ve el usuario final (ej. "department", no "department_final"); la
traduccion a las columnas exactas que espera el pipeline entrenado vive en
model_service.py, no aqui.
"""

from typing import Optional

from pydantic import BaseModel, Field

from src.pipelines.clean_data import VALID_FLOOR_RANGE, VALID_GARAGES_RANGE, VALID_STRATUM_RANGE


class ApartmentInput(BaseModel):
    area_m2: float = Field(..., gt=0, le=1000, description="Area privada en m2")
    bedrooms: int = Field(..., ge=1, le=10)
    bathrooms: int = Field(..., ge=1, le=10)
    stratum: Optional[int] = Field(None, ge=VALID_STRATUM_RANGE[0], le=VALID_STRATUM_RANGE[1])
    floor: Optional[int] = Field(None, ge=VALID_FLOOR_RANGE[0], le=VALID_FLOOR_RANGE[1])
    antiquity: Optional[int] = Field(
        None, ge=0, le=5, description="Codigo de antiguedad de fincaraiz (0=nuevo/en construccion .. 5=mas de 30 anios)"
    )
    garages: Optional[int] = Field(None, ge=VALID_GARAGES_RANGE[0], le=VALID_GARAGES_RANGE[1])
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    department: str = Field(..., description="Departamento real del inmueble, ej. 'Antioquia', 'Bogotá D.C.'")
    city: str = Field(..., description="Ciudad, ej. 'Medellín'")
    neighborhood: Optional[str] = Field(None, description="Barrio, ej. 'El Poblado'")
    owner_type: str = Field("inmobiliaria", description="inmobiliaria | desarrollador | sin especificar")
    is_new_project: bool = False
    amenities: list[str] = Field(
        default_factory=list,
        description="Amenidades presentes (ver GET /amenities para el vocabulario reconocido)",
    )
    description: Optional[str] = Field(
        None, description="Texto libre del anuncio (titulo + descripcion) para detectar atributos de acabados/diseno"
    )


class PredictionResponse(BaseModel):
    predicted_price_cop: float
    price_per_m2_cop: float
    model_name: str
    model_trained_at: str


class ModelInfo(BaseModel):
    model_name: str
    trained_at: str
    n_rows: int
    metrics_holdout: dict
    metrics_cv: dict
    known_amenities: list[str]
