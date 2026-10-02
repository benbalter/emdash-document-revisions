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
	# Back to the product default (private, as in WP Document Revisions).
	curl -s -o /dev/null -b "$TMP/jar" -H "$H" -H 'Content-Type: application/json' -X POST "$API/settings" -d '{"defaultVisibility":"private"}' 
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
# Most checks below assume documents are public once published; the default
# itself is tested in its own section.
curl -s -o /dev/null -b "$TMP/jar" -H "$H" -H 'Content-Type: application/json' -X POST "$API/settings" -d '{"defaultVisibility":"public"}' 
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

echo "Default visibility for new documents"
post "$API/settings" '{"defaultVisibility":"private"}' >/dev/null
DV_ID=$(create "verify-dv-$RUN" "Default private $RUN")
check "new document is private when the default is private" private \
	"$(as "$CONTENT/$DV_ID/files" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["visibility"]["mode"])')"
role 40
check "settings are Admin-only" 403 "$(code -b "$TMP/jar" "$API/settings")"
role 50
post "$API/settings" '{"defaultVisibility":"public"}' >/dev/null
DV2_ID=$(create "verify-dv2-$RUN" "Default public $RUN")
check "new document is public when the default is public" public \
	"$(as "$CONTENT/$DV2_ID/files" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["visibility"]["mode"])')"

echo "Range and conditional requests"
R_SL=verify-range-$RUN
R_ID=$(create "$R_SL" "Range $RUN")
seq 1 2000 >"$TMP/range.txt"
upload "$R_ID" "$TMP/range.txt" text/plain range.txt >/dev/null
publish "$R_ID"
check "first 10 bytes" "$(head -c 10 "$TMP/range.txt" | od -An -c | tr -d ' \n')" \
	"$(curl -s -H 'Range: bytes=0-9' "$B/documents/$R_SL.txt" | od -An -c | tr -d ' \n')"
check "206 with Content-Range" "206 bytes 0-9/$(wc -c <"$TMP/range.txt" | tr -d ' ')" \
	"$(curl -s -D - -o /dev/null -H 'Range: bytes=0-9' "$B/documents/$R_SL.txt" | tr -d '\r' | awk -F': ' '/^HTTP/{s=$0; sub(/^HTTP\/[0-9.]+ /,"",s); split(s,a," "); c=a[1]} tolower($1)=="content-range"{r=$2} END{print c" "r}')"
check "suffix range" "$(tail -c 6 "$TMP/range.txt" | od -An -c | tr -d ' \n')" \
	"$(curl -s -H 'Range: bytes=-6' "$B/documents/$R_SL.txt" | od -An -c | tr -d ' \n')"
