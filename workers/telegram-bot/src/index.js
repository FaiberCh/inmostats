/**
 * Webhook de Telegram para InmoStats.
 *
 * Responde a /status, /stats, /variables y /modelo. El estado del scraper y
 * las estadisticas se leen del repositorio de GitHub: con el secreto
 * GITHUB_READ_TOKEN (token de solo lectura) por la API de GitHub, que sirve
 * tambien si el repositorio es privado; sin ese secreto, por
 * raw.githubusercontent.com, que solo sirve si es publico. La configuracion
 * del modelo se lee de su repositorio publico en Hugging Face.
 *
 * /parar y /reanudar (cada uno con su /..._confirmar) desactivan y activan el
 * workflow del scraper por la API de GitHub. Usan un secreto aparte,
 * GITHUB_ACTIONS_TOKEN (permiso Actions de lectura y escritura sobre este
 * repo y nada mas). Sin ese secreto el bot sigue siendo de solo lectura.
 */

const REPO = "FaiberCh/inmostats";
const WORKFLOW_FILE = "scrape.yml";
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

/** Llama a la API de Actions sobre el workflow del scraper con el token de escritura. */
function workflowRequest(env, suffix = "", method = "GET", body = undefined) {
  return fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "inmostats-telegram-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// Disparo automatico del scraper. El cron de GitHub no es fiable (en la practica sale cada 1 a 3 horas
// y a veces pasa mas de 4 sin salir), asi que el cron de este Worker lanza las corridas. Tras terminar
// una corrida se espera un tiempo aleatorio entre 8 min 13 s y 16 min 37 s antes de lanzar la siguiente.
const WAIT_MIN_SECONDS = 8 * 60 + 13;
const WAIT_MAX_SECONDS = 16 * 60 + 37;
const CRON_INTERVAL_MS = 5 * 60 * 1000; // el mismo intervalo que "crons" en wrangler.toml
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILED_CONCLUSIONS = ["failure", "timed_out", "startup_failure"];

/**
 * Espera (en segundos) tras una corrida terminada. Se deriva del id de la corrida, asi es la misma en
 * cada consulta del cron y no hace falta guardar nada: sortearla en cada consulta daria casi siempre
 * el minimo.
 */
function waitSecondsForRun(runId) {
  const span = BigInt(WAIT_MAX_SECONDS - WAIT_MIN_SECONDS + 1);
  return WAIT_MIN_SECONDS + Number((BigInt(runId) * 2654435761n) % span);
}

/**
 * Decide que hacer con la lista de corridas del workflow (la mas reciente primero).
 * Devuelve { action: "dispatch" | "wait" | "running" | "failures", ... }.
 */
function decideDispatch(runs, nowMs) {
  if (runs.some((r) => r.status !== "completed")) return { action: "running" };
  if (runs.length === 0) return { action: "dispatch" };

  const last = runs[0];
  const endMs = Date.parse(last.updated_at);

  const recent = runs.slice(0, MAX_CONSECUTIVE_FAILURES);
  if (recent.length === MAX_CONSECUTIVE_FAILURES && recent.every((r) => FAILED_CONCLUSIONS.includes(r.conclusion))) {
    // Se avisa una sola vez: solo en la consulta del cron que sigue al ultimo fallo.
    return { action: "failures", notify: nowMs - endMs < CRON_INTERVAL_MS, runId: last.id };
  }

  const waitMs = waitSecondsForRun(last.id) * 1000;
  if (nowMs - endMs < waitMs) return { action: "wait", remainingMs: waitMs - (nowMs - endMs) };
  return { action: "dispatch" };
}

/** Un ciclo del cron: consulta GitHub y lanza el scraper si toca. Devuelve un texto con lo que hizo. */
async function runAutoDispatch(env, nowMs = Date.now()) {
  if (!env.GITHUB_ACTIONS_TOKEN) return "sin token de Actions";

  const state = await getWorkflowState(env);
  if (state !== "active") return `workflow no activo (${state})`;

  const res = await workflowRequest(env, "/runs?per_page=10");
  if (!res.ok) return `no pude leer las corridas (${res.status})`;
  const runs = (await res.json()).workflow_runs || [];

  const decision = decideDispatch(runs, nowMs);
  if (decision.action === "running") return "hay una corrida en curso";
  if (decision.action === "wait") return `esperando (${Math.round(decision.remainingMs / 1000)} s)`;
  if (decision.action === "failures") {
    if (decision.notify) {
      await sendTelegramMessage(
        env,
        env.AUTHORIZED_CHAT_ID,
        `🚨 <b>InmoStats</b>: las ultimas ${MAX_CONSECUTIVE_FAILURES} corridas fallaron y el bot dejo de lanzar nuevas.\n` +
          `Revisa: https://github.com/${REPO}/actions/runs/${decision.runId}\n` +
          "Cuando lo arregles, lanza una corrida manual; si termina bien, el bot sigue solo."
      );
    }
    return "detenido por fallos seguidos";
  }

  // Si el recorrido ya termino, el scraper respeta 24 h de cooldown: no tiene sentido lanzarlo antes.
  try {
    const cp = await fetch(...githubFile(CHECKPOINT_PATH, env));
    if (cp.ok) {
      const checkpoint = await cp.json();
      if (checkpoint.done && checkpoint.finished_at && nowMs - Date.parse(checkpoint.finished_at) < 24 * 3600 * 1000) {
        return "recorrido completo, en cooldown";
      }
    }
  } catch {
    // Sin checkpoint legible se lanza igual: el scraper decide por su cuenta.
  }

  const dispatch = await workflowRequest(env, "/dispatches", "POST", { ref: "master" });
  if (dispatch.status === 204) return "corrida lanzada";
  await sendTelegramMessage(
    env,
    env.AUTHORIZED_CHAT_ID,
    `⚠️ <b>InmoStats</b>: el bot no pudo lanzar el scraper (GitHub respondio ${dispatch.status}).`
  );
  return `error al lanzar (${dispatch.status})`;
}

const NO_CONTROL_MESSAGE =
  "⚠️ Este bot no tiene permiso para controlar el scraper (falta el secreto GITHUB_ACTIONS_TOKEN).";

/** "active", "disabled_manually", etc., o null si no hay token o la consulta falla. */
async function getWorkflowState(env) {
  if (!env || !env.GITHUB_ACTIONS_TOKEN) return null;
  try {
    const res = await workflowRequest(env);
    if (!res.ok) return null;
    return (await res.json()).state || null;
  } catch {
    return null;
  }
}

async function workflowStatusLine(env) {
  const state = await getWorkflowState(env);
  if (!state) return "";
  return `\n⚙️ Workflow del scraper: ${state === "active" ? "activo" : "desactivado"}`;
}

async function buildStopPrompt(env) {
  if (!env.GITHUB_ACTIONS_TOKEN) return NO_CONTROL_MESSAGE;
  const state = await getWorkflowState(env);
  if (state === null) return "⚠️ No pude consultar el estado del scraper ahora mismo. Intenta de nuevo en un momento.";
  if (state !== "active") return "ℹ️ El scraper ya esta desactivado.";
  return (
    "⚠️ Vas a <b>desactivar el scraper</b>. Si hay una ejecucion en curso terminara su tramo y guardara sus datos; " +
    "despues no saldran mas.\n\nPara confirmar envia /parar_confirmar"
  );
}

async function stopScraper(env) {
  if (!env.GITHUB_ACTIONS_TOKEN) return NO_CONTROL_MESSAGE;
  try {
    const res = await workflowRequest(env, "/disable", "PUT");
    if (res.status === 204) {
      return "⏹ <b>Scraper desactivado.</b> Una ejecucion en curso terminara su tramo. Para volver a activarlo: /reanudar";
    }
    return `⚠️ GitHub rechazo la orden (codigo ${res.status}). El scraper sigue como estaba.`;
  } catch {
    return "⚠️ No pude contactar a GitHub. El scraper sigue como estaba.";
  }
}

async function buildResumePrompt(env) {
  if (!env.GITHUB_ACTIONS_TOKEN) return NO_CONTROL_MESSAGE;
  const state = await getWorkflowState(env);
  if (state === null) return "⚠️ No pude consultar el estado del scraper ahora mismo. Intenta de nuevo en un momento.";
  if (state === "active") return "ℹ️ El scraper ya esta activo.";
  return (
    "⚠️ Vas a <b>activar el scraper</b>: el bot lanzara una corrida cada ~40 min hasta completar el recorrido. " +
    "Si el recorrido anterior ya termino y paso el cooldown de 24 h, arrancara una corrida nueva.\n\n" +
    "Para confirmar envia /reanudar_confirmar"
  );
}

async function resumeScraper(env) {
  if (!env.GITHUB_ACTIONS_TOKEN) return NO_CONTROL_MESSAGE;
  try {
    const res = await workflowRequest(env, "/enable", "PUT");
    if (res.status === 204) {
      return "▶️ <b>Scraper activado.</b> La proxima ejecucion la lanzara el bot en menos de 5 minutos. Para detenerlo: /parar";
    }
    return `⚠️ GitHub rechazo la orden (codigo ${res.status}). El scraper sigue como estaba.`;
  } catch {
    return "⚠️ No pude contactar a GitHub. El scraper sigue como estaba.";
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoDispatch(env));
  },

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
          "/modelo: resumen del modelo, sus metricas y parametros clave\n" +
          "/parar: desactivar el scraper (pide confirmacion)\n" +
          "/reanudar: activar el scraper (pide confirmacion)"
      );
    } else if (text === "/status" || text === "/estado") {
      await sendTelegramMessage(env, chatId, await buildStatusMessage(env));
    } else if (text === "/stats" || text === "/promedios") {
      await sendTelegramMessage(env, chatId, await buildStatsMessage(env));
    } else if (text === "/variables" || text === "/campos") {
      await sendTelegramMessage(env, chatId, buildVariablesMessage());
    } else if (text === "/modelo" || text === "/model") {
      await sendTelegramMessage(env, chatId, await buildModelMessage());
    } else if (text === "/parar" || text === "/stop") {
      await sendTelegramMessage(env, chatId, await buildStopPrompt(env));
    } else if (text === "/parar_confirmar") {
      await sendTelegramMessage(env, chatId, await stopScraper(env));
    } else if (text === "/reanudar" || text === "/resume") {
      await sendTelegramMessage(env, chatId, await buildResumePrompt(env));
    } else if (text === "/reanudar_confirmar") {
      await sendTelegramMessage(env, chatId, await resumeScraper(env));
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

  const wfLine = await workflowStatusLine(env);
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
      `${cooldownLine}${wfLine}\n${divider}`
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
    `🔁 El checkpoint se actualiza cada ~30 min via GitHub Actions${wfLine}`
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

export {
  buildStatusMessage,
  buildStatsMessage,
  buildVariablesMessage,
  buildModelMessage,
  buildStopPrompt,
  stopScraper,
  buildResumePrompt,
  resumeScraper,
  runAutoDispatch,
  decideDispatch,
  waitSecondsForRun,
};

async function sendTelegramMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}
