import { beforeEach, describe, expect, it } from "vitest";

import {
	ConcurrentUpdateError,
	contentDisposition,
	DEFAULT_SETTINGS,
	deleteAll,
	deleteEntry,
	emptyManifest,
	entryIdForSlug,
	extensionOf,
	feedKeyUser,
	hasFeedKey,
	issueFeedKey,
	listStoredEntryIds,
	permalink,
	readManifest,
	readSettings,
	revisionObjectKey,
	revokeAllFeedKeys,
	revokeFeedKey,
	sha256Hex,
	updateManifest,
	usage,
	visibilityOf,
	writeSettings,
	type Manifest,
} from "../../plugin/src/store";
import { bucket, clearBucket, revision } from "./helpers";

beforeEach(clearBucket);

const keys = async (prefix?: string) => (await bucket().list({ prefix })).objects.map((o) => o.key).sort();
const addRevision = (n: number) => (m: Manifest) => ({ ...m, revisions: [...m.revisions, revision(n)] });

describe("settings", () => {
	it("default to private, as in WP Document Revisions", async () => {
		expect(DEFAULT_SETTINGS).toEqual({ defaultVisibility: "private" });
		expect(await readSettings(bucket())).toEqual({ defaultVisibility: "private" });
	});

	it("round-trip", async () => {
		await writeSettings(bucket(), { defaultVisibility: "public" });
		expect(await readSettings(bucket())).toEqual({ defaultVisibility: "public" });
	});
});

describe("manifests", () => {
	it("an empty manifest is public unless told otherwise", () => {
		expect(emptyManifest("e", "s")).toEqual({ entryId: "e", slug: "s", revisions: [], visibility: { mode: "public" } });
		expect(emptyManifest("e", null, "private").visibility).toEqual({ mode: "private" });
	});

	it("visibilityOf treats missing manifests and legacy ones as public", () => {
		expect(visibilityOf(null)).toEqual({ mode: "public" });
		expect(visibilityOf({ entryId: "e", slug: null, revisions: [] })).toEqual({ mode: "public" });
	});

	it("a first manifest gets the site's default visibility (private)", async () => {
		const m = await updateManifest(bucket(), "e1", "doc", addRevision(1));
		expect(m.visibility).toEqual({ mode: "private" });
		expect((await readManifest(bucket(), "e1")).manifest).toEqual(m);
	});

	it("a first manifest gets the site's default visibility (public)", async () => {
		await writeSettings(bucket(), { defaultVisibility: "public" });
		const m = await updateManifest(bucket(), "e1", "doc", addRevision(1));
		expect(m.visibility).toEqual({ mode: "public" });
	});

	it("later updates keep the existing visibility", async () => {
		await updateManifest(bucket(), "e1", "doc", addRevision(1));
		await writeSettings(bucket(), { defaultVisibility: "public" });
		const m = await updateManifest(bucket(), "e1", "doc", addRevision(2));
		expect(m.visibility).toEqual({ mode: "private" });
		expect(m.revisions.map((r) => r.n)).toEqual([1, 2]);
	});

	it("readManifest returns null with no etag when absent", async () => {
		expect(await readManifest(bucket(), "nope")).toEqual({ manifest: null, etag: null });
	});
});


/**
 * A bucket where another writer appends a revision to the manifest just
 * before each of our conditional puts, `races` times, so the put's etag
 * check fails the way it would under real contention.
 */
function racingBucket(races: number): R2Bucket {
	const b = bucket();
	let left = races;
	let other = 100;
	return new Proxy(b, {
		get(target, prop) {
			if (prop !== "put") return Reflect.get(target, prop).bind(target);
			return async (key: string, value: string, options?: R2PutOptions) => {
				if (key.endsWith("/manifest.json") && options?.onlyIf && left > 0) {
					left--;
					const current = (await (await target.get(key))!.json()) as Manifest;
					await target.put(key, JSON.stringify({ ...current, revisions: [...current.revisions, revision(other++)] }));
				}
				return target.put(key, value, options);
			};
		},
	});
}

