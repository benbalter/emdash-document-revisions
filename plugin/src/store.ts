/**
 * Private document store.
 *
 * Document bytes and the revision log live in their own R2 bucket, not the
 * EmDash media bucket: core serves every media-bucket key through the public,
 * unauthenticated `/_emdash/api/media/file/:key` route, so anything stored
 * there is downloadable by anyone who learns the key.
 *
 * The revision log is a JSON manifest in the same bucket rather than plugin
 * storage, because the site routes that serve and accept files have to read
 * it and only plugin handlers can reach `ctx.storage`.
 */

import type { TextInfo } from "./processing";

export const COLLECTION = "documents";
export const BINDING = "DOCUMENTS";

/** EmDash role levels (`@emdash-cms/auth` Role). */
export const Role = {
	SUBSCRIBER: 10,
	CONTRIBUTOR: 20,
	AUTHOR: 30,
	EDITOR: 40,
	ADMIN: 50,
} as const;

export interface RevisionRecord {
	n: number;
	key: string;
	filename: string;
	contentType: string;
	size: number;
	authorId: string;
	authorName: string | null;
	note: string | null;
	createdAt: string;
	/** Set when this revision re-instates an earlier one's file. */
	restoredFrom?: number | null;
	/** Extraction state for this revision's file (shared by revisions with the same key). */
	text?: TextInfo;
}

export type VisibilityMode = "public" | "private" | "password";

export interface Visibility {
	mode: VisibilityMode;
	/** PBKDF2 hash and salt, base64url. Only set in password mode. */
	passwordHash?: string;
	salt?: string;
	/** PBKDF2 iterations used for this hash; absent on hashes from before it was stored. */
	iterations?: number;
}

export interface Manifest {
	entryId: string;
	slug: string | null;
	revisions: RevisionRecord[];
	/** Absent on manifests written before visibility existed: public. */
	visibility?: Visibility;
	/** Where an imported document came from, so re-running an import can skip it. */
	source?: { system: "wordpress"; id: number; site: string };
}

/**
 * Resolve the R2 binding lazily: `cloudflare:workers` only exists in the
 * Workers runtime, and Astro imports this package in Node to read the
 * plugin descriptor.
 */
export async function bucket(): Promise<R2Bucket> {
	const { env } = await import("cloudflare:workers");
	const b = (env as Record<string, unknown>)[BINDING] as R2Bucket | undefined;
	if (!b) throw new Error(`R2 binding ${BINDING} is not configured`);
	return b;
}

const entryPrefix = (entryId: string) => `entries/${entryId}/`;
const manifestKey = (entryId: string) => `${entryPrefix(entryId)}manifest.json`;
const slugKey = (slug: string) => `slugs/${slug}`;

export function emptyManifest(
	entryId: string,
	slug: string | null,
	mode: VisibilityMode = "public",
): Manifest {
	return { entryId, slug, revisions: [], visibility: { mode } };
}

// --- Site settings ------------------------------------------------------
//
// Kept in the bucket (not plugin settings) because the site routes that
// read them can't reach the plugin context.

export interface DocumentSettings {
	/** Visibility for newly created documents. WP Document Revisions defaults to private. */
	defaultVisibility: Exclude<VisibilityMode, "password">;
}

export const DEFAULT_SETTINGS: DocumentSettings = { defaultVisibility: "private" };

export async function readSettings(b: R2Bucket): Promise<DocumentSettings> {
	const obj = await b.get("settings.json");
	if (!obj) return DEFAULT_SETTINGS;
	return { ...DEFAULT_SETTINGS, ...((await obj.json()) as Partial<DocumentSettings>) };
}

export async function writeSettings(b: R2Bucket, next: DocumentSettings): Promise<DocumentSettings> {
	await b.put("settings.json", JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
	return next;
}

// --- Revision feed keys -------------------------------------------------
//
// Feed readers can't send session cookies, so each user gets a secret key
// for their revision feeds (WP Document Revisions' per-user feed key). Only
// a SHA-256 of the key is stored.

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function feedKeyUser(b: R2Bucket, key: string): Promise<string | null> {
	if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) return null;
	const obj = await b.get(`feedkeys/${await sha256Hex(key)}`);
	return obj ? ((await obj.json()) as { userId: string }).userId : null;
}

export async function hasFeedKey(b: R2Bucket, userId: string): Promise<boolean> {
	return (await b.head(`feedusers/${userId}`)) !== null;
}

/** Issue a new key for a user, revoking any previous one. Returns the key once. */
export async function issueFeedKey(b: R2Bucket, userId: string): Promise<string> {
	await revokeFeedKey(b, userId);
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const hash = await sha256Hex(key);
	await b.put(`feedkeys/${hash}`, JSON.stringify({ userId }));
	await b.put(`feedusers/${userId}`, JSON.stringify({ hash, createdAt: new Date().toISOString() }));
	return key;
}

/**
 * Revoke every user's feed key. EmDash's plugin user lookup returns disabled
 * accounts too (and no disable hook exists), so offboarding should revoke
 * keys; this is the bulk version for Admins.
 */
export async function revokeAllFeedKeys(b: R2Bucket): Promise<number> {
	return (await deletePrefix(b, "feedkeys/")) + (await deletePrefix(b, "feedusers/"));
}

export async function revokeFeedKey(b: R2Bucket, userId: string): Promise<void> {
	const obj = await b.get(`feedusers/${userId}`);
	if (!obj) return;
	const { hash } = (await obj.json()) as { hash: string };
	await b.delete([`feedkeys/${hash}`, `feedusers/${userId}`]);
}

