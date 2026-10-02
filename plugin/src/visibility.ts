/**
 * Helpers for site templates that list documents.
 *
 * Document visibility lives in the private manifest (so a password hash can
 * never leak through EmDash's content APIs), which means EmDash's own
 * queries don't know about it: `getEmDashCollection("documents")` returns
 * private and password-protected documents along with public ones. Filter
 * listings through these before rendering titles to anonymous visitors.
 *
 *   ---
 *   import { getEmDashCollection } from "emdash";
 *   import { filterPublicDocuments } from "emdash-document-revisions/visibility";
 *   const { entries } = await getEmDashCollection("documents");
 *   const visible = await filterPublicDocuments(entries);
 *   ---
 */

import { bucket, readManifest, readSettings, visibilityOf, type VisibilityMode } from "./store";

interface EntryLike {
	id: string;
	data?: unknown;
}

/** The database ID: live-collection entries carry it in `data.id`. */
function entryId(entry: EntryLike): string {
	const data = entry.data as { id?: unknown } | undefined;
	return typeof data?.id === "string" ? data.id : entry.id;
}

export async function documentVisibility(id: string): Promise<VisibilityMode> {
	const b = await bucket();
	const { manifest } = await readManifest(b, id);
	// No manifest yet: treat it as the site default (private unless changed).
	if (!manifest) return (await readSettings(b)).defaultVisibility;
	return visibilityOf(manifest).mode;
}

/** Keep only documents whose files anyone may open. */
export async function filterPublicDocuments<T extends EntryLike>(entries: T[]): Promise<T[]> {
	const modes = await Promise.all(entries.map((e) => documentVisibility(entryId(e))));
	return entries.filter((_, i) => modes[i] === "public");
}
