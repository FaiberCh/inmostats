"use client";

import { useLayoutEffect, useRef, useState } from "react";

/** Ancho real (px) de un contenedor, para dibujar los graficos SVG a tamano 1:1 y que el texto no se escale en el telefono. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}
