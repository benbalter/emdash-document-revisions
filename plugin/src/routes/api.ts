/// <reference types="emdash/locals" />
/**
 * Site-wide document API:
 *
 *   GET  /_emdash/api/document-revisions/me             caller's capabilities (admin UI)
 *   GET  /_emdash/api/document-revisions/storage        usage and orphaned documents (Admin)
 *   POST /_emdash/api/document-revisions/purge-orphans  delete files of deleted documents (Admin)
 *   POST /_emdash/api/document-revisions/purge-all      delete every document file (Admin)
 *   GET|POST /_emdash/api/document-revisions/settings   site-wide document settings (Admin)
 *   GET  /_emdash/api/document-revisions/columns?ids=…   content-list cells for visible rows
 *   GET|POST|DELETE /_emdash/api/document-revisions/feed-key   the caller's revision-feed key
 *   POST /_emdash/api/document-revisions/revoke-feed-keys      revoke every user's key (Admin)
 *
 * The storage actions stand in for `plugin:uninstall`, which EmDash only
 * runs for marketplace and registry plugins, never for native plugins
 * registered in astro.config. No core scope rule covers this path, so API
 * tokens need the `admin` scope here (core's middleware fails closed).
 */

import type { APIRoute } from "astro";

import { canReadDrafts, canSeeFiles, getEntry, liveLock } from "../access";
import { handle, HttpError, ok, readJson, requireUser } from "../http";
import {
	bucket,
	COLLECTION,
	deleteAll,
	deleteEntry,
	extensionOf,
	hasFeedKey,
	issueFeedKey,
	listStoredEntryIds,
	readManifest,
	readSettings,
	revokeAllFeedKeys,
	revokeFeedKey,
	Role,
	usage,
	visibilityOf,
	writeSettings,
	type DocumentSettings,
} from "../store";
import { maxFileBytes } from "./files";

export const prerender = false;

/** Typed into the confirmation box; long enough that it can't be an accident. */
export const PURGE_ALL_CONFIRMATION = "delete all document files";

function requireAdmin(locals: App.Locals) {
	const user = requireUser(locals);
	if (user.role < Role.ADMIN) throw new HttpError(403, "FORBIDDEN", "Administrators only");
	return user;
}

/** Documents with stored files whose entry no longer exists, trash included. */
async function orphanIds(locals: App.Locals, ids: string[]): Promise<string[]> {
	const get = locals.emdash?.handleContentGetIncludingTrashed;
	if (typeof get !== "function") throw new HttpError(500, "NOT_CONFIGURED", "EmDash is not initialized");
	const orphans: string[] = [];
	for (const id of ids) {
		const res = await get(COLLECTION, id);
		if (res.success) continue;
		// Only a definite "no such entry" makes an orphan. Anything else (a
		// database error, a timeout) must abort the purge, which deletes files
		// permanently, rather than count a live document as gone.
		if (res.error?.code !== "NOT_FOUND") {
			throw new HttpError(503, "CHECK_FAILED", `Couldn't check whether document ${id} still exists; try again`);
		}
		orphans.push(id);
	}
	return orphans;
}

async function storage(locals: App.Locals) {
	requireAdmin(locals);
	const b = await bucket();
	const ids = await listStoredEntryIds(b);
	const orphans = await orphanIds(locals, ids);
	return {
		documents: ids.length,
		orphans: orphans.length,
		...(await usage(b, "entries/")),
		purgeAllConfirmation: PURGE_ALL_CONFIRMATION,
	};
}

async function purgeOrphans(locals: App.Locals) {
	requireAdmin(locals);
	const b = await bucket();
	const orphans = await orphanIds(locals, await listStoredEntryIds(b));
	let objects = 0;
	for (const id of orphans) objects += await deleteEntry(b, id);
	return { documents: orphans.length, objects };
}

async function purgeAll(locals: App.Locals, request: Request) {
	requireAdmin(locals);
	const body = await readJson(request);
	if (body.confirm !== PURGE_ALL_CONFIRMATION) {
		throw new HttpError(400, "CONFIRMATION_REQUIRED", `Type "${PURGE_ALL_CONFIRMATION}" to confirm`);
	}
	return { objects: await deleteAll(await bucket()) };
}

