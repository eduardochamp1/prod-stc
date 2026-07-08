#!/bin/bash
# Instala os git hooks versionados em .git/hooks/ (P1-6 do backlog).
# Rode uma vez após clonar o repo: bash scripts/install-hooks.sh
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cp "$DIR/hooks/pre-push" "$DIR/.git/hooks/pre-push"
chmod +x "$DIR/.git/hooks/pre-push"
echo "✅ Hook pre-push instalado. Testes rodarão automaticamente antes de cada push."
