# InmoStats

Sistema extremo a extremo de analítica avanzada y predicción de precios de
vivienda en Colombia, con datos extraídos de `fincaraiz.com.co`: scraping
nacional automatizado, limpieza y feature engineering, EDA con mapas
geográficos reales, un modelo de precio afinado (XGBoost), una API que lo
sirve y un dashboard interactivo.

## Estructura

```text
inmostats/
├── data/
│   ├── raw/              # CSV crudos por corrida (versionados, ver Fase 1)
│   ├── processed/        # dataset limpio + stats_summary.json
│   └── reference/        # geojson de departamentos/municipios (geoBoundaries)
├── src/
│   ├── scraper/          # extracción de datos (fincaraiz_scraper.py)
│   ├── pipelines/        # limpieza, feature engineering, utilidades geo
│   ├── training/         # entrenamiento, tuning y evaluación del modelo
│   ├── api/               # servicio FastAPI que sirve el modelo
│   └── dashboard/         # dashboard Streamlit (predicción + resumen)
├── notebooks/             # EDA (01_eda.ipynb)
├── models/                # modelo entrenado + config de features (no versionados)
├── scripts/                # utilidades puntuales (ej. backfill de una zona)
├── workers/telegram-bot/    # bot de Telegram (Cloudflare Worker) para consultar progreso
├── .github/workflows/       # cron de GitHub Actions para el scraping periódico
└── requirements.txt
```

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

> Nota: varias versiones fijadas originalmente en `requirements.txt`
> (scikit-learn, xgboost, joblib, fastapi, pydantic, streamlit) no tenían
> wheel prebuilt para Python 3.14 y fallaban al compilar desde código
> fuente en Windows. Si eso pasa, instala la versión más reciente del
> paquete en cuestión y actualiza el pin.

## Fase 1: Scraping nacional

Recorre las 14 zonas que fincaraiz reconoce a nivel nacional para
"apartamento en venta" (13 departamentos + el bucket "resto-de-colombia",
tomados directamente de su sitemap oficial, no adivinados) y guarda el
resultado crudo en `data/raw/`:

```bash
python -m src.scraper.fincaraiz_scraper
```

Puntos clave del diseño:
- **Cobertura real, sin cap**: cada zona se pagina hasta su última página
  real (el propio sitio embebe `lastPage`/`total` en cada respuesta), no
  hasta un número fijo. Algunas zonas grandes (Bogotá D.C., Antioquia,
  "resto de Colombia") tienen cientos o miles de páginas, así que una
  corrida completa puede tardar **varias horas** — es intencional, dado
  que se pidió cobertura exhaustiva en vez de una muestra acotada.
- **Resumible**: el progreso se guarda en `data/raw/.checkpoint_national.json`
  después de cada página. Si el proceso se interrumpe (Ctrl+C, corte de
  red, etc.), volver a correr el mismo comando continúa exactamente donde
  quedó en vez de reiniciar. Cuando una corrida termina por completo, la
  siguiente ejecución arranca una corrida nueva (nuevo CSV con timestamp).
- **Ejecución periódica e incremental**: cada corrida crea un CSV nuevo en
  `data/raw/` (nunca sobreescribe los anteriores). El pipeline de limpieza
  (fase 2) consolida todos los CSV y deduplica por `listing_id`, así que
  correr el scraper periódicamente solo *añade* anuncios nuevos a la base
  consolidada.
- Rota el User-Agent, reintenta hasta 3 veces ante fallos de red/timeout,
  y espera 2-4.5s entre peticiones para no saturar el sitio.
- **Los datos vienen del JSON estructurado que la página embebe para
  hidratación** (`script#__NEXT_DATA__` -> `fetchResult.searchFast`), no de
  raspar el HTML visible de la tarjeta. Esto da campos limpios y tipados
  y es más resistente a cambios de diseño del sitio.
- `department_real` guarda el departamento propio de cada anuncio
  (`locations.state`), independiente de la zona de búsqueda. Esto importa
  sobre todo para "resto-de-colombia", un bucket mixto que en la práctica
  trae anuncios de cualquier departamento.

Variables extraídas por anuncio: `listing_id`, `title`, `description`,
`address`, `detail_url`, `department`/`department_slug` (zona consultada),
`department_real`, `city`, `neighborhood`, `locality`, `zone`,
`latitude`/`longitude`, `price_cop`, `admin_fee_cop`, `bedrooms`,
`bathrooms`, `area_m2`, `area_built_m2`, `stratum`, `floor`,
`floors_count`, `antiquity`, `construction_year`, `garages`, `amenities`,
`is_new_project`, `owner_type`/`owner_name`, `image_count`,
`main_image_url`, `listing_created_at`/`listing_updated_at`,
`source_page`, `scraped_at`.

## Fase 2: Limpieza y feature engineering

Consolida todos los CSV crudos, deduplica por `listing_id`, descarta
outliers de dominio y agrega features derivadas:

```bash
python -m src.pipelines.clean_data
```

Filtros de limpieza (`clean()`): rango válido de precio y área, máximo de
habitaciones/baños, estrato fuera de 1-6, y `floor`/`garages` fuera de un
rango plausible (algunos anuncios traen valores imposibles como piso 812 o
127 garajes, que sin filtrar desestabilizan modelos lineales).

Features agregadas (`engineer_features()`):
- `price_per_m2`: precio de venta dividido por área.
- `department_final`: departamento real del anuncio (`department_real`
  cuando existe, normalizado a nombre canónico) con fallback a inferencia
  por ciudad (`infer_department_from_city`, usando la moda del propio
  dataset) para los anuncios de "resto-de-colombia" sin dato real.

