"use client";

import { useEffect, useState } from "react";

/** Cambia cada vez que se alterna el tema; sirve para redibujar los canvas, que no heredan las variables CSS. */
export function useThemeVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return version;
}
