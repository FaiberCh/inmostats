// Filtros y agregados calculados en el navegador sobre los puntos. Replican los del exportador de Python
// (cuantiles con interpolacion lineal como pandas, histograma como numpy) para que la vista sin filtros
// y la filtrada hablen del mismo numero.
import type { AmenityStat, CityStat, DepartmentStat, StratumBox, TopCity } from "./types";
import type { Points } from "./points";

// Los sliders de precio y area guardan su posicion (entero), no el valor: asi el control no "salta" al arrastrar.
// El extremo de cada slider significa "sin limite": el precio llega a 3.000 M y el area a 300 m2.
export const PRICE_STEPS = 100;
export const AREA_STEPS = 57;
const PRICE_FLOOR = 50e6;
const PRICE_CEIL = 3000e6;
const AREA_FLOOR = 15;
const AREA_STEP = 5;

/** Precio (COP) de una posicion del slider: escala logaritmica de 50 M a 3.000 M, redondeado a una cifra legible. */
export function priceAt(pos: number): number {
  const raw = PRICE_FLOOR * Math.pow(PRICE_CEIL / PRICE_FLOOR, pos / PRICE_STEPS);
  const step = raw < 1e9 ? 10e6 : 50e6;
  return Math.round(raw / step) * step;
}

/** Area (m2) de una posicion del slider: de 15 a 300 m2 en pasos de 5. */
export const areaAt = (pos: number) => AREA_FLOOR + pos * AREA_STEP;

export type Filters = {
  /** Indice en meta.departments. */
  dept: number | null;
  /** Indice en meta.cities. */
  city: number | null;
  /** Posiciones [minimo, maximo] del slider de precio (0 y PRICE_STEPS = sin limite). */
  price: [number, number];
  /** Habitaciones 1 a 5 (5 = cinco o mas); vacio = todas. */
  beds: number[];
  /** Posiciones [minimo, maximo] del slider de area (0 y AREA_STEPS = sin limite). */
  area: [number, number];
};

export const NO_FILTERS: Filters = { dept: null, city: null, price: [0, PRICE_STEPS], beds: [], area: [0, AREA_STEPS] };

/** Cuantos grupos de filtro estan activos (para el contador del boton). */
export function activeCount(f: Filters): number {
  return (
    Number(f.dept !== null) +
    Number(f.price[0] !== 0 || f.price[1] !== PRICE_STEPS) +
    Number(f.beds.length > 0) +
    Number(f.area[0] !== 0 || f.area[1] !== AREA_STEPS)
  );
}

export const isActive = (f: Filters) => activeCount(f) > 0;

export function selectRows(p: Points, f: Filters): Uint32Array {
  const unit = p.meta.price_unit;
  const out = new Uint32Array(p.n);
  let m = 0;
  let bedMask = 0;
  for (const b of f.beds) bedMask |= 1 << b;
  const pMin = f.price[0] === 0 ? -Infinity : priceAt(f.price[0]);
  const pMax = f.price[1] === PRICE_STEPS ? Infinity : priceAt(f.price[1]);
  const aMin = f.area[0] === 0 ? -Infinity : areaAt(f.area[0]);
  const aMax = f.area[1] === AREA_STEPS ? Infinity : areaAt(f.area[1]);
  for (let i = 0; i < p.n; i++) {
    if (f.dept !== null && p.dept[i] !== f.dept) continue;
    if (f.city !== null && p.city[i] !== f.city) continue;
    const price = p.price[i] * unit;
    if (price < pMin || price > pMax) continue;
    const area = p.area[i];
    if (area < aMin || area > aMax) continue;
    if (bedMask && !(bedMask & (1 << Math.min(p.beds[i], 5)))) continue;
    out[m++] = i;
  }
  return out.subarray(0, m);
}

