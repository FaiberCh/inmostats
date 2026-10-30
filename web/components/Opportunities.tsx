"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { dec, int, millions, pesos, shortDate } from "@/lib/format";
import { listingUrl, type Points } from "@/lib/points";
import { niceStep, ticks } from "@/lib/scale";
import {
  ABOVE_RATIO,
  BELOW_RATIO,
  Position,
  classify,
  quantileSorted,
  type Classified,
  type Reference,
} from "@/lib/stats";
import { Card, EmptyNote } from "./ui";
import { useThemeVersion } from "./useThemeVersion";
import { useWidth } from "./useWidth";

type Props = { points: Points; rows: Uint32Array; filtered: boolean };

type Selection = { k: number; pinned: boolean };

const M = { top: 12, right: 26, bottom: 28, left: 66 };
const HIT_MOUSE = 14;
const HIT_TOUCH = 26;
const TIP_W = 250;

const niceCeil = (v: number) => {
  const step = niceStep(v, 5);
  return Math.ceil(v / step) * step;
};

function positionLabel(position: number, reference: Reference): string {
  if (position === Position.Below) return reference === "zone" ? "Bajo la mediana de la zona" : "Bajo lo esperado por el modelo";
  if (position === Position.Above) return reference === "zone" ? "Sobre la mediana de la zona" : "Sobre lo esperado por el modelo";
  if (position === Position.Extreme) return "Valor extremo, posible error";
  return "En línea con la referencia";
}

