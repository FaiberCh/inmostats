"use client";

import { useEffect, useRef, useState } from "react";

import { int, millions } from "@/lib/format";
import type { PointsMeta } from "@/lib/points";
import {
  AREA_STEPS,
  PRICE_STEPS,
  activeCount,
  areaAt,
  priceAt,
  type Filters,
} from "@/lib/stats";
import DualSlider from "./DualSlider";

type Props = {
  meta: PointsMeta | null;
  /** Indices de meta.cities que pueden elegirse (con pocos anuncios se omiten). */
  cityOptions: number[];
  filters: Filters;
  onChange: (next: Filters) => void;
  onClear: () => void;
  count: number;
  total: number;
  failed: boolean;
};

const BEDROOMS = [1, 2, 3, 4, 5];

function rangeText(lo: number, hi: number, steps: number, format: (pos: number) => string): string {
  if (lo === 0 && hi === steps) return "Cualquiera";
  if (lo === 0) return `Hasta ${format(hi)}`;
  if (hi === steps) return `Desde ${format(lo)}`;
  return `${format(lo)} a ${format(hi)}`;
}

export default function FilterBar({ meta, cityOptions, filters, onChange, onClear, count, total, failed }: Props) {
  const [open, setOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const n = activeCount(filters);
  const ready = meta !== null;

  // En el telefono los controles van en una hoja: Escape la cierra y el foco entra en ella al abrirla.
  useEffect(() => {
    if (!open) return;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const cities = meta
    ? cityOptions
        .filter((c) => filters.dept !== null && meta.cities[c][1] === filters.dept)
        .sort((a, b) => meta.cities[a][0].localeCompare(meta.cities[b][0], "es"))
    : [];

  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const toggleBeds = (b: number) =>
    set({ beds: filters.beds.includes(b) ? filters.beds.filter((x) => x !== b) : [...filters.beds, b] });

  const status = failed
    ? "No se pudieron cargar los anuncios para filtrar"
    : !ready
      ? "Cargando anuncios para filtrar…"
      : n === 0
        ? `${int(total)} anuncios`
        : `${int(count)} de ${int(total)} anuncios`;

  return (
    <div className="fbar">
      <div className="fbar-in">
        <button className="fbtn" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="filtros" disabled={!ready}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 4h12M4.5 8h7M7 12h2" />
          </svg>
          Filtros{n > 0 ? ` (${n})` : ""}
        </button>
        <p className="fcount num" aria-live="polite">
          {status}
        </p>
        {n > 0 && (
          <button className="btn-text fclear" onClick={onClear}>
            Limpiar
          </button>
        )}

        {open && <div className="fscrim" onClick={() => setOpen(false)} aria-hidden />}
        <div
          id="filtros"
          ref={sheetRef}
          tabIndex={-1}
          className={open ? "fpanel open" : "fpanel"}
          role={open ? "dialog" : undefined}
          aria-modal={open ? true : undefined}
          aria-label="Filtros del mercado"
        >
          <div className="fpanel-head">
            <h3 className="sub">Filtros</h3>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar filtros">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
              </svg>
            </button>
          </div>

          <div className="fcontrols">
            <label className="fsel">
              <span className="fsel-label">Departamento</span>
              <select
                className="input"
                disabled={!ready}
                value={filters.dept ?? ""}
                onChange={(e) => set({ dept: e.target.value === "" ? null : Number(e.target.value), city: null })}
              >
                <option value="">Todos</option>
                {meta?.departments.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="fsel">
              <span className="fsel-label">Ciudad</span>
              <select
                className="input"
                disabled={!ready || filters.dept === null}
                value={filters.city ?? ""}
                onChange={(e) => set({ city: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{filters.dept === null ? "Elige un departamento" : "Todas"}</option>
                {cities.map((c) => (
                  <option key={c} value={c}>
                    {meta!.cities[c][0]}
                  </option>
                ))}
              </select>
            </label>

            <DualSlider
              label="Precio"
              steps={PRICE_STEPS}
              lo={filters.price[0]}
              hi={filters.price[1]}
              disabled={!ready}
              ariaLo="Precio mínimo"
              ariaHi="Precio máximo"
              text={rangeText(filters.price[0], filters.price[1], PRICE_STEPS, (pos) => millions(priceAt(pos)))}
              onChange={(lo, hi) => set({ price: [lo, hi] })}
            />

            <fieldset className="fbeds">
              <legend className="fsel-label">Habitaciones</legend>
              <div className="chip-row tight">
                {BEDROOMS.map((b) => (
                  <button
                    key={b}
                    type="button"
                    disabled={!ready}
                    className={filters.beds.includes(b) ? "chip sq on" : "chip sq"}
                    aria-pressed={filters.beds.includes(b)}
                    aria-label={b === 5 ? "5 o más habitaciones" : `${b} ${b === 1 ? "habitación" : "habitaciones"}`}
                    onClick={() => toggleBeds(b)}
                  >
                    {b === 5 ? "5+" : b}
                  </button>
                ))}
              </div>
            </fieldset>

            <DualSlider
              label="Área"
              steps={AREA_STEPS}
              lo={filters.area[0]}
              hi={filters.area[1]}
              disabled={!ready}
              ariaLo="Área mínima"
              ariaHi="Área máxima"
              text={rangeText(filters.area[0], filters.area[1], AREA_STEPS, (pos) => `${areaAt(pos)} m²`)}
              onChange={(lo, hi) => set({ area: [lo, hi] })}
            />
          </div>

          <div className="fpanel-foot">
            <button className="btn-text" onClick={onClear} disabled={n === 0}>
              Limpiar
            </button>
            <button className="btn" onClick={() => setOpen(false)}>
              Ver {int(count)} anuncios
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
