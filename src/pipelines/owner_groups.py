"""
Clasificacion aproximada del anunciante y su efecto en el precio.

Los datos solo traen owner_type (inmobiliaria, desarrollador, sin especificar), que no separa a una
empresa de una persona natural. Aqui se clasifica ademas el nombre del anunciante con una heuristica
(palabras de negocio y nombres de pila frecuentes) y se cruza con owner_type. Al dashboard solo viaja
la categoria, nunca el nombre.

Grupos:
  1 empresa             nombre con palabras de negocio, siglas o numeros
  2 asesor independiente nombre de persona que publica como inmobiliaria (publica decenas de anuncios)
  3 propietario directo  nombre de persona que figura "sin especificar" (casi siempre un solo anuncio)
  4 desarrollador        owner_type desarrollador (proyectos nuevos); tiene prioridad sobre los demas
  0 sin clasificar       el resto (incluye personas cuyo nombre no esta en la lista)
"""

import re
import unicodedata

import numpy as np
import pandas as pd

SIN_CLASIFICAR, EMPRESA, ASESOR, PROPIETARIO, DESARROLLADOR = range(5)
OWNER_LABELS = [
    "Sin clasificar",
    "Empresas e inmobiliarias",
    "Asesores independientes",
    "Propietarios directos (probable)",
    "Desarrolladores (proyectos nuevos)",
]

_COMPANY = re.compile(
    r"\b(sas|s a s|ltda|s a|sa|s en c|e u|inmobiliaria\w*|inmo\w*|bienes|raices|raiz|constructora\w*|construcciones|"
    r"inversiones|inversion\w*|grupo|group|propiedades|properties|property|realty|real estate|asesor\w*|gestion|negocios|"
    r"corredor\w*|broker\w*|century|remax|re max|urbanizadora|proyectos|desarrollo\w*|promotora|fiduciaria|"
    r"arquitect\w*|ingenier\w*|habitat|vivienda\w*|hogar|casas|apartamentos|agencia|fincaraiz|cia|compania|"
    r"servicios|soluciones|consultores|capital|patrimonio|holding|ventas|comercial|asociados|hnos|hermanos|y cia|"
    r"inmueble\w*|territorio|urbano|urban|top|premium|elite|prime|luxury)\b"
)
_SYMBOLS = re.compile(r"[&+@/\d]|\.com|\.co\b")
# Nombres de pila frecuentes: marcan "persona natural" de forma conservadora (la lista no es exhaustiva)
_FIRST_NAMES = set(
    """
juan carlos jose luis jorge maria ana luz sandra claudia diana patricia martha marta gloria olga sara laura andrea paola
carolina catalina natalia monica liliana adriana alejandra angela beatriz blanca clara cecilia constanza dora elizabeth
esperanza fabiola fanny gladys ines isabel johanna juliana lucia margarita marcela maritza mercedes nancy nelly nidia
piedad rocio rosa ruth silvia sonia stella teresa victoria viviana yolanda yenny yeimy luisa lina jenny
alvaro andres antonio camilo cesar daniel david diego edgar edison eduardo efrain enrique ernesto fabian felipe fernando
francisco gabriel german gilberto guillermo gustavo hector hernan hugo ivan jaime javier jesus john jhon julian julio
leonardo manuel mario mauricio miguel nelson nestor nicolas oscar pablo pedro rafael ramiro ricardo roberto rodrigo
ruben santiago sergio victor wilson william alberto alejandro alfonso alexander armando arturo augusto bernardo
cristian cristhian dario denis dagoberto elkin fredy freddy gerardo harold henry hernando humberto jairo jhonatan jimmy
jonathan marco orlando oswaldo rene reinaldo rogelio samuel stiven steven tomas ubaldo wilmer yesid
""".split()
)


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def classify_name(name) -> str:
    """'empresa', 'persona' o 'indeterminado' a partir del nombre del anunciante."""
    if not isinstance(name, str) or not name.strip():
        return "indeterminado"
    normalized = _normalize(name)
    if _SYMBOLS.search(normalized) or _COMPANY.search(re.sub(r"[^a-z0-9& ]", " ", normalized)):
        return "empresa"
    tokens = [t for t in re.sub(r"[^a-z ]", " ", normalized).split() if t]
    if 2 <= len(tokens) <= 5 and tokens[0] in _FIRST_NAMES:
        return "persona"
    return "indeterminado"


