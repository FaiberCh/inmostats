# InmoStats web

Frontend del tablero: Next.js (App Router, TypeScript) pensado para Vercel. Es una sola página con cinco secciones
(Mercado, Oportunidades, Estimador, Dinámica y Modelo), con tema claro y oscuro, y diseñada primero para el teléfono.

## Cómo funciona

- **El tablero no necesita servidor.** Todas las cifras, gráficos y mapas salen de archivos estáticos en `public/data/`,
  que genera `python -m src.pipelines.export_dashboard_data` desde la raíz del repo. Se leen en el build, así que el HTML
  ya trae los números de la vista sin filtros.
- **Filtros globales** (departamento, ciudad, rango de precio, habitaciones y área) en una barra fija; en el teléfono se
  pliegan en un botón "Filtros" que abre una hoja. Afectan a las cifras, el mapa, los gráficos y el gráfico de
  oportunidades. Para eso el navegador descarga todos los anuncios (`points.bin.gz`, 1,1 MB) y calcula los agregados
  localmente; las medianas se calculan igual que en el exportador, así que sin filtros las dos vistas coinciden.
- **Oportunidades de mercado:** gráfico de dispersión en canvas (área contra precio) con la mediana por m² como línea.
  Cada anuncio se compara con esa mediana o con el **precio que esperaba el modelo**, calculado fuera de muestra
  (validación cruzada de 5 particiones) para que el modelo no "recuerde" el precio de un anuncio que vio al entrenar.
  Los valores extremos (menos de un tercio o más del triple de la referencia) se tratan como probables errores y no
  entran en las listas. Al pasar el cursor (o tocar) sale una tarjeta con el detalle; al fijarla aparece el enlace al
  anuncio original, cuya dirección se pide a uno de 64 archivos pequeños (`urls/NN.json`). Como más de la mitad de los
  enlaces guardados ya no existe, el botón solo se habilita si el anuncio sigue publicado: lo comprueba
  `/api/listing-status` (ruta de servidor de Next que consulta a Fincaraíz solo al fijar una tarjeta, con un agente de
  usuario honesto y el resultado en caché un día).
- **Precio según quién anuncia:** tarjeta en Mercado que compara el precio por m² de empresas, asesores independientes,
  propietarios directos y desarrolladores. El grupo se deduce del nombre del anunciante con una heurística
  (`src/pipelines/owner_groups.py`) y al navegador solo llega la categoría, nunca el nombre. Las medianas responden a los
  filtros; la diferencia "a igualdad de condiciones" (ciudad, estrato, área y habitaciones) es nacional y sale de
  `owner_groups.json`.
- **Solo el estimador llama a la API** (`POST /predict`, en Hugging Face). Si el Space estaba dormido, el formulario lo
  detecta, avisa que está despertando, sondea `/health` y reintenta solo. Además, al abrir la página se hace un
  `/health` en segundo plano para despertarlo mientras se lee.
- Los gráficos son SVG propios (o canvas para el de dispersión) y el mapa usa `d3-geo` sin teselas: pesa poco y
  funciona sin servicios externos.

## Desarrollo

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
npm run lint
```

Variable opcional: `NEXT_PUBLIC_API_URL` (por defecto `https://fchaparro-inmostats-api.hf.space`).

Si el CSS no refleja un cambio después de compilar, borra `web/.next` y vuelve a compilar.

## Actualizar los datos

```bash
python -m src.pipelines.export_dashboard_data      # desde la raíz
git add web/public/data && git commit
```

Opciones: `--skip-dynamics` (omite la dinámica, ~20 s), `--skip-points` (omite los anuncios y las direcciones),
`--skip-expected` (puntos sin precio esperado del modelo) y `--refresh-expected` (recalcula el precio esperado aunque haya
caché). El precio esperado tarda unos 30 s y se guarda en `data/processed/oof_expected_price.csv` (no se versiona).

## Desplegar en Vercel

1. Importar el repo `FaiberCh/inmostats` en Vercel.
2. **Root Directory:** `web`. Framework: Next.js (se detecta solo).
3. Cada push a `master` redespliega con los archivos que haya en `public/data/`.

La API necesita CORS para aceptar llamadas desde el navegador (`CORSMiddleware` en `src/api/main.py`), así que hay que
redesplegar el Space después de ese cambio (`bash scripts/deploy_space.sh`).
