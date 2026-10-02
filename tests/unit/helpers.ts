import { env as workerEnv } from "cloudflare:workers";

import type { Entry, User } from "../../plugin/src/access";
import type { Manifest, RevisionRecord, VisibilityMode } from "../../plugin/src/store";

/** Bindings the unit project configures in vitest.config.ts. */
export const env = workerEnv as unknown as {
	DOCUMENTS: R2Bucket;
	EMDASH_ENCRYPTION_KEY: string;
	DOCUMENT_PASSWORD_ITERATIONS?: string;
};

export const bucket = () => env.DOCUMENTS;

/** Empty the DOCUMENTS bucket, so tests that list or purge see only their own keys. */
export async function clearBucket(): Promise<void> {
	const b = bucket();
	let cursor: string | undefined;
	do {
		const page = await b.list({ cursor, limit: 1000 });
		if (page.objects.length) await b.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export const user = (id: string, role: number) => ({ id, role }) as unknown as User;

export const entry = (over: Partial<Entry> = {}): Entry => ({
	id: "e1",
	slug: "doc",
	status: "published",
	authorId: "owner",
	data: {},
	...over,
});

export const revision = (n: number, over: Partial<RevisionRecord> = {}): RevisionRecord => ({
	n,
	key: `entries/e1/files/file-${n}`,
	filename: `file-${n}.txt`,
	contentType: "text/plain",
	size: 4,
	authorId: "owner",
	authorName: "Owner",
	note: null,
	createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
	...over,
});

export const manifest = (mode: VisibilityMode = "public", over: Partial<Manifest> = {}): Manifest => ({
	entryId: "e1",
	slug: "doc",
	revisions: [revision(1)],
	visibility: { mode },
	...over,
});
