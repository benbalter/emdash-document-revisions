/// <reference types="emdash/locals" />
/**
 * Server-side data for the front-end blocks (astro/*.astro): document
 * lists, a document's revision list, and the inline preview.
 *
 * Every block applies the same rules as the permalinks, for whoever is
 * viewing the page (anonymous visitors included), so a block can never
 * show a file, revision, or title the viewer couldn't open directly.
 */

import { getEmDashCollection } from "emdash";

import {
	canEdit,
	canReadPrivate,
	canSeeFiles,
	fileAccess,
	getEntry,
	getPublishedEntry,
	passwordCookieName,
	passwordCookieValid,
	type Access,
	type Entry,
	type User,
} from "./access";
import {
	bucket,
	COLLECTION,
	entryIdForSlug,
	extensionOf,
	permalink,
	readManifest,
	readSettings,
	visibilityOf,
	type Manifest,
	type RevisionRecord,
} from "./store";

type Locals = App.Locals;
type Cookies = { get(name: string): { value: string } | undefined };

export interface ListedDocument {
	id: string;
	slug: string;
	title: string;
	summary: string | null;
	url: string;
	/** "PDF", "DOCX", …; from the current file's name. */
	type: string;
	size: number;
	updatedAt: string;
	editUrl: string | null;
}

export interface ListOptions {
	limit?: number;
	workflowState?: string;
	orderBy?: "published" | "updated" | "title";
	order?: "asc" | "desc";
}

const ORDER_FIELD = { published: "published_at", updated: "updated_at", title: "title" } as const;

/**
 * Published documents with a file, filtered for the viewer: public ones for
 * everybody; private ones for Editors, Admins and their author;
 * password-protected ones only for people who can edit them (their titles
 * may be as sensitive as the file, so they're not listed for visitors).
 */
export async function listDocuments(locals: Locals, opts: ListOptions = {}): Promise<ListedDocument[]> {
	const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 100);
	const user = locals.user;
	const b = await bucket();
	const settings = await readSettings(b);
	const out: ListedDocument[] = [];
	// Page through: entries the viewer can't see (or without files) are
	// skipped, so one page may not fill the list. Bounded at five pages.
	let cursor: string | undefined;
	for (let page = 0; page < 5 && out.length < limit; page++) {
		const { entries, nextCursor } = await getEmDashCollection(COLLECTION, {
			...(opts.workflowState ? { where: { workflow_state: opts.workflowState } } : {}),
			orderBy: { [ORDER_FIELD[opts.orderBy ?? "published"]]: opts.order ?? (opts.orderBy === "title" ? "asc" : "desc") },
			limit: Math.min(limit * 3, 100),
			...(cursor ? { cursor } : {}),
		});
		for (const e of entries) {
			if (out.length >= limit) break;
			const doc = await listable(b, settings.defaultVisibility, user, e);
			if (doc) out.push(doc);
		}
		if (!nextCursor) break;
		cursor = nextCursor;
	}
	return out;
}

async function listable(
	b: R2Bucket,
	defaultVisibility: "public" | "private",
	user: User | undefined,
	e: { id: string; data?: unknown },
): Promise<ListedDocument | null> {
	const data = (e.data ?? {}) as Record<string, unknown>;
	const id = typeof data.id === "string" ? data.id : e.id;
	const slug = typeof data.slug === "string" ? data.slug : e.id;
	const { manifest } = await readManifest(b, id);
	const latest = manifest?.revisions.at(-1);
	if (!latest) return null;
	const mode = manifest ? visibilityOf(manifest).mode : defaultVisibility;
	const entry = { authorId: (data.authorId as string | null | undefined) ?? null };
	const visible = mode === "public" || (mode === "private" ? canReadPrivate(user, entry) : canEdit(user, entry));
	if (!visible) return null;
	return {
		id,
		slug,
		title: String(data.title ?? slug),
		summary: typeof data.summary === "string" && data.summary ? data.summary : null,
		url: permalink(slug, latest),
		type: typeLabel(latest),
		size: latest.size,
		updatedAt: latest.createdAt,
		editUrl: canEdit(user, entry) ? `/_emdash/admin/content/documents/${encodeURIComponent(id)}` : null,
	};
}

export function typeLabel(r: Pick<RevisionRecord, "filename" | "contentType">): string {
	return (extensionOf(r.filename).slice(1) || r.contentType.split("/").pop() || "file").toUpperCase();
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Resolved {
	entry: Entry;
	manifest: Manifest;
}

/** A document by slug, as this viewer may see it (drafts only for signed-in users). */
export async function resolveDocument(locals: Locals, slug: string): Promise<Resolved | null> {
	if (!slug) return null;
	const b = await bucket();
	const entryId = await entryIdForSlug(b, slug);
	if (!entryId) return null;
	const entry = locals.user ? await getEntry(locals, entryId) : await getPublishedEntry(slug, entryId);
	if (!entry || entry.slug !== slug) return null;
	const { manifest } = await readManifest(b, entryId);
	return manifest ? { entry, manifest } : null;
}

export interface RevisionListItem {
	n: number;
	url: string;
	filename: string;
	type: string;
	size: number;
	createdAt: string;
	authorName: string | null;
	note: string | null;
	current: boolean;
}

/** A document's revisions, newest first, or null if the viewer may not see them. */
export async function listRevisions(locals: Locals, slug: string, limit = 10): Promise<RevisionListItem[] | null> {
	const r = await resolveDocument(locals, slug);
	if (!r || !canSeeFiles(locals.user, r.entry, r.manifest)) return null;
	const latestN = r.manifest.revisions.at(-1)?.n;
	return [...r.manifest.revisions]
		.reverse()
		.slice(0, Math.min(Math.max(Math.trunc(limit), 1), 100))
		.map((rev) => ({
			n: rev.n,
			url: permalink(slug, rev, rev.n),
			filename: rev.filename,
			type: typeLabel(rev),
			size: rev.size,
			createdAt: rev.createdAt,
			authorName: rev.authorName,
			note: rev.note,
			current: rev.n === latestN,
		}));
}

export interface PreviewData {
	access: Access;
	title: string;
	url: string;
	kind: "pdf" | "image" | "other";
	type: string;
	size: number;
}

/** What the preview block may show this viewer. null = no such document (or no file). */
export async function previewDocument(locals: Locals, cookies: Cookies, slug: string): Promise<PreviewData | null> {
	const r = await resolveDocument(locals, slug);
	const latest = r?.manifest.revisions.at(-1);
	if (!r || !latest) return null;
	const access = fileAccess(locals.user, r.entry, r.manifest, {
		revision: false,
		passwordCookieValid: await passwordCookieValid(r.manifest, cookies.get(passwordCookieName(r.entry.id))?.value),
	});
	const kind = latest.contentType === "application/pdf" ? "pdf" : latest.contentType.startsWith("image/") ? "image" : "other";
	return {
		access,
		title: String(r.entry.data.title ?? slug),
		url: permalink(slug, latest),
		kind,
		type: typeLabel(latest),
		size: latest.size,
	};
}
