/// <reference types="emdash/locals" />
/**
 * Document API: /_emdash/api/document-revisions/{revisions,upload,restore,visibility,me}
 *
 * Lives under /_emdash/api (injected by documentRevisionsRoutes()) rather
 * than as plugin routes, so that:
 * - EmDash's middleware still authenticates every request and enforces the
 *   X-EmDash-Request CSRF header on writes, exactly as for core routes;
 * - uploads stream into R2 instead of being buffered under the 8 MiB plugin
 *   route cap; and
 * - writes can honor core's entry edit lock, which plugin contexts can't read.
 */

import type { APIRoute } from "astro";

import {
	canEdit,
	canReadDrafts,
	canReadPrivate,
	getEntry,
	hashPassword,
	liveLock,
	lockedByOther,
	type Entry,
	type User,
} from "../access";
import {
	bucket,
	COLLECTION,
	ConcurrentUpdateError,
	permalink,
	readManifest,
	revisionObjectKey,
	Role,
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
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

class HttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
const fail = (e: HttpError) =>
	Response.json({ success: false, error: { code: e.code, message: e.message } }, { status: e.status });

function requireUser(locals: App.Locals): User {
	if (!locals.user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
	return locals.user;
}

async function requireEntry(locals: App.Locals, entryId: unknown): Promise<Entry> {
	if (typeof entryId !== "string" || !entryId) throw new HttpError(400, "BAD_REQUEST", "Missing entryId");
	const entry = await getEntry(locals, entryId);
	if (!entry) throw new HttpError(404, "NOT_FOUND", "Document not found");
	return entry;
}

/** Edit permission plus core's lock rule: refuse only if someone else holds it. */
async function requireWritable(locals: App.Locals, user: User, entry: Entry): Promise<void> {
	if (!canEdit(user, entry)) {
		throw new HttpError(403, "FORBIDDEN", "You can only change your own documents");
	}
	const lock = await lockedByOther(locals, entry.id, user.id);
	if (lock) {
		throw new HttpError(409, "ENTRY_LOCKED", `${lock.userName ?? "Another editor"} is editing this document`);
	}
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object") throw new HttpError(400, "BAD_REQUEST", "Expected a JSON body");
	return body as Record<string, unknown>;
}

const publicRevision = ({ key: _key, ...r }: RevisionRecord) => r;

/** Revision log, visibility, lock state, and core content edits, newest first. */
async function revisions(locals: App.Locals, url: URL) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, url.searchParams.get("entryId"));
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

	return {
		entryId: entry.id,
		slug,
		status: entry.status,
		visibility: { mode: visibility.mode, hasPassword: Boolean(visibility.passwordHash) },
		lock: await liveLock(locals, entry.id),
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
			createdAt: i.createdAt,
			authorName: i.authorId ? (authorNames.get(i.authorId) ?? null) : null,
		})),
	};
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

/**
 * Stream one file into R2 as a new revision. The raw file is the body;
 * metadata rides in the query string.
 */
async function upload(locals: App.Locals, request: Request, url: URL) {
	const user = requireUser(locals);
	const entry = await requireEntry(locals, url.searchParams.get("entryId"));
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
async function restore(locals: App.Locals, request: Request) {
	const user = requireUser(locals);
	const body = await readJson(request);
	const entry = await requireEntry(locals, body.entryId);
	await requireWritable(locals, user, entry);
	const n = Number(body.n);
	if (!Number.isInteger(n)) throw new HttpError(400, "BAD_REQUEST", "Missing revision number");

	const b = await bucket();
	const next = await updateManifest(b, entry.id, entry.slug, (m) => {
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

async function visibility(locals: App.Locals, request: Request) {
	const user = requireUser(locals);
	const body = await readJson(request);
	const entry = await requireEntry(locals, body.entryId);
	await requireWritable(locals, user, entry);
	const mode = body.mode as VisibilityMode;
	if (!MODES.includes(mode)) throw new HttpError(400, "BAD_REQUEST", "Unknown visibility");

	const password = typeof body.password === "string" ? body.password : "";
	if (password.length > 200) throw new HttpError(400, "BAD_REQUEST", "Password is too long");
	const b = await bucket();
	const { manifest } = await readManifest(b, entry.id);
	const current = visibilityOf(manifest);
	if (mode === "password" && !password && !current.passwordHash) {
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
					? { mode, ...(hashed ?? { passwordHash: prev.passwordHash, salt: prev.salt }) }
					: { mode },
		};
	});
	const v = visibilityOf(next);
	return { visibility: { mode: v.mode, hasPassword: Boolean(v.passwordHash) } };
}

/** Lets the admin UI decide whether to offer document creation at all. */
function me(locals: App.Locals) {
	const user = requireUser(locals);
	return { id: user.id, role: user.role, canCreate: user.role >= Role.AUTHOR };
}

export const ALL: APIRoute = async ({ params, request, locals, url }) => {
	const action = params.action ?? "";
	const method = request.method;
	try {
		if (action === "revisions" && method === "GET") return ok(await revisions(locals, url));
		if (action === "me" && method === "GET") return ok(me(locals));
		if (action === "upload" && method === "POST") return ok(await upload(locals, request, url), 201);
		if (action === "restore" && method === "POST") return ok(await restore(locals, request), 201);
		if (action === "visibility" && method === "POST") return ok(await visibility(locals, request));
		throw new HttpError(404, "NOT_FOUND", "Unknown document action");
	} catch (e) {
		if (e instanceof HttpError) return fail(e);
		if (e instanceof ConcurrentUpdateError) return fail(new HttpError(409, "CONFLICT", e.message));
		console.error("[document-revisions]", e);
		return fail(new HttpError(500, "INTERNAL_ERROR", "Document request failed"));
	}
};