async function settings(locals: App.Locals, request: Request) {
	requireAdmin(locals);
	const b = await bucket();
	if (request.method === "GET") return readSettings(b);
	const body = await readJson(request);
	const current = await readSettings(b);
	const next: DocumentSettings = { ...current };
	if (body.defaultVisibility !== undefined) {
		if (body.defaultVisibility !== "public" && body.defaultVisibility !== "private") {
			throw new HttpError(400, "BAD_REQUEST", "defaultVisibility must be public or private");
		}
		next.defaultVisibility = body.defaultVisibility;
	}
	return writeSettings(b, next);
}

/**
 * Cells for the admin content list, batched for the visible rows: current
 * file type and size, visibility, and who is editing. Private documents the
 * caller can't read only show their visibility.
 */
async function columns(locals: App.Locals, url: URL) {
	const user = requireUser(locals);
	if (!canReadDrafts(user)) throw new HttpError(403, "FORBIDDEN", "Insufficient permissions");
	const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 100);
	const b = await bucket();
	const out: Record<string, unknown> = {};
	await Promise.all(
		ids.map(async (id) => {
			const entry = await getEntry(locals, id);
			if (!entry) return;
			const { manifest } = await readManifest(b, id);
			const visibility = visibilityOf(manifest).mode;
			if (!canSeeFiles(user, entry, manifest)) {
				out[id] = { visibility };
				return;
			}
			const latest = manifest?.revisions.at(-1);
			const lock = await liveLock(locals, id).catch(() => null);
			out[id] = {
				visibility,
				revisions: manifest?.revisions.length ?? 0,
				type: latest ? extensionOf(latest.filename).slice(1) || latest.contentType : null,
				size: latest?.size ?? null,
				editingBy: lock && lock.userId !== user.id ? (lock.userName ?? "Another editor") : null,
			};
		}),
	);
	return out;
}

/** The caller's revision-feed key: GET says whether one exists, POST issues (once), DELETE revokes. */
async function feedKey(locals: App.Locals, request: Request) {
	const user = requireUser(locals);
	if (!canReadDrafts(user)) throw new HttpError(403, "FORBIDDEN", "Revision feeds need the Contributor role or higher");
	const b = await bucket();
	if (request.method === "POST") return { key: await issueFeedKey(b, user.id) };
	if (request.method === "DELETE") {
		await revokeFeedKey(b, user.id);
		return { hasKey: false };
	}
	return { hasKey: await hasFeedKey(b, user.id) };
}

/** Lets the admin UI decide what to offer. */
async function me(locals: App.Locals) {
	const user = requireUser(locals);
	return {
		id: user.id,
		role: user.role,
		canCreate: user.role >= Role.AUTHOR,
		isAdmin: user.role >= Role.ADMIN,
		maxUploadBytes: await maxFileBytes(),
	};
}

export const ALL: APIRoute = ({ params, request, locals, url }) =>
	handle(async () => {
		const action = params.action ?? "";
		const method = request.method;
		if (action === "me" && method === "GET") return ok(await me(locals));
		if (action === "storage" && method === "GET") return ok(await storage(locals));
		if (action === "purge-orphans" && method === "POST") return ok(await purgeOrphans(locals));
		if (action === "purge-all" && method === "POST") return ok(await purgeAll(locals, request));
		if (action === "settings" && (method === "GET" || method === "POST")) return ok(await settings(locals, request));
		if (action === "columns" && method === "GET") return ok(await columns(locals, url));
		if (action === "feed-key" && ["GET", "POST", "DELETE"].includes(method)) return ok(await feedKey(locals, request));
		if (action === "revoke-feed-keys" && method === "POST") {
			requireAdmin(locals);
			return ok({ objects: await revokeAllFeedKeys(await bucket()) });
		}
		throw new HttpError(404, "NOT_FOUND", "Unknown document action");
	});
