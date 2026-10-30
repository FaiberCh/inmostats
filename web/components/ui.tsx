export type KpiCell = { label: string; value: string; unit?: string; caption: string };

/** Cifras clave en un solo contenedor dividido por lineas de 1px; en el telefono pasa a 2 columnas. */
export function KpiStrip({ cells, label }: { cells: KpiCell[]; label: string }) {
  return (
    <dl className="kpis" aria-label={label} style={{ ["--cols" as string]: cells.length }}>
      {cells.map((c) => (
        <div key={c.label} className="kpi">
          <dt>{c.label}</dt>
          <dd className="num">
            {c.value}
            {c.unit && <span className="unit"> {c.unit}</span>}
          </dd>
          <dd className="cap">{c.caption}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Card({
  title,
  note,
  children,
  legend,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  legend?: React.ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-h">
        <div>
          <h3 className="sub">{title}</h3>
          {note && <p className="note">{note}</p>}
        </div>
        {legend}
      </header>
      {children}
    </section>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}
