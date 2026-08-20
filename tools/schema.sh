#!/usr/bin/env bash
# Print a type's fields (with argument names) from the live schema.
#
#   tools/schema.sh Query
#   tools/schema.sh UpdateChapterPatchInput
#
# Introspects fresh each run, so it reflects whatever server version is up.
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
[ $# -ge 1 ] || { echo "usage: $0 <TypeName>" >&2; exit 2; }

CACHE="${TMPDIR:-/tmp}/yume-schema-$(echo "$UPSTREAM" | tr -c 'a-zA-Z0-9' '-').json"
if [ ! -s "$CACHE" ] || [ -n "${REFRESH:-}" ]; then
  echo "introspecting $UPSTREAM ..." >&2
  curl -s -m 60 -X POST -H 'Content-Type: application/json' \
    --data '{"query":"{ __schema { types { name kind fields { name args { name type { name kind ofType { name kind ofType { name } } } } type { name kind ofType { name kind ofType { name } } } } inputFields { name type { name kind ofType { name kind ofType { name } } } } } } }"}' \
    "$UPSTREAM/api/graphql" > "$CACHE"
fi

jq -r --arg n "$1" '
  def unwrap: [.. | objects | .name? // empty] | map(select(. != null)) | last;
  .data.__schema.types[] | select(.name == $n) |
  "TYPE \(.name) [\(.kind)]",
  ((.fields // [])[] |
    "  \(.name)\(if (.args | length) > 0 then "(" + ([.args[] | .name + ": " + ((.type | unwrap) // "?")] | join(", ")) + ")" else "" end) -> \(.type | unwrap)"),
  ((.inputFields // [])[] | "  IN \(.name): \(.type | unwrap)")
' "$CACHE"
