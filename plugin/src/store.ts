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

export function emptyManifest(entryId: string, slug: string | null): Manifest {
	return { entryId, slug, revisions: [], visibility: { mode: "public" } };
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

/** Remove everything the plugin ever stored. Used on uninstall. */
export async function deleteAll(b: R2Bucket): Promise<number> {
	return (await deletePrefix(b, "entries/")) + (await deletePrefix(b, "slugs/"));
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
