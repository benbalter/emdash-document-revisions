import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anon, as, CONTENT, db, lockAs, makeDocument, ONE, TWO_PDF, uniq, unlock } from "../support/client";

describe("Restore", () => {
	const admin = as("admin");
	const SLUG = uniq("verify-restore");
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(SLUG, {
			files: [
				{ body: ONE, type: "text/plain", name: "one.txt" },
				{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" },
			],
		});
	});

	it("restore revision 1", async () => {
		expect((await admin.restore(id, 1)).status).toBe(201);
	});

	it("restored file is current", async () => {
		expect(await (await anon().get(`/documents/${SLUG}`)).text()).toBe(ONE);
	});

	it("restore records its source", async () => {
		const { revisions } = await admin.files(id);
		expect(revisions[0]).toMatchObject({ n: 3, restoredFrom: 1, filename: "one.txt" });
	});

	it("restore unknown revision", async () => {
		expect((await admin.restore(id, 99)).status).toBe(404);
	});
});

describe("Core edit lock", () => {
	const admin = as("admin");
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(uniq("verify-lock"));
	});

	afterAll(() => {
		db().run("update _emdash_collections set edit_locking = 1 where slug = 'documents'");
		unlock(id);
	});

	describe("while another user holds the lock", () => {
		beforeAll(() => lockAs(id));
		afterAll(() => unlock(id));

		it("upload while another user holds the lock", async () => {
			const res = await admin.upload(id, ONE, "text/plain", "one.txt");
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ENTRY_LOCKED");
		});

		it("restore while locked", async () => {
			expect((await admin.restore(id, 1)).status).toBe(409);
		});

		it("visibility while locked", async () => {
			expect((await admin.setVisibility(id, "private")).status).toBe(409);
		});

		it("revision log reports the holder", async () => {
			expect((await admin.files(id)).lock?.userId).toBe("t-other");
		});
	});

	it("upload while holding the lock yourself", async () => {
		expect((await admin.post(`${CONTENT}/${id}/lock`)).ok).toBe(true);
		try {
			expect((await admin.upload(id, ONE, "text/plain", "one.txt")).status).toBe(201);
		} finally {
			await admin.fetch(`${CONTENT}/${id}/lock`, { method: "DELETE" });
		}
	});

	it("stale lock ignored when locking is off", async () => {
		db().run("update _emdash_collections set edit_locking = 0 where slug = 'documents'");
		lockAs(id);
		try {
			expect((await admin.upload(id, ONE, "text/plain", "one.txt")).status).toBe(201);
		} finally {
			db().run("update _emdash_collections set edit_locking = 1 where slug = 'documents'");
			unlock(id);
		}
	});
});

describe("Ownership", () => {
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(uniq("verify-other"), { owner: "other" });
	});

	it("author uploading to another's document", async () => {
		expect((await as("author").upload(id, ONE, "text/plain", "one.txt")).status).toBe(403);
	});

	it("author restoring on another's document", async () => {
		expect((await as("author").restore(id, 1)).status).toBe(403);
	});

	it("author changing visibility on another's document", async () => {
		expect((await as("author").setVisibility(id, "private")).status).toBe(403);
	});

	it("editor uploading to another's document", async () => {
		expect((await as("editor").upload(id, ONE, "text/plain", "one.txt")).status).toBe(201);
	});

	it("author uploading to their own document", async () => {
		const own = await makeDocument(uniq("verify-own"), { owner: "author" });
		expect((await as("author").upload(own, ONE, "text/plain", "one.txt")).status).toBe(201);
	});
});

describe("Lock check fails closed", () => {
	const admin = as("admin");
	let id: string;
	let renamed = false;

	beforeAll(async () => {
		id = await makeDocument(uniq("verify-failclosed"));
	});

	afterAll(() => {
		if (renamed) db().exec("alter table _emdash_entry_locks_test rename to _emdash_entry_locks");
	});

	it("upload when the lock table is unreadable", async () => {
		db().exec("alter table _emdash_entry_locks rename to _emdash_entry_locks_test");
		renamed = true;
		const res = await admin.upload(id, ONE, "text/plain", "one.txt");
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("LOCK_CHECK_UNAVAILABLE");
	});

	it("log still readable", async () => {
		expect((await admin.get(`${CONTENT}/${id}/files`)).status).toBe(200);
	});

	it("upload once the table is back", async () => {
		db().exec("alter table _emdash_entry_locks_test rename to _emdash_entry_locks");
		renamed = false;
		expect((await admin.upload(id, ONE, "text/plain", "one.txt")).status).toBe(201);
	});
});
