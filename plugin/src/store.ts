/**
 * Private document store.
 *
 * Document bytes and the revision log live in their own R2 bucket, not the
 * EmDash media bucket: core serves every media-bucket key through the public,
 * unauthenticated `/_emdash/api/media/file/:key` route, so anything stored
 * there is downloadable by anyone who learns the key.
 *
 * The revision log is a JSON manifest in the same bucket rather than plugin
 * storage, because the permalink route (an Astro endpoint, not a plugin route)
 * has to read it and only plugin handlers can reach `ctx.storage`.
 */

import { PluginRouteError } from "emdash";

export const COLLECTION = "documents";
export const BINDING = "DOCUMENTS";

/** Lock lifetime. Matches WordPress's post-lock window closely enough for a spike. */
export const LOCK_TTL_MS = 15 * 60 * 1000;

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
}

export interface DocumentLock {
	userId: string;
	userName: string | null;
	expiresAt: string;
}

export interface Manifest {
	entryId: string;
	slug: string | null;
	revisions: RevisionRecord[];
	lock: DocumentLock | null;
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

const manifestKey = (entryId: string) => `entries/${entryId}/manifest.json`;
const slugKey = (slug: string) => `slugs/${slug}`;

export function emptyManifest(entryId: string, slug: string | null): Manifest {
	return { entryId, slug, revisions: [], lock: null };
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

/**
 * Read-modify-write the manifest with an R2 conditional put, so two uploads
 * racing on the same document can't drop a revision. A first write (no
 * existing manifest) is unconditional; that race is accepted for the spike.
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
		const next = mutate(manifest ?? emptyManifest(entryId, slug));
		const put = await b.put(manifestKey(entryId), JSON.stringify(next), {
			httpMetadata: { contentType: "application/json" },
			...(etag ? { onlyIf: { etagMatches: etag } } : {}),
		});
		if (put) {
			await syncSlug(b, entryId, manifest?.slug ?? null, next.slug);
			return next;
		}
	}
	throw new PluginRouteError("CONFLICT", "Document is being updated concurrently; try again", 409);
}

async function syncSlug(b: R2Bucket, entryId: string, prev: string | null, next: string | null) {
	if (prev && prev !== next) await b.delete(slugKey(prev));
	if (next) await b.put(slugKey(next), entryId);
}

export function activeLock(m: Manifest | null, now = Date.now()): DocumentLock | null {
	if (!m?.lock) return null;
	return Date.parse(m.lock.expiresAt) > now ? m.lock : null;
}

export function revisionObjectKey(entryId: string): string {
	return `entries/${entryId}/files/${crypto.randomUUID()}`;
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
