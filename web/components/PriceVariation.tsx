"use client";

import { useMemo, useState } from "react";

import { dec, int, millions } from "@/lib/format";
import type { Points } from "@/lib/points";
import { linear, ticks } from "@/lib/scale";
import { selectRows, type Filters } from "@/lib/stats";
import {
  DIMENSIONS,
  crossStats,
  dimLabel,
  groupStats,
  isSelected,
  hasSelection,
  keyOf,
  labelOf,
  selectOnly,
  toggleGroup,
  withoutDim,
  type DimKey,
  type Group,
  type Unit,
} from "@/lib/variation";
import { Card, EmptyNote } from "./ui";
import { useWidth } from "./useWidth";

type Mode = "median" | "mean" | "both";
type Order = "price" | "count";

const FEW = 30;
const ROW = 32;
const TOP = 6;
const BOTTOM = 24;

const MODES: { key: Mode; label: string }[] = [
  { key: "median", label: "Mediana" },
  { key: "mean", label: "Promedio" },
  { key: "both", label: "Ambos" },
];

const unitDigits = (unit: Unit) => (unit === "m2" ? 1 : 0);

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="pv-field">
      <span className="fsel-label">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.key} type="button" className={o.key === value ? "seg-on" : ""} aria-pressed={o.key === value} onClick={() => onChange(o.key)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Pick({ label, value, options, onChange }: { label: string; value: number; options: number[]; onChange: (v: number) => void }) {
  return (
    <label className="pv-field pv-pick">
      <span className="fsel-label">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Bars({
  groups,
  mode,
  unit,
  selectedKeys,
  anySelected,
  onPick,
}: {
  groups: Group[];
  mode: Mode;
  unit: Unit;
  selectedKeys: Set<number>;
  anySelected: boolean;
  onPick: (key: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const narrow = width < 460;
  const left = narrow ? 96 : 156;
  const right = narrow ? 92 : 112;
  const plotW = Math.max(0, width - left - right);
  const height = TOP + groups.length * ROW + BOTTOM;
  const hi = Math.max(1, ...groups.map((g) => (mode === "mean" ? g.mean : Math.max(g.q3, g.mean))));
  const xTicks = ticks(0, hi, narrow ? 2 : 4);
  const top = Math.max(hi, xTicks[xTicks.length - 1] ?? hi);
  const x = linear(0, top, 0, plotW);
  const digits = unit === "m2" && top < 10e6 ? 1 : 0;
  const maxChars = Math.floor((left - 12) / 6.4);

  return (
    <div ref={ref} style={{ height }} role="group" aria-label="Precio por grupo">
      {width > 0 && (
        <svg width={width} height={height}>
          <g transform={`translate(${left},${TOP})`}>
            {xTicks.map((t) => (
              <g key={t}>
                <line className="grid" x1={x(t)} x2={x(t)} y1={0} y2={groups.length * ROW} />
                <text className="tick" x={x(t)} y={groups.length * ROW + 16} textAnchor="middle">
                  {millions(t, digits)}
                </text>
              </g>
            ))}
            {groups.map((g, i) => {
              const cy = i * ROW + ROW / 2;
              const on = selectedKeys.has(g.key);
              const dim = anySelected && !on;
              const value = mode === "mean" ? g.mean : g.median;
              const label = g.label.length > maxChars ? `${g.label.slice(0, maxChars - 1)}…` : g.label;
              const tip = `${g.label}: mediana ${millions(g.median, unitDigits(unit))}, de ${millions(g.q1, unitDigits(unit))} a ${millions(g.q3, unitDigits(unit))}, promedio ${millions(g.mean, unitDigits(unit))} (${int(g.n)} anuncios). Toca para filtrar.`;
              return (
                <g
                  key={g.key}
                  className={`pv-row${on ? " on" : ""}${dim ? " dim" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  aria-label={tip}
                  onClick={() => onPick(g.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onPick(g.key);
                    }
                  }}
                >
                  <rect className="pv-hit" x={-left} y={i * ROW} width={width} height={ROW} />
                  <text className="tick ink" x={-10} y={cy} textAnchor="end" dominantBaseline="middle">
                    {label}
                  </text>
                  {mode === "mean" ? (
                    <rect className="bar-main" x={0} y={cy - 7} width={Math.max(2, x(g.mean))} height={14} rx={2} />
                  ) : (
                    <>
                      <rect className="box" x={x(g.q1)} y={cy - 8} width={Math.max(2, x(g.q3) - x(g.q1))} height={16} />
                      <line className="median" x1={x(g.median)} x2={x(g.median)} y1={cy - 8} y2={cy + 8} />
                      {mode === "both" && (
                        <polygon
                          className="pv-mean"
                          points={`${x(g.mean) - 5},${cy} ${x(g.mean)},${cy - 5} ${x(g.mean) + 5},${cy} ${x(g.mean)},${cy + 5}`}
                        />
                      )}
                    </>
                  )}
                  <text className="tick strong num" x={plotW + 10} y={cy} dominantBaseline="middle">
                    {millions(value, unitDigits(unit))}
                  </text>
                  <text className="tick num" x={plotW + right - 4} y={cy} textAnchor="end" dominantBaseline="middle">
                    {int(g.n)}
                  </text>
                  <title>{tip}</title>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

/** Grupos de una dimension ordenados para la tabla de calor: los pequenos (estrato, habitaciones) en orden natural, los grandes por cantidad. */
function heatGroups(points: Points, rows: Uint32Array, dim: DimKey, limit: number): { key: number; label: string; n: number }[] {
  const counts = new Map<number, number>();
  for (let r = 0; r < rows.length; r++) {
    const k = keyOf(points, dim, rows[r]);
    if (k >= 0) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const all = [...counts].map(([key, n]) => ({ key, label: labelOf(points, dim, key), n }));
  const natural = dim === "stratum" || dim === "beds" || dim === "owner";
  const top = [...all].sort((a, b) => b.n - a.n).slice(0, limit);
  return natural ? top.sort((a, b) => a.key - b.key) : top;
}

function Heat({
  points,
  filters,
  rowDim,
  colDim,
  unit,
  mode,
  minN,
  onChange,
}: {
  points: Points;
  filters: Filters;
  rowDim: DimKey;
  colDim: DimKey;
  unit: Unit;
  mode: Mode;
  minN: number;
  onChange: (next: Filters) => void;
}) {
  const rows = useMemo(() => selectRows(points, withoutDim(withoutDim(filters, rowDim), colDim)), [points, filters, rowDim, colDim]);
  const view = useMemo(() => {
    const rowGroups = heatGroups(points, rows, rowDim, 8);
    const colGroups = heatGroups(points, rows, colDim, 8);
    const cells = crossStats(points, rows, rowDim, colDim, unit);
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rowGroups) {
      for (const c of colGroups) {
        const cell = cells.get(`${r.key}|${c.key}`);
        if (!cell || cell.n < minN) continue;
        const v = mode === "mean" ? cell.mean : cell.median;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    return { rowGroups, colGroups, cells, lo, hi };
  }, [points, rows, rowDim, colDim, unit, mode, minN]);

  const pickCell = (rk: number, ck: number) => {
    const both = isSelected(filters, rowDim, rk) && isSelected(filters, colDim, ck);
    // Tocar una celda deja elegidos justo esa fila y esa columna; tocarla otra vez quita ambas.
    onChange(
      both
        ? withoutDim(withoutDim(filters, rowDim), colDim)
        : selectOnly(points, selectOnly(points, filters, rowDim, rk), colDim, ck),
    );
  };

  if (!view.rowGroups.length || !view.colGroups.length || !Number.isFinite(view.lo)) {
    return <EmptyNote>Muy pocos anuncios para cruzar estas dos variables con los filtros actuales.</EmptyNote>;
  }
  const span = view.hi - view.lo || 1;

  return (
    <div className="heat-wrap">
      <table className="heat">
        <thead>
          <tr>
            <th scope="col" className="heat-corner">
              {dimLabel(rowDim)} / {dimLabel(colDim)}
            </th>
            {view.colGroups.map((c) => (
              <th key={c.key} scope="col" className={isSelected(filters, colDim, c.key) ? "heat-col on" : "heat-col"}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rowGroups.map((r) => (
            <tr key={r.key}>
              <th scope="row" className={isSelected(filters, rowDim, r.key) ? "heat-row on" : "heat-row"}>
                {r.label}
              </th>
              {view.colGroups.map((c) => {
                const cell = view.cells.get(`${r.key}|${c.key}`);
                if (!cell || cell.n < minN) {
                  return (
                    <td key={c.key} className="heat-empty" title={cell ? `Solo ${int(cell.n)} anuncios` : "Sin anuncios"}>
                      ·
                    </td>
                  );
                }
                const v = mode === "mean" ? cell.mean : cell.median;
                const t = (v - view.lo) / span;
                const picked = isSelected(filters, rowDim, r.key) && isSelected(filters, colDim, c.key);
                return (
                  <td key={c.key} className="heat-cell-td">
                    <button
                      type="button"
                      className={`heat-cell${t > 0.55 ? " hi" : ""}${picked ? " picked" : ""}`}
                      style={{ background: `color-mix(in srgb, var(--map-hi) ${Math.round(t * 100)}%, var(--map-lo))` }}
                      aria-pressed={picked}
                      title={`${r.label} y ${c.label}: ${mode === "mean" ? "promedio" : "mediana"} ${millions(v, unitDigits(unit))} (${int(cell.n)} anuncios). Toca para filtrar.`}
                      onClick={() => pickCell(r.key, c.key)}
                    >
                      {dec(v / 1e6, unitDigits(unit))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Props = {
  points: Points;
  filters: Filters;
  onChange: (next: Filters) => void;
};

export default function PriceVariation({ points, filters, onChange }: Props) {
  const [dim, setDim] = useState<DimKey>("dept");
  const [mode, setMode] = useState<Mode>("both");
  const [unit, setUnit] = useState<Unit>("m2");
  const [order, setOrder] = useState<Order>("price");
  const [limit, setLimit] = useState(15);
  const [minN, setMinN] = useState(FEW);
  const [rowDim, setRowDim] = useState<DimKey>("stratum");
  const [colDim, setColDim] = useState<DimKey>("dept");

  const rows = useMemo(() => selectRows(points, withoutDim(filters, dim)), [points, filters, dim]);
  const groups = useMemo(() => {
    const all = groupStats(points, rows, dim, unit).filter((g) => g.n >= minN);
    const byPrice = (g: Group) => (mode === "mean" ? g.mean : g.median);
    all.sort((a, b) => (order === "count" ? b.n - a.n : byPrice(b) - byPrice(a)));
    const shown = all.slice(0, limit);
    // Lo que el usuario eligio siempre se ve, aunque no entre en el top.
    for (const g of all.slice(limit)) if (isSelected(filters, dim, g.key)) shown.push(g);
    return shown;
  }, [points, rows, dim, unit, minN, order, limit, mode, filters]);

  const selectedKeys = useMemo(() => new Set(groups.filter((g) => isSelected(filters, dim, g.key)).map((g) => g.key)), [groups, filters, dim]);
  const unitText = unit === "m2" ? "por metro cuadrado" : "precio total";
  const changeRowDim = (next: DimKey) => {
    setRowDim(next);
    if (next === colDim) setColDim(DIMENSIONS.find((d) => d.key !== next)!.key);
  };
  const changeColDim = (next: DimKey) => {
    setColDim(next);
    if (next === rowDim) setRowDim(DIMENSIONS.find((d) => d.key !== next)!.key);
  };

  return (
    <section id="variacion" className="sec" aria-labelledby="h-variacion">
      <h2 id="h-variacion">Cómo varían los precios</h2>
      <p className="sec-note">
        Compara el precio entre grupos. Toca una barra o una celda para filtrar todo el tablero con ese grupo; vuelve a tocarla para quitarlo.
      </p>

      <Card title={`Precio ${unitText} por ${dimLabel(dim).toLowerCase()}`} note="Caja: mitad central de los anuncios. Marca: mediana. Rombo: promedio.">
        <div className="pv-controls">
          <div className="pv-field pv-wide">
            <span className="fsel-label">Comparar por</span>
            <div className="chip-row tight" role="group" aria-label="Comparar por">
              {DIMENSIONS.map((d) => (
                <button key={d.key} type="button" className={d.key === dim ? "chip on" : "chip"} aria-pressed={d.key === dim} onClick={() => setDim(d.key)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <Seg label="Medida" value={mode} options={MODES} onChange={setMode} />
          <Seg
            label="Unidad"
            value={unit}
            options={[
              { key: "m2", label: "Por m²" },
              { key: "total", label: "Total" },
            ]}
            onChange={setUnit}
          />
          <Seg
            label="Orden"
            value={order}
            options={[
              { key: "price", label: "Más caros" },
              { key: "count", label: "Más anuncios" },
            ]}
            onChange={setOrder}
          />
          <Pick label="Mostrar" value={limit} options={[10, 15, 25]} onChange={setLimit} />
          <Pick label="Mínimo de anuncios" value={minN} options={[10, 30, 100, 300]} onChange={setMinN} />
        </div>

        {groups.length ? (
          <Bars
            groups={groups}
            mode={mode}
            unit={unit}
            selectedKeys={selectedKeys}
            anySelected={hasSelection(filters, dim) && selectedKeys.size > 0}
            onPick={(key) => onChange(toggleGroup(points, filters, dim, key))}
          />
        ) : (
          <EmptyNote>Ningún grupo llega al mínimo de {int(minN)} anuncios con los filtros actuales. Baja el mínimo o quita filtros.</EmptyNote>
        )}
        <p className="foot muted">
          Millones de pesos {unitText}. A la derecha, el valor y el número de anuncios de cada grupo. Se usa la mediana (el apartamento típico: la mitad
          cuesta menos y la mitad más) porque unos pocos inmuebles muy caros inflan el promedio.
          {dim === "city" || dim === "hood" ? " Con filtros de ciudad o barrio se ven las demás de la misma zona." : ""}
        </p>
      </Card>

      <Card
        title="Cruce de dos variables"
        note={`Cada celda es la ${mode === "mean" ? "media" : "mediana"} ${unit === "m2" ? "del m²" : "del precio"} en millones de pesos. Más oscuro es más caro.`}
      >
        <div className="pv-controls">
          <label className="pv-field pv-pick wide">
            <span className="fsel-label">Filas</span>
            <select className="input" value={rowDim} onChange={(e) => changeRowDim(e.target.value as DimKey)}>
              {DIMENSIONS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pv-field pv-pick wide">
            <span className="fsel-label">Columnas</span>
            <select className="input" value={colDim} onChange={(e) => changeColDim(e.target.value as DimKey)}>
              {DIMENSIONS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Heat points={points} filters={filters} rowDim={rowDim} colDim={colDim} unit={unit} mode={mode} minN={minN} onChange={onChange} />
        <p className="foot muted">
          La medida, la unidad y el mínimo de anuncios son los de arriba. El punto indica que no hay anuncios suficientes. Se muestran hasta 8 filas y 8
          columnas, las de más anuncios.
        </p>
      </Card>
    </section>
  );
}

/** Etiquetas de los filtros elegidos desde el panel (y los de departamento, ciudad y habitaciones), con una x para quitar cada una. */
export function ActiveChips({ points, filters, onChange }: Props) {
  const chips: { id: string; text: string; remove: () => void }[] = [];
  const m = points.meta;
  if (filters.dept !== null) chips.push({ id: "dept", text: m.departments[filters.dept], remove: () => onChange(withoutDim(filters, "dept")) });
  if (filters.city !== null) chips.push({ id: "city", text: m.cities[filters.city][0], remove: () => onChange(withoutDim(filters, "city")) });
  if (filters.hood !== null) chips.push({ id: "hood", text: m.neighborhoods[filters.hood - 1], remove: () => onChange(withoutDim(filters, "hood")) });
  for (const s of filters.stratum)
    chips.push({ id: `s${s}`, text: `Estrato ${s}`, remove: () => onChange({ ...filters, stratum: filters.stratum.filter((x) => x !== s) }) });
  for (const b of filters.beds)
    chips.push({ id: `b${b}`, text: b === 5 ? "5 o más hab." : `${b} hab.`, remove: () => onChange({ ...filters, beds: filters.beds.filter((x) => x !== b) }) });
  for (const o of filters.owner)
    chips.push({ id: `o${o}`, text: m.owner_groups[o], remove: () => onChange({ ...filters, owner: filters.owner.filter((x) => x !== o) }) });
  if (!chips.length) return null;
  return (
    <ul className="achips" aria-label="Filtros elegidos">
      {chips.map((c) => (
        <li key={c.id}>
          <button type="button" className="achip" onClick={c.remove} aria-label={`Quitar ${c.text}`}>
            {c.text}
            <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  );
}
