"""
Busqueda de hiperparametros para XGBoost (el modelo elegido en
train_baseline.py) via RandomizedSearchCV con validacion cruzada.

Se mantiene aparte de train_baseline.py porque es mucho mas lento (decenas
de entrenamientos por combinacion x fold); train_baseline.py debe seguir
siendo rapido para poder re-correrlo seguido a medida que cambian los datos.
"""

import logging

from scipy.stats import randint, uniform
from sklearn.model_selection import RandomizedSearchCV
from sklearn.pipeline import Pipeline
from xgboost import XGBRegressor

from src.training.train_baseline import build_preprocessor, load_dataset

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

PARAM_DISTRIBUTIONS = {
    "model__n_estimators": randint(300, 900),
    "model__max_depth": randint(4, 10),
    "model__learning_rate": uniform(0.01, 0.14),
    "model__subsample": uniform(0.7, 0.3),
    "model__colsample_bytree": uniform(0.6, 0.4),
    "model__min_child_weight": randint(1, 8),
}


def main(n_iter: int = 30, cv: int = 3) -> None:
    X, y_log, y_raw, extra_columns, amenities = load_dataset()
    logger.info("Dataset: %d filas, %d features", len(X), X.shape[1])

    pipe = Pipeline([
        ("prep", build_preprocessor(extra_columns)),
        ("model", XGBRegressor(n_jobs=-1, random_state=42)),
    ])

    search = RandomizedSearchCV(
        pipe,
        param_distributions=PARAM_DISTRIBUTIONS,
        n_iter=n_iter,
        cv=cv,
        scoring="neg_root_mean_squared_error",
        random_state=42,
        n_jobs=-1,
        verbose=1,
    )
    search.fit(X, y_log)

    logger.info("Mejores hiperparametros: %s", search.best_params_)
    logger.info("Mejor RMSE (log-precio, CV): %.4f", -search.best_score_)


if __name__ == "__main__":
    main()
