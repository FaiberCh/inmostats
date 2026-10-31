/**
 * Webhook de Telegram para InmoStats.
 *
 * Responde a /status, /stats, /variables y /modelo. El estado del scraper y
 * las estadisticas se leen del repositorio de GitHub: con el secreto
 * GITHUB_READ_TOKEN (token de solo lectura) por la API de GitHub, que sirve
 * tambien si el repositorio es privado; sin ese secreto, por
 * raw.githubusercontent.com, que solo sirve si es publico. La configuracion
 * del modelo se lee de su repositorio publico en Hugging Face.
 */

const REPO = "FaiberCh/inmostats";
const CHECKPOINT_PATH = "data/raw/.checkpoint_national.json";
const STATS_PATH = "data/processed/stats_summary.json";
// feature_config.json esta gitignored en el repo; la copia vigente vive en el
// repositorio de modelo publico de Hugging Face (el mismo que descarga el Space al construirse).
const MODEL_CONFIG_URL = "https://huggingface.co/fchaparro/inmostats-model/resolve/main/feature_config.json";

/** Argumentos de fetch para leer un archivo del repo: por la API con token si hay secreto, o por la direccion publica. */
function githubFile(path, env) {
  const token = env && env.GITHUB_READ_TOKEN;
  if (token) {
    return [
      `https://api.github.com/repos/${REPO}/contents/${path}?ref=master`,
      {
        cf: { cacheTtl: 0 },
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw+json",
          "User-Agent": "inmostats-telegram-bot",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    ];
  }
  return [`https://raw.githubusercontent.com/${REPO}/master/${path}`, { cf: { cacheTtl: 0 } }];
}

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
          "/status: progreso del scraping nacional\n" +
          "/stats: promedios y anuncios por zona\n" +
          "/variables: que campos se estan extrayendo\n" +
          "/modelo: resumen del modelo, sus metricas y parametros clave"
      );
    } else if (text === "/status" || text === "/estado") {
      await sendTelegramMessage(env, chatId, await buildStatusMessage(env));
    } else if (text === "/stats" || text === "/promedios") {
      await sendTelegramMessage(env, chatId, await buildStatsMessage(env));
    } else if (text === "/variables" || text === "/campos") {
      await sendTelegramMessage(env, chatId, buildVariablesMessage());
    } else if (text === "/modelo" || text === "/model") {
      await sendTelegramMessage(env, chatId, await buildModelMessage());
    }

    return new Response("OK");
  },
};

async function buildStatusMessage(env) {
  const divider = "━".repeat(21);

  let checkpoint;
  try {
    const res = await fetch(...githubFile(CHECKPOINT_PATH, env));
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
      `🎉 <b>InmoStats</b>: ultima corrida nacional: completa\n${divider}\n` +
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
    zonaLinea = `📍 Zona actual: <b>${current.name}</b> (pag. ${pagesDone}/${current.last_page}, ${pct}%)\n`;
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
    `🏗️ <b>InmoStats</b>: scraping en progreso\n${divider}\n` +
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

async function buildStatsMessage(env) {
  const divider = "━".repeat(21);

  let stats;
  try {
    const res = await fetch(...githubFile(STATS_PATH, env));
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
    `📈 <b>InmoStats</b>: estadisticas del dataset\n${divider}\n` +
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
    `🧬 <b>InmoStats</b>: variables extraidas por anuncio\n${divider}\n` +
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

function formatDecimal(value, digits) {
  return Number(value).toFixed(digits).replace(".", ",");
}

function formatMillionsCOP(amount) {
  if (amount === null || amount === undefined) return "N/D";
  return "$" + Math.round(amount / 1e6).toLocaleString("es-CO") + " M";
}

// Nombres como "num__area_m2" o "onehot__department_final_Bogota" salen del
// ColumnTransformer; se quita el prefijo del paso para leerlos mejor.
function cleanFeatureName(name) {
  return String(name).replace(/^[a-z_]+?__/, "");
}

async function buildModelMessage() {
  const divider = "━".repeat(21);

  let config;
  try {
    const res = await fetch(MODEL_CONFIG_URL, { cf: { cacheTtl: 0 } });
    if (!res.ok) {
      return "⚠️ Todavía no hay un modelo publicado (no encontré feature_config.json en Hugging Face).";
    }
    config = await res.json();
  } catch {
    return "⚠️ No pude leer los datos del modelo ahora mismo. Intenta de nuevo en un momento.";
  }

  const cv = config.metrics_cv || {};
  const trainedAt = config.trained_at
    ? new Date(config.trained_at).toLocaleString("es-CO", { timeZone: "America/Bogota" })
    : "N/D";

  const params = config.hyperparameters;
  const paramsLines = params
    ? Object.entries(params).map(([k, v]) => `  • ${k}: ${v}`).join("\n")
    : "  (este modelo se publicó antes de guardar los parámetros)";

  const topFeatures = Array.isArray(config.top_features) && config.top_features.length
    ? config.top_features
        .slice(0, 5)
        .map(([name, importance]) => `  • ${cleanFeatureName(name)}: ${formatDecimal(importance * 100, 1)} %`)
        .join("\n")
    : "  (no disponible en esta versión del modelo)";

  const count = (key) => (Array.isArray(config[key]) ? config[key].length : 0);

  return (
    `🤖 <b>InmoStats</b>: resumen del modelo\n${divider}\n` +
    `Modelo: <b>${config.model_name ?? "N/D"}</b>, predice el precio de venta (en log) de un apartamento\n` +
    `📚 Entrenado con ${(config.n_rows ?? 0).toLocaleString("es-CO")} anuncios el ${trainedAt}\n${divider}\n` +
    `<b>Métricas (validación cruzada, 5 folds)</b>\n` +
    `🎯 MAPE: ${formatDecimal(cv["MAPE_%"], 2)} %\n` +
    `📈 R²: ${formatDecimal(cv["R2"], 4)}\n` +
    `💰 Error absoluto medio: ${formatMillionsCOP(cv["MAE_COP"])} COP\n` +
    `📏 RMSE: ${formatMillionsCOP(cv["RMSE_COP"])} COP\n${divider}\n` +
    `<b>Parámetros clave</b>\n${paramsLines}\n${divider}\n` +
    `<b>Variables más influyentes</b>\n${topFeatures}\n${divider}\n` +
    `<b>Entradas del modelo</b>\n` +
    `${count("numeric_features")} numéricas, ${count("onehot_features")} categóricas (one-hot), ` +
    `${count("target_encode_features")} de alta cardinalidad (target encoding), ` +
    `${count("amenities")} amenidades y ${count("luxury_keywords")} palabras clave de lujo\n${divider}\n` +
    `⚠️ Limitación conocida: subestima el cuartil de precio más alto (lujo) y sobreestima el más barato.`
  );
}

export { buildStatusMessage, buildStatsMessage, buildVariablesMessage, buildModelMessage };

async function sendTelegramMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}
