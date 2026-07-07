"""
Dashboard de InmoStats: prediccion de precio (consume la API de src/api/,
no carga el modelo directo) + resumen del mercado de apartamentos en
Colombia (data/processed/, mismas coropletas que notebooks/01_eda.ipynb
via src/pipelines/geo.py).

Correr localmente (con la API ya corriendo en otra terminal):
    streamlit run src/dashboard/app.py
"""

import os
import sys
from pathlib import Path

# Streamlit Community Cloud ejecuta este script sin agregar la raiz del
# repo a sys.path (a diferencia de "streamlit run" desde la raiz en
# local), y los imports de abajo son absolutos (from src...). Se agrega
# a mano antes de esos imports para que funcione en ambos casos.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pandas as pd
import plotly.express as px
import requests
import streamlit as st

from src.pipelines.clean_data import clean, engineer_features, load_raw_data, save_processed
from src.pipelines.geo import load_department_geojson, match_city_features


def _get_api_base_url() -> str:
    env_value = os.environ.get("INMOSTATS_API_URL")
    if env_value:
        return env_value
    try:
        return st.secrets["INMOSTATS_API_URL"]
    except Exception:
        return "http://localhost:8000"


API_BASE_URL = _get_api_base_url()
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
PROCESSED_PATH = DATA_DIR / "processed" / "apartamentos_colombia_processed.csv"

st.set_page_config(page_title="InmoStats", page_icon="🏠", layout="wide")


@st.cache_data
def load_processed_data() -> pd.DataFrame:
    # data/processed/*.csv esta gitignored (se regenera de data/raw/, que si
    # esta versionado). Streamlit Community Cloud no tiene un build command
    # como Render para correr clean_data.py antes de servir la app, asi que
    # se genera aqui mismo en el primer acceso si todavia no existe.
    if not PROCESSED_PATH.exists():
        df_raw = load_raw_data()
        df_clean = engineer_features(clean(df_raw))
        save_processed(df_clean)
    return pd.read_csv(PROCESSED_PATH, encoding="utf-8-sig")


@st.cache_data(ttl=60)
def fetch_model_info():
    try:
        r = requests.get(f"{API_BASE_URL}/model-info", timeout=5)
        r.raise_for_status()
        return r.json()
    except requests.RequestException:
        return None


@st.cache_data(ttl=60)
def fetch_amenities() -> list[str]:
    try:
        r = requests.get(f"{API_BASE_URL}/amenities", timeout=5)
        r.raise_for_status()
        return r.json()
    except requests.RequestException:
        return []


st.title("🏠 InmoStats — Apartamentos en venta en Colombia")

tab_pred, tab_resumen = st.tabs(["Predicción de precio", "Resumen del mercado"])

# --- Tab 1: prediccion ------------------------------------------------
with tab_pred:
    model_info = fetch_model_info()
    if model_info is None:
        st.error(
            f"No se pudo conectar con la API en {API_BASE_URL}. "
            f"¿Esta corriendo `uvicorn src.api.main:app --reload`?"
        )
    else:
        st.caption(
            f"Modelo: **{model_info['model_name']}** · entrenado {model_info['trained_at'][:10]} · "
            f"MAPE (CV): {model_info['metrics_cv']['MAPE_%']}% · R²: {model_info['metrics_cv']['R2']} · "
            f"{model_info['n_rows']:,} anuncios de entrenamiento"
        )

        df = load_processed_data()
        known_amenities = fetch_amenities()

        col1, col2, col3 = st.columns(3)
        with col1:
            area_m2 = st.number_input("Área (m²)", min_value=15.0, max_value=1000.0, value=80.0, step=5.0)
            bedrooms = st.number_input("Habitaciones", min_value=1, max_value=10, value=3)
            bathrooms = st.number_input("Baños", min_value=1, max_value=10, value=2)
        with col2:
            stratum = st.selectbox("Estrato", options=[1, 2, 3, 4, 5, 6], index=3)
            floor = st.number_input("Piso", min_value=-2, max_value=60, value=5)
            garages = st.number_input("Garajes", min_value=0, max_value=10, value=1)
        with col3:
            antiquity = st.selectbox(
                "Antigüedad (código fincaraiz: 0=nuevo .. 5=+30 años)",
                options=[0, 1, 2, 3, 4, 5],
                index=2,
            )
            owner_type = st.selectbox("Tipo de anunciante", options=["inmobiliaria", "desarrollador", "sin especificar"])
            is_new_project = st.checkbox("Proyecto nuevo / sobre planos")

        departments = sorted(df["department_final"].dropna().unique().tolist())
        col4, col5, col6 = st.columns(3)
        with col4:
            default_dept = departments.index("Antioquia") if "Antioquia" in departments else 0
            department = st.selectbox("Departamento", options=departments, index=default_dept)
        with col5:
            cities_in_dept = sorted(df.loc[df["department_final"] == department, "city"].dropna().unique().tolist())
            city = st.selectbox("Ciudad", options=cities_in_dept)
        with col6:
            neighborhoods = sorted(
                df.loc[(df["department_final"] == department) & (df["city"] == city), "neighborhood"]
                .dropna()
                .unique()
                .tolist()
            )
            neighborhood_choice = st.selectbox("Barrio (opcional)", options=["(sin especificar)"] + neighborhoods)

        amenities_selected = st.multiselect("Amenidades presentes", options=known_amenities)
        description = st.text_area(
            "Descripción del anuncio (opcional, texto libre)",
            placeholder="Ej: Espectacular penthouse con chimenea, techos altos y vista panorámica...",
        )

        if st.button("Estimar precio", type="primary"):
            payload = {
                "area_m2": area_m2,
                "bedrooms": bedrooms,
                "bathrooms": bathrooms,
                "stratum": stratum,
                "floor": floor,
                "antiquity": antiquity,
                "garages": garages,
                "department": department,
                "city": city,
                "neighborhood": None if neighborhood_choice == "(sin especificar)" else neighborhood_choice,
                "owner_type": owner_type,
                "is_new_project": is_new_project,
                "amenities": amenities_selected,
                "description": description or None,
            }
            try:
                r = requests.post(f"{API_BASE_URL}/predict", json=payload, timeout=10)
                r.raise_for_status()
                result = r.json()
                st.success(f"### Precio estimado: ${result['predicted_price_cop']:,.0f} COP")
                st.metric("Precio por m²", f"${result['price_per_m2_cop']:,.0f} COP")
            except requests.RequestException as exc:
                st.error(f"Error al predecir: {exc}")