export default function Opportunities({ points, rows, filtered }: Props) {
  const [reference, setReference] = useState<Reference>("zone");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tab, setTab] = useState<"below" | "above">("below");
  const hasExpected = points.meta.has_expected;
  const mode: Reference = hasExpected ? reference : "zone";

  const classified = useMemo(() => classify(points, rows, mode), [points, rows, mode]);

  // Una seleccion de una vista anterior ya no apunta al mismo anuncio: se descarta cuando cambian los filtros o la referencia.
  const [seenRows, setSeenRows] = useState<{ rows: Uint32Array; mode: Reference }>({ rows, mode });
  if (seenRows.rows !== rows || seenRows.mode !== mode) {
    setSeenRows({ rows, mode });
    setSelection(null);
  }

  const ranked = useMemo(() => {
    const wanted = tab === "below" ? Position.Below : Position.Above;
    const picks: number[] = [];
    for (let k = 0; k < rows.length; k++) if (classified.position[k] === wanted) picks.push(k);
    picks.sort((a, b) => (tab === "below" ? classified.ratio[a] - classified.ratio[b] : classified.ratio[b] - classified.ratio[a]));
    return picks.slice(0, 6);
  }, [rows, classified, tab]);

  const counts = classified.counts;
  const total = rows.length;

  return (
    <section id="oportunidades" className="sec" aria-labelledby="h-oportunidades">
      <h2 id="h-oportunidades">Oportunidades de mercado</h2>
      <p className="sec-note">
        Cada punto es un anuncio: su área y su precio. Los que cuestan bastante menos o bastante más que la referencia se resaltan.
        {filtered ? " Se muestran solo los anuncios que cumplen los filtros." : " Filtra por ciudad para comparar apartamentos de una misma zona."}
      </p>

      {total === 0 ? (
        <Card title="Precio frente al área">
          <EmptyNote>Ningún anuncio cumple estos filtros.</EmptyNote>
        </Card>
      ) : (
        <Card
          title="Precio frente al área"
          note={`${int(total)} anuncios. El eje vertical va en millones de pesos y el horizontal en metros cuadrados.`}
          legend={<Legend counts={counts} />}
        >
          <div className="map-controls">
            <div className="seg" role="tablist" aria-label="Referencia de comparación">
              <button role="tab" aria-selected={mode === "zone"} className={mode === "zone" ? "seg-on" : ""} onClick={() => setReference("zone")}>
                Mediana de la zona
              </button>
              <button
                role="tab"
                aria-selected={mode === "model"}
                className={mode === "model" ? "seg-on" : ""}
                disabled={!hasExpected}
                onClick={() => setReference("model")}
              >
                Precio esperado por el modelo
              </button>
            </div>
          </div>
          <ScatterCanvas
            points={points}
            rows={rows}
            classified={classified}
            mode={mode}
            selection={selection}
            onSelect={setSelection}
          />
          <p className="foot muted">
            {mode === "zone"
              ? `La línea es la mediana de precio por m² de estos anuncios (${millions(classified.medianPpm2, 1)} por m²). Los puntos en azul verdoso cuestan ${Math.round((1 - BELOW_RATIO) * 100)} % o más por debajo de ella; los oscuros, ${Math.round((ABOVE_RATIO - 1) * 100)} % o más por encima.`
              : `El color compara el precio publicado con el que el modelo esperaba, calculado sin que el modelo hubiera visto ese anuncio (validación cruzada). La línea sigue siendo la mediana por m² (${millions(classified.medianPpm2, 1)}), solo como guía.`}{" "}
            {counts[Position.Extreme] > 0 &&
              `Los ${int(counts[Position.Extreme])} puntos huecos están a menos de un tercio o a más del triple de su referencia: casi siempre son errores de captura y no entran en las listas.`}
          </p>
        </Card>
      )}

      {total > 0 && (
        <div className="grid2">
          <Card title="Mayores diferencias" note="Toca una fila para verla en el gráfico.">
            <div className="seg" role="tablist" aria-label="Sentido de la diferencia">
              <button role="tab" aria-selected={tab === "below"} className={tab === "below" ? "seg-on" : ""} onClick={() => setTab("below")}>
                Más por debajo
              </button>
              <button role="tab" aria-selected={tab === "above"} className={tab === "above" ? "seg-on" : ""} onClick={() => setTab("above")}>
                Más por encima
              </button>
            </div>
            {ranked.length === 0 ? (
              <EmptyNote>Ningún anuncio cae en este grupo con los filtros actuales.</EmptyNote>
            ) : (
              <ol className="difflist">
                {ranked.map((k) => (
                  <li key={k}>
                    <DiffRow points={points} row={rows[k]} ratio={classified.ratio[k]} onPick={() => setSelection({ k, pinned: true })} />
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Cómo leerlo">
            <div className="prose">
              <p>
                <strong>Es una señal estadística, no una recomendación.</strong> Un precio bajo puede ser una buena oportunidad, pero también un error de
                captura, un anuncio desactualizado o algo que los datos no ven: el estado del inmueble, el piso, la ubicación exacta.
              </p>
              <p>
                <strong>Compara dentro de una zona.</strong> Con todo el país a la vez, la mediana mezcla ciudades muy distintas. Elige un departamento y una
                ciudad, y la comparación se vuelve mucho más justa.
              </p>
              <p>
                <strong>Dos referencias.</strong> La mediana de la zona es fácil de verificar a mano. El modelo además tiene en cuenta el estrato, el
                barrio y los garajes, así que no marca como baratos los apartamentos pequeños o de estratos bajos solo por serlo.
              </p>
              <p className="muted small">Anuncios capturados hasta el {shortDate(points.meta.captured_to)}: pueden haber cambiado o haberse retirado.</p>
            </div>
          </Card>
        </div>
      )}
    </section>
  );
}

function Legend({ counts }: { counts: Classified["counts"] }) {
  return (
    <ul className="legend" aria-label="Posición frente a la referencia">
      <li>
        <i className="lg lg-in" />
        En línea {int(counts[Position.InLine])}
      </li>
      <li>
        <i className="lg lg-below" />
        Por debajo {int(counts[Position.Below])}
      </li>
      <li>
        <i className="lg lg-above" />
        Por encima {int(counts[Position.Above])}
      </li>
      <li>
        <i className="lg lg-extreme" />
        Extremos {int(counts[Position.Extreme])}
      </li>
    </ul>
  );
}

function DiffRow({ points, row, ratio, onPick }: { points: Points; row: number; ratio: number; onPick: () => void }) {
  const unit = points.meta.price_unit;
  const price = points.price[row] * unit;
  const diff = (ratio - 1) * 100;
  const hood = points.hood[row] ? points.meta.neighborhoods[points.hood[row] - 1] : null;
  const city = points.meta.cities[points.city[row]][0];
  return (
    <button className="diffrow" onClick={onPick}>
      <span className="diff-main">
        <span className="num diff-price">{millions(price)}</span>
        <span className="num diff-pct">
          {diff > 0 ? "+" : "−"}
          {dec(Math.abs(diff), 0)} %
        </span>
      </span>
      <span className="diff-sub muted">
        {hood ? `${hood}, ` : ""}
        {city} · {dec(points.area[row], 0)} m² · {points.beds[row]} hab.
      </span>
    </button>
  );
}

// --- Grafico de dispersion en canvas -------------------------------------------------------

type ScatterProps = {
  points: Points;
  rows: Uint32Array;
  classified: Classified;
  mode: Reference;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
};

function ScatterCanvas({ points, rows, classified, mode, selection, onSelect }: ScatterProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screen = useRef<{ px: Float32Array; py: Float32Array; k: Uint32Array; n: number } | null>(null);
  const pointerType = useRef<string>("mouse");
  const themeVersion = useThemeVersion();
  const unit = points.meta.price_unit;
  const height = width < 600 ? 320 : 400;
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;

  // Dominio: hasta el percentil 99 en cada eje, para que unos pocos anuncios enormes no aplasten al resto.
  const domain = useMemo(() => {
    const m = rows.length;
    const areas = new Float64Array(m);
    const prices = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      areas[k] = points.area[rows[k]];
      prices[k] = points.price[rows[k]] * unit;
    }
    areas.sort();
    prices.sort();
    return { xMax: niceCeil(quantileSorted(areas, 0.99) * 1.03), yMax: niceCeil(quantileSorted(prices, 0.99) * 1.03) };
  }, [points, rows, unit]);

  const xOf = (area: number) => M.left + (area / domain.xMax) * plotW;
  const yOf = (price: number) => M.top + plotH - (price / domain.yMax) * plotH;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const grid = color("--grid");
    const muted = color("--muted");
    const ink = color("--text");
    const accent = color("--accent");
    const faint = color("--faint");

    ctx.font = `11px ${fontFamily}`;
    ctx.textBaseline = "middle";

    // Ejes y cuadricula
    const yTicks = ticks(0, domain.yMax, 5);
    const xTicks = ticks(0, domain.xMax, width < 460 ? 4 : 7);
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.textAlign = "right";
    for (const t of yTicks) {
      const y = Math.round(yOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(M.left, y);
      ctx.lineTo(M.left + plotW, y);
      ctx.stroke();
      ctx.fillText(millions(t), M.left - 8, y);
    }
    ctx.textAlign = "center";
    for (const t of xTicks) ctx.fillText(`${t} m²`, xOf(t), M.top + plotH + 16);

    // Puntos visibles (dentro del dominio), agrupados por posicion para dibujar primero los "en linea"
    const m = rows.length;
    const px = new Float32Array(m);
    const py = new Float32Array(m);
    const ks = new Uint32Array(m);
    let n = 0;
    const byClass: number[][] = [[], [], [], []];
    for (let k = 0; k < m; k++) {
      const area = points.area[rows[k]];
      const price = points.price[rows[k]] * unit;
      if (area > domain.xMax || price > domain.yMax) continue;
      px[n] = xOf(area);
      py[n] = yOf(price);
      ks[n] = k;
      byClass[classified.position[k]].push(n);
      n++;
    }
    screen.current = { px, py, k: ks, n };

    const small = width < 600 ? 1.1 : 1.4;
    const drawSquares = (list: number[], fill: string, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (const j of list) ctx.rect(px[j] - small, py[j] - small, small * 2, small * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    const drawCircles = (list: number[], r: number, fill: string | null, stroke: string | null, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (const j of list) {
        ctx.moveTo(px[j] + r, py[j]);
        ctx.arc(px[j], py[j], r, 0, Math.PI * 2);
      }
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    drawSquares(byClass[Position.InLine], faint, 0.4);
    drawCircles(byClass[Position.Extreme], 3, null, muted, 0.7);
    drawCircles(byClass[Position.Below], 2.8, accent, null, 0.95);
    drawCircles(byClass[Position.Above], 2.8, ink, null, 0.95);

    // Linea de tendencia: precio = mediana por m2 x area (diagonal que parte del origen)
    const slope = classified.medianPpm2;
    if (Number.isFinite(slope) && slope > 0) {
      const xEnd = Math.min(domain.xMax, domain.yMax / slope);
      ctx.save();
      ctx.strokeStyle = ink;
      ctx.globalAlpha = mode === "zone" ? 0.9 : 0.45;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(0));
      ctx.lineTo(xOf(xEnd), yOf(slope * xEnd));
      ctx.stroke();
      ctx.restore();
      const label = `Mediana ${millions(slope, 1)}/m²`;
      const lx = xOf(xEnd * 0.62);
      const ly = yOf(slope * xEnd * 0.62) - 12;
      ctx.textAlign = "center";
      ctx.font = `500 11px ${fontFamily}`;
      const textW = ctx.measureText(label).width;
      const tx = Math.min(Math.max(lx, M.left + textW / 2 + 6), M.left + plotW - textW / 2 - 6);
      const ty = Math.max(ly, M.top + 10);
      ctx.fillStyle = color("--surface");
      ctx.globalAlpha = 0.88;
      ctx.fillRect(tx - textW / 2 - 4, ty - 8, textW + 8, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink;
      ctx.fillText(label, tx, ty);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, domain, rows, classified, mode, themeVersion]);

  const nearest = (x: number, y: number, radius: number) => {
    const s = screen.current;
    if (!s) return -1;
    let best = -1;
    let bestScore = radius * radius;
    for (let j = 0; j < s.n; j++) {
      const dx = s.px[j] - x;
      const dy = s.py[j] - y;
      const flagged = classified.position[s.k[j]] === Position.Below || classified.position[s.k[j]] === Position.Above;
      const score = dx * dx + dy * dy - (flagged ? 40 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    }
    return best < 0 ? -1 : s.k[best];
  };

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || selection?.pinned) return;
    const { x, y } = local(e);
    const k = nearest(x, y, HIT_MOUSE);
    if (k < 0) {
      if (selection) onSelect(null);
    } else if (selection?.k !== k) onSelect({ k, pinned: false });
  };

  const onClick = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const k = nearest(x, y, pointerType.current === "touch" ? HIT_TOUCH : HIT_MOUSE);
    onSelect(k < 0 ? null : { k, pinned: true });
  };

  // Posicion en pantalla del punto seleccionado (si esta dentro del dominio) para ubicar el anillo y la tarjeta
  const selRow = selection ? rows[selection.k] : null;
  const selPos =
    selRow !== null
      ? (() => {
          const area = points.area[selRow];
          const price = points.price[selRow] * unit;
          return area > domain.xMax || price > domain.yMax ? null : { x: xOf(area), y: yOf(price) };
        })()
      : null;
  const floating = selection !== null && selPos !== null && width >= 700;

  return (
    <div className="scatter-wrap">
      <div
        ref={wrapRef}
        className="scatter"
        style={{ height }}
        onPointerMove={onMove}
        onPointerDown={(e) => (pointerType.current = e.pointerType)}
        onPointerLeave={() => selection && !selection.pinned && onSelect(null)}
        onClick={onClick}
      >
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          role="img"
          aria-label={`Gráfico de dispersión de ${int(rows.length)} anuncios: área en metros cuadrados contra precio en pesos, con la línea de la mediana por metro cuadrado.`}
        />
        {selPos && <span className="ring" style={{ left: selPos.x, top: selPos.y }} />}
        {selection && selRow !== null && floating && selPos && (
          <TipCard
            floating
            style={{
              left: selPos.x + 16 + TIP_W > width ? Math.max(0, selPos.x - 16 - TIP_W) : selPos.x + 16,
              top: Math.min(Math.max(0, selPos.y - 50), height - 250),
            }}
            points={points}
            row={selRow}
            ratio={classified.ratio[selection.k]}
            position={classified.position[selection.k]}
            mode={mode}
            medianPpm2={classified.medianPpm2}
            pinned={selection.pinned}
            onClose={() => onSelect(null)}
          />
        )}
      </div>
      {selection && selRow !== null && !floating && (
        <TipCard
          points={points}
          row={selRow}
          ratio={classified.ratio[selection.k]}
          position={classified.position[selection.k]}
          mode={mode}
          medianPpm2={classified.medianPpm2}
          pinned
          onClose={() => onSelect(null)}
        />
      )}
    </div>
  );
}

// --- Tarjeta del anuncio -----------------------------------------------------------------------

type TipProps = {
  points: Points;
  row: number;
  ratio: number;
  position: number;
  mode: Reference;
  medianPpm2: number;
  pinned: boolean;
  floating?: boolean;
  style?: React.CSSProperties;
  onClose: () => void;
};

function TipCard({ points, row, ratio, position, mode, medianPpm2, pinned, floating, style, onClose }: TipProps) {
  const unit = points.meta.price_unit;
  const price = points.price[row] * unit;
  const area = points.area[row];
  const id = points.id[row];
  const hood = points.hood[row] ? points.meta.neighborhoods[points.hood[row] - 1] : null;
  const city = points.meta.cities[points.city[row]];
  const department = points.meta.departments[city[1]];
  const stratum = points.stratum[row];
  const diff = (ratio - 1) * 100;
  const tone = position === Position.Below ? "below" : position === Position.Above ? "above" : position === Position.Extreme ? "extreme" : "in";

  // La direccion del anuncio vive en archivos aparte: se pide solo al fijar la tarjeta.
  const [link, setLink] = useState<{ id: number; url: string | null } | null>(null);
  useEffect(() => {
    if (!pinned) return;
    let cancelled = false;
    listingUrl(id).then((url) => !cancelled && setLink({ id, url }));
    return () => {
      cancelled = true;
    };
  }, [id, pinned]);

  return (
    <div className={floating ? "tip tip-float" : "tip"} style={style} role={pinned ? "group" : undefined} aria-label="Detalle del anuncio">
      <div className="tip-head">
        <span className={`badge badge-${tone}`}>{positionLabel(position, mode)}</span>
        {pinned && (
          <button className="icon-btn tiny" onClick={onClose} aria-label="Cerrar detalle">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        )}
      </div>
      <p className="tip-price num">{pesos(price)}</p>
      <p className="muted small">
        {dec(area, 0)} m² · {points.beds[row]} hab. · {points.baths[row]} {points.baths[row] === 1 ? "baño" : "baños"}
        {stratum ? ` · estrato ${stratum}` : ""}
      </p>
      <dl className="kv tight">
        <div>
          <dt>Precio por m²</dt>
          <dd className="num">{pesos(price / area)}</dd>
        </div>
        <div>
          <dt>{mode === "zone" ? "Frente a la mediana" : "Frente a lo esperado"}</dt>
          <dd className="num">
            {Number.isNaN(diff) ? "Sin dato" : `${diff > 0 ? "+" : "−"}${dec(Math.abs(diff), 0)} %`}
          </dd>
        </div>
        <div>
          <dt>{mode === "zone" ? "Mediana de la zona" : "Precio esperado"}</dt>
          <dd className="num">
            {mode === "zone" ? `${millions(medianPpm2, 1)}/m²` : points.expected[row] ? millions(points.expected[row] * unit) : "Sin dato"}
          </dd>
        </div>
        <div>
          <dt>Ubicación</dt>
          <dd>
            {hood ? `${hood}, ` : ""}
            {city[0]}
            <span className="muted"> · {department}</span>
          </dd>
        </div>
      </dl>
      {pinned ? (
        <div className="tip-actions">
          {link?.id === id && link.url ? (
            <a className="btn small-btn" href={link.url} target="_blank" rel="noopener noreferrer">
              Ver detalles
            </a>
          ) : (
            <button className="btn small-btn" disabled>
              {link?.id === id ? "Enlace no disponible" : "Ver detalles"}
            </button>
          )}
          <span className="muted small">Abre el anuncio original, capturado el {shortDate(points.meta.captured_to)}.</span>
        </div>
      ) : (
        <p className="muted small">Haz clic para fijar y ver el enlace al anuncio.</p>
      )}
    </div>
  );
}
