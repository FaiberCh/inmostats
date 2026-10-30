"use client";

import { linear, ticks } from "@/lib/scale";
import { useWidth } from "./useWidth";

export type Series = {
  name: string;
  values: number[];
  /** "main" usa el color de acento (el dato principal); "ink" la tinta; "grey" el gris. */
  tone: "main" | "ink" | "grey";
  dashed?: boolean;
};

type Props = {
  labels: string[];
  series: Series[];
  yMin: number;
  yMax: number;
  height?: number;
  yDecimals?: number;
  label: string;
  /** Referencia horizontal (por ejemplo base = 100). */
  reference?: number;
};

const M = { top: 10, right: 12, bottom: 24, left: 44 };

export default function LineChart({ labels, series, yMin, yMax, height = 200, yDecimals = 1, label, reference }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const x = linear(0, labels.length - 1, 0, plotW);
  const y = linear(yMin, yMax, plotH, 0);
  const yTicks = ticks(yMin, yMax, 4);
  const xStep = width < 460 ? 3 : 2;

  return (
    <div ref={ref} style={{ height }} role="img" aria-label={label}>
      {width > 0 && (
        <svg width={width} height={height}>
          <g transform={`translate(${M.left},${M.top})`}>
            {yTicks.map((t) => (
              <g key={t}>
                <line className="grid" x1={0} x2={plotW} y1={y(t)} y2={y(t)} />
                <text className="tick" x={-8} y={y(t)} textAnchor="end" dominantBaseline="middle">
                  {t.toLocaleString("es-CO", { minimumFractionDigits: yDecimals, maximumFractionDigits: yDecimals })}
                </text>
              </g>
            ))}
            {reference !== undefined && (
              <line className="marker" x1={0} x2={plotW} y1={y(reference)} y2={y(reference)} />
            )}
            {labels.map((l, i) =>
              i === labels.length - 1 || (i % xStep === 0 && labels.length - 1 - i >= xStep) ? (
                <text
                  key={l}
                  className="tick"
                  x={x(i)}
                  y={plotH + 16}
                  textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}
                >
                  {l}
                </text>
              ) : null,
            )}
            {series.map((s) => (
              <polyline
                key={s.name}
                className={`line line-${s.tone}${s.dashed ? " dashed" : ""}`}
                fill="none"
                points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              />
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}