# --- Tab 2: resumen del mercado -----------------------------------------
with tab_resumen:
    df = load_processed_data()

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Anuncios", f"{len(df):,}")
    col2.metric("Precio promedio", f"${df['price_cop'].mean() / 1e6:,.0f}M COP")
    col3.metric("Precio mediano", f"${df['price_cop'].median() / 1e6:,.0f}M COP")
    col4.metric("Área promedio", f"{df['area_m2'].mean():.0f} m²")

    st.subheader("Distribución de precios")
    price_p99 = df["price_cop"].quantile(0.99)
    fig_hist = px.histogram(
        df[df["price_cop"] < price_p99], x="price_cop", nbins=60,
        labels={"price_cop": "Precio (COP)"},
    )
    fig_hist.update_layout(margin={"r": 0, "t": 10, "b": 0, "l": 0})
    st.plotly_chart(fig_hist, width="stretch")

    st.subheader("Precio/m² mediano por departamento")
    depto_geojson = load_department_geojson()
    depto_stats = (
        df.groupby("department_final")
        .agg(anuncios=("listing_id", "count"), precio_m2_mediana=("price_per_m2", "median"))
        .reset_index()
    )
    fig_map_dept = px.choropleth_map(
        depto_stats, geojson=depto_geojson, locations="department_final",
        featureidkey="properties.department_final", color="precio_m2_mediana",
        color_continuous_scale="YlOrRd", map_style="carto-positron",
        center={"lat": 4.5, "lon": -74.0}, zoom=4.3, height=550,
        hover_data={"anuncios": True},
        labels={"precio_m2_mediana": "Precio/m² mediano (COP)", "department_final": "Departamento"},
    )
    fig_map_dept.update_layout(margin={"r": 0, "t": 10, "b": 0, "l": 0})
    st.plotly_chart(fig_map_dept, width="stretch")

    # A diferencia de los departamentos (poligonos grandes), los municipios
    # son mucho mas chicos -Bogota/Medellin/Cali casi no se ven a media
    # columna, aunque el matching este perfecto (57/58 verificado). Se le
    # da ancho completo y mas zoom para que sean visibles.
    st.subheader("Precio/m² mediano por ciudad (min. 30 anuncios)")
    city_stats_all = df.groupby("city").agg(
        anuncios=("listing_id", "count"),
        precio_m2_mediana=("price_per_m2", "median"),
        lat_mediana=("latitude", "median"),
        lon_mediana=("longitude", "median"),
    ).query("anuncios >= 30")
    city_geojson, matched_city_names, _ = match_city_features(city_stats_all)
    plot_df = city_stats_all.reset_index()
    plot_df = plot_df[plot_df["city"].isin(matched_city_names)]
    fig_map_city = px.choropleth_map(
        plot_df, geojson=city_geojson, locations="city",
        featureidkey="properties.city_matched", color="precio_m2_mediana",
        color_continuous_scale="YlOrRd", map_style="carto-positron",
        center={"lat": 4.5, "lon": -74.0}, zoom=4.8, height=650,
        hover_data={"anuncios": True},
        labels={"precio_m2_mediana": "Precio/m² mediano (COP)", "city": "Ciudad"},
    )
    fig_map_city.update_layout(margin={"r": 0, "t": 10, "b": 0, "l": 0})
    st.plotly_chart(fig_map_city, width="stretch")

    col_bar, col_box = st.columns(2)

    with col_bar:
        st.subheader("Top 15 ciudades por número de anuncios")
        top_cities = df["city"].value_counts().head(15).reset_index()
        top_cities.columns = ["city", "count"]
        fig_bar = px.bar(top_cities, x="count", y="city", orientation="h", labels={"count": "Anuncios", "city": "Ciudad"})
        fig_bar.update_yaxes(categoryorder="total ascending")
        fig_bar.update_layout(margin={"r": 0, "t": 10, "b": 0, "l": 0})
        st.plotly_chart(fig_bar, width="stretch")

    with col_box:
        st.subheader("Precio por estrato")
        fig_box = px.box(
            df.dropna(subset=["stratum"]), x="stratum", y="price_cop",
            labels={"price_cop": "Precio (COP)", "stratum": "Estrato"},
        )
        fig_box.update_layout(margin={"r": 0, "t": 10, "b": 0, "l": 0})
        st.plotly_chart(fig_box, width="stretch")

    st.subheader("Amenidades más frecuentes")
    amenities_freq = (
        df["amenities"].dropna().str.split("; ").explode().str.strip().value_counts().head(15).reset_index()
    )
    amenities_freq.columns = ["amenity", "count"]
    fig_amenities = px.bar(
        amenities_freq, x="count", y="amenity", orientation="h",
        labels={"count": "Anuncios", "amenity": "Amenidad"},
    )
    fig_amenities.update_yaxes(categoryorder="total ascending")
    fig_amenities.update_layout(margin={"r": 0, "t": 10, "b": 0, "l": 0})
    st.plotly_chart(fig_amenities, width="stretch")
