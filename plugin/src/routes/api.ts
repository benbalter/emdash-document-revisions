/// <reference types="emdash/locals" />
/**
 * Site-wide document API:
 *
 *   GET  /_emdash/api/document-revisions/me             caller's capabilities (admin UI)
 *   GET  /_emdash/api/document-revisions/storage        usage and orphaned documents (Admin)
 *   POST /_emdash/api/document-revisions/purge-orphans  delete files of deleted documents (Admin)
 *   POST /_emdash/api/document-revisions/purge-all      delete every document file (Admin)
 *
 * The storage actions stand in for `plugin:uninstall`, which EmDash only
 * runs for marketplace and registry plugins, never for native plugins
 * registered in astro.config. No core scope rule covers this path, so API
 * tokens need the `admin` scope here (core's middleware fails closed).
 */

import type { APIRoute } from "astro";

import { handle, HttpError, ok, readJson, requireUser } from "../http";
import { bucket, COLLECTION, deleteAll, deleteEntry, listStoredEntryIds, Role, usage } from "../store";
import { MAX_UPLOAD_BYTES } from "./files";

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
		if (!res.success) orphans.push(id);
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

/** Lets the admin UI decide what to offer. */
function me(locals: App.Locals) {
	const user = requireUser(locals);
	return {
		id: user.id,
		role: user.role,
		canCreate: user.role >= Role.AUTHOR,
		isAdmin: user.role >= Role.ADMIN,
		maxUploadBytes: MAX_UPLOAD_BYTES,
	};
}

export const ALL: APIRoute = ({ params, request, locals }) =>
	handle(async () => {
		const action = params.action ?? "";
		const method = request.method;
		if (action === "me" && method === "GET") return ok(me(locals));
		if (action === "storage" && method === "GET") return ok(await storage(locals));
		if (action === "purge-orphans" && method === "POST") return ok(await purgeOrphans(locals));
		if (action === "purge-all" && method === "POST") return ok(await purgeAll(locals, request));
		throw new HttpError(404, "NOT_FOUND", "Unknown document action");
	});
