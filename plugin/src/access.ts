/// <reference types="emdash/locals" />
/**
 * Server-side access rules shared by the permalink and API routes.
 *
 * Mirrors core's rules where core has one (`content:edit_own` /
 * `content:edit_any`, `content:read_drafts`, entry edit locks) and WP
 * Document Revisions' where it doesn't (private and password-protected
 * documents).
 */

import { COLLECTION, Role, type Manifest, visibilityOf } from "./store";

type Locals = App.Locals;
export type User = NonNullable<Locals["user"]>;

export interface Entry {
	id: string;
	slug: string | null;
	status: string;
	authorId: string | null;
	data: Record<string, unknown>;
}

/**
 * Look an entry up by ID, drafts included. Trashed entries come back null.
 *
 * Only signed-in requests get EmDash's content handlers; on the anonymous
 * fast path `locals.emdash` carries no database or handlers at all. Callers
 * that serve anonymous visitors use getPublishedEntry() instead.
 */
export async function getEntry(locals: Locals, entryId: string): Promise<Entry | null> {
	if (typeof locals.emdash?.handleContentGet !== "function") return null;
	const res = await locals.emdash.handleContentGet(COLLECTION, entryId);
	if (!res?.success || !res.data?.item) return null;
	const item = res.data.item as Record<string, unknown>;
	return {
		id: String(item.id),
		slug: (item.slug as string | null) ?? null,
		status: String(item.status),
		authorId: (item.authorId as string | null) ?? null,
		data: (item.data as Record<string, unknown>) ?? {},
	};
}

/**
 * The published entry at `slug`, through EmDash's public query API (which
 * works without a session). Returns null unless it is published and still
 * the entry the slug index points at.
 */
export async function getPublishedEntry(slug: string, entryId: string): Promise<Entry | null> {
	const { getEmDashEntry } = await import("emdash");
	const { entry } = await getEmDashEntry(COLLECTION, slug);
	if (!entry) return null;
	const data = (entry.data ?? {}) as Record<string, unknown>;
	const id = typeof data.id === "string" ? data.id : entry.id;
	if (id !== entryId || data.status !== "published") return null;
	return {
		id,
		slug,
		status: "published",
		authorId: (data.authorId as string | null | undefined) ?? null,
		data,
	};
}

/** Core's content:edit_own (Author, own entries) / content:edit_any (Editor). */
export function canEdit(user: User | undefined, entry: Pick<Entry, "authorId">): boolean {
	if (!user) return false;
	if (user.role >= Role.EDITOR) return true;
	return user.role >= Role.AUTHOR && entry.authorId === user.id;
}

/** Core's content:read_drafts: drafts, scheduled entries, and past revisions. */
export function canReadDrafts(user: User | undefined): boolean {
	return (user?.role ?? 0) >= Role.CONTRIBUTOR;
}

/**
 * WP Document Revisions grants read_private_documents to Editors and
 * Administrators; WordPress also lets authors read their own private posts.
 */
export function canReadPrivate(user: User | undefined, entry: Pick<Entry, "authorId">): boolean {
	if (!user) return false;
	return user.role >= Role.EDITOR || entry.authorId === user.id;
}

export type Access = "allow" | "password" | "deny";

/**
 * Whether `user` may download a file of this document.
 *
 * Past revisions are never more open than the current file: they need
 * content:read_drafts on top of whatever the current file needs.
 */
export function fileAccess(
	user: User | undefined,
	entry: Entry,
	manifest: Manifest,
	opts: { revision: boolean; passwordCookieValid: boolean },
): Access {
	const visibility = visibilityOf(manifest).mode;
	let current: Access;
	if (entry.status !== "published") {
		current = canReadDrafts(user) ? "allow" : "deny";
		// A draft keeps its visibility setting; a private draft stays private.
		if (current === "allow" && visibility === "private" && !canReadPrivate(user, entry)) {
			current = "deny";
		}
	} else if (visibility === "private") {
		current = canReadPrivate(user, entry) ? "allow" : "deny";
	} else if (visibility === "password") {
		current = canEdit(user, entry) || opts.passwordCookieValid ? "allow" : "password";
	} else {
		current = "allow";
	}
	if (!opts.revision || current !== "allow") return current;
	return canReadDrafts(user) ? "allow" : "deny";
}

export interface LockHolder {
	userId: string;
	userName: string | null;
	expiresAt: string;
}

/**
 * The live core edit lock on this entry, if any and if the collection has
 * locking on. Core exposes no handler for this outside its own routes, so
 * read its table the way EntryLockRepository.findEnforceable does.
 */