def owner_codes(df: pd.DataFrame) -> np.ndarray:
    """Codigo de grupo (uint8) de cada anuncio, a partir de owner_name y owner_type."""
    names = df["owner_name"].fillna("")
    lookup = {name: classify_name(name) for name in names.unique()}
    kind = names.map(lookup)
    owner_type = df["owner_type"].fillna("sin especificar")
    codes = np.zeros(len(df), dtype=np.uint8)
    codes[(kind == "empresa").values] = EMPRESA
    codes[((kind == "persona") & (owner_type == "inmobiliaria")).values] = ASESOR
    codes[((kind == "persona") & (owner_type == "sin especificar")).values] = PROPIETARIO
    codes[(owner_type == "desarrollador").values] = DESARROLLADOR
    return codes


def _effect(data: pd.DataFrame, flag: np.ndarray, with_new_project: bool) -> tuple[float, float, float, int]:
    """Diferencia porcentual del precio por m2 del grupo marcado frente al resto de la muestra, a igualdad de
    ciudad, estrato, area y habitaciones (regresion de log(precio por m2) con errores robustos HC1)."""
    d = data.assign(flag=flag.astype(float)).dropna(subset=["price_per_m2", "area_m2", "stratum", "city"])
    d = d.assign(city_f=np.where(d["city"].map(d["city"].value_counts()) >= 50, d["city"], "otras"))
    X = pd.get_dummies(d[["city_f"]], drop_first=True).astype(float)
    X["estrato"] = d["stratum"].astype(float)
    X["log_area"] = np.log(d["area_m2"])
    X["habitaciones"] = d["bedrooms"].astype(float)
    if with_new_project:
        X["nuevo"] = d["is_new_project"].astype(float)
    X["grupo"] = d["flag"]
    X.insert(0, "const", 1.0)
    y = np.log(d["price_per_m2"].values)
    A = X.values
    beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = y - A @ beta
    n, k = A.shape
    inv = np.linalg.pinv(A.T @ A)
    meat = (A * resid[:, None]).T @ (A * resid[:, None])
    cov = inv @ meat @ inv * n / (n - k)
    i = list(X.columns).index("grupo")
    b, se = float(beta[i]), float(np.sqrt(max(cov[i, i], 0.0)))
    pct = lambda v: round(100 * (float(np.exp(v)) - 1), 1)
    return pct(b), pct(b - 1.96 * se), pct(b + 1.96 * se), int(n)


def owner_summary(df: pd.DataFrame, codes: np.ndarray) -> list[dict]:
    """Por grupo: anuncios, mediana de precio por m2 y, frente a las empresas, el efecto ajustado."""
    rows = []
    for code in (EMPRESA, ASESOR, PROPIETARIO, DESARROLLADOR):
        sub = df[codes == code]
        row = {
            "code": code,
            "label": OWNER_LABELS[code],
            "listings": int(len(sub)),
            "price_m2_median": int(round(sub["price_per_m2"].median())),
        }
        if code != EMPRESA:
            pair = df[(codes == EMPRESA) | (codes == code)]
            effect, low, high, n = _effect(pair, (codes[(codes == EMPRESA) | (codes == code)] == code), with_new_project=code != DESARROLLADOR)
            row.update({"effect_pct": effect, "ci_low": low, "ci_high": high, "n_fit": n})
        rows.append(row)
    return rows
