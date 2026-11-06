// Comparaciones del precio entre grupos (estrato, departamento, ciudad, barrio, habitaciones, anunciante)
// calculadas en el navegador sobre los anuncios que dejan pasar los filtros.
import type { Points } from "./points";
import { quantileSorted, type Filters } from "./stats";

export type DimKey = "stratum" | "dept" | "city" | "hood" | "beds" | "owner";
export type Unit = "m2" | "total";

export const DIMENSIONS: { key: DimKey; label: string }[] = [
  { key: "stratum", label: "Estrato" },
  { key: "dept", label: "Departamento" },
  { key: "city", label: "Ciudad" },
  { key: "hood", label: "Barrio" },
  { key: "beds", label: "Habitaciones" },
  { key: "owner", label: "Anunciante" },
];

export const dimLabel = (key: DimKey) => DIMENSIONS.find((d) => d.key === key)!.label;

/** Los barrios se identifican por barrio y ciudad a la vez (hay barrios con el mismo nombre en ciudades distintas). */
const HOOD_BASE = 8192;

/** Clave del grupo al que pertenece el anuncio i, o -1 si no tiene el dato. */
export function keyOf(p: Points, dim: DimKey, i: number): number {
  switch (dim) {
    case "stratum": {
      const s = p.stratum[i];
      return s >= 1 && s <= 6 ? s : -1;
    }
    case "dept":
      return p.dept[i];
    case "city":
      return p.city[i];
    case "hood":
      return p.hood[i] === 0 ? -1 : p.hood[i] * HOOD_BASE + p.city[i];
    case "beds":
      return p.beds[i] < 1 ? -1 : Math.min(p.beds[i], 5);
    case "owner":
      return p.owner[i] >= 1 ? p.owner[i] : -1;
  }
}

export function labelOf(p: Points, dim: DimKey, key: number): string {
  switch (dim) {
    case "stratum":
      return `Estrato ${key}`;
    case "dept":
      return p.meta.departments[key];
    case "city":
      return p.meta.cities[key][0];
    case "hood": {
      const hood = Math.floor(key / HOOD_BASE);
      const city = key % HOOD_BASE;
      return `${p.meta.neighborhoods[hood - 1]}, ${p.meta.cities[city][0]}`;
    }
    case "beds":
      return key === 5 ? "5 o más hab." : `${key} hab.`;
    case "owner":
      return p.meta.owner_groups[key];
  }
}

/** Quita de los filtros el que corresponde a esta dimension (cada grafico se muestra sin su propio filtro). */
export function withoutDim(f: Filters, dim: DimKey): Filters {
  switch (dim) {
    case "stratum":
      return { ...f, stratum: [] };
    case "dept":
      return { ...f, dept: null, city: null, hood: null };
    case "city":
      return { ...f, city: null, hood: null };
    case "hood":
      return { ...f, hood: null };
    case "beds":
      return { ...f, beds: [] };
    case "owner":
      return { ...f, owner: [] };
  }
}

export function isSelected(f: Filters, dim: DimKey, key: number): boolean {
  switch (dim) {
    case "stratum":
      return f.stratum.includes(key);
    case "dept":
      return f.dept === key;
    case "city":
      return f.city === key;
    case "hood":
      return f.hood === Math.floor(key / HOOD_BASE) && f.city === key % HOOD_BASE;
    case "beds":
      return f.beds.includes(key);
    case "owner":
      return f.owner.includes(key);
  }
}

export function hasSelection(f: Filters, dim: DimKey): boolean {
  switch (dim) {
    case "stratum":
      return f.stratum.length > 0;
    case "dept":
      return f.dept !== null;
    case "city":
      return f.city !== null;
    case "hood":
      return f.hood !== null;
    case "beds":
      return f.beds.length > 0;
    case "owner":
      return f.owner.length > 0;
  }
}

const toggleIn = (list: number[], key: number) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key]);

/** Filtros resultantes de tocar un grupo: lo elige si no estaba y lo quita si ya estaba. */
export function toggleGroup(p: Points, f: Filters, dim: DimKey, key: number): Filters {
  switch (dim) {
    case "stratum":
      return { ...f, stratum: toggleIn(f.stratum, key) };
    case "dept":
      return f.dept === key ? { ...f, dept: null, city: null, hood: null } : { ...f, dept: key, city: null, hood: null };
    case "city":
      return f.city === key ? { ...f, city: null, hood: null } : { ...f, city: key, dept: p.meta.cities[key][1], hood: null };
    case "hood": {
      const hood = Math.floor(key / HOOD_BASE);
      const city = key % HOOD_BASE;
      return isSelected(f, dim, key) ? { ...f, hood: null } : { ...f, hood, city, dept: p.meta.cities[city][1] };
    }
    case "beds":
      return { ...f, beds: toggleIn(f.beds, key) };
    case "owner":
      return { ...f, owner: toggleIn(f.owner, key) };
  }
}

/** Deja elegido solo este grupo de la dimension (reemplaza lo que hubiera elegido en ella). */
export function selectOnly(p: Points, f: Filters, dim: DimKey, key: number): Filters {
  switch (dim) {
    case "stratum":
      return { ...f, stratum: [key] };
    case "beds":
      return { ...f, beds: [key] };
    case "owner":
      return { ...f, owner: [key] };
    default:
      return isSelected(f, dim, key) ? f : toggleGroup(p, f, dim, key);
  }
}

export type Group = { key: number; label: string; n: number; q1: number; median: number; q3: number; mean: number };

/** Valor del anuncio i en la unidad elegida (pesos), o NaN si no se puede calcular. */
function valueOf(p: Points, unit: Unit, i: number): number {
  const price = p.price[i] * p.meta.price_unit;
  if (unit === "total") return price;
  return p.area[i] > 0 ? price / p.area[i] : NaN;
}

function summarize(values: number[]): Omit<Group, "key" | "label"> {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    q1: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    q3: quantileSorted(sorted, 0.75),
    mean: sum / sorted.length,
  };
}

/** Cuartiles, mediana y promedio del precio de cada grupo de la dimension. */
export function groupStats(p: Points, rows: Uint32Array, dim: DimKey, unit: Unit): Group[] {
  const buckets = new Map<number, number[]>();
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    const key = keyOf(p, dim, i);
    if (key < 0) continue;
    const v = valueOf(p, unit, i);
    if (!Number.isFinite(v)) continue;
    const list = buckets.get(key);
    if (list) list.push(v);
    else buckets.set(key, [v]);
  }
  return [...buckets].map(([key, values]) => ({ key, label: labelOf(p, dim, key), ...summarize(values) }));
}

export type Cell = { n: number; median: number; mean: number };

/** Mediana y promedio del precio en cada cruce de dos dimensiones, indexado por "filaKey|columnaKey". */
export function crossStats(p: Points, rows: Uint32Array, dimRow: DimKey, dimCol: DimKey, unit: Unit): Map<string, Cell> {
  const buckets = new Map<string, number[]>();
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    const kr = keyOf(p, dimRow, i);
    const kc = keyOf(p, dimCol, i);
    if (kr < 0 || kc < 0) continue;
    const v = valueOf(p, unit, i);
    if (!Number.isFinite(v)) continue;
    const id = `${kr}|${kc}`;
    const list = buckets.get(id);
    if (list) list.push(v);
    else buckets.set(id, [v]);
  }
  const out = new Map<string, Cell>();
  for (const [id, values] of buckets) {
    const s = summarize(values);
    out.set(id, { n: s.n, median: s.median, mean: s.mean });
  }
  return out;
}
