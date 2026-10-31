"use client";

import { dec } from "@/lib/format";
import { linear, ticks } from "@/lib/scale";
import type { OwnerGroup } from "@/lib/types";
import { useWidth } from "./useWidth";

const ROW = 60;
const TOP = 6;
const AXIS = 30;
const PAD = 14;

const SHORT: Record<number, string> = {
  2: "Asesores independientes",
  3: "Propietarios directos",
  4: "Desarrolladores (proyectos nuevos)",
};

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${dec(Math.abs(n), 1)} %`;

/** Diferencia frente a las empresas con su intervalo de confianza: un punto por grupo y una linea de cero. */
export default function OwnerEffectChart({ groups }: { groups: OwnerGroup[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const rows = groups.filter((g) => g.effect_pct !== undefined && g.ci_low !== undefined && g.ci_high !== undefined);
  if (rows.length === 0) return null;

  const lo = Math.min(0, ...rows.map((g) => g.ci_low!));
  const hi = Math.max(0, ...rows.map((g) => g.ci_high!));
  const margin = Math.max(2, (hi - lo) * 0.04);
  const min = lo - margin;
  const max = hi + margin;
  const plotW = Math.max(0, width - 2 * PAD);
  const x = linear(min, max, PAD, PAD + plotW);
  const xTicks = ticks(min, max, width < 460 ? 4 : 6);
  const height = TOP + rows.length * ROW + AXIS;

  return (
    <div
      ref={ref}
      style={{ height }}
      role="img"
      aria-label={`Diferencia de precio frente a las empresas: ${rows
        .map((g) => `${SHORT[g.code] ?? g.label} ${signed(g.effect_pct!)}, entre ${dec(g.ci_low!, 1)} y ${dec(g.ci_high!, 1)}`)
        .join("; ")}`}
    >
      {width > 0 && (
        <svg width={width} height={height}>
          {xTicks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "marker" : "grid"} x1={x(t)} x2={x(t)} y1={TOP} y2={TOP + rows.length * ROW} />
              <text className={t === 0 ? "tick strong" : "tick"} x={x(t)} y={TOP + rows.length * ROW + 17} textAnchor="middle">
                {t === 0 ? "Empresas" : `${t > 0 ? "+" : "−"}${Math.abs(t)} %`}
              </text>
            </g>
          ))}
          {rows.map((g, i) => {
            const base = TOP + i * ROW;
            const unclear = g.ci_low! <= 0 && g.ci_high! >= 0;
            const lineY = base + 38;
            return (
              <g key={g.code}>
                <text className="tick ink" x={PAD} y={base + 16}>
                  {SHORT[g.code] ?? g.label}
                </text>
                <text className={unclear ? "tick" : "tick strong"} x={width - PAD} y={base + 16} textAnchor="end">
                  {unclear ? "Sin diferencia clara" : signed(g.effect_pct!)}
                </text>
                <line className={unclear ? "ci-line weak" : "ci-line"} x1={x(g.ci_low!)} x2={x(g.ci_high!)} y1={lineY} y2={lineY} />
                <circle className={unclear ? "ci-dot weak" : "ci-dot"} cx={x(g.effect_pct!)} cy={lineY} r={6} />
                <title>{`${SHORT[g.code] ?? g.label}: ${signed(g.effect_pct!)} (intervalo del 95 %: ${dec(g.ci_low!, 1)} a ${dec(g.ci_high!, 1)})`}</title>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
