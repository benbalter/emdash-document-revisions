#!/usr/bin/env bash
# End-to-end check of the WordPress importer.
#
# 1. Boots WordPress in Playground with the released WP Document Revisions,
#    seeds documents (scripts/fixtures/wpdr-seed.php), and runs the exporter.
# 2. Imports the bundle into the local EmDash dev site, twice.
# 3. Checks files, revision numbers, authors, notes, visibility, workflow
#    states, publish status, and that the second run skips everything.
#
# Needs `pnpm dev` running (local miniflare state, dev-bypass login) and
# network access for Playground's first download. Never point it at a real
# deployment.

set -uo pipefail

B=${BASE_URL:-http://localhost:4329}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
RUN=$(date +%s)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
check() {
	if [[ "$3" == "$2" ]]; then
		pass=$((pass + 1)); printf '  ok    %s\n' "$1"
	else
		fail=$((fail + 1)); printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"
	fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Export from WordPress (Playground)"
mkdir -p "$WORK/out"
cp "$ROOT/scripts/fixtures/wpdr-seed.php" "$WORK/"
echo "$RUN" >"$WORK/run.txt"
npx -y @wp-playground/cli@latest run-blueprint \
	--blueprint="$ROOT/scripts/fixtures/blueprint.json" \
	--mount="$WORK:/fixtures" --mount="$WORK/out:/out" --mount="$ROOT/scripts:/scripts" >"$WORK/playground.log" 2>&1
export_status=$?
BUNDLE=$WORK/out/bundle
check "exporter succeeded" 0 "$export_status"
check "seed stored files in a document directory outside uploads" OFFSITE-OK "$(cat "$WORK/out/seed-check.txt" 2>/dev/null)"
if [[ $export_status -ne 0 ]]; then
	grep -a -E 'missing|Error' "$WORK/playground.log" | head -5
	echo "Export failed; not importing. Playground log: $WORK/playground.log"
	trap - EXIT
	exit 1
fi
check "bundle written" yes "$([[ -f $BUNDLE/export.json ]] && echo yes || echo no)"
check "documents exported" 7 "$(python3 -c "import json; print(len(json.load(open('$BUNDLE/export.json'))['documents']))" 2>/dev/null)"

check "exporter recorded the plugin version" yes \
	"$(python3 -c "import json; print('yes' if json.load(open('$BUNDLE/export.json'))['wpdrVersion'] else 'no')" 2>/dev/null)"

echo "Import into EmDash"
# An EmDash user matching the WordPress editor's email, so owner mapping is
# tested against someone other than the importing admin.
D1=$(ls -S "$ROOT"/site/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata | head -1)
sqlite3 "$D1" "insert or ignore into users (id, email, name, role) values ('verify-wp-editor', 'editor@example.com', 'Edna (EmDash)', 40);"
curl -s -c "$WORK/jar" -o /dev/null "$B/_emdash/api/setup/dev-bypass?redirect=/"
TOKEN=$(curl -s -b "$WORK/jar" -H 'X-EmDash-Request: 1' -H 'Content-Type: application/json' -X POST \
	"$B/_emdash/api/admin/api-tokens" -d "{\"name\":\"verify-import-$RUN\",\"scopes\":[\"admin\"]}" |
	python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
# --multipart-over 100: every file over 100 bytes (the fixture PDF included)
# goes through the multipart path, which the byte-identical PDF check covers.
EMDASH_TOKEN=$TOKEN node "$ROOT/scripts/import-wpdr.mjs" "$BUNDLE" --site "$B" --multipart-over 100 >"$WORK/import1.log"
check "first import" 0 $?
check "first import imported all 7" 1 "$(grep -c '^7 imported$' "$WORK/import1.log")"
EMDASH_TOKEN=$TOKEN node "$ROOT/scripts/import-wpdr.mjs" "$BUNDLE" --site "$B" >"$WORK/import2.log"
check "re-run skips everything" 1 "$(grep -c '^7 skipped$' "$WORK/import2.log")"

api() { curl -s -H "Authorization: Bearer $TOKEN" "$B$1"; }
H=handbook-$RUN
H_ID=$(api "/_emdash/api/content/documents/$H" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["item"]["id"])')

echo "Files and permalinks"
check "latest file, anonymous" "Handbook v3" "$(curl -s "$B/documents/$H.txt")"
check "WordPress-style dated revision URL serves the original PDF" same \
	"$(curl -s -b "$WORK/jar" "$B/documents/2026/01/$H-revision-1.pdf" | cmp -s - "$WORK/out/fixture.pdf" && echo same || echo different)"
check "note-only revision shares the previous file" "Handbook v2" "$(curl -s -b "$WORK/jar" "$B/documents/$H-revision-3.txt")"
check "past revision stays private" 404 "$(code "$B/documents/$H-revision-1.pdf")"

echo "Revision log"
LOG=$(api "/_emdash/api/content/documents/$H_ID/files")
py() { python3 -c "import json,sys; d=json.loads(sys.argv[1])['data']; $1" "$LOG"; }
check "revision numbers preserved" "4,3,2,1" "$(py 'print(",".join(str(r["n"]) for r in d["revisions"]))')"
check "authors preserved" "Ada Admin,Edna Editor,Edna Editor,Ada Admin" "$(py 'print(",".join(r["authorName"] for r in d["revisions"]))')"
check "notes preserved" "Final wording|Fixed a typo in the title|Second draft|Initial upload" \
	"$(py 'print("|".join(r["note"] for r in d["revisions"]))')"
check "source recorded" "wordpress" "$(py 'print(d["source"]["system"])')"

echo "Document metadata"
ITEM=$(api "/_emdash/api/content/documents/$H_ID")
check "title is the current WordPress title" "Handbook 2026" \
	"$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["data"]["item"]["data"]["title"])' "$ITEM")"
check "description became the summary" "Policies for all staff." \
	"$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["data"]["item"]["data"]["summary"])' "$ITEM")"
check "published" published "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["data"]["item"]["status"])' "$ITEM")"
check "owner mapped by email" verify-wp-editor \
	"$(api "/_emdash/api/content/documents/proposal-$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["item"]["authorId"])')"
title_of() { api "/_emdash/api/content/documents/$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["item"]["data"]["title"])'; }
check "private title has no 'Private:' prefix" "Board Minutes" "$(title_of "minutes-$RUN")"
check "password title has no 'Protected:' prefix" "Salary Bands" "$(title_of "bands-$RUN")"
check "workflow state assigned" final \
	"$(api "/_emdash/api/content/documents/$H_ID/terms/workflow_state" | python3 -c 'import json,sys; print(",".join(t["slug"] for t in json.load(sys.stdin)["data"]["terms"]))')"

echo "Visibility and status"
check "private document, anonymous" 404 "$(code "$B/documents/minutes-$RUN.txt")"
check "private document, admin" 200 "$(code -b "$WORK/jar" "$B/documents/minutes-$RUN.txt")"
check "password document asks for the password" 401 "$(code "$B/documents/bands-$RUN.txt")"
check "the WordPress password still works" 303 "$(code -X POST --data-urlencode password=open-sesame "$B/documents/bands-$RUN.txt")"
check "draft stays a draft" 404 "$(code "$B/documents/proposal-$RUN.txt")"
check "draft visible to admin" 200 "$(code -b "$WORK/jar" "$B/documents/proposal-$RUN.txt")"
check "document without files imported" published \
	"$(api "/_emdash/api/content/documents/empty-$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["item"]["status"])')"

check "scheduled document is scheduled" scheduled \
	"$(api "/_emdash/api/content/documents/plan-$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["item"]["status"])')"
check "trashed document is in the trash" 1 \
	"$(api "/_emdash/api/content/documents/trash" | python3 -c 'import json,sys; print(sum(i["slug"]=="memo-'"$RUN"'" for i in json.load(sys.stdin)["data"]["items"]))')"
check "trashed document's file isn't served" 404 "$(code -b "$WORK/jar" "$B/documents/memo-$RUN.txt")"

echo "Oversized files"
# Fake a 6 GB revision in a copy of the bundle: the importer must refuse the
# document before creating anything, not fail halfway through its revisions.
python3 - "$BUNDLE/export.json" "$WORK/big.json" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
doc = next(d for d in e["documents"] if d["slug"].startswith("minutes-"))
doc["slug"] = doc["slug"] + "-big"
doc["revisions"][0]["file"]["size"] = 6 * 1024 ** 3  # over the 5 GB multipart cap
e["documents"] = [doc]
json.dump(e, open(sys.argv[2], "w"))
PY
mkdir -p "$WORK/big" && cp "$WORK/big.json" "$WORK/big/export.json" && cp -R "$BUNDLE/files" "$WORK/big/"
EMDASH_TOKEN=$TOKEN node "$ROOT/scripts/import-wpdr.mjs" "$WORK/big" --site "$B" >"$WORK/big.log"
check "oversized document refused up front" 1 "$(grep -c '^  too-large' "$WORK/big.log")"
check "no entry created for it" 404 "$(code -H "Authorization: Bearer $TOKEN" "$B/_emdash/api/content/documents/minutes-$RUN-big")"

echo "Import endpoint guards"
check "import refuses a non-increasing revision number" 409 \
	"$(code -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/plain' --data-binary x -X POST \
		"$B/_emdash/api/content/documents/$H_ID/files/import?n=2&filename=x.txt")"

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]] || { echo "Playground log: kept at $WORK/playground.log"; trap - EXIT; }
[[ $fail -eq 0 ]]
