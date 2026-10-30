/** Paso "redondo" (1, 2, 5 x 10^k) para dividir un rango en unas `count` marcas. */
export function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** Marcas entre min y max (ambos incluidos si caen en un paso). */
export function ticks(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min, count);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export const linear = (d0: number, d1: number, r0: number, r1: number) => (v: number) =>
  d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
