"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { dec, int, millions, pct } from "@/lib/format";
import { loadPoints, type Points } from "@/lib/points";
import type { OwnerSummary } from "@/lib/types";
import { NO_FILTERS, computeSummary, isActive, selectRows, type Filters, type Summary } from "@/lib/stats";
import BarList from "./BarList";
import FilterBar from "./FilterBar";
import Histogram from "./Histogram";
import MarketMap from "./MarketMap";
import OwnerCompare from "./OwnerCompare";
import Opportunities from "./Opportunities";
import StratumRange from "./StratumRange";
import { Card, EmptyNote, KpiStrip } from "./ui";

type Props = {
  /** Vista sin filtros, calculada en el build: es lo que se ve (y se indexa) antes de que carguen los anuncios. */
  initial: Summary;
  /** Ciudades que tienen poligono en el mapa. */
  mapCities: { city: string; department: string }[];
  /** Efecto del tipo de anunciante a igualdad de condiciones (nacional). */
  ownerEffects: OwnerSummary;
};

const MIN_CITY_LISTINGS_TO_PICK = 5;
const FEW_LISTINGS = 30;

export default function MarketScope({ initial, mapCities, ownerEffects }: Props) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const deferred = useDeferredValue(filters);
  const [points, setPoints] = useState<Points | null>(null);
  const [failed, setFailed] = useState(false);

  // Los anuncios (2 MB) se piden poco despues de pintar la pagina; hasta entonces se ve la vista sin filtros.
  useEffect(() => {
    const timer = setTimeout(() => loadPoints().then(setPoints).catch(() => setFailed(true)), 300);
    return () => clearTimeout(timer);
  }, []);

  const mapCityIndexes = useMemo(() => {
    if (!points) return [];
    const wanted = new Set(mapCities.map((c) => `${c.department}|${c.city}`));
    const out: number[] = [];
    points.meta.cities.forEach(([city, dept], i) => {
      if (wanted.has(`${points.meta.departments[dept]}|${city}`)) out.push(i);
    });
    return out;
  }, [points, mapCities]);

  const cityOptions = useMemo(() => {
    if (!points) return [];
    const counts = new Uint32Array(points.meta.cities.length);
    for (let i = 0; i < points.n; i++) counts[points.city[i]]++;
    const out: number[] = [];
    counts.forEach((c, i) => c >= MIN_CITY_LISTINGS_TO_PICK && out.push(i));
    return out;
  }, [points]);

  const active = isActive(deferred);
  const rows = useMemo(() => (points ? selectRows(points, deferred) : null), [points, deferred]);
  const summary = useMemo(
    () => (points && rows && active ? computeSummary(points, rows, mapCityIndexes) : initial),
    [points, rows, active, mapCityIndexes, initial],
  );

  const total = points?.n ?? initial.count;
  const count = summary.count;
  const pending = filters !== deferred;
  const k = summary.kpis;
  const deltaVsNational = (k.price_m2_median_cop / initial.kpis.price_m2_median_cop - 1) * 100;
  const clear = () => setFilters(NO_FILTERS);

  return (
    <div className="scope" aria-busy={pending}>
      <FilterBar
        meta={points?.meta ?? null}
        cityOptions={cityOptions}
        filters={filters}
        onChange={setFilters}
        onClear={clear}
        count={count}
        total={total}
        failed={failed}
      />

      <div className={pending ? "scope-body pending" : "scope-body"}>
        {active && count > 0 && count < FEW_LISTINGS && (
          <p className="notice">
            Solo {int(count)} {count === 1 ? "anuncio cumple" : "anuncios cumplen"} los filtros: las medianas son poco confiables.
          </p>
        )}

        {active && count > 0 && (
          <p className="callout">
            <strong>Lectura rápida.</strong> Con estos filtros hay {int(count)} anuncios y el m² mediano es {millions(k.price_m2_median_cop, 1)},{" "}
            {Math.abs(deltaVsNational) < 1
              ? "igual que"
              : `${dec(Math.abs(deltaVsNational), 0)} % ${deltaVsNational > 0 ? "por encima de" : "por debajo de"}`}{" "}
            la mediana nacional ({millions(initial.kpis.price_m2_median_cop, 1)}).
          </p>
        )}

        {count > 0 && (
          <KpiStrip
            label="Cifras del mercado"
            cells={[
              {
                label: "Anuncios",
                value: int(count),
                caption: active ? `${pct((100 * count) / total, 1)} del total` : "apartamentos únicos",
              },
              {
                label: "Precio mediano",
                value: millions(k.price_median_cop),
                caption: `mitad entre ${millions(k.price_p25_cop)} y ${millions(k.price_p75_cop)}`,
              },
              { label: "Precio por m² mediano", value: millions(k.price_m2_median_cop, 1), caption: "por metro cuadrado" },
              { label: "Área mediana", value: dec(k.area_median_m2, 0), unit: "m²", caption: "área privada" },
            ]}
          />
        )}

        <section id="mercado" className="sec" aria-labelledby="h-mercado">
          <h2 id="h-mercado">Mercado</h2>
          <p className="sec-note">Dónde está caro el m², cómo se distribuyen los precios y qué ofrecen los anuncios.</p>

          {count === 0 ? (
            <Card title="Sin resultados">
              <EmptyNote>Ningún anuncio cumple estos filtros.</EmptyNote>
              <button className="btn" onClick={clear}>
                Quitar filtros
              </button>
            </Card>
          ) : (
            <>
              <Card title="Precio por m² mediano" note="Elige el nivel; la lista ordena los más caros.">
                <MarketMap departments={summary.byDepartment} cities={summary.byCity} minListings={active ? 10 : 100} />
              </Card>

              <div className="grid2">
                <Card title="Distribución de precios" note="Anuncios por rango de precio, hasta el percentil 99.">
                  {summary.histogram ? (
                    <Histogram
                      edges={summary.histogram.edges_cop}
                      counts={summary.histogram.counts}
                      xFormat="millions"
                      marker={{ value: k.price_median_cop, label: `Mediana ${millions(k.price_median_cop)}` }}
                      label="Histograma del precio de los anuncios en millones de pesos"
                    />
                  ) : (
                    <EmptyNote>Muy pocos anuncios para dibujar la distribución.</EmptyNote>
                  )}
                </Card>
                <Card title="Precio por estrato" note="Caja: mitad central. Marca: mediana. Línea: rango sin atípicos.">
                  {summary.byStratum.length ? (
                    <StratumRange rows={summary.byStratum} />
                  ) : (
                    <EmptyNote>Muy pocos anuncios con estrato para dibujar esta comparación.</EmptyNote>
                  )}
                </Card>
              </div>

              <div className="grid2">
                <Card title="Ciudades con más anuncios" note="Anuncios y su peso en el total.">
                  <BarList
                    label="Ciudades con más anuncios"
                    rows={summary.topCities.map((c) => ({
                      label: c.city,
                      value: c.listings,
                      display: int(c.listings),
                      note: `· ${pct((100 * c.listings) / count, 1)}`,
                    }))}
                  />
                </Card>
                <Card title="Amenidades más frecuentes" note="Parte de los anuncios que la menciona.">
                  {summary.amenities.length ? (
                    <BarList
                      label="Amenidades más frecuentes"
                      rows={summary.amenities.map((a) => ({
                        label: a.amenity,
                        value: a.listings,
                        display: pct(a.share_pct, 1),
                        note: `· ${int(a.listings)}`,
                      }))}
                    />
                  ) : (
                    <EmptyNote>Ningún anuncio de este grupo menciona amenidades.</EmptyNote>
                  )}
                </Card>
              </div>

              <Card title="Precio según quién anuncia" note="Mediana de precio por m² por tipo de anunciante, frente a las empresas.">
                <OwnerCompare groups={summary.byOwner} effects={ownerEffects} total={count} />
              </Card>
            </>
          )}
        </section>

        {points && rows ? (
          <Opportunities points={points} rows={rows} filtered={active} />
        ) : (
          <section id="oportunidades" className="sec" aria-labelledby="h-oportunidades">
            <h2 id="h-oportunidades">Oportunidades de mercado</h2>
            <Card title="Precio frente al área">
              <EmptyNote>{failed ? "No se pudieron cargar los anuncios. Recarga la página para intentarlo de nuevo." : "Cargando los anuncios…"}</EmptyNote>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
