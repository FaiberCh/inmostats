#!/usr/bin/env bash
# Publica la rama local space-deploy en el Space de Hugging Face
# (remoto "space", rama main), que es lo que dispara el build de la API.
#
# Uso (desde cualquier carpeta del repo):
#     bash scripts/deploy_space.sh
#
# Comprobaciones antes de empujar:
#   - el remoto "space" esta configurado,
#   - la rama space-deploy existe,
#   - no hay cambios sin confirmar en el arbol de trabajo,
#   - space/main es ancestro de space-deploy (el push es fast-forward;
#     este script nunca fuerza un push).
# Muestra los commits que se van a subir y pide confirmacion explicita.

set -euo pipefail

REMOTE="space"
BRANCH="space-deploy"
REMOTE_BRANCH="main"

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    echo "Error: el remoto '$REMOTE' no está configurado." >&2
    echo "Agrégalo con: git remote add $REMOTE https://huggingface.co/spaces/<usuario>/<space>" >&2
    exit 1
fi

if ! git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
    echo "Error: la rama local '$BRANCH' no existe." >&2
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "Error: hay cambios sin confirmar; haz commit o stash antes de desplegar." >&2
    git status --short >&2
    exit 1
fi

echo "Remoto $REMOTE: $(git remote get-url "$REMOTE")"
echo "Consultando $REMOTE/$REMOTE_BRANCH..."
git fetch "$REMOTE" "$REMOTE_BRANCH"

REMOTE_REF="refs/remotes/$REMOTE/$REMOTE_BRANCH"

if ! git merge-base --is-ancestor "$REMOTE_REF" "refs/heads/$BRANCH"; then
    echo "Error: $REMOTE/$REMOTE_BRANCH tiene commits que $BRANCH no incluye;" >&2
    echo "el push no sería un fast-forward y este script no fuerza pushes." >&2
    echo "Revisa la divergencia con: git log --oneline $BRANCH..$REMOTE/$REMOTE_BRANCH" >&2
    exit 1
fi

PENDING="$(git log --oneline "$REMOTE_REF..refs/heads/$BRANCH")"
if [ -z "$PENDING" ]; then
    echo "Nada que subir: $REMOTE/$REMOTE_BRANCH ya está al día con $BRANCH."
    exit 0
fi

echo
echo "Commits que se van a subir ($BRANCH -> $REMOTE/$REMOTE_BRANCH):"
echo "$PENDING"
echo
echo "Archivos afectados:"
git diff --stat "$REMOTE_REF" "refs/heads/$BRANCH"
echo

read -r -p "¿Empujar $BRANCH a $REMOTE/$REMOTE_BRANCH? Esto dispara un rebuild del Space. [escribe 'si' para continuar] " ANSWER
if [ "$ANSWER" != "si" ]; then
    echo "Cancelado, no se empujó nada."
    exit 1
fi

git push "$REMOTE" "$BRANCH:$REMOTE_BRANCH"
echo "Listo. Sigue el build en: https://huggingface.co/spaces/fchaparro/inmostats-api"
