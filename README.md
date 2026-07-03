# InmoStats

Sistema extremo a extremo de analítica avanzada y predicción de precios de
vivienda en Colombia, con datos extraídos de `fincaraiz.com.co`.

## Estructura

```text
inmostats/
├── data/            # raw (crudo) y processed (limpio/features)
├── src/
│   ├── scraper/     # extracción de datos (fincaraiz_scraper.py)
│   ├── pipelines/   # limpieza y feature engineering
│   └── training/    # entrenamiento de modelos
├── api/             # servicio FastAPI para servir predicciones
├── dashboard/        # dashboard Streamlit
├── notebooks/        # EDA y experimentación
├── models/            # modelos entrenados serializados
└── requirements.txt
```

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

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
  consolidada. Nota: fincaraiz no expone un orden "más recientes primero"
  vía URL, así que cada corrida periódica vuelve a recorrer las páginas
  completas de cada zona (no hay forma de saltar directo a "solo lo
  nuevo" del lado del scraper); la deduplicación ocurre al consolidar.
- Rota el User-Agent, reintenta hasta 3 veces ante fallos de red/timeout,
  y espera 2-4.5s entre peticiones para no saturar el sitio.

## Fase 2: Limpieza y feature engineering

Consolida todos los CSV crudos, deduplica por `listing_id`, descarta
outliers de dominio (precio, área, habitaciones/baños fuera de rango) y
agrega features derivadas:

```bash
python -m src.pipelines.clean_data
```

Features agregadas:
- `neighborhood` / `city`: barrio y ciudad extraídos del título (ej.
  "niza" / "bogotá", "el poblado" / "medellín").
- `is_new_project`: si el anuncio es un proyecto de vivienda nueva.
- `price_per_m2`: precio de venta dividido por área.

`department` / `department_slug` vienen directamente del scraper (no se
infieren), ya que corresponden a la zona nacional consultada.

Genera `data/processed/apartamentos_colombia_processed.csv`.
