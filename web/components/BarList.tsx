type Row = { label: string; value: number; display: string; note?: string };

/** Ranking ordenado: etiqueta, cifra a la derecha y una barra fina proporcional debajo (la primera en tinta, el resto en gris). */
export default function BarList({ rows, label }: { rows: Row[]; label: string }) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <ol className="barlist" aria-label={label}>
      {rows.map((r, i) => (
        <li key={r.label}>
          <div className="barlist-line">
            <span className="barlist-name">{r.label}</span>
            <span className="num barlist-value">
              {r.display}
              {r.note && <span className="muted"> {r.note}</span>}
            </span>
          </div>
          <div className="barlist-track" aria-hidden>
            <div className={i === 0 ? "barlist-fill first" : "barlist-fill"} style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}
