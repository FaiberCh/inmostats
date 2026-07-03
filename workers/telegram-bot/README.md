# InmoStats Telegram Bot (webhook)

Cloudflare Worker que responde a `/status` con el progreso actual del
scraper nacional, leyendo el checkpoint publico del repo en tiempo real.
No requiere token de GitHub: lee `data/raw/.checkpoint_national.json` via
`raw.githubusercontent.com` (el repo es publico).

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
```

- `TELEGRAM_BOT_TOKEN`: el mismo token del bot usado en el scraper.
- `TELEGRAM_WEBHOOK_SECRET`: un string aleatorio que tu eliges (ej. generado
  con `openssl rand -hex 32`); Telegram lo reenvia en cada request para que
  el Worker pueda verificar que la peticion es autentica.
- `AUTHORIZED_CHAT_ID`: tu chat_id de Telegram; el bot ignora mensajes de
  cualquier otro chat.

## Registrar el webhook en Telegram

Despues del deploy, wrangler imprime la URL del Worker
(`https://inmostats-telegram-bot.<tu-subdominio>.workers.dev`). Con esa URL:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Deberia responder `{"ok":true,"result":true,...}`. A partir de ahi, escribir
`/status` (o `/estado`) al bot responde al instante.
