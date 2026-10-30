import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });

export const metadata: Metadata = {
  title: "InmoStats: precios de apartamentos en Colombia",
  description:
    "Tablero con más de 80.000 anuncios de apartamentos en venta en Colombia: precio por metro cuadrado, mapa, estimador de precio con XGBoost y dinámica del mercado.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f5f9" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

// Fija el tema antes de pintar para que no haya destello: lo guardado, o el del sistema.
const THEME_INIT = `try{var t=localStorage.getItem("theme");if(!t){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={geist.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
