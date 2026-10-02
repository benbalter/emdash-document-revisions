/// <reference types="emdash/locals" />
/**
 * Per-document file API:
 *
 *   GET  /_emdash/api/content/documents/:id/files              revision log
 *   POST /_emdash/api/content/documents/:id/files?filename=…   upload (raw body)
 *   POST /_emdash/api/content/documents/:id/files/restore      { n }
 *   POST /_emdash/api/content/documents/:id/files/visibility   { mode, password? }
 *
 * Injected under core's content namespace on purpose:
 * - EmDash's middleware authenticates every request, requires the CSRF
 *   header on cookie writes, and maps API-token scopes by path prefix, so
 *   `content:read` tokens can read the log and `content:write` tokens can
 *   upload, exactly as for core content routes;
 * - uploads stream into R2 instead of being buffered under the 8 MiB
 *   plugin-route cap; and
 * - writes can honor core's entry edit lock, which plugin contexts can't read.
 */

import type { APIRoute } from "astro";

import { canEdit, canReadDrafts, canReadPrivate, hashPassword, liveLock } from "../access";
import { handle, HttpError, ok, readJson, requireEntry, requireUser, requireWritable } from "../http";
import {
	bucket,
	COLLECTION,
	permalink,
	readManifest,
	revisionObjectKey,
	updateManifest,
	visibilityOf,
	type Manifest,
	type RevisionRecord,
	type VisibilityMode,
} from "../store";

export const prerender = false;

/**
 * Cloudflare rejects request bodies over the plan's limit before the Worker
 * runs (about 100 MB on Free and Pro). Enforce the same ceiling here so the
 * error is ours and consistent across plans and local dev.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const publicRevision = ({ key: _key, ...r }: RevisionRecord) => r;

/**
 * Core stores revision times as SQLite "YYYY-MM-DD HH:MM:SS" in UTC with no
 * zone marker; browsers would read that as local time and it wouldn't sort
 * against the ISO timestamps in the manifest.
 */
function toIso(value: string): string {
	return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}

async function namesFor(locals: App.Locals, ids: string[]): Promise<Map<string, string | null>> {
	const db = locals.emdash?.db;
	if (!db || ids.length === 0) return new Map();
	const rows = await db
		.selectFrom("users")
		.select(["id", "name", "email"])
		.where("id", "in", [...new Set(ids)])
		.execute();
	return new Map(rows.map((r) => [String(r.id), (r.name as string | null) ?? String(r.email)]));
}

/** Revision log, visibility, lock state, and core content edits, newest first. */
async function revisions(locals: App.Locals, entryId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	const { manifest } = await readManifest(await bucket(), entry.id);
	const visibility = visibilityOf(manifest);
	if (!canReadDrafts(user) || (visibility.mode === "private" && !canReadPrivate(user, entry))) {
		throw new HttpError(403, "FORBIDDEN", "Insufficient permissions");
	}

	const files = manifest?.revisions ?? [];
	const latest = files.at(-1);
	const slug = entry.slug;

	// Core keeps its own revisions of the entry's fields (title, summary,
	// taxonomy). Show them in the same timeline so the log reads like WP
	// Document Revisions' combined revision log.
	const coreRes = await locals.emdash?.handleRevisionList(COLLECTION, entry.id, { limit: 50 });
	const coreItems = ((coreRes?.success ? (coreRes.data as { items?: unknown[] })?.items : null) ??
		[]) as Array<{ id: string; createdAt: string; authorId: string | null }>;
	const authorNames = await namesFor(
		locals,
		coreItems.map((i) => i.authorId).filter((id): id is string => Boolean(id)),
	);

	// A read must not fail because the lock can't be checked; writes still do.
	const lock = await liveLock(locals, entry.id).catch(() => null);

	return {
		entryId: entry.id,
		slug,
		status: entry.status,
		visibility: { mode: visibility.mode, hasPassword: Boolean(visibility.passwordHash) },
		lock,
		userId: user.id,
		canEdit: canEdit(user, entry),
		maxUploadBytes: MAX_UPLOAD_BYTES,
		permalink: slug && latest ? permalink(slug, latest) : null,
		revisions: [...files].reverse().map((r) => ({
			...publicRevision(r),
			url: slug ? permalink(slug, r, r.n) : null,
		})),
		edits: coreItems.map((i) => ({
			id: i.id,
			createdAt: toIso(i.createdAt),
			authorName: i.authorId ? (authorNames.get(i.authorId) ?? null) : null,
		})),
	};
}

