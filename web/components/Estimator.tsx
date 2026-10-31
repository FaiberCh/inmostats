"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { dec, int, millions, pesos } from "@/lib/format";
import type { CityStat, PlaceIndexEntry } from "@/lib/types";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "https://fchaparro-inmostats-api.hf.space").replace(/\/$/, "");
const PREDICT_TIMEOUT_MS = 20_000;
const WAKE_POLL_MS = 4_000;
const WAKE_LIMIT_MS = 180_000;

type Props = {
  places: PlaceIndexEntry[];
  cities: CityStat[];
  amenities: string[];
  /** Error tipico del modelo en validacion cruzada (MAPE, en %). */
  mape: number;
};

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "waking"; since: number }
  | { kind: "error"; message: string }
  | { kind: "done"; price: number; perM2: number; payloadCity: string };

type Neighborhoods = Record<string, string[]>;

const ANTIQUITY = [
  { value: "", label: "No sé" },
  { value: "0", label: "0 · Nuevo o en construcción" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5 · Más de 30 años" },
];

const OWNER_TYPES = [
  { value: "inmobiliaria", label: "Inmobiliaria" },
  { value: "desarrollador", label: "Desarrollador o constructora" },
  { value: "sin especificar", label: "Sin especificar" },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function isApiAwake(): Promise<boolean> {
  try {
    const r = await fetchWithTimeout(`${API_URL}/health`, {}, 8_000);
    const body = await r.json();
    return body?.status === "ok";
  } catch {
    return false;
  }
}

export default function Estimator({ places, cities, amenities, mape }: Props) {
  const defaultDept = places.find((p) => p.department === "Antioquia") ?? places[0];
  const [department, setDepartment] = useState(defaultDept.department);
  const [cityChoice, setCityChoice] = useState<string | null>(null);
  const [neighborhood, setNeighborhood] = useState("");
  const [loadedPlaces, setLoadedPlaces] = useState<{ slug: string; data: Neighborhoods } | null>(null);
  const [area, setArea] = useState("80");
  const [bedrooms, setBedrooms] = useState("3");
  const [bathrooms, setBathrooms] = useState("2");
  const [stratum, setStratum] = useState("4");
  const [floor, setFloor] = useState("5");
  const [garages, setGarages] = useState("1");
  const [antiquity, setAntiquity] = useState("");
  const [ownerType, setOwnerType] = useState("inmobiliaria");
  const [newProject, setNewProject] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const resultRef = useRef<HTMLDivElement>(null);
  const runId = useRef(0);

  const entry = useMemo(() => places.find((p) => p.department === department) ?? defaultDept, [places, department, defaultDept]);

  // Ciudad por defecto: la de mas anuncios del departamento (si esta en el mapa), si no la primera.
  const defaultCity = useMemo(() => {
    const inDept = cities.filter((c) => c.department === department).sort((a, b) => b.listings - a.listings);
    return inDept.find((c) => entry.cities.includes(c.city))?.city ?? entry.cities[0] ?? "";
  }, [cities, department, entry]);
  const city = cityChoice && entry.cities.includes(cityChoice) ? cityChoice : defaultCity;

  // Los barrios se piden por departamento para no cargar todo el pais en el telefono.
  useEffect(() => {
    let cancelled = false;
    fetch(`/data/places/${entry.slug}.json`)
      .then((r) => r.json())
      .then((data) => !cancelled && setLoadedPlaces({ slug: entry.slug, data: data.neighborhoods ?? {} }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entry.slug]);
  const neighborhoods = loadedPlaces?.slug === entry.slug ? loadedPlaces.data : {};

  // Despierta el Space (si estaba dormido) mientras la persona llena el formulario.
  useEffect(() => {
    fetch(`${API_URL}/health`, { mode: "no-cors" }).catch(() => undefined);
  }, []);

  const neighborhoodOptions = neighborhoods[city] ?? [];
  const neighborhoodKnown = neighborhood !== "" && neighborhoodOptions.includes(neighborhood);
  const cityMarket = cities.find((c) => c.city === city && c.department === department);

  const toggleAmenity = (name: string) =>
    setChosen((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

  const buildPayload = () => ({
    area_m2: Number(area),
    bedrooms: Number(bedrooms),
    bathrooms: Number(bathrooms),
    stratum: numberOrNull(stratum),
    floor: numberOrNull(floor),
    antiquity: numberOrNull(antiquity),
    garages: numberOrNull(garages),
    department,
    city,
    neighborhood: neighborhoodKnown ? neighborhood : null,
    owner_type: ownerType,
    is_new_project: newProject,
    amenities: chosen,
    description: description.trim() || null,
  });

  async function predictOnce(payload: ReturnType<typeof buildPayload>) {
    const r = await fetchWithTimeout(
      `${API_URL}/predict`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      PREDICT_TIMEOUT_MS,
    );
    if (r.status === 422) throw new ValidationError("Revisa los datos: algún valor está fuera del rango permitido.");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { predicted_price_cop: number; price_per_m2_cop: number };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const id = ++runId.current;
    const payload = buildPayload();
    setStatus({ kind: "loading" });
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));

    const finish = (result: { predicted_price_cop: number; price_per_m2_cop: number }) =>
      runId.current === id &&
      setStatus({ kind: "done", price: result.predicted_price_cop, perM2: result.price_per_m2_cop, payloadCity: city });

    try {
      finish(await predictOnce(payload));
      return;
    } catch (error) {
      if (error instanceof ValidationError) {
        setStatus({ kind: "error", message: error.message });
        return;
      }
    }

    // La API no respondio: lo normal es que el Space estuviera dormido. Se espera a que despierte y se reintenta una vez.
    const since = Date.now();
    setStatus({ kind: "waking", since });
    while (Date.now() - since < WAKE_LIMIT_MS) {
      if (runId.current !== id) return;
      if (await isApiAwake()) {
        try {
          finish(await predictOnce(payload));
          return;
        } catch (error) {
          setStatus({
            kind: "error",
            message: error instanceof ValidationError ? error.message : "El servicio respondió con un error. Intenta de nuevo en un momento.",
          });
          return;
        }
      }
      await sleep(WAKE_POLL_MS);
    }
    if (runId.current === id) {
      setStatus({ kind: "error", message: "El servicio no despertó a tiempo. Intenta de nuevo en un par de minutos." });
    }
  }

  const waking = status.kind === "waking";
  const busy = status.kind === "loading" || waking;

  return (
    <form className="est" onSubmit={submit}>
      <div className="est-form card">
        <div className="fields fields-3">
          <Field label="Área (m²)">
            <input className="input" type="number" inputMode="decimal" min={15} max={1000} step={1} required value={area} onChange={(e) => setArea(e.target.value)} />
          </Field>
          <Field label="Habitaciones">
            <input className="input" type="number" inputMode="numeric" min={1} max={10} required value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} />
          </Field>
          <Field label="Baños">
            <input className="input" type="number" inputMode="numeric" min={1} max={10} required value={bathrooms} onChange={(e) => setBathrooms(e.target.value)} />
          </Field>
          <Field label="Estrato">
            <select className="input" value={stratum} onChange={(e) => setStratum(e.target.value)}>
              <option value="">No sé</option>
              {[1, 2, 3, 4, 5, 6].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Piso">
            <input className="input" type="number" inputMode="numeric" min={-2} max={60} value={floor} onChange={(e) => setFloor(e.target.value)} />
          </Field>
          <Field label="Garajes">
            <input className="input" type="number" inputMode="numeric" min={0} max={10} value={garages} onChange={(e) => setGarages(e.target.value)} />
          </Field>
        </div>

        <div className="fields fields-3">
          <Field label="Departamento">
            <select
              className="input"
              value={department}
              onChange={(e) => {
                setDepartment(e.target.value);
                setCityChoice(null);
                setNeighborhood("");
              }}
            >
              {places.map((p) => (
                <option key={p.slug} value={p.department}>
                  {p.department}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ciudad">
            <select
              className="input"
              value={city}
              onChange={(e) => {
                setCityChoice(e.target.value);
                setNeighborhood("");
              }}
            >
              {entry.cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field className="span-2" label="Barrio (opcional)" hint={neighborhood && !neighborhoodKnown ? "No está en la lista: se estimará sin barrio." : undefined}>
            <input
              className="input"
              list="barrios"
              placeholder={neighborhoodOptions.length ? "Buscar barrio" : "Sin barrios registrados"}
              value={neighborhood}
              onChange={(e) => setNeighborhood(e.target.value)}
              autoComplete="off"
            />
            <datalist id="barrios">
              {neighborhoodOptions.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
        </div>

        <div className="fields fields-3">
          <Field label="Antigüedad (código)" hint="Código de Fincaraíz: 0 es nuevo, 5 más de 30 años.">
            <select className="input" value={antiquity} onChange={(e) => setAntiquity(e.target.value)}>
              {ANTIQUITY.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de anunciante">
            <select className="input" value={ownerType} onChange={(e) => setOwnerType(e.target.value)}>
              {OWNER_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <label className="check span-2">
            <input type="checkbox" checked={newProject} onChange={(e) => setNewProject(e.target.checked)} />
            <span>Proyecto nuevo o sobre planos</span>
          </label>
        </div>

        <fieldset className="chips">
          <legend>Amenidades presentes</legend>
          <div className="chip-row">
            {amenities.map((a) => (
              <button key={a} type="button" className={chosen.includes(a) ? "chip on" : "chip"} aria-pressed={chosen.includes(a)} onClick={() => toggleAmenity(a)}>
                {a}
              </button>
            ))}
          </div>
        </fieldset>

        <Field label="Descripción del anuncio (opcional)" hint="Palabras como “penthouse” o “vista panorámica” pueden ajustar el estimado.">
          <textarea className="input area" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ej: Espectacular penthouse con chimenea, techos altos y vista panorámica" />
        </Field>

        <div className="form-actions">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Calculando…" : "Estimar precio"}
          </button>
          <span className="muted small">Estimación estadística con datos de oferta, no un avalúo.</span>
        </div>
      </div>

      <div ref={resultRef} className="est-result card" aria-live="polite">
        <h3 className="sub">Resultado</h3>
        {status.kind === "idle" && (
          <p className="muted">
            Completa los datos y pulsa <strong>Estimar precio</strong>.
          </p>
        )}
        {status.kind === "loading" && <p className="muted">Calculando el estimado…</p>}
        {waking && <WakingNotice since={status.since} />}
        {status.kind === "error" && (
          <div>
            <p className="notice-error">{status.message}</p>
            <button type="button" className="btn-text" onClick={(e) => submit(e as unknown as React.FormEvent)}>
              Reintentar
            </button>
          </div>
        )}
        {status.kind === "done" && (
          <div>
            <p className="est-price num">{pesos(status.price)}</p>
            <p className="muted small">pesos colombianos (COP)</p>
            <dl className="kv">
              <div>
                <dt>Precio por m²</dt>
                <dd className="num">{pesos(status.perM2)}</dd>
              </div>
              <div>
                <dt>Margen orientativo</dt>
                <dd className="num">
                  {millions(status.price * (1 - mape / 100))} a {millions(status.price * (1 + mape / 100))}
                </dd>
              </div>
              {cityMarket && (
                <div>
                  <dt>Mediana en {cityMarket.city}</dt>
                  <dd className="num">{dec(cityMarket.price_m2_median / 1e6, 1)} M/m²</dd>
                </div>
              )}
            </dl>
            <p className="muted small">
              Margen: error típico del modelo ({dec(mape, 1)} %); mayor en inmuebles de lujo.
            </p>
          </div>
        )}
      </div>
    </form>
  );
}

class ValidationError extends Error {}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={className ? `field ${className}` : "field"}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function WakingNotice({ since }: { since: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - since) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return (
    <div className="notice">
      <p>
        <strong>El servicio estaba dormido y se está despertando</strong> (1 a 3 minutos la primera vez). Tu estimado saldrá solo.
      </p>
      <p className="muted small num">Esperando {int(seconds)} s…</p>
    </div>
  );
}
