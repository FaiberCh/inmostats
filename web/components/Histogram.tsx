"use client";

import { millions } from "@/lib/format";
import { linear, ticks } from "@/lib/scale";
import { useWidth } from "./useWidth";

type Props = {
  edges: number[];
  counts: number[];
  height?: number;
  /** Formato del eje X: pesos en millones o variacion porcentual con signo. */
  xFormat: "millions" | "signedPct";
  /** Marca vertical opcional (por ejemplo la mediana) con su etiqueta. */
  marker?: { value: number; label: string };
  label: string;
};

const formatX = (kind: Props["xFormat"], v: number) => (kind === "millions" ? millions(v) : `${v > 0 ? "+" : ""}${v} %`);

const M = { top: 10, right: 8, bottom: 24, left: 50 };

export default function Histogram({ edges, counts, height = 200, xFormat, marker, label }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;

  const x0 = edges[0];
  const x1 = edges[edges.length - 1];
  const maxCount = Math.max(...counts);
  const yTicks = ticks(0, maxCount, 4);
  const yMax = yTicks[yTicks.length - 1] >= maxCount ? yTicks[yTicks.length - 1] : yTicks[yTicks.length - 1] + (yTicks[1] - yTicks[0]);
  const x = linear(x0, x1, 0, plotW);
  const y = linear(0, yMax, plotH, 0);
  const xTicks = ticks(x0, x1, width < 460 ? 5 : 7);
  const yAll = ticks(0, yMax, 4);

  return (
    <div ref={ref} style={{ height }} role="img" aria-label={label}>
      {width > 0 && (
        <svg width={width} height={height}>
          <g transform={`translate(${M.left},${M.top})`}>
            {yAll.map((t) => (
              <g key={t}>
                <line className={t === 0 ? "axis" : "grid"} x1={0} x2={plotW} y1={y(t)} y2={y(t)} />
                <text className="tick" x={-8} y={y(t)} textAnchor="end" dominantBaseline="middle">
                  {t.toLocaleString("es-CO")}
                </text>
              </g>
            ))}
            {counts.map((c, i) => {
              const bx = x(edges[i]);
              const bw = Math.max(1, x(edges[i + 1]) - bx - 1);
              return <rect key={i} className="bar-main" x={bx} y={y(c)} width={bw} height={plotH - y(c)} />;
            })}
            {xTicks.map((t) => (
              <text key={t} className="tick" x={x(t)} y={plotH + 16} textAnchor="middle">
                {formatX(xFormat, t)}
              </text>
            ))}
            {marker && (
              <g>
                <line className="marker" x1={x(marker.value)} x2={x(marker.value)} y1={0} y2={plotH} />
                <text
                  className="tick strong"
                  x={x(marker.value) + (x(marker.value) > plotW * 0.7 ? -6 : 6)}
                  y={10}
                  textAnchor={x(marker.value) > plotW * 0.7 ? "end" : "start"}
                >
                  {marker.label}
                </text>
              </g>
            )}
          </g>
        </svg>
      )}
    </div>
  );
}