export async function liveLock(locals: Locals, entryId: string): Promise<LockHolder | null> {
	const db = locals.emdash?.db;
	if (!db) return null;
	const rows = await db
		.selectFrom("_emdash_entry_locks")
		.innerJoin("_emdash_collections", "_emdash_collections.slug", "_emdash_entry_locks.collection")
		.leftJoin("users", "users.id", "_emdash_entry_locks.user_id")
		.select([
			"_emdash_entry_locks.user_id as userId",
			"_emdash_entry_locks.expires_at as expiresAt",
			"users.name as userName",
		])
		.where("_emdash_entry_locks.collection", "=", COLLECTION)
		.where("_emdash_entry_locks.entry_id", "=", entryId)
		.where("_emdash_collections.edit_locking", "!=", 0)
		.execute();
	const now = Date.now();
	const live = rows.find((r) => Date.parse(String(r.expiresAt)) > now);
	return live
		? {
				userId: String(live.userId),
				userName: (live.userName as string | null) ?? null,
				expiresAt: String(live.expiresAt),
			}
		: null;
}

/**
 * Core refuses a write only when someone else holds a live lease; with no
 * lease, or the caller's own, the write goes through. Uploads follow the
 * same rule, which is how WP Document Revisions uses the post lock.
 */
export async function lockedByOther(
	locals: Locals,
	entryId: string,
	userId: string,
): Promise<LockHolder | null> {
	const lock = await liveLock(locals, entryId);
	return lock && lock.userId !== userId ? lock : null;
}

// --- Password protection -------------------------------------------------

/**
 * Sized for Cloudflare's Free plan, where a request gets about 10 ms of CPU
 * and WebCrypto work counts toward it. These are shared access codes for a
 * document, not account passwords (WordPress stores post passwords in
 * plaintext), so this trades hash strength for headroom. The count is
 * stored with each hash, so it can be raised without breaking old ones.
 */
const PBKDF2_ITERATIONS = 20_000;
/** What hashes written before the count was stored used. */
const LEGACY_PBKDF2_ITERATIONS = 60_000;
const COOKIE_MAX_AGE = 10 * 24 * 60 * 60; // WordPress's post-password cookie lifetime.

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const byte of arr) s += String.fromCharCode(byte);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(new ArrayBuffer(bin.length));
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function pbkdf2(password: string, salt: BufferSource, iterations: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256,
	);
	return b64url(bits);
}

export async function hashPassword(
	password: string,
): Promise<{ passwordHash: string; salt: string; iterations: number }> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return {
		passwordHash: await pbkdf2(password, salt, PBKDF2_ITERATIONS),
		salt: b64url(salt),
		iterations: PBKDF2_ITERATIONS,
	};
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function verifyPassword(manifest: Manifest, password: string): Promise<boolean> {
	const v = visibilityOf(manifest);
	if (v.mode !== "password" || !v.passwordHash || !v.salt) return false;
	const iterations = v.iterations ?? LEGACY_PBKDF2_ITERATIONS;
	return timingSafeEqual(await pbkdf2(password, fromB64url(v.salt), iterations), v.passwordHash);
}

async function cookieSecret(): Promise<string> {
	const { env } = await import("cloudflare:workers");
	const secret = (env as Record<string, unknown>).EMDASH_ENCRYPTION_KEY;
	if (typeof secret !== "string" || !secret) {
		throw new Error("EMDASH_ENCRYPTION_KEY is required for password-protected documents");
	}
	return secret;
}

export const passwordCookieName = (entryId: string) => `edr_pw_${entryId}`;

/**
 * The cookie is an HMAC over the entry and its current password hash, so
 * changing the password invalidates every cookie issued for the old one.
 */
async function passwordCookieValue(manifest: Manifest): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(await cookieSecret()),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const msg = `${manifest.entryId}:${visibilityOf(manifest).passwordHash ?? ""}`;
	return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export async function passwordCookieValid(manifest: Manifest, cookie: string | undefined): Promise<boolean> {
	if (!cookie || visibilityOf(manifest).mode !== "password") return false;
	return timingSafeEqual(cookie, await passwordCookieValue(manifest));
}

export async function passwordCookieHeader(manifest: Manifest, secure: boolean): Promise<string> {
	const value = await passwordCookieValue(manifest);
	return [
		`${passwordCookieName(manifest.entryId)}=${value}`,
		"Path=/documents",
		`Max-Age=${COOKIE_MAX_AGE}`,
		"HttpOnly",
		"SameSite=Lax",
		...(secure ? ["Secure"] : []),
	].join("; ");
}
