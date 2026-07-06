"""
Entrena y compara modelos baseline para predecir precio de apartamentos
en Colombia: Regresion Lineal (baseline simple), Random Forest y XGBoost.

Usa el mismo pipeline de limpieza que el EDA (src/pipelines/clean_data.py),
no una copia aparte. El modelo se entrena sobre log(price_cop) -la
distribucion de precio viene sesgada a la derecha, ver notebooks/01_eda.ipynb
seccion 3- y las metricas se reportan de vuelta en COP para que sean
interpretables.
"""

import logging
import unicodedata
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression
from sklearn.metrics import (
    mean_absolute_error,
    mean_absolute_percentage_error,
    r2_score,
    root_mean_squared_error,
)
from sklearn.model_selection import KFold, cross_val_predict, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, TargetEncoder
from xgboost import XGBRegressor

from src.pipelines.clean_data import clean, engineer_features, load_raw_data

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"

# department_final: cardinalidad chica (~15-25) -> one-hot esta bien.
# city: cientos de valores distintos -> one-hot explotaria en columnas;
# se usa target encoding (con cross-fitting interno de sklearn, evita
# leakage) en vez de agrupar a mano "top-N + otra".
NUMERIC_FEATURES = [
    "area_m2", "bedrooms", "bathrooms", "stratum", "floor", "antiquity", "garages",
    "latitude", "longitude",
]
ONEHOT_FEATURES = ["department_final", "owner_type"]
TARGET_ENCODE_FEATURES = ["city"]
BOOL_FEATURES = ["is_new_project"]
TARGET = "price_cop"
N_AMENITY_FEATURES = 15

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def top_amenities(df, n: int = N_AMENITY_FEATURES) -> list[str]:
    exploded = df["amenities"].dropna().str.split("; ").explode().str.strip()
    return exploded.value_counts().head(n).index.tolist()


def add_amenity_flags(df, amenities: list[str]):
    """Una columna binaria por amenidad (esta presente o no en el anuncio).
    Que amenidades usar se decide sobre todo el dataset (no solo train):
    es solo vocabulario de features, no usa el precio, asi que no hay
    leakage real del target hacia el set de prueba."""
    amenities_text = df["amenities"].fillna("")
    flags = {}
    for amenity in amenities:
        col = "amenity_" + _slugify(amenity)
        flags[col] = amenities_text.str.contains(amenity, regex=False).astype(int)
    return pd.DataFrame(flags, index=df.index)


def _slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return "".join(c if c.isalnum() else "_" for c in text.lower()).strip("_")


def build_preprocessor(amenity_columns: list[str]) -> ColumnTransformer:
    return ColumnTransformer(
        transformers=[
            ("num", SimpleImputer(strategy="median"), NUMERIC_FEATURES),
            ("onehot", OneHotEncoder(handle_unknown="ignore"), ONEHOT_FEATURES),
            ("target_enc", TargetEncoder(target_type="continuous"), TARGET_ENCODE_FEATURES),
            ("bool", "passthrough", BOOL_FEATURES + amenity_columns),
        ]
    )


def load_dataset():
    df = load_raw_data()
    df = clean(df)
    df = engineer_features(df)
    df = df.dropna(subset=[TARGET]).copy()

    amenities = top_amenities(df)
    amenity_df = add_amenity_flags(df, amenities)

    features = NUMERIC_FEATURES + ONEHOT_FEATURES + TARGET_ENCODE_FEATURES + BOOL_FEATURES
    X = pd.concat([df[features].copy(), amenity_df], axis=1)
    X["is_new_project"] = X["is_new_project"].astype(int)
    y_log = np.log1p(df[TARGET])
    y_raw = df[TARGET]
    return X, y_log, y_raw, amenity_df.columns.tolist()


def evaluate(pipe: Pipeline, X_test, y_test_raw) -> dict:
    pred = np.expm1(pipe.predict(X_test))
    return {
        "RMSE_COP": round(root_mean_squared_error(y_test_raw, pred), 0),
        "MAE_COP": round(mean_absolute_error(y_test_raw, pred), 0),
        "MAPE_%": round(mean_absolute_percentage_error(y_test_raw, pred) * 100, 2),
        "R2": round(r2_score(y_test_raw, pred), 4),
    }


def cross_val_predictions(model, X, y_log, amenity_columns, n_splits: int = 5) -> np.ndarray:
    """Predicciones out-of-fold en COP: cada fila se predice con un modelo
    que no la vio en entrenamiento, sin tocar el modelo final ya ajustado
    con todos los datos. Base tanto para las metricas agregadas de CV como
    para el desglose de error por segmento."""
    cv = KFold(n_splits=n_splits, shuffle=True, random_state=42)
    pipe = Pipeline([("prep", build_preprocessor(amenity_columns)), ("model", model)])
    pred_log = cross_val_predict(pipe, X, y_log, cv=cv, n_jobs=-1)
    return np.expm1(pred_log)


def metrics_from_predictions(y_raw, pred) -> dict:
    return {
        "RMSE_COP": round(root_mean_squared_error(y_raw, pred), 0),
        "MAE_COP": round(mean_absolute_error(y_raw, pred), 0),
        "MAPE_%": round(mean_absolute_percentage_error(y_raw, pred) * 100, 2),
        "R2": round(r2_score(y_raw, pred), 4),
    }


