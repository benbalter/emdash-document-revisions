/// <reference types="emdash/locals" />
/**
 * Request plumbing shared by the injected API routes. Responses use EmDash's
 * `{ success, data | error }` envelope so the admin's parseApiResponse()
 * reads them like core responses.
 */

import { canEdit, getEntry, LockCheckUnavailable, lockedByOther, type Entry, type User } from "./access";
import { ConcurrentUpdateError } from "./store";

export class HttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

export const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });

const fail = (e: HttpError) =>
	Response.json({ success: false, error: { code: e.code, message: e.message } }, { status: e.status });

/** Run a handler, mapping expected failures to their HTTP status. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof HttpError) return fail(e);
		if (e instanceof ConcurrentUpdateError) return fail(new HttpError(409, "CONFLICT", e.message));
		if (e instanceof LockCheckUnavailable) {
			console.error("[document-revisions]", e);
			return fail(new HttpError(503, "LOCK_CHECK_UNAVAILABLE", e.message));
		}
		console.error("[document-revisions]", e);
		return fail(new HttpError(500, "INTERNAL_ERROR", "Document request failed"));
	}
}

export function requireUser(locals: App.Locals): User {
	if (!locals.user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
	return locals.user;
}

export async function requireEntry(locals: App.Locals, entryId: unknown): Promise<Entry> {
	if (typeof entryId !== "string" || !entryId) throw new HttpError(400, "BAD_REQUEST", "Missing document ID");
	const entry = await getEntry(locals, entryId);
	if (!entry) throw new HttpError(404, "NOT_FOUND", "Document not found");
	return entry;
}

/** Edit permission plus core's lock rule: refuse only if someone else holds it. */
export async function requireWritable(locals: App.Locals, user: User, entry: Entry): Promise<void> {
	if (!canEdit(user, entry)) {
		throw new HttpError(403, "FORBIDDEN", "You can only change your own documents");
	}
	const lock = await lockedByOther(locals, entry.id, user.id);
	if (lock) {
		throw new HttpError(409, "ENTRY_LOCKED", `${lock.userName ?? "Another editor"} is editing this document`);
	}
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object") throw new HttpError(400, "BAD_REQUEST", "Expected a JSON body");
	return body as Record<string, unknown>;
}
