import { NextResponse } from "next/server";

// Comprueba si un anuncio de Fincaraiz sigue publicado. Lo hace el servidor porque el navegador no puede
// consultar otro sitio (CORS). Se llama solo cuando alguien fija una tarjeta, y el resultado se guarda
// en cache, asi que el trafico hacia Fincaraiz es minimo.
export const runtime = "nodejs";

const BASE = "https://www.fincaraiz.com.co";
// Ruta de un anuncio: minusculas, digitos y guiones, terminada en el id. No se acepta nada mas: asi el
// endpoint no puede usarse para consultar otras direcciones.
const PATH_PATTERN = /^\/[a-z0-9\-_/]{3,200}\/\d{4,12}$/;
const USER_AGENT = "Mozilla/5.0 (compatible; InmoStatsLinkCheck/1.0; +https://github.com/FaiberCh/inmostats)";
const TIMEOUT_MS = 8000;
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000;

type Status = "alive" | "dead" | "unknown";
const memory = new Map<string, { status: Status; at: number }>();

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!PATH_PATTERN.test(path)) {
    return NextResponse.json({ error: "Ruta no valida" }, { status: 400 });
  }

  const cached = memory.get(path);
  if (cached && Date.now() - cached.at < MEMORY_TTL_MS) return reply(cached.status);

  let status: Status = "unknown";
  try {
    // redirect: "manual": un anuncio retirado responde 301/302 hacia la lista general, y eso cuenta como roto.
    const response = await fetch(BASE + path, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    void response.body?.cancel(); // solo importa el codigo de respuesta, no la pagina
    if (response.status === 200) status = "alive";
    else if (response.status === 404 || response.status === 410 || (response.status >= 300 && response.status < 400)) status = "dead";
  } catch {
    status = "unknown"; // sin respuesta no se afirma nada y no se guarda en cache
  }

  if (status !== "unknown") memory.set(path, { status, at: Date.now() });
  return reply(status);
}

function reply(status: Status) {
  return NextResponse.json(
    { status },
    // El CDN lo guarda un dia; "unknown" no se guarda para poder reintentar.
    { headers: { "Cache-Control": status === "unknown" ? "no-store" : "public, s-maxage=86400, stale-while-revalidate=604800" } },
  );
}