/** Stream one file into R2 as a new revision. Metadata rides in the query string. */
async function upload(locals: App.Locals, request: Request, url: URL, entryId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	await requireWritable(locals, user, entry);

	const filename = (url.searchParams.get("filename") ?? "").slice(0, 255);
	if (!filename) throw new HttpError(400, "BAD_REQUEST", "Missing filename");
	const note = url.searchParams.get("note")?.slice(0, 500) || null;

	const lengthHeader = request.headers.get("content-length");
	if (!lengthHeader) throw new HttpError(411, "LENGTH_REQUIRED", "Content-Length is required");
	const size = Number(lengthHeader);
	if (!Number.isSafeInteger(size) || size <= 0 || !request.body) {
		throw new HttpError(400, "BAD_REQUEST", "Empty file");
	}
	if (size > MAX_UPLOAD_BYTES) {
		throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
	}
	const contentType =
		request.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";

	const b = await bucket();
	// Write the object before the manifest: an orphaned object is harmless,
	// a manifest entry pointing at nothing is not.
	const key = revisionObjectKey(entry.id);
	await b.put(key, request.body.pipeThrough(new FixedLengthStream(size)), {
		httpMetadata: { contentType },
	});

	const next = await updateManifest(b, entry.id, entry.slug, (m) => ({
		...m,
		slug: entry.slug,
		revisions: [
			...m.revisions,
			{
				n: (m.revisions.at(-1)?.n ?? 0) + 1,
				key,
				filename,
				contentType,
				size,
				authorId: user.id,
				authorName: user.name ?? user.email,
				note,
				createdAt: new Date().toISOString(),
			},
		],
	}));
	return { revision: publicRevision(next.revisions.at(-1)!) };
}

/**
 * Make an earlier revision current again by appending it as a new revision,
 * as WP Document Revisions does. The new revision points at the same R2
 * object; files are only deleted with the whole document, so sharing is safe.
 */
async function restore(locals: App.Locals, request: Request, entryId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	await requireWritable(locals, user, entry);
	const body = await readJson(request);
	const n = Number(body.n);
	if (!Number.isInteger(n)) throw new HttpError(400, "BAD_REQUEST", "Missing revision number");

	const next = await updateManifest(await bucket(), entry.id, entry.slug, (m) => {
		const source = m.revisions.find((r) => r.n === n);
		if (!source) throw new HttpError(404, "NOT_FOUND", `Revision ${n} not found`);
		return {
			...m,
			slug: entry.slug,
			revisions: [
				...m.revisions,
				{
					...source,
					n: (m.revisions.at(-1)?.n ?? 0) + 1,
					authorId: user.id,
					authorName: user.name ?? user.email,
					note: `Restored revision ${n}`,
					createdAt: new Date().toISOString(),
					restoredFrom: n,
				},
			],
		};
	});
	return { revision: publicRevision(next.revisions.at(-1)!) };
}

const MODES: readonly VisibilityMode[] = ["public", "private", "password"];

async function visibility(locals: App.Locals, request: Request, entryId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	await requireWritable(locals, user, entry);
	const body = await readJson(request);
	const mode = body.mode as VisibilityMode;
	if (!MODES.includes(mode)) throw new HttpError(400, "BAD_REQUEST", "Unknown visibility");

	const password = typeof body.password === "string" ? body.password : "";
	if (password.length > 200) throw new HttpError(400, "BAD_REQUEST", "Password is too long");
	const b = await bucket();
	const { manifest } = await readManifest(b, entry.id);
	if (mode === "password" && !password && !visibilityOf(manifest).passwordHash) {
		throw new HttpError(400, "BAD_REQUEST", "A password is required");
	}
	const hashed = mode === "password" && password ? await hashPassword(password) : null;

	const next = await updateManifest(b, entry.id, entry.slug, (m: Manifest) => {
		const prev = visibilityOf(m);
		return {
			...m,
			slug: entry.slug,
			visibility:
				mode === "password"
					? {
							mode,
							...(hashed ?? {
								passwordHash: prev.passwordHash,
								salt: prev.salt,
								iterations: prev.iterations,
							}),
						}
					: { mode },
		};
	});
	const v = visibilityOf(next);
	return { visibility: { mode: v.mode, hasPassword: Boolean(v.passwordHash) } };
}

export const ALL: APIRoute = ({ params, request, locals, url }) =>
	handle(async () => {
		const entryId = params.id ?? "";
		const action = params.action ?? "";
		const method = request.method;
		if (action === "" && method === "GET") return ok(await revisions(locals, entryId));
		if (action === "" && method === "POST") return ok(await upload(locals, request, url, entryId), 201);
		if (action === "restore" && method === "POST") return ok(await restore(locals, request, entryId), 201);
		if (action === "visibility" && method === "POST") return ok(await visibility(locals, request, entryId));
		throw new HttpError(404, "NOT_FOUND", "Unknown document action");
	});
