import { dec, int, millions, pct } from "@/lib/format";
import type { Summary } from "@/lib/stats";
import type { OwnerGroup, OwnerSummary } from "@/lib/types";

const EMPRESA = 1;
const ASESOR = 2;
const PROPIETARIO = 3;
const DESARROLLADOR = 4;

// Con menos anuncios que esto la mediana de un grupo es poco confiable (en una ciudad pequena un solo proyecto la mueve).
const FEW = 30;

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${dec(Math.abs(n), 1)} %`;

/** El intervalo de confianza incluye el cero: no se puede afirmar que haya diferencia. */
const unclear = (g: OwnerGroup) => (g.ci_low ?? 0) <= 0 && (g.ci_high ?? 0) >= 0;

/** Lo que se pide de mas o de menos, o "sin diferencia clara" cuando el dato no alcanza para afirmarlo. */
const verdict = (g: OwnerGroup | undefined) =>
  g?.effect_pct === undefined ? "sin dato" : unclear(g) ? "sin diferencia clara" : signed(g.effect_pct);

type Props = {
  /** Medianas por grupo para los anuncios que cumplen los filtros. */
  groups: Summary["byOwner"];
  /** Efecto a igualdad de condiciones, calculado a nivel nacional (no cambia con los filtros). */
  effects: OwnerSummary;
  total: number;
};

export default function OwnerCompare({ groups, effects, total }: Props) {
  const reference = groups.find((g) => g.code === EMPRESA);
  const effect = (code: number) => effects.groups.find((g) => g.code === code);
  const asesor = effect(ASESOR);
  const propietario = effect(PROPIETARIO);
  const desarrollador = effect(DESARROLLADOR);

  return (
    <>
      <table className="owner-table">
        <thead>
          <tr>
            <th>Anunciante</th>
            <th className="r">Anuncios</th>
            <th className="r">Precio por m² mediano</th>
            <th className="r">Frente a empresas</th>
            <th className="r" title={`A igualdad de ${effects.controls}. Cifra nacional: no cambia con los filtros.`}>
              A igualdad de condiciones
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const has = g.listings > 0 && Number.isFinite(g.price_m2_median);
            const few = has && g.listings < FEW;
            const raw =
              g.code === EMPRESA
                ? "Referencia"
                : few
                  ? "Pocos datos"
                  : has && reference && reference.listings > 0 && Number.isFinite(reference.price_m2_median)
                  ? signed((g.price_m2_median / reference.price_m2_median - 1) * 100)
                  : "—";
            const adjusted = effect(g.code);
            return (
              <tr key={g.code}>
                <td className="name">{g.label}</td>
                <td className="r num" data-label="Anuncios">
                  <span>
                    {int(g.listings)} <span className="muted small">· {pct((100 * g.listings) / Math.max(total, 1), 1)}</span>
                  </span>
                </td>
                <td className="r num" data-label="Precio por m² mediano">
                  {has ? <span className={few ? "muted" : undefined}>{millions(g.price_m2_median, 1)}</span> : "—"}
                </td>
                <td className="r num" data-label="Frente a empresas">
                  {raw}
                </td>
                <td className="r num" data-label="A igualdad de condiciones">
                  {g.code === EMPRESA || !adjusted ? (
                    "Referencia"
                  ) : unclear(adjusted) ? (
                    <span className="muted">Sin diferencia clara</span>
                  ) : (
                    <span>
                      {signed(adjusted.effect_pct!)}{" "}
                      <span className="muted small">
                        ({dec(adjusted.ci_low!, 1)} a {dec(adjusted.ci_high!, 1)})
                      </span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="foot">
        <strong>A igualdad de {effects.controls}</strong>, los asesores independientes piden {verdict(asesor)} y los propietarios directos,{" "}
        {verdict(propietario)}, frente a las empresas. Los desarrolladores piden {verdict(desarrollador)}, sobre todo porque venden proyectos nuevos y no se
        puede separar ese efecto del de ser nuevo.
      </p>
      <p className="foot muted">
        La clasificación es aproximada: se deduce del nombre del anunciante. Son precios de oferta, no de cierre, y la columna de igualdad de condiciones es
        nacional y no cambia con los filtros.
      </p>
    </>
  );
}
