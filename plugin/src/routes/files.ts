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
import type { Entry, User } from "../access";
import { enqueue, textKey } from "../processing";
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
	Role,
} from "../store";

export const prerender = false;

/**
 * Cloudflare rejects request bodies over the plan's limit before the Worker
 * runs (about 100 MB on Free and Pro). Enforce the same ceiling here so the
 * error is ours and consistent across plans and local dev.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const publicRevision = ({ key: _key, ...r }: RevisionRecord) => r;

/** Hand a new file to the processing queue (no-op without DOC_JOBS). */
async function queueText(entryId: string, r: RevisionRecord) {
	await enqueue({ entryId, n: r.n, key: r.key, contentType: r.contentType, filename: r.filename }).catch((e) => {
		// Processing is best-effort; never fail the upload over it.
		console.error("[document-revisions] enqueue failed", e);
	});
}

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
	// Trashed documents keep their log readable (for editors and importers);
	// every write still refuses them.
	const entry = await requireEntry(locals, entryId, { includeTrashed: true });
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
		source: manifest?.source ?? null,
		canEdit: canEdit(user, entry),
		// Per file: larger uploads go through multipart, up to this cap.
		maxUploadBytes: await maxFileBytes(),
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

	return appendUploaded(user, entry, { key, size, contentType, filename, note });
}

/** Append a new revision for a file already in R2, and queue it for processing. */
async function appendUploaded(
	user: User,
	entry: Entry,
	file: { key: string; size: number; contentType: string; filename: string; note: string | null },
) {
	const next = await updateManifest(await bucket(), entry.id, entry.slug, (m) => ({
		...m,
		slug: entry.slug,
		revisions: [
			...m.revisions,
			{
				n: (m.revisions.at(-1)?.n ?? 0) + 1,
				...file,
				authorId: user.id,
				authorName: user.name ?? user.email,
				createdAt: new Date().toISOString(),
			},
		],
	}));
	const added = next.revisions.at(-1)!;
	await queueText(entry.id, added);
	return { revision: publicRevision(added) };
}

// --- Multipart uploads ----------------------------------------------------

/**
 * Largest file accepted through multipart uploads. Each part is its own
 * request (under Cloudflare's per-request body limit); R2 assembles them.
 * Override with DOCUMENT_MAX_FILE_BYTES.
 */
export async function maxFileBytes(): Promise<number> {
	const { env } = await import("cloudflare:workers");
	const raw = Number((env as Record<string, unknown>).DOCUMENT_MAX_FILE_BYTES);
	return Number.isFinite(raw) && raw > 0 ? raw : 5 * 1024 * 1024 * 1024;
}

/** Suggested part size for clients; R2 requires >= 5 MiB for all but the last part. */
export const PART_BYTES = 50 * 1024 * 1024;

/** A multipart key must belong to this document's files, so a part can't land elsewhere. */
function requireOwnKey(entry: Entry, key: unknown): string {
	if (typeof key !== "string" || !key.startsWith(`entries/${entry.id}/files/`) || key.includes("..")) {
		throw new HttpError(400, "BAD_REQUEST", "Invalid upload key");
	}
	return key;
}

