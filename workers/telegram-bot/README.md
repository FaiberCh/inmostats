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

## Registrar el webhook en Telegram

Despues del deploy, wrangler imprime la URL del Worker
(`https://inmostats-telegram-bot.<tu-subdominio>.workers.dev`). Con esa URL:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Deberia responder `{"ok":true,"result":true,...}`. A partir de ahi, escribir
`/status` (o `/estado`) al bot responde al instante.
