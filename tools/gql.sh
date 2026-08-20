#!/usr/bin/env bash
# Run one GraphQL document against Suwayomi and pretty-print the result.
#
#   tools/gql.sh '{ aboutServer { version } }'
#   SUWAYOMI=http://host:4567 tools/gql.sh 'mutation { ... }'
#
# Reads SUWAYOMI from .env (see .env.example) when not set in the environment.
#
# Schema field names vary by server version — introspect rather than trusting
# memory. See SCHEMA.md for the operations already verified.
set -euo pipefail
# Read .env from the project root if present; a real environment variable wins.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.env"; set +a
fi
UPSTREAM="${SUWAYOMI:-http://suwayomi.local:4567}"
case "$UPSTREAM" in
  *.local:*) echo "SUWAYOMI is not configured (\$UPSTREAM is a placeholder)." >&2
             echo "Copy .env.example to .env and set it." >&2; exit 3;;
esac
[ $# -ge 1 ] || { echo "usage: $0 '<graphql document>'" >&2; exit 2; }
curl -s -m 30 -X POST -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg q "$1" '{query:$q}')" \
  "$UPSTREAM/api/graphql" | jq .
