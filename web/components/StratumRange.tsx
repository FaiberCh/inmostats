"use client";

import { int, millions } from "@/lib/format";
import { linear, ticks } from "@/lib/scale";
import type { StratumBox } from "@/lib/types";
import { useWidth } from "./useWidth";

const ROW = 34;
const LEFT = 62;
const RIGHT = 56;
const TOP = 6;
const BOTTOM = 24;

export default function StratumRange({ rows }: { rows: StratumBox[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = TOP + rows.length * ROW + BOTTOM;
  const plotW = Math.max(0, width - LEFT - RIGHT);
  const max = Math.max(...rows.map((r) => r.whisker_high));
  const xTicks = ticks(0, max, width < 460 ? 2 : 4);
  const top = xTicks[xTicks.length - 1] >= max ? xTicks[xTicks.length - 1] : max;
  const x = linear(0, top, 0, plotW);

  return (
    <div ref={ref} style={{ height }} role="img" aria-label="Rango de precios por estrato: cuartiles, mediana y bigotes">
      {width > 0 && (
        <svg width={width} height={height}>
          <g transform={`translate(${LEFT},${TOP})`}>
            {xTicks.map((t) => (
              <g key={t}>
                <line className="grid" x1={x(t)} x2={x(t)} y1={0} y2={rows.length * ROW} />
                <text className="tick" x={x(t)} y={rows.length * ROW + 16} textAnchor="middle">
                  {millions(t)}
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const cy = i * ROW + ROW / 2;
              return (
                <g key={r.stratum}>
                  <text className="tick ink" x={-10} y={cy} textAnchor="end" dominantBaseline="middle">
                    Estrato {r.stratum}
                  </text>
                  <line className="whisker" x1={x(r.whisker_low)} x2={x(r.whisker_high)} y1={cy} y2={cy} />
                  <rect
                    className="box"
                    x={x(r.q1)}
                    y={cy - 8}
                    width={Math.max(2, x(r.q3) - x(r.q1))}
                    height={16}
                  />
                  <line className="median" x1={x(r.median)} x2={x(r.median)} y1={cy - 8} y2={cy + 8} />
                  <text className="tick num" x={plotW + 10} y={cy} dominantBaseline="middle">
                    {int(r.listings)}
                  </text>
                  <title>{`Estrato ${r.stratum}: mediana ${millions(r.median)}, de ${millions(r.q1)} a ${millions(r.q3)} (${int(r.listings)} anuncios)`}</title>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
