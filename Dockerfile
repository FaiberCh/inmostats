# Imagen heredada para la API (src/api/). Entrena el modelo durante el build, lo
# que exigia los CSV de data/raw/ en git; ya no estan versionados (viven en el
# dataset privado de Hugging Face), asi que esta imagen ya no construye sola.
# El Space se construye desde la rama space-deploy, que descarga el modelo.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN python -m src.training.train_baseline

EXPOSE 7860

CMD ["uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "7860"]
