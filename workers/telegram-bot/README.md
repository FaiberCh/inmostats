# InmoStats Telegram Bot (webhook)

Cloudflare Worker que responde comandos de Telegram leyendo archivos en
tiempo real. El estado del scraper y las estadisticas se leen del repo de
GitHub: con el secreto opcional `GITHUB_READ_TOKEN` (token de solo lectura,
ver mas abajo) por la API de GitHub, que sirve aunque el repo sea privado; sin
el secreto, por `raw.githubusercontent.com`, que solo sirve si el repo es
publico. El modelo se lee de su repositorio publico en Hugging Face.

| Comando | Responde | Fuente |
|---|---|---|
| `/status` (`/estado`) | progreso del scraper nacional | `data/raw/.checkpoint_national.json` del repo (API con token, o `raw.githubusercontent.com`) |
| `/stats` (`/promedios`) | promedios y anuncios por zona | `data/processed/stats_summary.json` del repo (API con token, o `raw.githubusercontent.com`) |
| `/variables` (`/campos`) | campos que se extraen por anuncio | texto fijo en el worker |
| `/modelo` (`/model`) | resumen del modelo: metricas de validacion cruzada, parametros clave y variables mas influyentes | `feature_config.json` de `fchaparro/inmostats-model` en Hugging Face |
| `/parar` y `/parar_confirmar` | desactivan el workflow del scraper (el primero solo pide confirmar y no cambia nada) | API de Actions de GitHub, con `GITHUB_ACTIONS_TOKEN` |
| `/reanudar` y `/reanudar_confirmar` | activan el workflow del scraper, con la misma confirmacion en dos pasos | API de Actions de GitHub, con `GITHUB_ACTIONS_TOKEN` |

Con `GITHUB_ACTIONS_TOKEN` configurado, `/status` agrega ademas una linea con el
estado del workflow (activo o desactivado). Desactivar no cancela la ejecucion
en curso: termina su tramo y guarda sus datos. Todos los comandos responden
solo al chat autorizado.

**Lanzamiento automatico del scraper.** El cron de GitHub Actions no es fiable (en
la practica sale cada 1 a 3 horas y a veces pasa mas de 4 sin salir), asi que el
cron de este Worker (`*/5 * * * *`, ver `wrangler.toml`) lanza las corridas con
`workflow_dispatch`. En cada ciclo consulta la API de GitHub y solo lanza si:

- el workflow esta activo (`/parar` lo detiene todo),
- no hay una corrida en curso o en cola,
- paso la espera desde que termino la ultima corrida: un tiempo entre 8 min 13 s y
  16 min 37 s, derivado del id de esa corrida (es el mismo en cada consulta, no se
  guarda estado),
- las ultimas 3 corridas no fallaron seguidas (si fallan, avisa una vez por Telegram
  y deja de lanzar hasta que una corrida manual termine bien),
- el recorrido no termino hace menos de 24 h (cooldown del scraper).

Como el cron corre cada 5 minutos, la espera real queda entre 8 min 13 s y unos
21 min 37 s. Necesita `GITHUB_ACTIONS_TOKEN` con permiso de escritura en Actions.
`scrape.yml` conserva su propio cron como respaldo.

**Resumen diario.** Un segundo cron (`0 13 * * *`, las 8:00 a. m. en Colombia) manda
al chat autorizado el avance de las ultimas 24 h: porcentaje nacional ahora y hace
24 h, paginas ganadas, zonas completadas, corridas del scraper (bien y con fallo) y
cuantos dias faltan al ritmo actual. El checkpoint de hace 24 h se lee del historial
de git. `/resumen` lo pide en cualquier momento.

`/modelo` muestra la ultima version publicada en el repositorio de modelo
`fchaparro/inmostats-model` (la misma que descarga el Space al construirse),
no el archivo local. Si ese `feature_config.json` es anterior a que el
entrenamiento guardara `hyperparameters` y `top_features`, el bot lo indica
en vez de fallar. Para actualizarlo despues de reentrenar, se suben los dos
archivos a ese repositorio (por ejemplo con `huggingface_hub.HfApi.upload_file`)
y, para que el Space reconstruya con el modelo nuevo, se cambia el texto del
`RUN` del Dockerfile de la rama `space-deploy`.

## Deploy

```bash
cd workers/telegram-bot
npx wrangler deploy
```

Requiere tener configurado `CLOUDFLARE_API_TOKEN` en el entorno (o haber
corrido `npx wrangler login` de forma interactiva antes).

## Secrets del Worker

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put AUTHORIZED_CHAT_ID
npx wrangler secret put GITHUB_READ_TOKEN
npx wrangler secret put GITHUB_ACTIONS_TOKEN
```

- `TELEGRAM_BOT_TOKEN`: el mismo token del bot usado en el scraper.
- `TELEGRAM_WEBHOOK_SECRET`: un string aleatorio que tu eliges (ej. generado
  con `openssl rand -hex 32`); Telegram lo reenvia en cada request para que
  el Worker pueda verificar que la peticion es autentica.
- `AUTHORIZED_CHAT_ID`: tu chat_id de Telegram; el bot ignora mensajes de
  cualquier otro chat.
- `GITHUB_READ_TOKEN` (opcional mientras el repo sea publico, necesario si es
  privado): token de GitHub de grano fino, limitado al repo `inmostats` y con
  un solo permiso, **Contents: Read-only**. Se crea en Settings, Developer
  settings, Personal access tokens, Fine-grained tokens. Caduca (maximo 1 ano),
  asi que hay que renovarlo y volver a ejecutar `wrangler secret put`.
- `GITHUB_ACTIONS_TOKEN` (opcional; sin el, el bot sigue siendo de solo
  lectura y `/parar` y `/reanudar` avisan que no tienen permiso): otro token de
  grano fino, tambien limitado al repo `inmostats`, con el permiso **Actions:
  Read and write** (Metadata queda en solo lectura). No sirve para leer ni
  modificar codigo o datos del repo, pero si para activar, desactivar y lanzar
  workflows, asi que se mantiene separado del token de lectura. Caduca y hay
  que renovarlo igual.

## Registrar el webhook en Telegram

Despues del deploy, wrangler imprime la URL del Worker
(`https://inmostats-telegram-bot.<tu-subdominio>.workers.dev`). Con esa URL:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Deberia responder `{"ok":true,"result":true,...}`. A partir de ahi, escribir
`/status` (o `/estado`) al bot responde al instante.