/** Cuantil con interpolacion lineal sobre un arreglo ya ordenado (igual que pandas). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const sortedCopy = (values: ArrayLike<number>) => Float64Array.from(values).sort();

export type Summary = {
  count: number;
  kpis: {
    price_median_cop: number;
    price_p25_cop: number;
    price_p75_cop: number;
    price_m2_median_cop: number;
    area_median_m2: number;
  };
  histogram: { edges_cop: number[]; counts: number[]; p99_cop: number } | null;
  byDepartment: DepartmentStat[];
  byCity: CityStat[];
  topCities: TopCity[];
  amenities: AmenityStat[];
  byStratum: StratumBox[];
};

const HISTOGRAM_BINS = 60;
const TOP_N = 15;

/** Agrupa valores por clave (indices 0..groups-1) y devuelve la mediana de cada grupo. */
function groupMedians(keys: Int32Array, groups: number, ...series: Float64Array[]): { count: number[]; medians: number[][] } {
  const count = new Array<number>(groups).fill(0);
  for (const k of keys) if (k >= 0) count[k]++;
  const offsets = new Array<number>(groups + 1).fill(0);
  for (let g = 0; g < groups; g++) offsets[g + 1] = offsets[g] + count[g];
  const medians = series.map(() => new Array<number>(groups).fill(NaN));
  const cursor = offsets.slice(0, groups);
  const buffers = series.map(() => new Float64Array(offsets[groups]));
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k < 0) continue;
    series.forEach((s, j) => (buffers[j][cursor[k]] = s[i]));
    cursor[k]++;
  }
  for (let g = 0; g < groups; g++) {
    if (!count[g]) continue;
    buffers.forEach((b, j) => {
      const slice = b.subarray(offsets[g], offsets[g + 1]).sort();
      medians[j][g] = quantileSorted(slice, 0.5);
    });
  }
  return { count, medians };
}

export function computeSummary(p: Points, rows: Uint32Array, mapCities: number[]): Summary {
  const m = rows.length;
  const unit = p.meta.price_unit;
  const price = new Float64Array(m);
  const ppm2 = new Float64Array(m);
  const area = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = rows[k];
    price[k] = p.price[i] * unit;
    area[k] = p.area[i];
    ppm2[k] = price[k] / area[k];
  }
  const sortedPrice = sortedCopy(price);
  const sortedPpm2 = sortedCopy(ppm2);
  const sortedArea = sortedCopy(area);

  // Histograma de precios hasta el percentil 99, con 60 intervalos iguales entre el minimo y el maximo de ese tramo.
  let histogram: Summary["histogram"] = null;
  if (m >= 10) {
    const p99 = quantileSorted(sortedPrice, 0.99);
    const below = sortedPrice.filter((v) => v < p99);
    if (below.length > 1) {
      const lo = below[0];
      const hi = below[below.length - 1];
      const width = (hi - lo) / HISTOGRAM_BINS;
      const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
      for (const v of below) counts[Math.min(HISTOGRAM_BINS - 1, Math.floor((v - lo) / width))]++;
      histogram = {
        edges_cop: Array.from({ length: HISTOGRAM_BINS + 1 }, (_, b) => Math.round(lo + b * width)),
        counts,
        p99_cop: Math.round(p99),
      };
    }
  }

  // Por departamento y por ciudad del mapa.
  const deptKeys = new Int32Array(m);
  const citySlot = new Int16Array(p.meta.cities.length).fill(-1);
  mapCities.forEach((c, slot) => (citySlot[c] = slot));
  const cityKeys = new Int32Array(m);
  for (let k = 0; k < m; k++) {
    deptKeys[k] = p.dept[rows[k]];
    cityKeys[k] = citySlot[p.city[rows[k]]];
  }
  const byDept = groupMedians(deptKeys, p.meta.departments.length, ppm2, price);
  const byCityGroups = groupMedians(cityKeys, mapCities.length, ppm2, price);

  const byDepartment: DepartmentStat[] = p.meta.departments
    .map((department, d) => ({
      department,
      listings: byDept.count[d],
      price_m2_median: Math.round(byDept.medians[0][d]),
      price_median: Math.round(byDept.medians[1][d]),
    }))
    .filter((d) => d.listings > 0)
    .sort((a, b) => b.listings - a.listings);

  const byCity: CityStat[] = mapCities
    .map((c, slot) => ({
      city: p.meta.cities[c][0],
      department: p.meta.departments[p.meta.cities[c][1]],
      listings: byCityGroups.count[slot],
      price_m2_median: Math.round(byCityGroups.medians[0][slot]),
      price_median: Math.round(byCityGroups.medians[1][slot]),
    }))
    .filter((c) => c.listings > 0)
    .sort((a, b) => b.listings - a.listings);

  // Ciudades con mas anuncios (por nombre, como en el exportador) y amenidades.
  const cityCount = new Map<string, number>();
  const amenityCount = new Array<number>(p.meta.amenities.length).fill(0);
  const stratumValues: number[][] = [[], [], [], [], [], [], []];
  for (let k = 0; k < m; k++) {
    const i = rows[k];
    const name = p.meta.cities[p.city[i]][0];
    cityCount.set(name, (cityCount.get(name) ?? 0) + 1);
    const mask = p.amen[i];
    if (mask) for (let b = 0; b < amenityCount.length; b++) if (mask & (1 << b)) amenityCount[b]++;
    const s = p.stratum[i];
    if (s >= 1 && s <= 6) stratumValues[s].push(price[k]);
  }
  const topCities = [...cityCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([city, listings]) => ({ city, listings }));
  const amenities = p.meta.amenities
    .map((amenity, b) => ({ amenity, listings: amenityCount[b], share_pct: m ? Math.round((1000 * amenityCount[b]) / m) / 10 : 0 }))
    .filter((a) => a.listings > 0)
    .sort((a, b) => b.listings - a.listings)
    .slice(0, TOP_N);

  // Caja por estrato con bigotes de Tukey (1,5 x IQR).
  const byStratum: StratumBox[] = [];
  for (let s = 1; s <= 6; s++) {
    const values = Float64Array.from(stratumValues[s]).sort();
    if (values.length < 5) continue;
    const q1 = quantileSorted(values, 0.25);
    const median = quantileSorted(values, 0.5);
    const q3 = quantileSorted(values, 0.75);
    const iqr = q3 - q1;
    const inside = values.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    byStratum.push({
      stratum: s,
      listings: values.length,
      whisker_low: inside[0],
      q1: Math.round(q1),
      median: Math.round(median),
      q3: Math.round(q3),
      whisker_high: inside[inside.length - 1],
      outliers: values.length - inside.length,
    });
  }

  return {
    count: m,
    kpis: {
      price_median_cop: Math.round(quantileSorted(sortedPrice, 0.5)),
      price_p25_cop: Math.round(quantileSorted(sortedPrice, 0.25)),
      price_p75_cop: Math.round(quantileSorted(sortedPrice, 0.75)),
      price_m2_median_cop: Math.round(quantileSorted(sortedPpm2, 0.5)),
      area_median_m2: Math.round(quantileSorted(sortedArea, 0.5) * 10) / 10,
    },
    histogram,
    byDepartment,
    byCity,
    topCities,
    amenities,
    byStratum,
  };
}

