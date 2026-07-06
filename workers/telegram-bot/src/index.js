/**
 * Webhook de Telegram para InmoStats.
 *
 * Responde a /status, /stats y /variables leyendo archivos publicos del
 * repo directamente desde raw.githubusercontent.com (sin token, sin llamar
 * a la API de GitHub) para mantenerlo simple y sin credenciales extra en
 * este worker.
 */

const CHECKPOINT_URL =
  "https://raw.githubusercontent.com/FaiberCh/inmostats/master/data/raw/.checkpoint_national.json";
const STATS_URL =
  "https://raw.githubusercontent.com/FaiberCh/inmostats/master/data/processed/stats_summary.json";

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

    if (text === "/start" || text === "/help" || text === "/ayuda") {
      await sendTelegramMessage(
        env,
        chatId,
        "👋 Hola, soy el bot de <b>InmoStats</b>.\n\n" +
          "/status — progreso del scraping nacional\n" +
          "/stats — promedios y anuncios por zona\n" +
          "/variables — que campos se estan extrayendo"
      );
    } else if (text === "/status" || text === "/estado") {
      await sendTelegramMessage(env, chatId, await buildStatusMessage());
    } else if (text === "/stats" || text === "/promedios") {
      await sendTelegramMessage(env, chatId, await buildStatsMessage());
    } else if (text === "/variables" || text === "/campos") {
      await sendTelegramMessage(env, chatId, buildVariablesMessage());
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
    const duration = formatDuration(checkpoint.started_at, checkpoint.finished_at);

    return (
      `🎉 <b>InmoStats</b> — ultima corrida nacional: completa\n${divider}\n` +
      `✅ ${doneCount}/${total} zonas cubiertas\n` +
      `⏱ Tiempo total: ${duration}\n` +
      `${cooldownLine}\n${divider}`
    );
  }

  const current = departments.find((d) => !d.done);
  let zonaLinea = "";
  if (current && current.last_page) {
    const pagesDone = current.next_page - 1;
    const pct = Math.round((pagesDone / current.last_page) * 100);
    zonaLinea = `📍 Zona actual: <b>${current.name}</b> (pag. ${pagesDone}/${current.last_page} — ${pct}%)\n`;
  } else if (current) {
    zonaLinea = `📍 Zona actual: <b>${current.name}</b> (aun sin iniciar, calculando total de paginas...)\n`;
  }

  const zonesPct = total ? Math.round((doneCount / total) * 100) : 0;
  const filled = total ? Math.round((doneCount / total) * 10) : 0;
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);

  // Progreso nacional por paginas (mas representativo que el conteo de
  // zonas, ya que algunas zonas son muchisimo mas grandes que otras).
  // Solo cuenta zonas cuyo total de paginas ya se conoce (las que no han
  // arrancado, como "resto-de-colombia" antes de su primera pagina, quedan
  // fuera del calculo hasta que se sepa su tamano real).
  const known = departments.filter((d) => d.last_page);
  const totalPages = known.reduce((sum, d) => sum + d.last_page, 0);
  const donePages = known.reduce(
    (sum, d) => sum + (d.done ? d.last_page : d.next_page - 1),
    0
  );
  const notStarted = departments.filter((d) => !d.done && !d.last_page).length;
  const nationalPct = totalPages ? Math.round((donePages / totalPages) * 100) : 0;
  const nationalNote = notStarted
    ? ` (sin contar ${notStarted} zona${notStarted > 1 ? "s" : ""} aun sin iniciar)`
    : "";

  return (
    `🏗️ <b>InmoStats</b> — Scraping en progreso\n${divider}\n` +
    zonaLinea +
    `📊 Zonas completadas: ${bar} ${doneCount}/${total} (${zonesPct}%)\n` +
    `📈 Avance nacional por paginas: ${nationalPct}%${nationalNote}\n${divider}\n` +
    `🔁 El checkpoint se actualiza cada ~30 min via GitHub Actions`
  );
}

function formatCOP(amount) {
  if (amount === null || amount === undefined) return "N/D";
  return "$" + Math.round(amount).toLocaleString("es-CO");
}

function formatDuration(startIso, endIso) {
  const totalSeconds = Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

async function buildStatsMessage() {
  const divider = "━".repeat(21);

  let stats;
  try {
    const res = await fetch(STATS_URL, { cf: { cacheTtl: 0 } });
    if (!res.ok) {
      return "⚠️ Todavia no hay estadisticas calculadas (se generan despues de la primera corrida).";
    }
    stats = await res.json();
  } catch {
    return "⚠️ No pude leer las estadisticas ahora mismo. Intenta de nuevo en un momento.";
  }

  const byDept = Object.entries(stats.by_department || {})
    .map(([name, d]) => `  • ${name}: ${d.listings.toLocaleString("es-CO")} (${formatCOP(d.avg_price_cop)})`)
    .join("\n");

  return (
    `📈 <b>InmoStats</b> — Estadisticas del dataset\n${divider}\n` +
    `🏠 Total anuncios: ${stats.total_listings.toLocaleString("es-CO")}\n` +
    `🗺 Zonas con datos: ${stats.zones_with_data}\n` +
    `💰 Precio promedio: ${formatCOP(stats.avg_price_cop)}\n` +
    `📐 Precio/m² promedio: ${formatCOP(stats.avg_price_per_m2)}\n` +
    `📏 Area promedio: ${stats.avg_area_m2 ?? "N/D"} m²\n` +
    `🛏 Habitaciones promedio: ${stats.avg_bedrooms ?? "N/D"}\n` +
    `🚿 Baños promedio: ${stats.avg_bathrooms ?? "N/D"}\n` +
    `🏷 Estrato promedio: ${stats.avg_stratum ?? "N/D"}\n` +
    `${divider}\n` +
    `Anuncios y precio promedio por zona:\n${byDept}\n` +
    `${divider}\n` +
    `🕒 Calculado: ${new Date(stats.generated_at).toLocaleString("es-CO", { timeZone: "America/Bogota" })}`
  );
}

function buildVariablesMessage() {
  const divider = "━".repeat(21);
  return (
    `🧬 <b>InmoStats</b> — Variables extraidas por anuncio\n${divider}\n` +
    `<b>Identificacion</b>\n` +
    `listing_id, title, description, address, detail_url\n\n` +
    `<b>Ubicacion</b>\n` +
    `department, city, neighborhood, locality, zone, latitude, longitude\n\n` +
    `<b>Precio</b>\n` +
    `price_cop, admin_fee_cop, price_per_m2 (calculado)\n\n` +
    `<b>Caracteristicas</b>\n` +
    `bedrooms, bathrooms, area_m2, area_built_m2, stratum, floor, floors_count, antiquity, construction_year, garages, amenities\n\n` +
    `<b>Metadata del anuncio</b>\n` +
    `is_new_project, owner_type, owner_name, image_count, main_image_url, listing_created_at, listing_updated_at\n` +
    `${divider}\n` +
    `Se extraen del JSON estructurado que la pagina de fincaraiz embebe, no de texto libre.`
  );
}

export { buildStatusMessage, buildStatsMessage, buildVariablesMessage };

async function sendTelegramMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}
