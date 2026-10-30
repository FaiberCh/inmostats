"use client";

import { geoCentroid, geoMercator, geoPath } from "d3-geo";
import { useEffect, useMemo, useState } from "react";

import { dec, int, millions } from "@/lib/format";
import type { CityStat, DepartmentStat, GeoCollection } from "@/lib/types";
import { useWidth } from "./useWidth";

type Mode = "departments" | "cities";

type Props = { departments: DepartmentStat[]; cities: CityStat[] };

type Selected = { name: string; listings: number; price_m2_median: number; price_median: number; extra?: string };

const RANK_ROWS = 10;
// Colombia es mas alta que ancha: ~1.18 de alto por 1 de ancho.
const ASPECT = 1.18;

/** Color de la escala: mezcla del tono claro al oscuro del acento, segun t en [0, 1]. Cambia solo con el tema (variables CSS). */
const ramp = (t: number) => `color-mix(in srgb, var(--map-hi) ${Math.round(t * 100)}%, var(--map-lo))`;

export default function MarketMap({ departments, cities }: Props) {
  const [mode, setMode] = useState<Mode>("departments");
  const [deptGeo, setDeptGeo] = useState<GeoCollection | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();

  useEffect(() => {
    fetch("/data/geo/departments.json")
      .then((r) => r.json())
      .then(setDeptGeo)
      .catch(() => setFailed(true));
  }, []);

  const height = Math.round(width * ASPECT);

  const projection = useMemo(() => {
    if (!deptGeo || width === 0) return null;
    return geoMercator().fitSize([width, height], deptGeo as never);
  }, [deptGeo, width, height]);

  const path = useMemo(() => (projection ? geoPath(projection) : null), [projection]);

  const deptByName = useMemo(() => new Map(departments.map((d) => [d.department, d])), [departments]);

  const [lo, hi] = useMemo(() => {
    const values = (mode === "departments" ? departments : cities).map((d) => d.price_m2_median).sort((a, b) => a - b);
    // Se recorta al percentil 5 y 95 para que un valor extremo no aplane la escala.
    return [values[Math.floor(values.length * 0.05)], values[Math.floor(values.length * 0.95)]];
  }, [mode, departments, cities]);

  const t = (v: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));

  const maxCityListings = Math.max(...cities.map((c) => c.listings));
  // El centroide de cada ciudad sale de su poligono municipal exportado; se carga solo al abrir esa vista.
  const [cityGeo, setCityGeo] = useState<GeoCollection | null>(null);
  useEffect(() => {
    if (mode !== "cities" || cityGeo) return;
    fetch("/data/geo/cities.json")
      .then((r) => r.json())
      .then(setCityGeo)
      .catch(() => setFailed(true));
  }, [mode, cityGeo]);

  const dots = useMemo(() => {
    if (mode !== "cities" || !cityGeo || !projection) return [];
    const byCity = new Map(cities.map((c) => [c.city, c]));
    return cityGeo.features
      .map((f) => {
        const stat = byCity.get(f.properties.city);
        const point = projection(geoCentroid(f as never));
        return stat && point ? { stat, x: point[0], y: point[1] } : null;
      })
      .filter((d): d is { stat: CityStat; x: number; y: number } => d !== null)
      .sort((a, b) => b.stat.listings - a.stat.listings);
  }, [mode, cityGeo, projection, cities]);

  const ranking = useMemo(() => {
    const source: (DepartmentStat | CityStat)[] = mode === "departments" ? departments : cities;
    return [...source]
      .filter((d) => d.listings >= 100)
      .sort((a, b) => b.price_m2_median - a.price_m2_median)
      .slice(0, RANK_ROWS);
  }, [mode, departments, cities]);

  const nameOf = (d: DepartmentStat | CityStat) => ("city" in d ? d.city : d.department);
  const select = (d: DepartmentStat | CityStat) =>
    setSelected({
      name: nameOf(d),
      listings: d.listings,
      price_m2_median: d.price_m2_median,
      price_median: d.price_median,
      extra: "city" in d ? d.department : undefined,
    });

  const switchMode = (next: Mode) => {
    setMode(next);
    setSelected(null);
  };

  return (
    <div className="map-layout">
      <div className="map-main">
        <div className="map-controls">
          <div className="seg" role="tablist" aria-label="Nivel del mapa">
            {(["departments", "cities"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? "seg-on" : ""}
                onClick={() => switchMode(m)}
              >
                {m === "departments" ? "Departamentos" : "Ciudades"}
              </button>
            ))}
          </div>
          <div className="scale" aria-hidden>
            <span className="num">{millions(lo, 1)}</span>
            <span className="scale-bar">
              {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                <i key={v} style={{ background: ramp(v) }} />
              ))}
            </span>
            <span className="num">{millions(hi, 1)}</span>
          </div>
        </div>

        <div ref={ref} className="map-frame" style={{ height: height || undefined, minHeight: 240 }}>
          {failed && <p className="empty">No se pudo cargar el mapa. Recarga la página para intentarlo de nuevo.</p>}
          {path && deptGeo && (
            <svg width={width} height={height} role="img" aria-label="Mapa de Colombia con el precio por metro cuadrado mediano">
              <g>
                {deptGeo.features.map((f) => {
                  const name = f.properties.department;
                  const stat = deptByName.get(name);
                  const filled = mode === "departments" && stat;
                  return (
                    <path
                      key={name}
                      d={path(f as never) ?? undefined}
                      className={filled ? "geo geo-hot" : "geo"}
                      style={filled ? { fill: ramp(t(stat.price_m2_median)) } : undefined}
                      onPointerEnter={() => stat && mode === "departments" && select(stat)}
                      onClick={() => stat && mode === "departments" && select(stat)}
                    >
                      <title>{stat ? `${name}: ${millions(stat.price_m2_median, 1)}/m²` : `${name}: sin anuncios`}</title>
                    </path>
                  );
                })}
              </g>
              {mode === "cities" && (
                <g>
                  {dots.map(({ stat, x, y }) => (
                    <circle
                      key={stat.city}
                      className="dot"
                      cx={x}
                      cy={y}
                      r={3 + 11 * Math.sqrt(stat.listings / maxCityListings)}
                      style={{ fill: ramp(t(stat.price_m2_median)) }}
                      onPointerEnter={() => select(stat)}
                      onClick={() => select(stat)}
                    >
                      <title>{`${stat.city}: ${millions(stat.price_m2_median, 1)}/m²`}</title>
                    </circle>
                  ))}
                </g>
              )}
            </svg>
          )}
        </div>

        <p className="readout" aria-live="polite">
          {selected ? (
            <>
              <strong>{selected.name}</strong>
              {selected.extra && <span className="muted">, {selected.extra}</span>}
              <span className="num">
                {" "}
                · {millions(selected.price_m2_median, 1)}/m² · mediana {millions(selected.price_median)} · {int(selected.listings)} anuncios
              </span>
            </>
          ) : (
            <span className="muted">
              {mode === "departments"
                ? "Toca o pasa el cursor sobre un departamento para ver su precio por m²."
                : "Cada punto es una ciudad (30 anuncios o más): el tamaño marca los anuncios y el tono el precio por m²."}
            </span>
          )}
        </p>
      </div>

      <div className="map-rank">
        <h3 className="sub">
          Más caros por m²{" "}
          <span className="muted">({mode === "departments" ? "departamentos" : "ciudades"} con 100 anuncios o más)</span>
        </h3>
        <ol className="rank">
          {ranking.map((d, i) => (
            <li key={nameOf(d)}>
              <button
                className={selected?.name === nameOf(d) ? "rank-row on" : "rank-row"}
                onClick={() => select(d)}
                onPointerEnter={() => select(d)}
              >
                <span className="rank-pos num">{i + 1}.</span>
                <span className="rank-name">{nameOf(d)}</span>
                <span className="num rank-value">{dec(d.price_m2_median / 1e6, 1)} M</span>
                <span className="num rank-count muted">{int(d.listings)}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="foot muted">Precio mediano por m² en millones de pesos, y número de anuncios.</p>
      </div>
    </div>
  );
}