describe("updateManifest compare-and-swap", () => {
	beforeEach(async () => {
		await updateManifest(bucket(), "e1", "doc", addRevision(1));
	});

	it("re-reads and retries after losing a race, so no revision is dropped", async () => {
		let calls = 0;
		const m = await updateManifest(racingBucket(2), "e1", "doc", (base) => {
			calls++;
			return addRevision(3)(base);
		});
		expect(calls).toBe(3);
		expect(m.revisions.map((r) => r.n)).toEqual([1, 100, 101, 3]);
		expect((await readManifest(bucket(), "e1")).manifest!.revisions.map((r) => r.n)).toEqual([1, 100, 101, 3]);
	});

	it("gives up with ConcurrentUpdateError after its attempts", async () => {
		let calls = 0;
		const update = updateManifest(
			racingBucket(Infinity),
			"e1",
			"doc",
			(base) => {
				calls++;
				return addRevision(3)(base);
			},
			3,
		);
		await expect(update).rejects.toBeInstanceOf(ConcurrentUpdateError);
		expect(calls).toBe(3);
		expect((await readManifest(bucket(), "e1")).manifest!.revisions.map((r) => r.n)).not.toContain(3);
	});
});

describe("slug index", () => {
	it("points the slug at the entry", async () => {
		await updateManifest(bucket(), "e1", "doc", addRevision(1));
		expect(await entryIdForSlug(bucket(), "doc")).toBe("e1");
	});

	it("moves with a slug change", async () => {
		await updateManifest(bucket(), "e1", "old", addRevision(1));
		await updateManifest(bucket(), "e1", "old", (m) => ({ ...m, slug: "new" }));
		expect(await entryIdForSlug(bucket(), "new")).toBe("e1");
		expect(await entryIdForSlug(bucket(), "old")).toBeNull();
	});

	it("leaves a slug alone once another entry owns it", async () => {
		await updateManifest(bucket(), "e1", "shared", addRevision(1));
		await updateManifest(bucket(), "e2", "shared", addRevision(1));
		await updateManifest(bucket(), "e1", "shared", (m) => ({ ...m, slug: "renamed" }));
		expect(await entryIdForSlug(bucket(), "shared")).toBe("e2");
	});
});

describe("deleting", () => {
	beforeEach(async () => {
		const b = bucket();
		await updateManifest(b, "e1", "one", addRevision(1));
		await b.put("entries/e1/files/a", "aaaa");
		await b.put("entries/e1/text/a.md", "text");
		await updateManifest(b, "e2", "two", addRevision(1));
		await b.put("entries/e2/files/b", "bb");
		await writeSettings(b, { defaultVisibility: "public" });
	});

	it("deleteEntry removes a document's files, text, manifest and slug", async () => {
		expect(await deleteEntry(bucket(), "e1")).toBe(3);
		expect(await keys("entries/e1/")).toEqual([]);
		expect(await entryIdForSlug(bucket(), "one")).toBeNull();
		expect(await keys("entries/e2/")).toEqual(["entries/e2/files/b", "entries/e2/manifest.json"]);
	});

	it("deleteEntry keeps a slug another entry has taken over", async () => {
		await bucket().put("slugs/one", "e2");
		await deleteEntry(bucket(), "e1");
		expect(await entryIdForSlug(bucket(), "one")).toBe("e2");
	});

	it("listStoredEntryIds lists each document once", async () => {
		expect((await listStoredEntryIds(bucket())).sort()).toEqual(["e1", "e2"]);
	});

	it("usage counts objects and bytes under a prefix", async () => {
		const u = await usage(bucket(), "entries/e1/files/");
		expect(u).toEqual({ objects: 1, bytes: 4 });
		expect((await usage(bucket(), "entries/")).objects).toBe(5);
	});

	it("deleteAll removes everything the plugin stored except settings", async () => {
		await issueFeedKey(bucket(), "u1");
		const n = await deleteAll(bucket());
		expect(n).toBe(9); // 5 entry objects, 2 slugs, 2 feed-key objects
		expect(await keys()).toEqual(["settings.json"]);
	});

	it("handles more than one page of keys", async () => {
		const b = bucket();
		await Promise.all(Array.from({ length: 1005 }, (_, i) => b.put(`entries/e3/files/${i}`, "x")));
		expect(await deleteEntry(b, "e3")).toBe(1005);
		expect(await keys("entries/e3/")).toEqual([]);
	});
});

