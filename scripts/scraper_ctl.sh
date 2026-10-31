#!/usr/bin/env bash
# Control del cron de scraping (workflow "Scraper InmoStats" de GitHub Actions).
#
# Uso (desde cualquier carpeta del repo):
#     bash scripts/scraper_ctl.sh status   # estado del workflow, secrets y checkpoint del repo
#     bash scripts/scraper_ctl.sh start    # comprueba requisitos, pide confirmacion y activa el cron
#     bash scripts/scraper_ctl.sh stop     # pide confirmacion y desactiva el cron
#
# Usa solo la CLI de GitHub (gh), que debe estar autenticada. Activar y
# desactivar el workflow funciona con el token por defecto (no requiere el
# permiso "workflow", que solo hace falta para editar el archivo .yml).
#
# Recuerda: una corrida completa tarda varios dias y suma ~235 MB a
# data/raw/. El cron NO se detiene solo al terminar una corrida: cuando
# pasa el cooldown de 24h arranca otra. Cuando llegue el mensaje de Telegram
# "corrida nacional completa", ejecuta "stop".

set -euo pipefail

WORKFLOW="Scraper InmoStats"
REPO="FaiberCh/inmostats"
CHECKPOINT_PATH="data/raw/.checkpoint_national.json"

cd "$(git rev-parse --show-toplevel)"

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: no encuentro la CLI de GitHub (gh)." >&2
    exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
    echo "Error: gh no está autenticada. Ejecuta: gh auth login" >&2
    exit 1
fi

workflow_state() {
    gh workflow list --all --repo "$REPO" | awk -F'\t' -v w="$WORKFLOW" '$1 == w { print $2 }'
}

# Se usa el ID y no el nombre: gh no siempre resuelve por nombre un workflow desactivado.
workflow_id() {
    gh workflow list --all --repo "$REPO" | awk -F'	' -v w="$WORKFLOW" '$1 == w { print $3 }'
}

missing_secrets() {
    local present
    present="$(gh secret list --repo "$REPO" | awk '{ print $1 }')"
    for name in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
        grep -qx "$name" <<<"$present" || echo "$name"
    done
}

checkpoint_summary() {
    # Lee el checkpoint del repo por la API de GitHub (sirve tambien si es privado).
    local py code
    py="$(command -v python3 || command -v python)"
    code="$(cat <<'PY'
import json, sys
from datetime import datetime, timezone

c = json.load(sys.stdin)
zonas = list(c["departments"].values())
hechas = sum(1 for z in zonas if z.get("done"))
print("Corrida iniciada:", c.get("started_at"))
if c.get("done"):
    fin = datetime.fromisoformat(c["finished_at"])
    horas = (datetime.now(timezone.utc) - fin).total_seconds() / 3600
    print("Estado: completa (%d/%d zonas), terminó hace %.0f h" % (hechas, len(zonas), horas))
    if horas >= 24:
        print("Al activar el cron arrancaría una corrida NUEVA (el cooldown de 24 h ya pasó).")
    else:
        print("Al activar el cron esperaría a que pasen las 24 h de cooldown.")
else:
    print("Estado: en curso (%d/%d zonas completas)" % (hechas, len(zonas)))
PY
)"
    gh api "repos/$REPO/contents/$CHECKPOINT_PATH?ref=master" -H "Accept: application/vnd.github.raw+json" | "$py" -c "$code"
}

confirm() {
    local answer
    read -r -p "$1 [escribe 'si' para continuar] " answer
    if [ "$answer" != "si" ]; then
        echo "Cancelado, no se cambió nada."
        exit 1
    fi
}

cmd="${1:-status}"

case "$cmd" in
    status)
        echo "Workflow '$WORKFLOW': $(workflow_state)"
        faltan="$(missing_secrets)"
        if [ -n "$faltan" ]; then
            echo "Secrets que faltan en el repo: $faltan"
        else
            echo "Secrets de Telegram: presentes"
        fi
        echo "Últimas ejecuciones:"
        gh run list --workflow "$(workflow_id)" --repo "$REPO" --limit 5 || true
        echo "Checkpoint del repo:"
        checkpoint_summary
        ;;
    start)
        estado="$(workflow_state)"
        if [ "$estado" = "active" ]; then
            echo "El workflow ya está activo, no hay nada que hacer."
            exit 0
        fi
        faltan="$(missing_secrets)"
        if [ -n "$faltan" ]; then
            echo "Error: faltan secrets en el repo ($faltan); sin ellos fallan las notificaciones." >&2
            exit 1
        fi
        echo "Estado actual del workflow: $estado"
        checkpoint_summary
        echo
        echo "Una corrida completa tarda varios días y suma ~235 MB a data/raw/ (el repo ya pesa ~2 GB)."
        echo "El cron no se detiene solo: ejecuta 'bash scripts/scraper_ctl.sh stop' cuando llegue el aviso de corrida completa."
        confirm "¿Activar el cron de scraping?"
        gh workflow enable "$(workflow_id)" --repo "$REPO"
        echo "Activado. El primer tramo arranca en la próxima marca de 30 minutos."
        ;;
    stop)
        estado="$(workflow_state)"
        if [ "$estado" != "active" ]; then
            echo "El workflow no está activo (estado: $estado), no hay nada que detener."
            exit 0
        fi
        confirm "¿Desactivar el cron de scraping?"
        gh workflow disable "$(workflow_id)" --repo "$REPO"
        echo "Desactivado."
        ;;
    *)
        echo "Uso: bash scripts/scraper_ctl.sh {status|start|stop}" >&2
        exit 1
        ;;
esac
