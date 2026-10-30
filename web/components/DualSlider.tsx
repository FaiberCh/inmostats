"use client";

type Props = {
  label: string;
  /** Posiciones enteras 0..steps. */
  steps: number;
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
  /** Valor legible del rango actual ("$120 M a $800 M"). */
  text: string;
  disabled?: boolean;
  ariaLo: string;
  ariaHi: string;
};

/** Slider de rango con dos manijas: dos inputs nativos superpuestos (teclado y tacto funcionan sin codigo extra). */
export default function DualSlider({ label, steps, lo, hi, onChange, text, disabled, ariaLo, ariaHi }: Props) {
  return (
    <div className={disabled ? "dual disabled" : "dual"}>
      <div className="dual-head">
        <span className="dual-label">{label}</span>
        <span className="num dual-value">{text}</span>
      </div>
      <div className="dual-track">
        <div className="dual-rail" />
        <div className="dual-fill" style={{ left: `${(lo / steps) * 100}%`, right: `${100 - (hi / steps) * 100}%` }} />
        <input
          type="range"
          min={0}
          max={steps}
          step={1}
          value={lo}
          disabled={disabled}
          aria-label={ariaLo}
          style={{ zIndex: lo > steps - 10 ? 3 : 2 }}
          onChange={(e) => onChange(Math.min(Number(e.target.value), hi - 1), hi)}
        />
        <input
          type="range"
          min={0}
          max={steps}
          step={1}
          value={hi}
          disabled={disabled}
          aria-label={ariaHi}
          style={{ zIndex: 2 }}
          onChange={(e) => onChange(lo, Math.max(Number(e.target.value), lo + 1))}
        />
      </div>
    </div>
  );
}
