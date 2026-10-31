import { int, millions } from "@/lib/format";
import type { Summary } from "@/lib/stats";
import type { OwnerSummary } from "@/lib/types";
import BarList from "./BarList";
import OwnerEffectChart from "./OwnerEffectChart";
import { Card } from "./ui";

// Con menos anuncios que esto la mediana de un grupo es poco confiable (en una ciudad pequena un solo proyecto la mueve).
const FEW = 30;

type Props = {
  /** Medianas por grupo para los anuncios que cumplen los filtros. */
  groups: Summary["byOwner"];
  /** Efecto a igualdad de condiciones, calculado a nivel nacional (no cambia con los filtros). */
  effects: OwnerSummary;
};

export default function OwnerCompare({ groups, effects }: Props) {
  const shown = groups.filter((g) => g.listings > 0 && Number.isFinite(g.price_m2_median));

  return (
    <>
      <div className="grid2">
        <Card title="Precio por m² según quién anuncia" note="Mediana de los anuncios filtrados.">
          {shown.length ? (
            <BarList
              label="Precio por m² mediano según quién anuncia"
              rows={shown.map((g) => ({
                label: g.label.replace(" (proyectos nuevos)", ""),
                value: g.price_m2_median,
                display: millions(g.price_m2_median, 1),
                note: g.listings < FEW ? `· ${int(g.listings)}, pocos datos` : `· ${int(g.listings)}`,
              }))}
            />
          ) : (
            <p className="empty">Sin anuncios clasificados en esta selección.</p>
          )}
        </Card>
        <Card title="Diferencia frente a las empresas" note={`A igualdad de ${effects.controls}. Cifra nacional.`}>
          <OwnerEffectChart groups={effects.groups} />
        </Card>
      </div>
      <p className="foot muted">
        Clasificación aproximada, deducida del nombre del anunciante. Precios de oferta, no de cierre. Los desarrolladores venden proyectos nuevos y no se
        puede separar ese efecto del de ser nuevo.
      </p>
    </>
  );
}
