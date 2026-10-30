# InmoStats web

Frontend del tablero: Next.js (App Router, TypeScript) pensado para Vercel. Es una sola página con cuatro secciones
(Mercado, Estimador, Dinámica y Modelo), con tema claro y oscuro, y diseñada primero para el teléfono.

## Cómo funciona

- **El tablero no necesita servidor.** Todas las cifras, gráficos y mapas salen de JSON estáticos en `public/data/`,
  que genera `python -m src.pipelines.export_dashboard_data` desde la raíz del repo. Se leen en el build, así que el HTML
  ya trae los números.
- **Solo el estimador llama a la API** (`POST /predict`, en Hugging Face). Si el Space estaba dormido, el formulario lo
  detecta, avisa que está despertando, sondea `/health` y reintenta solo. Además, al abrir la página se hace un
  `/health` en segundo plano para despertarlo mientras se lee.
- Los gráficos son SVG propios y el mapa usa `d3-geo` sin teselas: pesa poco y funciona sin servicios externos.

## Desarrollo

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
npm run lint
```

Variable opcional: `NEXT_PUBLIC_API_URL` (por defecto `https://fchaparro-inmostats-api.hf.space`).

## Actualizar los datos

```bash
python -m src.pipelines.export_dashboard_data      # desde la raíz; --skip-dynamics omite la dinámica
git add web/public/data && git commit
```

## Desplegar en Vercel

1. Importar el repo `FaiberCh/inmostats` en Vercel.
2. **Root Directory:** `web`. Framework: Next.js (se detecta solo).
3. Cada push a `master` redespliega con los JSON que haya en `public/data/`.

La API necesita CORS para aceptar llamadas desde el navegador (`CORSMiddleware` en `src/api/main.py`), así que hay que
redesplegar el Space después de ese cambio (`bash scripts/deploy_space.sh`).
