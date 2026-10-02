#!/usr/bin/env bash
# End-to-end checks for permalinks, access control, uploads, locking,
# restore, visibility, and cleanup.
#
# Runs against a local `pnpm dev` (astro dev with miniflare D1/R2) and uses
# the dev-bypass login. It flips the dev user's role and inserts a second
# user and lock rows straight into the local D1 file, so never point it at
# a real deployment.
#
#   pnpm dev            # in one terminal (restart after plugin code changes)
#   scripts/verify.sh   # in another

set -uo pipefail

B=${BASE_URL:-http://localhost:4329}
SITE=$(cd "$(dirname "$0")/../site" && pwd)
D1=$(ls -S "$SITE"/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata | head -1)
R2DIR="$SITE/.wrangler/state/v3/r2/miniflare-R2BucketObject"
API=$B/_emdash/api/document-revisions
CONTENT=$B/_emdash/api/content/documents
H='X-EmDash-Request: 1'
TMP=$(mktemp -d)
RUN=$(date +%s)
DEV=dev@emdash.local
OTHER=verify-other
cleanup() {
	role 50 >/dev/null
	sql "alter table _emdash_entry_locks_verify rename to _emdash_entry_locks;" 2>/dev/null
	sql "update _emdash_collections set edit_locking=1 where slug='documents'; delete from _emdash_entry_locks where token='verify';"
	rm -rf "$TMP"
}
trap cleanup EXIT

pass=0
fail=0
check() { # name expected actual
	if [[ "$3" == "$2" ]]; then
		pass=$((pass + 1)); printf '  ok    %s\n' "$1"
	else
		fail=$((fail + 1)); printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"
		[[ -s "$TMP/last" ]] && printf '        last response: %s\n' "$(head -c 300 "$TMP/last")"
	fi
}
code() { curl -s -o "$TMP/last" -w '%{http_code}' "$@"; }
sql() { sqlite3 "$D1" "$1"; }
r2count() { # objects whose key starts with $1, across local R2 buckets
	local n=0 f c
	for f in "$R2DIR"/*.sqlite; do
		[[ $f == *metadata* ]] && continue
		c=$(sqlite3 "$f" "select count(*) from _mf_objects where key like '$1%'" 2>/dev/null || echo 0)
		n=$((n + c))
	done
	echo $n
}

# Log in as the dev user with a given role level; cookie jar at $TMP/jar.
role() {
	sql "update users set role=$1 where email='$DEV';"
	curl -s -c "$TMP/jar" -o /dev/null "$B/_emdash/api/setup/dev-bypass?redirect=/"
}
as() { curl -s -b "$TMP/jar" -H "$H" "$@"; }
create() { # slug title -> id
	as -H 'Content-Type: application/json' -X POST "$CONTENT" -d "{\"slug\":\"$1\",\"data\":{\"title\":\"$2\"}}" |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["item"]["id"])'
}
publish() { as -H 'Content-Type: application/json' -X POST "$CONTENT/$1/publish" -d '{}' >/dev/null; }
upload() { # id file content-type filename [extra curl args]
	local id=$1 file=$2 type=$3 name=$4; shift 4
	curl -s -o "$TMP/last" -w '%{http_code}' -b "$TMP/jar" -H "$H" -H "Content-Type: $type" \
		--data-binary "@$file" "$@" "$CONTENT/$id/files?filename=$name"
}
# JSON bodies come from printf: inline {"a":1,"b":2} inside $(...) gets
# brace-expanded by bash into separate words.
post() { # url json -> http code
	curl -s -o "$TMP/last" -w '%{http_code}' -b "$TMP/jar" -H "$H" -H 'Content-Type: application/json' \
		-X POST "$1" -d "$2"
}
restore() { post "$CONTENT/$1/files/restore" "$(printf '{"n":%s}' "$2")"; }
setvis() { post "$CONTENT/$1/files/visibility" "$(printf '{"mode":"%s","password":"%s"}' "$2" "${3:-}")"; }

role 50
dev_id=$(sql "select id from users where email='$DEV'")
sql "insert or ignore into users (id, email, name, role) values ('$OTHER', 'other@verify.local', 'Other Editor', 40);"

printf 'one\n' >"$TMP/one.txt"
printf '%%PDF-1.4 fake two\n' >"$TMP/two.pdf"

echo "Upload and permalinks"
P=verify-$RUN
P_ID=$(create "$P" "Verify $RUN")
check "upload revision 1" 201 "$(upload "$P_ID" "$TMP/one.txt" text/plain one.txt)"
check "upload revision 2" 201 "$(upload "$P_ID" "$TMP/two.pdf" application/pdf two.pdf)"
check "draft, anonymous" 404 "$(code "$B/documents/$P")"
check "draft, admin" 200 "$(code -b "$TMP/jar" "$B/documents/$P")"
check "draft is never publicly cacheable" "private, no-store" \
	"$(curl -s -D - -o /dev/null -b "$TMP/jar" "$B/documents/$P" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
publish "$P_ID"
check "published, extensionless" 200 "$(code "$B/documents/$P")"
check "published, canonical .pdf" 200 "$(code "$B/documents/$P.pdf")"
check "published, wrong extension still resolves" 200 "$(code "$B/documents/$P.doc")"
check "published, WP date form" 200 "$(code "$B/documents/2011/08/$P.pdf")"
check "public latest is cacheable" "public, max-age=60" \
	"$(curl -s -D - -o /dev/null "$B/documents/$P.pdf" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
role 10
check "published, signed-in subscriber" 200 "$(code -b "$TMP/jar" "$B/documents/$P.pdf")"
check "revision 1, subscriber" 404 "$(code -b "$TMP/jar" "$B/documents/$P-revision-1.txt")"
role 50
check "revision 1, anonymous" 404 "$(code "$B/documents/$P-revision-1.txt")"
check "revision 1, admin" one "$(curl -s -b "$TMP/jar" "$B/documents/$P-revision-1.txt")"
check "unknown revision" 404 "$(code -b "$TMP/jar" "$B/documents/$P-revision-99.txt")"
check "bad path shape" 404 "$(code "$B/documents/a/b")"
check "revision log hides storage keys" 0 \
	"$(as "$CONTENT/$P_ID/files" | grep -c '"key"')"
as -H 'Content-Type: application/json' -X PUT "$CONTENT/$P_ID" -d '{"data":{"title":"Verify renamed"}}' >/dev/null
check "revision log includes core field edits, ISO-dated" yes \
	"$(as "$CONTENT/$P_ID/files" | python3 -c 'import json,sys; e=json.load(sys.stdin)["data"]["edits"]; print("yes" if e and all(x["createdAt"].endswith("Z") for x in e) else "no")')"

echo "Dotted slugs"
DOT=verify.$RUN
DOT_ID=$(create "$DOT" "Dotted $RUN")
upload "$DOT_ID" "$TMP/one.txt" text/plain one.txt >/dev/null
check "dotted slug, exact" 200 "$(code -b "$TMP/jar" "$B/documents/$DOT")"
check "dotted slug + extension" 200 "$(code -b "$TMP/jar" "$B/documents/$DOT.txt")"

echo "Large uploads (streamed, no 8 MiB plugin cap)"
head -c $((30 * 1024 * 1024)) /dev/urandom >"$TMP/30m.bin"
check "30 MiB upload" 201 "$(upload "$P_ID" "$TMP/30m.bin" application/octet-stream big.bin)"
check "30 MiB round-trips byte-identical" same \
	"$(curl -s "$B/documents/$P" | cmp -s - "$TMP/30m.bin" && echo same || echo different)"
check "missing Content-Length" 411 \
	"$(upload "$P_ID" "$TMP/one.txt" text/plain one.txt -H 'Transfer-Encoding: chunked')"
head -c $((101 * 1024 * 1024)) /dev/zero >"$TMP/101m.bin"
check "over 100 MiB" 413 "$(upload "$P_ID" "$TMP/101m.bin" application/octet-stream huge.bin)"
rm -f "$TMP/101m.bin"

echo "Restore"
check "restore revision 1" 201 "$(restore "$P_ID" 1)"
check "restored file is current" one "$(curl -s "$B/documents/$P")"
check "restore records its source" 1 \
	"$(as "$CONTENT/$P_ID/files" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["revisions"][0]["restoredFrom"])')"
check "restore unknown revision" 404 "$(restore "$P_ID" 99)"

echo "Core edit lock"
now=$(python3 -c 'import datetime as d; t=d.datetime.now(d.timezone.utc); print(t.isoformat(timespec="milliseconds").replace("+00:00","Z"), (t+d.timedelta(minutes=5)).isoformat(timespec="milliseconds").replace("+00:00","Z"))')
read -r acquired expires <<<"$now"
sql "insert into _emdash_entry_locks (collection, entry_id, user_id, token, acquired_at, expires_at) values ('documents', '$P_ID', '$OTHER', 'verify', '$acquired', '$expires');"
check "upload while another user holds the lock" 409 "$(upload "$P_ID" "$TMP/one.txt" text/plain one.txt)"
check "restore while locked" 409 "$(restore "$P_ID" 1)"
check "visibility while locked" 409 "$(setvis "$P_ID" private)"
sql "delete from _emdash_entry_locks where entry_id='$P_ID';"
as -H 'Content-Type: application/json' -X POST "$CONTENT/$P_ID/lock" -d '{}' >/dev/null
check "upload while holding the lock yourself" 201 "$(upload "$P_ID" "$TMP/one.txt" text/plain one.txt)"
as -X DELETE "$CONTENT/$P_ID/lock" >/dev/null
sql "update _emdash_collections set edit_locking=0 where slug='documents';"
sql "insert into _emdash_entry_locks (collection, entry_id, user_id, token, acquired_at, expires_at) values ('documents', '$P_ID', '$OTHER', 'verify', '$acquired', '$expires');"
check "stale lock ignored when locking is off" 201 "$(upload "$P_ID" "$TMP/one.txt" text/plain one.txt)"
sql "update _emdash_collections set edit_locking=1 where slug='documents'; delete from _emdash_entry_locks where entry_id='$P_ID';"

echo "Ownership"
O=verify-other-$RUN
O_ID=$(create "$O" "Owned by someone else $RUN")
upload "$O_ID" "$TMP/one.txt" text/plain one.txt >/dev/null
publish "$O_ID"
sql "update ec_documents set author_id='$OTHER' where id='$O_ID';"
role 30
check "author uploading to another's document" 403 "$(upload "$O_ID" "$TMP/one.txt" text/plain one.txt)"
check "author restoring on another's document" 403 "$(restore "$O_ID" 1)"
role 40
check "editor uploading to another's document" 201 "$(upload "$O_ID" "$TMP/one.txt" text/plain one.txt)"

echo "Private documents"
role 50
check "set private" 200 "$(setvis "$O_ID" private)"
check "private, anonymous" 404 "$(code "$B/documents/$O")"
role 10; check "private, subscriber" 404 "$(code -b "$TMP/jar" "$B/documents/$O")"
role 20; check "private, contributor (not author)" 404 "$(code -b "$TMP/jar" "$B/documents/$O")"
check "private revision log, contributor" 403 "$(code -b "$TMP/jar" "$CONTENT/$O_ID/files")"
role 30; check "private, author role (not this document's author)" 404 "$(code -b "$TMP/jar" "$B/documents/$O")"
role 40; check "private, editor" 200 "$(code -b "$TMP/jar" "$B/documents/$O")"
check "private is never publicly cacheable" "private, no-store" \
	"$(curl -s -D - -o /dev/null -b "$TMP/jar" "$B/documents/$O" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
role 50
sql "update ec_documents set author_id='$dev_id' where id='$O_ID';"
role 20; check "private, its own author at contributor level" 200 "$(code -b "$TMP/jar" "$B/documents/$O")"
role 50

echo "Password-protected documents"
check "password mode needs a password" 400 "$(setvis "$P_ID" password)"
check "set password" 200 "$(setvis "$P_ID" password pw-one)"
check "anonymous gets the password form" 401 "$(code "$B/documents/$P")"
check "wrong password" 401 "$(code -X POST --data-urlencode password=nope "$B/documents/$P")"
check "cross-site form post" 403 \
	"$(code -X POST -H 'Origin: https://evil.example' --data-urlencode password=pw-one "$B/documents/$P")"
check "right password redirects" 303 "$(code -c "$TMP/pw" -X POST --data-urlencode password=pw-one "$B/documents/$P")"
check "password cookie is HttpOnly and scoped" yes \
	"$(curl -s -D - -o /dev/null -X POST --data-urlencode password=pw-one "$B/documents/$P" | tr -d '\r' |
		grep -i '^set-cookie:' | grep -q 'Path=/documents.*HttpOnly.*SameSite=Lax' && echo yes || echo no)"
check "with cookie" 200 "$(code -b "$TMP/pw" "$B/documents/$P")"
role 10
check "subscriber gets the password form" 401 "$(code -b "$TMP/jar" "$B/documents/$P")"
cat "$TMP/jar" "$TMP/pw" >"$TMP/both"
check "subscriber with cookie" 200 "$(code -b "$TMP/both" "$B/documents/$P")"
role 50
check "cookie doesn't open past revisions" 404 "$(code -b "$TMP/pw" "$B/documents/$P-revision-1.txt")"
check "editor needs no password" 200 "$(code -b "$TMP/jar" "$B/documents/$P")"
check "password log hides the hash" 0 "$(as "$CONTENT/$P_ID/files" | grep -c 'passwordHash')"
check "change password" 200 "$(setvis "$P_ID" password pw-two)"
check "old cookie stops working" 401 "$(code -b "$TMP/pw" "$B/documents/$P")"
check "back to public" 200 "$(setvis "$P_ID" public)"
check "public again" 200 "$(code "$B/documents/$P")"

echo "Trash, restore, permanent delete"
T=verify-trash-$RUN
T_ID=$(create "$T" "Trash $RUN")
upload "$T_ID" "$TMP/one.txt" text/plain one.txt >/dev/null
upload "$T_ID" "$TMP/two.pdf" application/pdf two.pdf >/dev/null
publish "$T_ID"
as -X DELETE "$CONTENT/$T_ID" >/dev/null
check "trashed, admin" 404 "$(code -b "$TMP/jar" "$B/documents/$T")"
check "trashed files kept" 3 "$(r2count "entries/$T_ID/")"
as -X POST "$CONTENT/$T_ID/restore" >/dev/null
# Core restores trashed entries as drafts.
check "restored from trash, admin" 200 "$(code -b "$TMP/jar" "$B/documents/$T")"
check "restored from trash is a draft again, anonymous" 404 "$(code "$B/documents/$T")"
as -X DELETE "$CONTENT/$T_ID" >/dev/null
as -X DELETE "$CONTENT/$T_ID/permanent" >/dev/null
check "permanent delete removes files and manifest" 0 "$(r2count "entries/$T_ID/")"
check "permanent delete removes slug index" 0 "$(r2count "slugs/$T")"
NEW_ID=$(create "$T" "Recycled $RUN")
publish "$NEW_ID"
check "recycled slug with no files" 404 "$(code "$B/documents/$T")"

echo "Plumbing"
check "write without CSRF header" 403 \
	"$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/jar" -X POST "$CONTENT/$P_ID/files/restore" -d '{}')"
check "anonymous API" 401 "$(code "$API/me")"
check "old plugin upload route is gone" 404 \
	"$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/jar" -H "$H" -X POST "$B/_emdash/api/plugins/document-revisions/upload")"
role 20; check "contributor can't create documents" False \
	"$(as "$API/me" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["canCreate"])')"
role 30; check "author can create documents" True \
	"$(as "$API/me" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["canCreate"])')"
role 50

echo "Private titles stay out of public listings"
check "public search never returns documents" 0 \
	"$(curl -s "$B/_emdash/api/search?q=Verify" | python3 -c 'import json,sys; print(sum(i["collection"]=="documents" for i in json.load(sys.stdin)["data"]["items"]))')"
check "listing page shows a public document" 1 "$(curl -s "$B/documents" | grep -c "href=\"/documents/$P\"")"
setvis "$P_ID" password lp >/dev/null
check "listing page hides a password-protected document" 0 "$(curl -s "$B/documents" | grep -c "href=\"/documents/$P\"")"
setvis "$P_ID" public >/dev/null
check "listing page hides a private document" 0 "$(curl -s "$B/documents" | grep -c "href=\"/documents/$O\"")"

echo "Storage admin (stands in for plugin:uninstall)"
role 40
check "storage admin, editor" 403 "$(code -b "$TMP/jar" "$API/storage")"
role 50
ORPH=verify-orphan-$RUN
ORPH_ID=$(create "$ORPH" "Orphan $RUN")
upload "$ORPH_ID" "$TMP/one.txt" text/plain one.txt >/dev/null
# Simulate a document deleted while the plugin was off: the row vanishes, no hook runs.
sql "delete from ec_documents where id='$ORPH_ID';"
check "orphan detected" yes \
	"$(as "$API/storage" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["data"]["orphans"] >= 1 else "no")')"
check "purge orphans" 200 "$(post "$API/purge-orphans" '{}')"
check "orphan's files are gone" 0 "$(r2count "entries/$ORPH_ID/")"
check "live documents untouched by orphan purge" yes \
	"$([[ $(r2count "entries/$P_ID/") -gt 0 ]] && echo yes || echo no)"
check "purge-all without confirmation" 400 "$(post "$API/purge-all" '{"confirm":"yes"}')"

echo "Lock check fails closed"
sql "alter table _emdash_entry_locks rename to _emdash_entry_locks_verify;"
check "upload when the lock table is unreadable" 503 "$(upload "$P_ID" "$TMP/one.txt" text/plain one.txt)"
check "log still readable" 200 "$(code -b "$TMP/jar" "$CONTENT/$P_ID/files")"
sql "alter table _emdash_entry_locks_verify rename to _emdash_entry_locks;"
check "upload once the table is back" 201 "$(upload "$P_ID" "$TMP/one.txt" text/plain one.txt)"

echo "API tokens (scopes map like core content routes)"
mktoken() {
	as -H 'Content-Type: application/json' -X POST "$B/_emdash/api/admin/api-tokens" \
		-d "$(printf '{"name":"verify-%s","scopes":["%s"]}' "$1" "$1")" |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])'
}
read_token=$(mktoken content:read)
write_token=$(mktoken content:write)
admin_token=$(mktoken admin)
check "content:read token reads the log" 200 \
	"$(code -H "Authorization: Bearer $read_token" "$CONTENT/$P_ID/files")"
check "content:read token can't write" 403 \
	"$(code -H "Authorization: Bearer $read_token" -H 'Content-Type: application/json' -X POST "$CONTENT/$P_ID/files/restore" -d '{"n":1}')"
check "content:write token uploads" 201 \
	"$(code -H "Authorization: Bearer $write_token" -H 'Content-Type: text/plain' --data-binary "@$TMP/one.txt" "$CONTENT/$P_ID/files?filename=token.txt")"
check "content:write token can't reach storage admin" 403 \
	"$(code -H "Authorization: Bearer $write_token" "$API/storage")"
check "admin token reaches storage admin" 200 "$(code -H "Authorization: Bearer $admin_token" "$API/storage")"

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