async function multipartCreate(locals: App.Locals, request: Request, entryId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	await requireWritable(locals, user, entry);
	const body = await readJson(request);
	const size = Number(body.size);
	if (Number.isFinite(size) && size > (await maxFileBytes())) {
		throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Files are limited to ${Math.round((await maxFileBytes()) / 1024 ** 3)} GB`);
	}
	const contentType =
		typeof body.contentType === "string" && body.contentType ? body.contentType.split(";")[0]!.trim() : "application/octet-stream";
	const key = revisionObjectKey(entry.id);
	const mpu = await (await bucket()).createMultipartUpload(key, { httpMetadata: { contentType } });
	return { uploadId: mpu.uploadId, key, partBytes: PART_BYTES, maxFileBytes: await maxFileBytes() };
}

async function multipartPart(locals: App.Locals, request: Request, url: URL, entryId: string, uploadId: string, part: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	if (!canEdit(user, entry)) throw new HttpError(403, "FORBIDDEN", "You can only change your own documents");
	const key = requireOwnKey(entry, url.searchParams.get("key"));
	const partNumber = Number(part);
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
		throw new HttpError(400, "BAD_REQUEST", "Invalid part number");
	}
	const size = Number(request.headers.get("content-length"));
	if (!Number.isSafeInteger(size) || size <= 0 || !request.body) {
		throw new HttpError(411, "LENGTH_REQUIRED", "A part body with Content-Length is required");
	}
	if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Part too large");
	const mpu = (await bucket()).resumeMultipartUpload(key, uploadId);
	try {
		const uploaded = await mpu.uploadPart(partNumber, request.body.pipeThrough(new FixedLengthStream(size)));
		return { partNumber: uploaded.partNumber, etag: uploaded.etag };
	} catch (e) {
		throw new HttpError(400, "UPLOAD_FAILED", e instanceof Error ? e.message : "Part upload failed");
	}
}

async function multipartComplete(locals: App.Locals, request: Request, entryId: string, uploadId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	await requireWritable(locals, user, entry);
	const body = await readJson(request);
	const key = requireOwnKey(entry, body.key);
	const parts = Array.isArray(body.parts) ? (body.parts as R2UploadedPart[]) : [];
	if (!parts.length) throw new HttpError(400, "BAD_REQUEST", "No parts");
	const filename = (typeof body.filename === "string" ? body.filename : "").slice(0, 255);
	if (!filename) throw new HttpError(400, "BAD_REQUEST", "Missing filename");
	const importMeta = body.import && typeof body.import === "object" ? (body.import as Record<string, unknown>) : null;
	if (importMeta && user.role < Role.ADMIN) {
		throw new HttpError(403, "FORBIDDEN", "Importing is limited to administrators");
	}

	const b = await bucket();
	let object: R2Object;
	try {
		object = await b.resumeMultipartUpload(key, uploadId).complete(parts);
	} catch (e) {
		throw new HttpError(400, "UPLOAD_FAILED", e instanceof Error ? e.message : "Completing the upload failed");
	}
	if (object.size > (await maxFileBytes())) {
		await b.delete(key);
		throw new HttpError(413, "PAYLOAD_TOO_LARGE", "File exceeds the size limit");
	}
	const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
	if (importMeta) {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(importMeta)) if (v !== undefined && v !== null) q.set(k, String(v));
		q.set("filename", filename);
		return appendImported(locals, entry, q, { key, size: object.size, contentType });
	}
	const note = typeof body.note === "string" ? body.note.slice(0, 500) || null : null;
	return appendUploaded(user, entry, { key, size: object.size, contentType, filename, note });
}

async function multipartAbort(locals: App.Locals, url: URL, entryId: string, uploadId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId);
	if (!canEdit(user, entry)) throw new HttpError(403, "FORBIDDEN", "You can only change your own documents");
	const key = requireOwnKey(entry, url.searchParams.get("key"));
	await (await bucket()).resumeMultipartUpload(key, uploadId).abort().catch(() => undefined);
	return { aborted: true };
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

/**
 * Import one revision with its original number, author, date, and note.
 * Administrators only: unlike an upload, it lets the caller assert who made
 * the revision and when.
 *
 * Query: n, filename, note, createdAt, authorName, authorEmail, and either
 * a raw file body or `reuse=<n>` to share an already-imported revision's
 * file (WordPress revisions that only changed the title or note). The
 * first call can also record `sourceId` / `sourceSite` on the manifest.
 */
async function importRevision(locals: App.Locals, request: Request, url: URL, entryId: string) {
	const user = requireUser(locals);
	if (user.role < Role.ADMIN) throw new HttpError(403, "FORBIDDEN", "Importing is limited to administrators");
	const entry = await requireEntry(locals, entryId);
	await requireWritable(locals, user, entry);

	const q = url.searchParams;
	const n = Number(q.get("n"));
	if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "BAD_REQUEST", "Missing revision number");
	const filename = (q.get("filename") ?? "").slice(0, 255);
	if (!filename) throw new HttpError(400, "BAD_REQUEST", "Missing filename");
	const reuse = q.get("reuse") ? Number(q.get("reuse")) : null;

	const b = await bucket();
	let key: string;
	let size: number;
	let contentType: string;
	let reusedText: RevisionRecord["text"];
	if (reuse !== null) {
		const { manifest } = await readManifest(b, entry.id);
		const source = manifest?.revisions.find((r) => r.n === reuse);
		if (!source) throw new HttpError(404, "NOT_FOUND", `Revision ${reuse} to reuse not found`);
		({ key, size, contentType } = source);
		reusedText = source.text;
	} else {
		size = Number(request.headers.get("content-length"));
		if (!Number.isSafeInteger(size) || size <= 0 || !request.body) {
			throw new HttpError(411, "LENGTH_REQUIRED", "A file body with Content-Length is required");
		}
		if (size > MAX_UPLOAD_BYTES) {
			throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
		}
		contentType = request.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
		key = revisionObjectKey(entry.id);
		await b.put(key, request.body.pipeThrough(new FixedLengthStream(size)), { httpMetadata: { contentType } });
	}

	return appendImported(locals, entry, q, { key, size, contentType, text: reusedText });
}

/**
 * Append an imported revision (original number, author, date, note) for a
 * file already in R2. Shared by single-request and multipart imports.
 */
async function appendImported(
	locals: App.Locals,
	entry: Entry,
	q: URLSearchParams,
	file: { key: string; size: number; contentType: string; text?: RevisionRecord["text"] },
) {
	const n = Number(q.get("n"));
	if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "BAD_REQUEST", "Missing revision number");
	const filename = (q.get("filename") ?? "").slice(0, 255);
	if (!filename) throw new HttpError(400, "BAD_REQUEST", "Missing filename");
	const createdAt = q.get("createdAt") && !Number.isNaN(Date.parse(q.get("createdAt")!))
		? new Date(q.get("createdAt")!).toISOString()
		: new Date().toISOString();
	const authorEmail = q.get("authorEmail");
	const mapped = authorEmail ? await userByEmail(locals, authorEmail) : null;
	const { key, size, contentType } = file;
	const reusedText = file.text;
	const b = await bucket();
	const sourceId = Number(q.get("sourceId"));
	const next = await updateManifest(b, entry.id, entry.slug, (m) => {
		// Keep the log in order; a re-run of the same revision is a conflict, not a duplicate.
		if (m.revisions.some((r) => r.n >= n)) {
			throw new HttpError(409, "CONFLICT", `Revision ${n} is not newer than the existing revisions`);
		}
		return {
			...m,
			slug: entry.slug,
			...(Number.isInteger(sourceId) && sourceId > 0
				? { source: { system: "wordpress" as const, id: sourceId, site: q.get("sourceSite") ?? "" } }
				: {}),
			revisions: [
				...m.revisions,
				{
					n,
					key,
					filename,
					contentType,
					size,
					authorId: mapped?.id ?? `wordpress:${authorEmail ?? "unknown"}`,
					authorName: q.get("authorName") || mapped?.name || null,
					note: q.get("note")?.slice(0, 500) || null,
					createdAt,
					...(reusedText ? { text: reusedText } : {}),
				},
			],
		};
	});
	const added = next.revisions.at(-1)!;
	if (!added.text) await queueText(entry.id, added);
	return { revision: publicRevision(added) };
}


/** Record where a document came from when it has no files to import. Admins only. */
async function recordSource(locals: App.Locals, request: Request, entryId: string) {
	const user = requireUser(locals);
	if (user.role < Role.ADMIN) throw new HttpError(403, "FORBIDDEN", "Importing is limited to administrators");
	const entry = await requireEntry(locals, entryId);
	const body = await readJson(request);
	const id = Number(body.id);
	if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "BAD_REQUEST", "Missing source id");
	const site = typeof body.site === "string" ? body.site.slice(0, 500) : "";
	const next = await updateManifest(await bucket(), entry.id, entry.slug, (m) => ({
		...m,
		slug: entry.slug,
		source: { system: "wordpress", id, site },
	}));
	return { source: next.source };
}

async function userByEmail(locals: App.Locals, email: string): Promise<Pick<User, "id" | "name"> | null> {
	const db = locals.emdash?.db;
	if (!db) return null;
	const row = await db
		.selectFrom("users")
		.select(["id", "name"])
		.where("email", "=", email.toLowerCase())
		.executeTakeFirst();
	return row ? { id: String(row.id), name: (row.name as string | null) ?? null } : null;
}

/** A revision's extracted text (Markdown), once processing has finished. */
async function revisionText(locals: App.Locals, url: URL, entryId: string) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, entryId, { includeTrashed: true });
	const b = await bucket();
	const { manifest } = await readManifest(b, entry.id);
	if (!canReadDrafts(user) || (visibilityOf(manifest).mode === "private" && !canReadPrivate(user, entry))) {
		throw new HttpError(403, "FORBIDDEN", "Insufficient permissions");
	}
	const n = Number(url.searchParams.get("n"));
	const revision = manifest?.revisions.find((r) => r.n === n) ?? (url.searchParams.has("n") ? null : manifest?.revisions.at(-1));
	if (!revision) throw new HttpError(404, "NOT_FOUND", "Revision not found");
	if (revision.text?.status !== "done") {
		throw new HttpError(404, "NO_TEXT", `No extracted text (status: ${revision.text?.status ?? "pending"})`);
	}
	const obj = await b.get(textKey(entry.id, revision.key));
	if (!obj) throw new HttpError(404, "NO_TEXT", "Extracted text is missing");
	return { n: revision.n, text: await obj.text(), ...revision.text };
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
		if (action === "text" && method === "GET") return ok(await revisionText(locals, url, entryId));
		if (action === "" && method === "POST") return ok(await upload(locals, request, url, entryId), 201);
		if (action === "restore" && method === "POST") return ok(await restore(locals, request, entryId), 201);
		if (action === "visibility" && method === "POST") return ok(await visibility(locals, request, entryId));
		if (action === "source" && method === "POST") return ok(await recordSource(locals, request, entryId));
		const [head, uploadId, sub, part] = action.split("/");
		if (head === "uploads") {
			if (!uploadId && method === "POST") return ok(await multipartCreate(locals, request, entryId), 201);
			if (uploadId && sub === "parts" && part && method === "PUT") {
				return ok(await multipartPart(locals, request, url, entryId, uploadId, part));
			}
			if (uploadId && sub === "complete" && method === "POST") {
				return ok(await multipartComplete(locals, request, entryId, uploadId), 201);
			}
			if (uploadId && !sub && method === "DELETE") return ok(await multipartAbort(locals, url, entryId, uploadId));
		}
		if (action === "import" && method === "POST") {
			return ok(await importRevision(locals, request, url, entryId), 201);
		}
		throw new HttpError(404, "NOT_FOUND", "Unknown document action");
	});
