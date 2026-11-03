"""
Dashboard de InmoStats en Streamlit (version anterior).

El dashboard vigente es la app web: https://inmostats.vercel.app. Esta pagina solo
avisa del cambio y enlaza a la nueva, para que los enlaces antiguos sigan llevando
a algun sitio. No lee datos ni llama a la API.

El dashboard anterior completo se conserva en src/dashboard/app_anterior.py.
"""

import streamlit as st

NEW_URL = "https://inmostats.vercel.app"

st.set_page_config(page_title="InmoStats", page_icon="🏠")

# Intento de redireccion automatica; si el navegador la bloquea, queda el boton de abajo.
st.markdown(f'<meta http-equiv="refresh" content="3; url={NEW_URL}">', unsafe_allow_html=True)

st.title("🏠 InmoStats se movió")
st.write(
    "El dashboard ahora vive en una versión web nueva, con filtros, mapa, gráfico de "
    "oportunidades y estimador de precios."
)
st.link_button("Ir al nuevo dashboard", NEW_URL, type="primary")
st.caption(f"Si no te lleva solo en unos segundos, abre {NEW_URL}")