// --- Oportunidades ------------------------------------------------------------

export type Reference = "zone" | "model";

/** Posicion de un anuncio frente a su referencia. */
export const Position = { InLine: 0, Below: 1, Above: 2, Extreme: 3 } as const;

// Un anuncio a 25 % o mas por debajo de su referencia es "bajo"; a 33 % o mas por encima (1/0,75), "sobre".
export const BELOW_RATIO = 0.75;
export const ABOVE_RATIO = 1 / 0.75;
// Mas alla de esto es casi seguro un error de captura (area o precio mal digitados, precio "desde" de un proyecto).
export const EXTREME_LOW = 0.35;
export const EXTREME_HIGH = 3;

export type Classified = {
  /** Referencia: mediana de precio por m2 de los anuncios filtrados (COP/m2). */
  medianPpm2: number;
  /** Para cada fila de `rows`: precio / referencia (NaN si no hay referencia). */
  ratio: Float32Array;
  position: Uint8Array;
  counts: [number, number, number, number];
};

export function classify(p: Points, rows: Uint32Array, reference: Reference): Classified {
  const unit = p.meta.price_unit;
  const m = rows.length;
  const ppm2 = new Float64Array(m);
  for (let k = 0; k < m; k++) ppm2[k] = (p.price[rows[k]] * unit) / p.area[rows[k]];
  const medianPpm2 = quantileSorted(sortedCopy(ppm2), 0.5);

  const ratio = new Float32Array(m);
  const position = new Uint8Array(m);
  const counts: Classified["counts"] = [0, 0, 0, 0];
  for (let k = 0; k < m; k++) {
    const i = rows[k];
    const r =
      reference === "zone"
        ? ppm2[k] / medianPpm2
        : p.expected[i] > 0
          ? p.price[i] / p.expected[i]
          : NaN;
    ratio[k] = r;
    let pos: number = Position.InLine;
    if (Number.isNaN(r)) pos = Position.InLine;
    else if (r < EXTREME_LOW || r > EXTREME_HIGH) pos = Position.Extreme;
    else if (r <= BELOW_RATIO) pos = Position.Below;
    else if (r >= ABOVE_RATIO) pos = Position.Above;
    position[k] = pos;
    counts[pos]++;
  }
  return { medianPpm2, ratio, position, counts };
}
