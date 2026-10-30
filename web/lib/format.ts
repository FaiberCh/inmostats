// Formato colombiano: punto para miles, coma para decimales.
const LOCALE = "es-CO";

export const int = (n: number) => Math.round(n).toLocaleString(LOCALE, { useGrouping: true });

export const dec = (n: number, digits = 1) =>
  n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Millones de pesos: "$499 M". */
export const millions = (cop: number, digits = 0) => `$${dec(cop / 1e6, digits)}00a0M`;

/** Pesos completos con separador de miles: "$499.000.000". */
export const pesos = (cop: number) => `$${int(cop)}`;

export const pct = (n: number, digits = 1) => `${dec(n, digits)} %`;

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-07-30" a "30 jul 2026". */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-07-30" a "30 jul". */
export function dayMonth(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Nombre legible de una variable del modelo ("num__area_m2" a "Área (m²)"). */
const FEATURE_LABELS: Record<string, string> = {
  area_m2: "Área (m²)",
  garages: "Garajes",
  stratum: "Estrato",
  bedrooms: "Habitaciones",
  bathrooms: "Baños",
  floor: "Piso",
  antiquity: "Antigüedad",
  latitude: "Latitud",
  longitude: "Longitud",
  is_new_project: "Proyecto nuevo",
  neighborhood: "Barrio",
  city: "Ciudad",
};

export function featureLabel(raw: string): string {
  const [kind, ...rest] = raw.split("__");
  const name = rest.join("__");
  if (kind === "onehot") {
    if (name.startsWith("owner_type_")) return `Anunciante: ${name.slice("owner_type_".length)}`;
    if (name.startsWith("department_final_")) return `Departamento: ${name.slice("department_final_".length)}`;
    return name.replace(/_/g, " ");
  }
  if (kind === "amenity") return `Amenidad: ${name.replace(/_/g, " ")}`;
  return FEATURE_LABELS[name] ?? name.replace(/_/g, " ");
}