describe("feed keys", () => {
	it("issue a key that maps back to its user, stored only as a hash", async () => {
		const key = await issueFeedKey(bucket(), "u1");
		expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(await feedKeyUser(bucket(), key)).toBe("u1");
		expect(await hasFeedKey(bucket(), "u1")).toBe(true);
		expect(await keys("feedkeys/")).toEqual([`feedkeys/${await sha256Hex(key)}`]);
		expect(JSON.stringify(await keys())).not.toContain(key);
	});

	it("a new key revokes the old one", async () => {
		const old = await issueFeedKey(bucket(), "u1");
		const fresh = await issueFeedKey(bucket(), "u1");
		expect(await feedKeyUser(bucket(), old)).toBeNull();
		expect(await feedKeyUser(bucket(), fresh)).toBe("u1");
	});

	it("revoke one user's key", async () => {
		const key = await issueFeedKey(bucket(), "u1");
		const other = await issueFeedKey(bucket(), "u2");
		await revokeFeedKey(bucket(), "u1");
		await revokeFeedKey(bucket(), "nobody");
		expect(await feedKeyUser(bucket(), key)).toBeNull();
		expect(await hasFeedKey(bucket(), "u1")).toBe(false);
		expect(await feedKeyUser(bucket(), other)).toBe("u2");
	});

	it("revoke everyone's keys", async () => {
		const a = await issueFeedKey(bucket(), "u1");
		const b = await issueFeedKey(bucket(), "u2");
		expect(await revokeAllFeedKeys(bucket())).toBe(4);
		expect(await feedKeyUser(bucket(), a)).toBeNull();
		expect(await feedKeyUser(bucket(), b)).toBeNull();
	});

	it.each(["", "short", "has spaces in it, twenty+ chars", "x".repeat(101)])(
		"malformed key %j is refused without a lookup",
		async (key) => {
			expect(await feedKeyUser(bucket(), key)).toBeNull();
		},
	);
});

describe("names and URLs", () => {
	it.each([
		["Report.PDF", ".pdf"],
		["archive.tar.gz", ".gz"],
		["README", ""],
		["weird.", ""],
		["file.toolongextension", ""],
		["notes.md", ".md"],
	])("extensionOf(%j) = %j", (name, ext) => {
		expect(extensionOf(name)).toBe(ext);
	});

	it("permalinks for the latest file and a revision", () => {
		const r = revision(3, { filename: "Report.PDF" });
		expect(permalink("tps-report", r)).toBe("/documents/tps-report.pdf");
		expect(permalink("tps-report", r, 3)).toBe("/documents/tps-report-revision-3.pdf");
		expect(permalink("a b/c", revision(1, { filename: "x" }))).toBe("/documents/a%20b%2Fc");
	});

	it("inline only for safe types; filenames sanitized and UTF-8 encoded", () => {
		expect(contentDisposition("a.pdf", "application/pdf")).toBe(`inline; filename="a.pdf"; filename*=UTF-8''a.pdf`);
		expect(contentDisposition("page.html", "text/html")).toMatch(/^attachment; /);
		expect(contentDisposition('Ré"sumé.txt', "text/plain")).toBe(
			`inline; filename="R__sum_.txt"; filename*=UTF-8''R%C3%A9%22sum%C3%A9.txt`,
		);
	});

	it("revision object keys are random and under the entry", () => {
		const a = revisionObjectKey("e1");
		expect(a).toMatch(/^entries\/e1\/files\/[0-9a-f-]{36}$/);
		expect(revisionObjectKey("e1")).not.toBe(a);
	});

	it("sha256Hex", async () => {
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});
