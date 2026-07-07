# Imagen para la API (src/api/), pensada para Hugging Face Spaces (tipo
# Docker). El modelo se entrena durante el build -models/*.joblib y
# feature_config.json estan gitignored a proposito (son artefactos
# derivados, no codigo fuente), pero data/raw/*.csv SI esta versionado,
# asi que el entrenamiento es reproducible dentro de la imagen.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN python -m src.training.train_baseline

EXPOSE 7860

CMD ["uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "7860"]
