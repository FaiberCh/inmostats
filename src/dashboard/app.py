"""
Dashboard de InmoStats en Streamlit (version anterior).

El dashboard vigente es la app web: https://inmostats.vercel.app. Esta pagina solo
avisa del cambio y enlaza a la nueva, para que los enlaces antiguos sigan llevando
a algun sitio. No lee datos ni llama a la API.

El dashboard anterior completo se conserva en src/dashboard/app_anterior.py.
"""

import streamlit as st
import streamlit.components.v1 as components

NEW_URL = "https://inmostats.vercel.app"

st.set_page_config(page_title="InmoStats", page_icon="🏠")

# Redireccion automatica. Streamlit no interpreta un <meta refresh> (lo muestra como texto), asi que se
# hace con JavaScript desde el iframe del componente; si el navegador la bloquea, quedan el boton y el
# enlace de abajo.
components.html(
    f"""<script>
    const url = "{NEW_URL}";
    // El iframe del componente esta aislado (sandbox) y no puede cambiar la pagina principal; el script
    // inyectado en la pagina padre (mismo origen) si.
    const s = window.parent.document.createElement("script");
    s.textContent = 'window.top.location.href = "' + url + '";';
    window.parent.document.head.appendChild(s);
    </script>""",
    height=0,
)

st.title("🏠 InmoStats se movió")
st.write(
    "El dashboard ahora vive en una versión web nueva, con filtros, mapa, gráfico de "
    "oportunidades y estimador de precios."
)
st.link_button("Ir al nuevo dashboard", NEW_URL, type="primary")
st.caption(f"Si no te lleva solo en unos segundos, abre {NEW_URL}")
