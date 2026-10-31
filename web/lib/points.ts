// Todos los anuncios en formato columnar: lo genera src/pipelines/export_dashboard_data.py
// (points.json describe las columnas y los diccionarios; points.bin trae los datos).

export type PointsMeta = {
  n: number;
  price_unit: number;
  has_expected: boolean;
  captured_to: string;
  columns: { name: string; type: string; offset: number }[];
  departments: string[];
  cities: [string, number][];
  neighborhoods: string[];
  amenities: string[];
};

export type Points = {
  meta: PointsMeta;
  n: number;
  id: Uint32Array;
  area: Float32Array;
  /** En miles de COP (meta.price_unit). */
  price: Uint32Array;
  /** Precio esperado por el modelo fuera de muestra, en miles de COP; 0 si se desconoce. */
  expected: Uint32Array;
  dept: Uint8Array;
  city: Uint16Array;
  /** 0 = sin barrio; si no, indice + 1 en meta.neighborhoods. */
  hood: Uint16Array;
  beds: Uint8Array;
  baths: Uint8Array;
  /** 0 = sin dato. */
  stratum: Uint8Array;
  /** Un bit por amenidad de meta.amenities. */
  amen: Uint16Array;
};

const ARRAY_TYPES = {
  uint32: Uint32Array,
  float32: Float32Array,
  uint16: Uint16Array,
  uint8: Uint8Array,
} as const;

let cached: Promise<Points> | null = null;

export function loadPoints(): Promise<Points> {
  cached ??= (async () => {
    const [metaRes, binRes] = await Promise.all([fetch("/data/points.json"), fetch("/data/points.bin.gz")]);
    if (!metaRes.ok || !binRes.ok || !binRes.body) throw new Error("No se pudieron cargar los anuncios");
    const meta = (await metaRes.json()) as PointsMeta;
    // El binario viaja comprimido (1,1 MB en vez de 2,1 MB) y se descomprime en el navegador.
    const buffer = await new Response(binRes.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const columns: Record<string, ArrayLike<number>> = {};
    for (const column of meta.columns) {
      const Type = ARRAY_TYPES[column.type as keyof typeof ARRAY_TYPES];
      columns[column.name] = new Type(buffer, column.offset, meta.n);
    }
    return { meta, n: meta.n, ...columns } as unknown as Points;
  })().catch((error) => {
    cached = null; // permite reintentar
    throw error;
  });
  return cached;
}

export type LinkStatus = "alive" | "dead" | "unknown";

/** Pregunta al servidor si el anuncio sigue publicado (el navegador no puede consultar Fincaraiz por CORS). */
export async function checkListing(url: string): Promise<LinkStatus> {
  try {
    const response = await fetch(`/api/listing-status?path=${encodeURIComponent(new URL(url).pathname)}`);
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { status?: LinkStatus };
    return body.status === "alive" || body.status === "dead" ? body.status : "unknown";
  } catch {
    return "unknown";
  }
}

const SITE_BASE = "https://www.fincaraiz.com.co";
const URL_SHARDS = 64;
const shardCache = new Map<number, Promise<Record<string, string>>>();

/** Direccion del anuncio original; se pide solo el archivo (de 64) que contiene ese id. */
export async function listingUrl(id: number): Promise<string | null> {
  const shard = id % URL_SHARDS;
  if (!shardCache.has(shard)) {
    shardCache.set(
      shard,
      fetch(`/data/urls/${String(shard).padStart(2, "0")}.json`).then((r) => {
        if (!r.ok) throw new Error("direcciones no disponibles");
        return r.json();
      }),
    );
  }
  try {
    const path = (await shardCache.get(shard)!)[String(id)];
    return path ? SITE_BASE + path : null;
  } catch {
    shardCache.delete(shard);
    return null;
  }
}
