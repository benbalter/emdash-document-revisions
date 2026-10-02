import { beforeEach, describe, expect, it } from "vitest";

import { ALL } from "../../plugin/src/routes/api";
import { readManifest, updateManifest } from "../../plugin/src/store";
import { bucket, clearBucket, user } from "./helpers";

/**
 * POST purge-orphans with EmDash's including-trashed lookup answering `lookup`
 * for each stored document.
 */
async function purge(lookup: Record<string, { success: boolean; error?: { code: string } }>) {
	const locals = {
		user: user("admin", 50),
		emdash: { handleContentGetIncludingTrashed: async (_c: string, id: string) => lookup[id] },
	};
	const url = new URL("http://site.test/_emdash/api/document-revisions/purge-orphans");
	const context = { params: { action: "purge-orphans" }, request: new Request(url, { method: "POST" }), locals, url };
	return (ALL as unknown as (c: unknown) => Promise<Response>)(context);
}

const stored = async (id: string) => (await readManifest(bucket(), id)).manifest !== null;

describe("purge-orphans", () => {
	beforeEach(async () => {
		await clearBucket();
		for (const id of ["live", "gone"]) await updateManifest(bucket(), id, id, (m) => m);
	});

	it("deletes documents EmDash says don't exist, and keeps the rest", async () => {
		const res = await purge({ live: { success: true }, gone: { success: false, error: { code: "NOT_FOUND" } } });
		expect(res.status).toBe(200);
		expect(await stored("gone")).toBe(false);
		expect(await stored("live")).toBe(true);
	});

	it("deletes nothing when a lookup fails for any other reason", async () => {
		const res = await purge({
			live: { success: false, error: { code: "INTERNAL_ERROR" } },
			gone: { success: false, error: { code: "NOT_FOUND" } },
		});
		expect(res.status).toBe(503);
		expect(await stored("live")).toBe(true);
		expect(await stored("gone")).toBe(true);
	});
});
