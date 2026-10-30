"use client";

import { useEffect, useRef, useState } from "react";

const SECTIONS = [
  { id: "mercado", label: "Mercado" },
  { id: "oportunidades", label: "Oportunidades" },
  { id: "estimador", label: "Estimador" },
  { id: "dinamica", label: "Dinámica" },
  { id: "modelo", label: "Modelo" },
];

function Mark() {
  // Tres barras de distinta altura bajo un tejado: el precio por m² de tres zonas, y una casa.
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <path d="M2 10.5 11 3l9 7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="5" y="13" width="3" height="6" fill="currentColor" />
      <rect x="9.5" y="11" width="3" height="8" fill="currentColor" />
      <rect x="14" y="14.5" width="3" height="4.5" fill="currentColor" />
    </svg>
  );
}

function ThemeIcons() {
  // Los dos iconos conviven y el CSS muestra el que corresponde al tema activo ([data-theme]).
  return (
    <>
      <svg className="icon-to-light" width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
      </svg>
      <svg className="icon-to-dark" width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" />
      </svg>
    </>
  );
}

export default function SiteBar() {
  const [active, setActive] = useState("mercado");
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // La seccion activa es la ultima cuyo borde superior ya paso por debajo de la barra.
    const update = () => {
      const line = 56 + 24;
      let current = SECTIONS[0].id;
      // Se busca por id en cada scroll: una seccion puede reemplazarse (la de oportunidades pasa de marcador a grafico).
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top - line <= 0) current = s.id;
      }
      setActive(current);
      const nav = navRef.current;
      const link = nav?.querySelector<HTMLElement>(`a[href="#${current}"]`);
      if (nav && link && nav.scrollWidth > nav.clientWidth) {
        nav.scrollTo({ left: link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2, behavior: "smooth" });
      }
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* sin almacenamiento: el tema solo dura la visita */
    }
  };

  return (
    <header className="bar">
      <div className="bar-in">
        <a className="brand" href="#top" aria-label="InmoStats, inicio">
          <Mark />
          <span className="brand-name">InmoStats</span>
        </a>
        <nav ref={navRef} className="bar-nav" aria-label="Secciones">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={active === s.id ? "on" : ""} aria-current={active === s.id ? "location" : undefined}>
              {s.label}
            </a>
          ))}
        </nav>
        <button className="icon-btn" onClick={toggleTheme} aria-label="Cambiar entre tema claro y oscuro" title="Cambiar tema">
          <ThemeIcons />
        </button>
      </div>
    </header>
  );
}
