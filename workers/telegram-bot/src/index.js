/**
 * Webhook de Telegram para InmoStats.
 *
 * Responde a /status con el progreso actual del scraper nacional, leyendo
 * el checkpoint directamente del repo publico en GitHub (sin token, sin
 * llamar a la API de GitHub) para mantenerlo simple y sin credenciales
 * extra en este worker.
 */

const CHECKPOINT_URL =
  "https://raw.githubusercontent.com/FaiberCh/inmostats/master/data/raw/.checkpoint_national.json";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("InmoStats Telegram webhook activo.");
    }

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    const message = update.message;
    if (!message || !message.text) {
      return new Response("OK");
    }

    const chatId = String(message.chat.id);
    if (chatId !== env.AUTHORIZED_CHAT_ID) {
      // No respondemos a nadie que no sea el chat autorizado.
      return new Response("OK");
    }

    const text = message.text.trim().toLowerCase();

    if (text === "/start") {
      await sendTelegramMessage(
        env,
        chatId,
        "👋 Hola, soy el bot de <b>InmoStats</b>. Escribe /status para ver el progreso del scraping nacional."
      );
    } else if (text === "/status" || text === "/estado") {
      const reply = await buildStatusMessage();
      await sendTelegramMessage(env, chatId, reply);
    }

    return new Response("OK");
  },
};

async function buildStatusMessage() {
  const divider = "━".repeat(21);

  let checkpoint;
  try {
    const res = await fetch(CHECKPOINT_URL, { cf: { cacheTtl: 0 } });
    if (!res.ok) {
      return "⚠️ Todavia no hay ninguna corrida registrada (checkpoint no encontrado).";
    }
    checkpoint = await res.json();
  } catch {
    return "⚠️ No pude leer el estado del scraper ahora mismo. Intenta de nuevo en un momento.";
  }

  const departments = Object.values(checkpoint.departments);
  const doneCount = departments.filter((d) => d.done).length;
  const total = departments.length;

  if (checkpoint.done) {
    const finishedAt = new Date(checkpoint.finished_at);
    const hoursSince = (Date.now() - finishedAt.getTime()) / 3600000;
    const hoursLeft = Math.max(0, 24 - hoursSince);
    const cooldownLine =
      hoursLeft > 0
        ? `😴 Cooldown: ${hoursLeft.toFixed(1)}h restantes antes de la proxima corrida`
        : "🔁 Cooldown terminado, deberia arrancar una corrida nueva pronto";

    return (
      `🎉 <b>InmoStats</b> — ultima corrida nacional: completa\n${divider}\n` +
      `✅ ${doneCount}/${total} zonas cubiertas\n` +
      `${cooldownLine}\n${divider}`
    );
  }

  const current = departments.find((d) => !d.done);
  let zonaLinea = "";
  if (current && current.last_page) {
    const pagesDone = current.next_page - 1;
    zonaLinea = `📍 Zona actual: <b>${current.name}</b> (pag. ${pagesDone}/${current.last_page})\n`;
  } else if (current) {
    zonaLinea = `📍 Zona actual: <b>${current.name}</b>\n`;
  }

  const filled = total ? Math.round((doneCount / total) * 10) : 0;
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);

  return (
    `🏗️ <b>InmoStats</b> — Scraping en progreso\n${divider}\n` +
    zonaLinea +
    `📊 Zonas completadas: ${bar} ${doneCount}/${total}\n${divider}\n` +
    `🔁 El checkpoint se actualiza cada ~30 min via GitHub Actions`
  );
}

export { buildStatusMessage };

async function sendTelegramMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}
