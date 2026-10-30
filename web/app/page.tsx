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

function weeksBetween(from: string, to: string) {
  return Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000 / 7));
}

export default async function Page() {
  const { kpis, histogram, byDepartment, byCity, topCities, amenities, byStratum, places, meta, model, dynamics } = await loadAll();

  const priciest = [...byDepartment].filter((d) => d.listings >= 100).sort((a, b) => b.price_m2_median - a.price_m2_median)[0];
  const t = dynamics.turnover;
  const pc = dynamics.price_changes;
  const lvl = dynamics.price_level;
  const weeks = weeksBetween(dynamics.date_from, dynamics.date_to);
  const gen = new Date(meta.generated_at);

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
  };

  return (
    <>
      <SiteBar />
      <main id="top" className="wrap">
        <div className="title-row">
          <div>
            <h1>Apartamentos en venta en Colombia</h1>
            <p className="lede">
              {int(kpis.listings)} anuncios capturados entre el {shortDate(meta.data_from)} y el {shortDate(meta.data_to)}. El metro cuadrado
              mediano del país vale {millions(kpis.price_m2_median_cop, 1)}; {priciest.department} es el departamento más caro, con{" "}
              {millions(priciest.price_m2_median, 1)} por m².
            </p>
          </div>
          <a className="btn" href="#estimador">
            Estimar el precio de un apartamento
          </a>
        </div>

        <MarketScope initial={initial} mapCities={byCity.map((c) => ({ city: c.city, department: c.department }))} />

        <section id="estimador" className="sec sec-feature" aria-labelledby="h-estimador">
          <h2 id="h-estimador">Estimador de precio</h2>
          <p className="sec-note">
            <strong>¿Cuánto vale tu apartamento?</strong> Descríbelo y el modelo calcula un precio de referencia comparándolo con los{" "}
            {int(model.n_rows)} anuncios con los que se entrenó.
          </p>
          <Estimator places={places} cities={byCity} amenities={model.amenities} mape={model.metrics_cv["MAPE_%"]} />
        </section>

        <section id="dinamica" className="sec" aria-labelledby="h-dinamica">
          <h2 id="h-dinamica">Dinámica del mercado</h2>
          <p className="sec-note">
            Qué cambia entre capturas repetidas del mismo mercado: {dynamics.n_runs} corridas entre el {shortDate(dynamics.date_from)} y el{" "}
            {shortDate(dynamics.date_to)} (unas {weeks} semanas). Son precios de oferta, no de cierre.
          </p>

          {t && pc && (
            <KpiStrip
              label="Indicadores de dinámica"
              cells={[
                { label: "Persisten entre corridas", value: pct(t.persist_pct_mean), caption: "de los anuncios de una corrida siguen en la siguiente" },
                ...(t.reappear_pct_mean !== null
                  ? [{ label: "Reaparecen", value: pct(t.reappear_pct_mean), caption: "de los que faltaron vuelven en la siguiente: es cobertura, no ventas" }]
                  : []),
                { label: "Cambian de precio", value: pct(pc.changed_pct, 1), caption: `de ${int(pc.comparisons)} comparaciones entre corridas` },
                { label: "No vuelven a verse", value: `≤ ${pct(t.never_return_pct_upper_bound)}`, caption: "de la primera corrida, cota de los retiros reales" },
              ]}
            />
          )}

          <div className="grid2">
            {lvl && (
              <Card
                title="Nivel de precios, base 100"
                note="Primera corrida igual a 100. Con los mismos anuncios el nivel no se mueve."
                legend={
                  <ul className="legend" aria-label="Series">
                    <li><i className="sw main" />Mediana por m² (todos)</li>
                    <li><i className="sw ink" />Anuncios que persisten</li>
                    <li><i className="sw grey" />Panel balanceado</li>
                  </ul>
                }
              >
                <LineChart
                  labels={lvl.dates.map(dayMonth)}
                  yMin={99}
                  yMax={102}
                  reference={100}
                  yDecimals={1}
                  label="Índice de precios por corrida, base 100"
                  series={[
                    { name: "Mediana por m² (todos)", values: lvl.median_price_m2, tone: "main" },
                    { name: "Anuncios que persisten", values: lvl.chained, tone: "ink" },
                    ...(lvl.balanced ? [{ name: "Panel balanceado", values: lvl.balanced, tone: "grey" as const, dashed: true }] : []),
                  ]}
                />
                <p className="foot muted">
                  La mediana por m² sube {dec(lvl.median_price_m2[lvl.median_price_m2.length - 1] - 100, 1)} %: es un cambio de mezcla de anuncios, no un alza de precios.
                </p>
              </Card>
            )}
            {pc && (
              <Card
                title="Cuánto cambian los que cambian"
                note={`Variación del precio de un mismo anuncio entre corridas (solo los ${int(pc.changed)} que cambiaron; recortada a ±30 %).`}
              >
                <Histogram
                  edges={pc.histogram.edges_pct}
                  counts={pc.histogram.counts}
                  xFormat="signedPct"
                  marker={{ value: 0, label: "Sin cambio" }}
                  label="Histograma de la variación de precio entre corridas"
                />
                <p className="foot muted">
                  {pc.down_pct !== null && `${dec(pc.down_pct, 0)} % son bajas. `}
                  {pc.median_abs_change_pct !== null && `El cambio mediano es de ${dec(pc.median_abs_change_pct, 1)} %. `}
                  {pc.p10_pct !== null && pc.p90_pct !== null && `El 80 % central va de ${dec(pc.p10_pct, 1)} % a +${dec(pc.p90_pct, 1)} %.`}
                </p>
              </Card>
            )}
          </div>

          <div className="grid2">
            <Card title="Corridas" note="Anuncios únicos y precio mediano por m² en cada captura.">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="r">Anuncios</th>
                    <th className="r">Mediana por m²</th>
                  </tr>
                </thead>
                <tbody>
                  {dynamics.runs.map((r) => (
                    <tr key={r.date}>
                      <td>{shortDate(r.date)}</td>
                      <td className="r num">{int(r.listings)}</td>
                      <td className="r num">{millions(r.median_price_m2, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Cómo leerlo">
              <div className="prose">
                <p>
                  <strong>La rotación aparente es sobre todo cobertura incompleta.</strong> Solo {t ? pct(t.persist_pct_mean, 0) : "una parte"} de los anuncios
                  persiste entre corridas, pero casi la mitad de los que faltan reaparece en la siguiente
                  {t?.truly_new_pct_mean != null && `, y solo el ${pct(t.truly_new_pct_mean, 1)} de los “nuevos” se publicó realmente después`}. Una captura
                  no es un censo del mercado.
                </p>
                <p>
                  <strong>Los retiros reales son pocos.</strong>{" "}
                  {t ? `Como máximo el ${pct(t.never_return_pct_upper_bound)} de los anuncios de la primera corrida no vuelve a aparecer en ninguna de las siguientes` : "Pocos anuncios desaparecen"}
                  , y esa cota incluye anuncios que el scraper simplemente no vio.
                </p>
                <p>
                  <strong>Los vendedores casi no ajustan el precio.</strong> Menos de uno de cada cien anuncios cambia de precio en unas {weeks} semanas, y
                  cuando lo hace suele ser una baja.
                </p>
                <p>
                  <strong>Qué falta.</strong> Una ventana tan corta no muestra tendencias ni estacionalidad. Cada corrida nueva alarga la serie, y estas
                  cifras se recalculan con ella.
                </p>
              </div>
            </Card>
          </div>
        </section>

        <section id="modelo" className="sec" aria-labelledby="h-modelo">
          <h2 id="h-modelo">El modelo</h2>
          <p className="sec-note">
            {model.model_name} sobre el logaritmo del precio, entrenado el {shortDate(model.trained_at)} con {int(model.n_rows)} anuncios.
          </p>

          <KpiStrip
            label="Métricas del modelo en validación cruzada"
            cells={[
              { label: "Error porcentual medio", value: pct(model.metrics_cv["MAPE_%"]), caption: `validación cruzada; en reserva ${pct(model.metrics_holdout["MAPE_%"])}` },
              { label: "R²", value: dec(model.metrics_cv.R2, 3), caption: `parte de la variación del precio que explica; en reserva ${dec(model.metrics_holdout.R2, 3)}` },
              { label: "Error absoluto medio", value: millions(model.metrics_cv.MAE_COP), caption: "pesos de diferencia típica con el precio publicado" },
              { label: "Raíz del error cuadrático", value: millions(model.metrics_cv.RMSE_COP), caption: "pesa más los errores grandes" },
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
            <Card title="Parámetros" note="Los que más influyen en cómo aprende el modelo.">
              <dl className="kv">
                {Object.entries(model.hyperparameters).map(([key, value]) => (
                  <div key={key}>
                    <dt className="mono">{key}</dt>
                    <dd className="num">{value.toLocaleString("es-CO", { maximumFractionDigits: 4 })}</dd>
                  </div>
                ))}
              </dl>
              <p className="notice">
                <strong>Limitación conocida.</strong> El modelo se equivoca más en los inmuebles de lujo y de precio muy alto, donde hay pocos anuncios
                comparables. Úsalo como referencia, no como avalúo.
              </p>
            </Card>
          </div>
        </section>
      </main>

      <footer className="foot-site">
        <div className="wrap foot-in">
          <p>
            Datos: anuncios de apartamentos en venta de Fincaraíz capturados entre el {shortDate(meta.data_from)} y el {shortDate(meta.data_to)}. Cifras
            calculadas el {shortDate(gen.toISOString())}. Son precios de oferta, no de cierre.
          </p>
          <p>
            <a href="https://github.com/FaiberCh/inmostats">Código en GitHub</a>
            <span aria-hidden> · </span>
            <a href="https://fchaparro-inmostats-api.hf.space/docs">API del modelo</a>
          </p>
        </div>
      </footer>
    </>
  );
}