def residual_breakdown(segment: pd.Series, y_raw: pd.Series, pred: np.ndarray, min_count: int = 100) -> pd.DataFrame:
    """MAPE y error promedio por segmento (departamento, cuartil de precio,
    etc.) usando las predicciones out-of-fold de cross_val_predictions.
    Segmentos con pocas filas se excluyen -su MAPE es ruidoso y no dice
    mucho sobre si el modelo tiene un sesgo sistematico ahi."""
    df = pd.DataFrame({
        "segment": segment.values,
        "y_raw": y_raw.values,
        "pred": pred,
    })
    df["pct_error"] = (df["pred"] - df["y_raw"]) / df["y_raw"] * 100
    grouped = df.groupby("segment").agg(
        n=("y_raw", "size"),
        mape=("pct_error", lambda s: s.abs().mean()),
        bias_pct=("pct_error", "mean"),
    )
    grouped = grouped[grouped["n"] >= min_count].sort_values("mape", ascending=False)
    return grouped.round(2)


def top_feature_importances(pipe: Pipeline, top_n: int = 15) -> list[tuple[str, float]]:
    """Importancias del modelo final, mapeadas a nombres de columna legibles
    (target encoding y one-hot dejan nombres tecnicos tipo 'onehot__x0_Bogota';
    get_feature_names_out() del ColumnTransformer ya resuelve eso)."""
    names = pipe.named_steps["prep"].get_feature_names_out()
    importances = pipe.named_steps["model"].feature_importances_
    ranked = sorted(zip(names, importances), key=lambda pair: pair[1], reverse=True)
    return ranked[:top_n]


def build_models() -> dict:
    return {
        "LinearRegression": LinearRegression(),
        "RandomForest": RandomForestRegressor(
            n_estimators=300, max_depth=16, min_samples_leaf=3, n_jobs=-1, random_state=42
        ),
        "XGBoost": XGBRegressor(
            # Hiperparametros de src/training/tune_xgboost.py (RandomizedSearchCV,
            # 30 combinaciones x 3 folds, optimizado por RMSE de log-precio).
            n_estimators=846, max_depth=6, learning_rate=0.0555,
            subsample=0.842, colsample_bytree=0.724, min_child_weight=4,
            n_jobs=-1, random_state=42,
        ),
    }


def train_and_compare(X, y_log, y_raw, amenity_columns, test_size: float = 0.2, random_state: int = 42):
    X_train, X_test, y_train_log, y_test_log, y_train_raw, y_test_raw = train_test_split(
        X, y_log, y_raw, test_size=test_size, random_state=random_state
    )

    results, fitted = {}, {}
    for name, model in build_models().items():
        pipe = Pipeline([("prep", build_preprocessor(amenity_columns)), ("model", model)])
        pipe.fit(X_train, y_train_log)
        metrics = evaluate(pipe, X_test, y_test_raw)
        results[name] = metrics
        fitted[name] = pipe
        logger.info("%s -> %s", name, metrics)

    return results, fitted, (X_test, y_test_raw)


def main() -> None:
    X, y_log, y_raw, amenity_columns = load_dataset()
    logger.info("Dataset de entrenamiento: %d filas, %d features", len(X), X.shape[1])

    results, fitted, _ = train_and_compare(X, y_log, y_raw, amenity_columns)

    # RandomForest y XGBoost quedan practicamente empatados en RMSE (la
    # diferencia esta dentro del ruido entre corridas), pero el archivo
    # serializado de RandomForest pesa ~200MB contra ~2MB de XGBoost (100x)
    # -inviable para versionar en git o servir desde una API mas adelante.
    # Se prefiere XGBoost salvo que otro modelo sea claramente mejor (>10%
    # menos RMSE), no solo marginalmente.
    best_by_rmse = min(results, key=lambda n: results[n]["RMSE_COP"])
    if "XGBoost" in results and results["XGBoost"]["RMSE_COP"] <= results[best_by_rmse]["RMSE_COP"] * 1.10:
        best_name = "XGBoost"
    else:
        best_name = best_by_rmse
    logger.info("Modelo elegido: %s (%s)", best_name, results[best_name])

    # El split 80/20 de arriba usa una sola particion aleatoria; se confirma
    # con 5-fold CV que el resultado no fue solo suerte con ese split.
    cv_pred = cross_val_predictions(build_models()[best_name], X, y_log, amenity_columns)
    cv_metrics = metrics_from_predictions(y_raw, cv_pred)
    logger.info("%s -> %s (5-fold CV, todas las filas como test una vez)", best_name, cv_metrics)

    # Un MAPE agregado puede esconder que el modelo falla mucho en un
    # segmento especifico y compensa acertando en otro mas grande. Se
    # desglosa por departamento y por cuartil de precio sobre las mismas
    # predicciones out-of-fold (nada de esto reentrena ni usa el modelo final).
    price_quartile = pd.qcut(y_raw, q=4, labels=["Q1 (mas barato)", "Q2", "Q3", "Q4 (mas caro)"])
    logger.info("Error por cuartil de precio:\n%s", residual_breakdown(price_quartile, y_raw, cv_pred))
    logger.info("Error por departamento (min. 100 anuncios):\n%s", residual_breakdown(X["department_final"], y_raw, cv_pred))

    importances = top_feature_importances(fitted[best_name])
    logger.info("Top features por importancia (%s):", best_name)
    for name, importance in importances:
        logger.info("  %s: %.4f", name, importance)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = MODELS_DIR / "price_model.joblib"
    joblib.dump(fitted[best_name], output_path)
    logger.info("Guardado modelo en %s (%.1f MB)", output_path, output_path.stat().st_size / 1e6)


if __name__ == "__main__":
    main()