check "unsatisfiable range" 416 "$(code -H 'Range: bytes=99999999-' "$B/documents/$R_SL.txt")"
etag=$(curl -s -D - -o /dev/null "$B/documents/$R_SL.txt" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
check "If-None-Match gets 304" 304 "$(code -H "If-None-Match: $etag" "$B/documents/$R_SL.txt")"
check "Accept-Ranges advertised" bytes \
	"$(curl -s -D - -o /dev/null "$B/documents/$R_SL.txt" | tr -d '\r' | awk -F': ' 'tolower($1)=="accept-ranges"{print $2}')"
setvis "$R_ID" private >/dev/null
check "Range doesn't bypass privacy" 404 "$(code -H 'Range: bytes=0-9' "$B/documents/$R_SL.txt")"

echo "Multipart uploads (past the 100 MB single-request cap)"
MP_ID=$(create "verify-mp-$RUN" "Multipart $RUN")
head -c $((150 * 1024 * 1024)) /dev/urandom >"$TMP/mp.bin"
mp_create() { curl -s -b "$TMP/jar" -H "$H" -H 'Content-Type: application/json' -X POST "$CONTENT/$1/files/uploads" -d '{"contentType":"application/octet-stream"}'; }
MP=$(mp_create "$MP_ID")
MP_UP=$(echo "$MP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["uploadId"])')
MP_KEY=$(echo "$MP" | python3 -c 'import json,sys,urllib.parse; print(urllib.parse.quote(json.load(sys.stdin)["data"]["key"], safe=""))')
MP_RAWKEY=$(echo "$MP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["key"])')
split -b $((50 * 1024 * 1024)) "$TMP/mp.bin" "$TMP/mp_part_"
parts="["
n=1
for f in "$TMP"/mp_part_*; do
	parts+=$(curl -s -b "$TMP/jar" -H "$H" -X PUT --data-binary "@$f" "$CONTENT/$MP_ID/files/uploads/$MP_UP/parts/$n?key=$MP_KEY" |
		python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["data"]))'),
	n=$((n + 1))
done
parts="${parts%,}]"
check "three parts accepted" 3 "$(echo "$parts" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "complete" 201 "$(post "$CONTENT/$MP_ID/files/uploads/$MP_UP/complete" "$(printf '{"key":"%s","parts":%s,"filename":"big.bin","note":"multipart"}' "$MP_RAWKEY" "$parts")")"
check "150 MiB round-trips byte-identical" same \
	"$(curl -s -b "$TMP/jar" "$B/documents/verify-mp-$RUN" | cmp -s - "$TMP/mp.bin" && echo same || echo different)"
rm -f "$TMP/mp.bin" "$TMP"/mp_part_*
MP2=$(mp_create "$MP_ID")
MP2_UP=$(echo "$MP2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["uploadId"])')
MP2_KEY=$(echo "$MP2" | python3 -c 'import json,sys,urllib.parse; print(urllib.parse.quote(json.load(sys.stdin)["data"]["key"], safe=""))')
curl -s -o /dev/null -b "$TMP/jar" -H "$H" -X PUT --data-binary "@$TMP/one.txt" "$CONTENT/$MP_ID/files/uploads/$MP2_UP/parts/1?key=$MP2_KEY"
check "abort" 200 "$(code -b "$TMP/jar" -H "$H" -X DELETE "$CONTENT/$MP_ID/files/uploads/$MP2_UP?key=$MP2_KEY")"
check "aborted upload adds no revision" 1 \
	"$(as "$CONTENT/$MP_ID/files" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]["revisions"]))')"
check "a part can't target another document's key" 400 \
	"$(code -b "$TMP/jar" -H "$H" -X PUT --data-binary "@$TMP/one.txt" "$CONTENT/$MP_ID/files/uploads/x/parts/1?key=entries%2F$P_ID%2Ffiles%2Fx")"
sql "insert into _emdash_entry_locks (collection, entry_id, user_id, token, acquired_at, expires_at) values ('documents', '$MP_ID', '$OTHER', 'verify', '$acquired', '$expires');"
check "multipart refused while someone else holds the lock" 409 "$(code -b "$TMP/jar" -H "$H" -H 'Content-Type: application/json' -X POST "$CONTENT/$MP_ID/files/uploads" -d '{}')"
sql "delete from _emdash_entry_locks where entry_id='$MP_ID';"
sql "update ec_documents set author_id='$OTHER' where id='$O_ID';"
role 30
check "author can't start a multipart upload on another's document" 403 \
	"$(code -b "$TMP/jar" -H "$H" -H 'Content-Type: application/json' -X POST "$CONTENT/$O_ID/files/uploads" -d '{}')"
role 50

echo "Password rate limit"
RL_SL=verify-rl-$RUN
RL_ID=$(create "$RL_SL" "Rate limit $RUN")
upload "$RL_ID" "$TMP/one.txt" text/plain one.txt >/dev/null
publish "$RL_ID"
setvis "$RL_ID" password rl-secret >/dev/null
codes=""
for _ in 1 2 3 4 5 6; do codes+="$(code -X POST --data-urlencode password=wrong "$B/documents/$RL_SL") "; done
check "sixth wrong password in a minute is throttled" "401 401 401 401 401 429" "${codes% }"

echo "Text extraction (queue)"
TX_ID=$(create "verify-tx-$RUN" "Text $RUN")
printf 'The quick brown fox\n' >"$TMP/fox.txt"
upload "$TX_ID" "$TMP/fox.txt" text/plain fox.txt >/dev/null
upload "$TX_ID" "$TMP/two.pdf" application/pdf two.pdf >/dev/null
text_status() { as "$CONTENT/$TX_ID/files" | python3 -c "import json,sys; r={x['n']:x for x in json.load(sys.stdin)['data']['revisions']}; print((r[$1].get('text') or {}).get('status','pending'))"; }
for _ in $(seq 1 20); do [[ $(text_status 1) != pending && $(text_status 2) != pending ]] && break; sleep 0.5; done
check "plain text extracted" done "$(text_status 1)"
check "extracted text matches" "The quick brown fox" \
	"$(as "$CONTENT/$TX_ID/files/text?n=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["text"].strip())')"
check "PDF skipped without a Workers AI binding" skipped "$(text_status 2)"
role 10
check "extracted text needs read-drafts" 403 "$(code -b "$TMP/jar" "$CONTENT/$TX_ID/files/text?n=1")"
role 50
as -X DELETE "$CONTENT/$TX_ID" >/dev/null
as -X DELETE "$CONTENT/$TX_ID/permanent" >/dev/null
check "permanent delete removes extracted text" 0 "$(r2count "entries/$TX_ID/text/")"

echo "List columns"
COLS=$(as "$API/columns?ids=$P_ID,$O_ID")
check "columns report file type and size" yes \
	"$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])["data"]; r=d[sys.argv[2]]; print("yes" if r["type"] and r["size"]>0 and r["visibility"] else "no")' "$COLS" "$P_ID")"
role 10
check "columns need read-drafts" 403 "$(code -b "$TMP/jar" "$API/columns?ids=$P_ID")"
role 50

echo "Revision feed"
FEED_KEY=$(as -X POST "$API/feed-key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["key"])')
check "feed without a key" 404 "$(code "$B/documents/$P/feed")"
check "feed with a wrong key" 404 "$(code "$B/documents/$P/feed?key=wrongwrongwrongwrongwrong")"
check "feed with the key" 200 "$(code "$B/documents/$P/feed?key=$FEED_KEY")"
check "feed is Atom with one entry per revision" yes "$(curl -s "$B/documents/$P/feed?key=$FEED_KEY" | python3 -c '
import sys, xml.etree.ElementTree as ET
ns={"a":"http://www.w3.org/2005/Atom"}
root=ET.fromstring(sys.stdin.read())
entries=root.findall("a:entry",ns)
print("yes" if len(entries)>=4 and all("-revision-" in e.find("a:link",ns).get("href") for e in entries) else "no")')"
OLD_KEY=$FEED_KEY
FEED_KEY=$(as -X POST "$API/feed-key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["key"])')
check "a new key revokes the old one" 404 "$(code "$B/documents/$P/feed?key=$OLD_KEY")"
role 10
SUB_KEY_STATUS=$(code -b "$TMP/jar" -H "$H" -X POST "$API/feed-key")
check "subscribers can't get feed keys" 403 "$SUB_KEY_STATUS"
# One dev account, so one key: the feed checks the user's role on every
# request, which also shows role changes take effect immediately.
sql "update ec_documents set author_id='$OTHER' where id='$O_ID';"
setvis "$O_ID" private >/dev/null
role 20
check "contributor's key can't read another's private document feed" 404 "$(code "$B/documents/$O/feed?key=$FEED_KEY")"
role 50
check "same key works once the user is promoted" 200 "$(code "$B/documents/$O/feed?key=$FEED_KEY")"
as -X DELETE "$API/feed-key" >/dev/null
check "revoked key stops working" 404 "$(code "$B/documents/$O/feed?key=$FEED_KEY")"

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