export function visibilityOf(m: Manifest | null): Visibility {
	return m?.visibility ?? { mode: "public" };
}

export async function readManifest(
	b: R2Bucket,
	entryId: string,
): Promise<{ manifest: Manifest | null; etag: string | null }> {
	const obj = await b.get(manifestKey(entryId));
	if (!obj) return { manifest: null, etag: null };
	return { manifest: (await obj.json()) as Manifest, etag: obj.etag };
}

export async function entryIdForSlug(b: R2Bucket, slug: string): Promise<string | null> {
	const obj = await b.get(slugKey(slug));
	return obj ? (await obj.text()).trim() : null;
}

export class ConcurrentUpdateError extends Error {}

/**
 * Read-modify-write the manifest with an R2 conditional put, so two uploads
 * racing on the same document can't drop a revision. A first write (no
 * existing manifest) is unconditional; that race is accepted for now.
 */
export async function updateManifest(
	b: R2Bucket,
	entryId: string,
	slug: string | null,
	mutate: (m: Manifest) => Manifest,
	attempts = 5,
): Promise<Manifest> {
	for (let i = 0; i < attempts; i++) {
		const { manifest, etag } = await readManifest(b, entryId);
		// A first manifest gets the site default, so a new document stays
		// private even if the afterSave hook that normally creates it didn't run.
		const base = manifest ?? emptyManifest(entryId, slug, (await readSettings(b)).defaultVisibility);
		const next = mutate(base);
		const put = await b.put(manifestKey(entryId), JSON.stringify(next), {
			httpMetadata: { contentType: "application/json" },
			...(etag ? { onlyIf: { etagMatches: etag } } : {}),
		});
		if (put) {
			await syncSlug(b, entryId, manifest?.slug ?? null, next.slug);
			return next;
		}
	}
	throw new ConcurrentUpdateError("Document is being updated concurrently; try again");
}

async function syncSlug(b: R2Bucket, entryId: string, prev: string | null, next: string | null) {
	if (prev && prev !== next) await dropSlugIfOwned(b, prev, entryId);
	if (next) await b.put(slugKey(next), entryId);
}

async function dropSlugIfOwned(b: R2Bucket, slug: string, entryId: string) {
	if ((await entryIdForSlug(b, slug)) === entryId) await b.delete(slugKey(slug));
}

/** Delete every key under a prefix. R2 list and delete cap at 1000 keys per call. */
async function deletePrefix(b: R2Bucket, prefix?: string): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const page = await b.list({ prefix, cursor, limit: 1000 });
		const keys = page.objects.map((o) => o.key);
		if (keys.length) await b.delete(keys);
		deleted += keys.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return deleted;
}

/** Remove a document's files, manifest, and slug index entry. */
export async function deleteEntry(b: R2Bucket, entryId: string): Promise<number> {
	const { manifest } = await readManifest(b, entryId);
	if (manifest?.slug) await dropSlugIfOwned(b, manifest.slug, entryId);
	return deletePrefix(b, entryPrefix(entryId));
}

/** Entry IDs that have anything stored, from R2's delimited listing. */
export async function listStoredEntryIds(b: R2Bucket): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await b.list({ prefix: "entries/", delimiter: "/", cursor, limit: 1000 });
		for (const p of page.delimitedPrefixes) ids.push(p.slice("entries/".length, -1));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return ids;
}

/** Object count and bytes under a prefix. */
export async function usage(b: R2Bucket, prefix: string): Promise<{ objects: number; bytes: number }> {
	let objects = 0;
	let bytes = 0;
	let cursor: string | undefined;
	do {
		const page = await b.list({ prefix, cursor, limit: 1000 });
		for (const o of page.objects) {
			objects++;
			bytes += o.size;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return { objects, bytes };
}

/** Remove everything the plugin ever stored. Used on uninstall. */
export async function deleteAll(b: R2Bucket): Promise<number> {
	return (
		(await deletePrefix(b, "entries/")) +
		(await deletePrefix(b, "slugs/")) +
		(await deletePrefix(b, "feedkeys/")) +
		(await deletePrefix(b, "feedusers/"))
	);
}

export function revisionObjectKey(entryId: string): string {
	return `${entryPrefix(entryId)}files/${crypto.randomUUID()}`;
}

/** ".pdf" for "Report.PDF"; "" when the filename has no usable extension. */
export function extensionOf(filename: string): string {
	const m = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
	return m ? `.${m[1]!.toLowerCase()}` : "";
}

/** Canonical permalink for the latest file, or for revision `n`. */
export function permalink(slug: string, revision: RevisionRecord, n: number | null = null): string {
	const suffix = n === null ? "" : `-revision-${n}`;
	return `/documents/${encodeURIComponent(slug)}${suffix}${extensionOf(revision.filename)}`;
}

/**
 * A client-supplied MIME type, reduced to `type/subtype` and lowercased, or
 * application/octet-stream if it isn't one. It's stored and later sent back
 * as the permalink's Content-Type, where anything else (control characters,
 * parameters) would make the response throw or carry stray header text.
 */
export function normalizeContentType(raw: unknown): string {
	const type = typeof raw === "string" ? raw.split(";")[0]!.trim().toLowerCase() : "";
	return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(type)
		? type
		: "application/octet-stream";
}

/** Types safe to render inline; everything else downloads, as core media does. */
const INLINE_TYPES = new Set([
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"text/plain",
]);

export function contentDisposition(filename: string, contentType: string): string {
	const kind = INLINE_TYPES.has(contentType) ? "inline" : "attachment";
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
