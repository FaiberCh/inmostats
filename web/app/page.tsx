import Estimator from "@/components/Estimator";
import LineChart from "@/components/LineChart";
import BarList from "@/components/BarList";
import Histogram from "@/components/Histogram";
import MarketScope from "@/components/MarketScope";
import SiteBar from "@/components/SiteBar";
import { Card, KpiStrip } from "@/components/ui";
import { loadAll } from "@/lib/data";
import { dayMonth, dec, featureLabel, int, millions, pct, shortDate } from "@/lib/format";
import type { Summary } from "@/lib/stats";

// Nombres de los hiperparametros del modelo en lenguaje llano (el nombre tecnico queda como tooltip).
const PARAM_LABELS: Record<string, string> = {
  n_estimators: "Árboles",
  max_depth: "Profundidad máxima",
  learning_rate: "Tasa de aprendizaje",
  subsample: "Fracción de filas por árbol",
  colsample_bytree: "Fracción de variables por árbol",
  min_child_weight: "Peso mínimo por hoja",
  min_samples_leaf: "Mínimo de anuncios por hoja",
};

function weeksBetween(from: string, to: string) {
  return Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000 / 7));
}

export default async function Page() {
  const { kpis, histogram, byDepartment, byCity, topCities, amenities, byStratum, places, meta, model, dynamics, owner } = await loadAll();

  const ranked = [...byDepartment].filter((d) => d.listings >= 100).sort((a, b) => b.price_m2_median - a.price_m2_median);
  const [first] = ranked;
  const t = dynamics.turnover;
  const pc = dynamics.price_changes;
  const lvl = dynamics.price_level;
  const weeks = weeksBetween(dynamics.date_from, dynamics.date_to);
  const lastRun = dynamics.runs[dynamics.runs.length - 1];
  // Escala de la grafica de nivel: ajustada a los indices (casi planos), no a la mediana que se deja fuera.
  const levelValues = lvl ? [...lvl.chained, ...(lvl.balanced ?? []), 100] : [100];
  const levelMin = Math.floor((Math.min(...levelValues) - 0.2) * 10) / 10;
  const levelMax = Math.ceil((Math.max(...levelValues) + 0.2) * 10) / 10;
  // Persistencia solo entre capturas comparables: a menos de una semana y con una cobertura parecida (la de noviembre es otra cosa).
  const listingsByDate = new Map(dynamics.runs.map((r) => [r.date, r.listings]));
  const comparablePairs = (t?.pairs ?? []).filter((pair) => {
    const days = (Date.parse(pair.to) - Date.parse(pair.from)) / 86_400_000;
    const a = listingsByDate.get(pair.from) ?? 0;
    const b = listingsByDate.get(pair.to) ?? 0;
    return days <= 7 && a > 0 && Math.abs(b - a) / a < 0.1;
  });
  const comparablePersist = comparablePairs.length
    ? comparablePairs.reduce((sum, pair) => sum + pair.persist_pct, 0) / comparablePairs.length
    : null;
  const gen = new Date(meta.generated_at);

  // Tres hallazgos para leer en 20 segundos. Todo sale de los datos: nada esta escrito a mano.
  const shortLabel = (name: string) => featureLabel(name).replace(/ \(m²\)$/, "");
  const [f1, f2, f3] = model.top_features.map(([name, weight]) => ({ label: shortLabel(name), pct: weight * 100 }));
  const bigTwoShare = topCities.length > 1 ? (100 * (topCities[0].listings + topCities[1].listings)) / kpis.listings : null;
  const findings = [
    {
      label: "Dónde está más caro el m²",
      figure: first.department,
      text: `${millions(first.price_m2_median, 1)} por m², frente a ${millions(kpis.price_m2_median_cop, 1)} nacional.${
        bigTwoShare !== null ? ` ${topCities[0].city} y ${topCities[1].city} reúnen el ${pct(bigTwoShare, 0)} de los anuncios.` : ""
      }`,
    },
    {
      label: "Qué pesa más en el precio",
      figure: `${f1.label} y ${f2.label.toLowerCase()}`,
      text: `${pct(f1.pct, 0)} y ${pct(f2.pct, 0)} de la importancia en el modelo, más que ${f3.label.toLowerCase()} (${pct(f3.pct, 0)}). Error promedio: ${pct(model.metrics_cv["MAPE_%"], 1)}.`,
    },
    ...(pc
      ? [
          {
            label: "Cuánto se mueve el mercado",
            figure: pct(pc.changed_pct, 1),
            text: `de los anuncios cambió de precio en unas ${weeks} semanas; el nivel quedó plano.`,
          },
        ]
      : []),
  ];

  // Vista sin filtros: es lo que trae el HTML y lo que se ve hasta que cargan los anuncios para filtrar.
  const initial: Summary = {
    count: kpis.listings,
    kpis: {
      price_median_cop: kpis.price_median_cop,
      price_p25_cop: kpis.price_p25_cop,
      price_p75_cop: kpis.price_p75_cop,
      price_m2_median_cop: kpis.price_m2_median_cop,
      area_median_m2: kpis.area_median_m2,
    },
    histogram,
    byDepartment,
    byCity,
    topCities,
    amenities,
    byStratum,
    byOwner: owner.groups.map((g) => ({ code: g.code, label: g.label, listings: g.listings, price_m2_median: g.price_m2_median })),
  };

  return (
    <>
      <SiteBar />
      <main id="top" className="wrap">
        <div className="title-row">
          <div>
            <h1>Apartamentos en venta en Colombia</h1>
            <p className="lede">
              Precios de oferta de {int(kpis.listings)} apartamentos, del {dayMonth(meta.data_from)} al {shortDate(meta.data_to)}. Cifras en medianas.
            </p>
          </div>
          <a className="btn" href="#estimador">
            Estimar el precio de un apartamento
          </a>
        </div>

        <section className="exec" aria-labelledby="h-esencial">
          <h2 id="h-esencial">Lo esencial</h2>
          <ol className="exec-grid" style={{ ["--cols" as string]: findings.length }}>
            {findings.map((f) => (
              <li key={f.label} className="exec-item">
                <p className="exec-label">{f.label}</p>
                <p className="exec-figure">{f.figure}</p>
                <p className="exec-text">{f.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <MarketScope initial={initial} ownerEffects={owner} mapCities={byCity.map((c) => ({ city: c.city, department: c.department }))} />

        <section id="estimador" className="sec sec-feature" aria-labelledby="h-estimador">
          <h2 id="h-estimador">Estimador de precio</h2>
          <p className="sec-note">
            <strong>¿Cuánto vale tu apartamento?</strong> Descríbelo y el modelo calcula un precio de referencia.
          </p>
          <Estimator places={places} cities={byCity} amenities={model.amenities} mape={model.metrics_cv["MAPE_%"]} />
        </section>

        <section id="dinamica" className="sec" aria-labelledby="h-dinamica">
          <h2 id="h-dinamica">Cambios de precio en el tiempo</h2>
          <p className="sec-note">
            Precios de oferta, no de cierre. {dynamics.n_runs} capturas entre el {shortDate(dynamics.date_from)} y el {shortDate(dynamics.date_to)} (unas{" "}
            {weeks} semanas).
          </p>

          {pc && (
            <KpiStrip
              label="Cambios de precio de los anuncios"
              cells={[
                { label: "Cambian de precio", value: pct(pc.changed_pct, 1), caption: `de ${int(pc.comparisons)} comparaciones` },
                ...(pc.down_pct !== null ? [{ label: "Son bajas", value: pct(pc.down_pct, 0), caption: "de los que cambian" }] : []),
                ...(pc.median_abs_change_pct !== null
                  ? [{ label: "Cambio típico", value: pct(pc.median_abs_change_pct, 1), caption: "mediana del tamaño del cambio" }]
                  : []),
              ]}
            />
          )}

          <div className="grid2">
            {lvl && (
              <Card
                title="Nivel de precios, base 100"
                note="Primera captura igual a 100. Con los mismos anuncios el nivel casi no se mueve."
                legend={
                  <ul className="legend" aria-label="Series">
                    <li><i className="sw main" />Anuncios que persisten</li>
                    <li><i className="sw grey" />Panel balanceado</li>
                  </ul>
                }
              >
                <LineChart
                  labels={lvl.dates.map(dayMonth)}
                  yMin={levelMin}
                  yMax={levelMax}
                  reference={100}
                  yDecimals={1}
                  label="Índice de precios por captura, base 100"
                  series={[
                    { name: "Anuncios que persisten", values: lvl.chained, tone: "main" },
                    ...(lvl.balanced ? [{ name: "Panel balanceado", values: lvl.balanced, tone: "grey" as const, dashed: true }] : []),
                  ]}
                />
                <p className="foot muted">
                  Entre julio y noviembre pasaron más de tres meses y la cobertura cambió. La mediana de todos los anuncios no se dibuja
                  porque mezcla zonas distintas.
                </p>
              </Card>
            )}
            {pc && (
              <Card
                title="Cuánto cambian los que cambian"
                note={`Variación de precio de los ${int(pc.changed)} anuncios que cambiaron (recortada a ±30 %).`}
              >
                <Histogram
                  edges={pc.histogram.edges_pct}
                  counts={pc.histogram.counts}
                  xFormat="signedPct"
                  marker={{ value: 0, label: "Sin cambio" }}
                  label="Histograma de la variación de precio entre capturas"
                />
                <p className="foot muted">
                  {pc.p10_pct !== null && pc.p90_pct !== null && `El 80 % central va de ${dec(pc.p10_pct, 1)} % a +${dec(pc.p90_pct, 1)} %. `}
                  Una ventana de {weeks} semanas no muestra tendencias ni estacionalidad.
                </p>
              </Card>
            )}
          </div>

          <Card title="Cómo se recogieron los datos" note="Nota de método: sirve para leer bien las cifras de arriba.">
            <div className="prose">
                <p>
                  <strong>Cada captura es una foto, no un censo.</strong>{" "}
                  {comparablePersist !== null
                    ? `En las capturas de julio, que son comparables entre sí, cerca del ${pct(comparablePersist, 0)} de los anuncios de una captura seguía en la siguiente. `
                    : ""}
                  Parte de los que faltan no se retiraron: el sitio no los devolvió esa vez.
                </p>
                <p>
                  <strong>La de noviembre es la primera captura completa.</strong> Recorre {int(lastRun.listings)} anuncios, muchos más que en julio, sobre todo en
                  Bogotá y Antioquia. Por eso comparar julio con noviembre mezcla tiempo con cobertura, y los índices de arriba usan solo los anuncios que aparecen
                  en ambas capturas.
                </p>
            </div>
          </Card>
        </section>

        <section id="modelo" className="sec" aria-labelledby="h-modelo">
          <h2 id="h-modelo">El modelo</h2>
          <p className="sec-note">
            {model.model_name} sobre el logaritmo del precio, entrenado el {shortDate(model.trained_at)} con {int(model.n_rows)} anuncios.
          </p>

          <KpiStrip
            label="Métricas del modelo en validación cruzada"
            cells={[
              { label: "Error porcentual medio", value: pct(model.metrics_cv["MAPE_%"]), caption: `en reserva: ${pct(model.metrics_holdout["MAPE_%"])}` },
              { label: "R²", value: dec(model.metrics_cv.R2, 3), caption: `en reserva: ${dec(model.metrics_holdout.R2, 3)}` },
              { label: "Error absoluto medio", value: millions(model.metrics_cv.MAE_COP), caption: "error típico en pesos" },
              { label: "Raíz del error cuadrático", value: millions(model.metrics_cv.RMSE_COP), caption: "castiga los errores grandes" },
            ]}
          />

          <div className="grid2">
            <Card title="Variables que más pesan" note="Importancia relativa en el modelo.">
              <BarList
                label="Variables más importantes"
                rows={model.top_features.map(([name, weight]) => ({
                  label: featureLabel(name),
                  value: weight,
                  display: pct(weight * 100, 1),
                }))}
              />
            </Card>
            <Card title="Parámetros" note="Con los que se entrenó el modelo.">
              <dl className="kv">
                {Object.entries(model.hyperparameters).map(([key, value]) => (
                  <div key={key}>
                    <dt title={key}>{PARAM_LABELS[key] ?? key.replace(/_/g, " ")}</dt>
                    <dd className="num">{value.toLocaleString("es-CO", { maximumFractionDigits: 4 })}</dd>
                  </div>
                ))}
              </dl>
              <p className="notice">
                <strong>Limitación conocida.</strong> El modelo falla más en inmuebles de lujo, donde hay pocos anuncios comparables. Úsalo como referencia, no como
                avalúo.
              </p>
            </Card>
          </div>
        </section>
      </main>

      <footer className="foot-site">
        <div className="wrap foot-in">
          <p>
            Datos: anuncios de apartamentos en venta de Fincaraíz, del {shortDate(meta.data_from)} al {shortDate(meta.data_to)}. Cifras calculadas el{" "}
            {shortDate(gen.toISOString())}. Precios de oferta, no de cierre.
          </p>
          <p>
            <a href="https://fchaparro-inmostats-api.hf.space/docs">API del modelo</a>
          </p>
        </div>
      </footer>
    </>
  );
}