Genera `data/processed/apartamentos_colombia_processed.csv`.

## Fase 3: Automatización (GitHub Actions + Telegram)

El scraping nacional corre solo, sin depender de que una máquina local
esté prendida:

- **`.github/workflows/scrape.yml`**: cron cada 30 minutos (más
  `workflow_dispatch` manual). Cada corrida scrapea un tramo acotado
  (`MAX_RUNTIME_SECONDS`), sube los CSV nuevos y el checkpoint a git
  (con reintento automático si otro push se adelantó), y respeta un
  cooldown de 24h entre corridas completas (`MIN_HOURS_BETWEEN_RUNS`) para
  no re-scrapear el sitio completo todos los días sin necesidad.
- **Notificaciones por Telegram**: inicio de una corrida nueva, resumen al
  terminar (duración total, anuncios nuevos), progreso porcentual, y
  alerta si el workflow falla.
- **`workers/telegram-bot/`**: bot interactivo (Cloudflare Worker, sin
  servidor propio) que responde a `/status` (progreso del scraping),
  `/stats` (promedios y anuncios por zona, calculados por
  `src/pipelines/compute_stats.py` en `data/processed/stats_summary.json`)
  y `/variables` (qué campos se están extrayendo), leyendo archivos
  públicos del repo vía `raw.githubusercontent.com`.

## Fase 4: Modelado

```bash
python -m src.training.train_baseline   # entrena, evalúa y guarda el modelo
python -m src.training.tune_xgboost     # busqueda de hiperparametros (lento, aparte)
```

Compara `LinearRegression` (baseline simple), `RandomForest` y `XGBoost`
sobre `log(price_cop)` (la distribución de precio viene sesgada a la
derecha), reportando métricas de vuelta en COP. Se prefiere XGBoost salvo
que otro modelo sea claramente mejor (>10% menos RMSE): a igual precisión,
el archivo serializado es ~100x más chico que el de RandomForest.

**Features**: numéricas (área, habitaciones, baños, estrato, piso,
antigüedad, garajes, lat/lon), categóricas de baja cardinalidad
(`department_final`, `owner_type`, one-hot) y de alta cardinalidad
(`city`, `neighborhood`, target encoding), flags binarios de las 15
amenidades más frecuentes, y flags de palabras clave de lujo/acabados
detectadas en el texto libre del anuncio (`title`/`description`) — ej.
"penthouse", "chimenea", "techos altos", elegidas comparando qué palabras
son más frecuentes en el cuartil de precio más caro que en el más barato.

**Evaluación**: split 80/20 más validación cruzada 5-fold (para no
depender de qué partición aleatoria tocó), y desglose de error por
cuartil de precio y por departamento (un MAPE agregado puede esconder
sesgos sistemáticos en un segmento específico).

**Resultado actual** (ver `models/feature_config.json` para el detalle
exacto de la corrida vigente): XGBoost, MAPE ≈ 14.5%, R² ≈ 0.86 en CV
sobre ~47k anuncios. El modelo subestima sistemáticamente el segmento de
lujo (cuartil más caro) y sobreestima el más barato — se investigó con
sample weighting, recalibración isotónica y features de texto; la mejora
real vino de agregar `neighborhood` como feature, no de esas técnicas. El
sesgo remanente es una limitación conocida y documentada, no un bug: es
consistente con entrenar sobre `log(precio)` con relativamente pocos
anuncios de lujo, y probablemente falta información que solo está en las
fotos (calidad real de acabados).

Guarda `models/price_model.joblib` (pipeline completo: preprocesamiento +
modelo) y `models/feature_config.json` (vocabulario de amenidades/keywords,
métricas, features usadas) — ambos gitignored, se regeneran localmente.

## Fase 5: API

Sirve el modelo entrenado (`models/price_model.joblib`) vía FastAPI:

```bash
uvicorn src.api.main:app --reload
```

Documentación interactiva en `http://localhost:8000/docs`.

- `GET /health` — chequeo básico.
- `GET /model-info` — modelo activo, fecha de entrenamiento y métricas.
- `GET /amenities` — vocabulario de amenidades reconocidas por el modelo.
- `POST /predict` — recibe características de un apartamento (ver
  `src/api/schemas.py::ApartmentInput`) y devuelve el precio estimado.
  Reconstruye internamente las columnas `amenity_*`/`txt_*` que el
  pipeline espera a partir de `amenities` (lista) y `description` (texto
  libre), usando `models/feature_config.json` para saber cuáles buscar.

## Fase 6: Dashboard

Consume la API (no carga el modelo directo) y los datos procesados para
un resumen interactivo del mercado:

```bash
streamlit run src/dashboard/app.py
```

Requiere la API corriendo (`INMOSTATS_API_URL`, default
`http://localhost:8000`). Dos pestañas:

- **Predicción de precio**: mismo formulario que expone la API, con
  selección de departamento → ciudad → barrio encadenada a partir de
  `data/processed/apartamentos_colombia_processed.csv`.
- **Resumen del mercado**: KPIs generales, distribución de precios,
  coropletas de precio/m² por departamento y por ciudad (reutilizando el
  matching geográfico de `src/pipelines/geo.py`, extraído del notebook de
  EDA), top ciudades por número de anuncios, precio por estrato y
  amenidades más frecuentes.

## Notebooks

`notebooks/01_eda.ipynb`: EDA completo — distribuciones de precio, análisis
por departamento/ciudad/estrato, correlaciones, mapas interactivos
(scatter y coropletas reales con `plotly`), regresión precio-vs-área por
departamento, heatmap departamento×estrato y análisis de amenidades.
