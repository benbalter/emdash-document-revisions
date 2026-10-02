import { beforeAll, describe, expect, it } from "vitest";

import {
	anon,
	API,
	as,
	CONTENT,
	db,
	makeDocument,
	ONE,
	r2count,
	settledR2Count,
	textSettled,
	TWO_PDF,
	uniq,
} from "../support/client";

describe("Trash, restore, permanent delete", () => {
	const admin = as("admin");
	const SLUG = uniq("verify-trash");
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(SLUG, {
			files: [
				{ body: ONE, type: "text/plain", name: "one.txt" },
				{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" },
			],
		});
		await textSettled(id);
		await admin.trash(id);
	});

	it("trashed, admin", async () => {
		expect((await admin.get(`/documents/${SLUG}`)).status).toBe(404);
	});

	it("trashed files kept", () => {
		// Both files and the manifest. (Not a count of entries/<id>/ as a
		// whole: extracted text lands there too, whenever the queue gets to it.)
		expect(r2count(`entries/${id}/files/`)).toBe(2);
		expect(r2count(`entries/${id}/manifest.json`)).toBe(1);
	});

	it("trashed log stays readable", async () => {
		expect((await admin.files(id)).revisions).toHaveLength(2);
	});

	it("restored from trash, admin", async () => {
		await admin.post(`${CONTENT}/${id}/restore`);
		expect((await admin.get(`/documents/${SLUG}`)).status).toBe(200);
	});

	it("restored from trash is a draft again, anonymous", async () => {
		// Core restores trashed entries as drafts.
		expect((await anon().get(`/documents/${SLUG}`)).status).toBe(404);
	});

	it("permanent delete removes files and manifest", async () => {
		await admin.deletePermanently(id);
		expect(await settledR2Count(`entries/${id}/`, 0)).toBe(0);
	});

	it("permanent delete removes slug index", async () => {
		expect(await settledR2Count(`slugs/${SLUG}`, 0)).toBe(0);
	});

	it("recycled slug with no files", async () => {
		const fresh = await admin.createDocument(SLUG, `Recycled ${SLUG}`);
		await admin.publish(fresh);
		expect((await anon().get(`/documents/${SLUG}`)).status).toBe(404);
	});
});

describe("Storage admin (stands in for plugin:uninstall)", () => {
	const admin = as("admin");
	let live: string;
	let orphan: string;

	beforeAll(async () => {
		live = await makeDocument(uniq("verify-live"));
		orphan = await makeDocument(uniq("verify-orphan"), { publish: false });
		await textSettled(orphan);
		// Simulate a document deleted while the plugin was off: the row
		// vanishes and no hook runs.
		db().run("delete from ec_documents where id = ?", orphan);
	});

	it("storage admin, editor", async () => {
		expect((await as("editor").get(`${API}/storage`)).status).toBe(403);
	});

	it("orphan detected", async () => {
		const s = await admin.json<{ documents: number; orphans: number; objects: number; bytes: number }>(
			`${API}/storage`,
		);
		expect(s.orphans).toBeGreaterThanOrEqual(1);
		expect(s.documents).toBeGreaterThanOrEqual(2);
		expect(s.bytes).toBeGreaterThan(0);
	});

	it("purge orphans", async () => {
		const res = await admin.post(`${API}/purge-orphans`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { data: { documents: number } }).data.documents).toBeGreaterThanOrEqual(1);
	});

	it("orphan's files are gone", () => {
		expect(r2count(`entries/${orphan}/`)).toBe(0);
	});

	it("live documents untouched by orphan purge", () => {
		expect(r2count(`entries/${live}/`)).toBeGreaterThan(0);
	});

	it("purge-all without confirmation", async () => {
		const res = await admin.post(`${API}/purge-all`, { confirm: "yes" });
		expect(res.status).toBe(400);
		expect(r2count(`entries/${live}/`)).toBeGreaterThan(0);
	});

	it("purge-all is Admin-only", async () => {
		expect((await as("editor").post(`${API}/purge-all`, { confirm: "delete all document files" })).status).toBe(403);
	});
});

describe("Plumbing", () => {
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(uniq("verify-plumbing"));
	});

	it("write without CSRF header", async () => {
		const res = await as("admin").post(`${CONTENT}/${id}/files/restore`, { n: 1 }, { csrf: false });
		expect(res.status).toBe(403);
	});

	it("anonymous API", async () => {
		expect((await anon().get(`${API}/me`)).status).toBe(401);
	});

	it("old plugin upload route is gone", async () => {
		const res = await as("admin").fetch("/_emdash/api/plugins/document-revisions/upload", { method: "POST" });
		expect(res.status).toBe(404);
	});

	it("contributor can't create documents", async () => {
		expect((await as("contributor").json<{ canCreate: boolean }>(`${API}/me`)).canCreate).toBe(false);
	});

	it("author can create documents", async () => {
		expect((await as("author").json<{ canCreate: boolean }>(`${API}/me`)).canCreate).toBe(true);
	});

	it("only Admins are admins", async () => {
		expect((await as("editor").json<{ isAdmin: boolean }>(`${API}/me`)).isAdmin).toBe(false);
		expect((await as("admin").json<{ isAdmin: boolean }>(`${API}/me`)).isAdmin).toBe(true);
	});
});

describe("List columns", () => {
	let pub: string;
	let priv: string;

	beforeAll(async () => {
		pub = await makeDocument(uniq("verify-cols"), {
			files: [{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" }],
		});
		priv = await makeDocument(uniq("verify-cols-priv"), { visibility: "private", owner: "other" });
	});

	it("columns report file type and size", async () => {
		const cols = await as("admin").json<Record<string, Record<string, unknown>>>(`${API}/columns?ids=${pub},${priv}`);
		expect(cols[pub]).toEqual({
			visibility: "public",
			revisions: 1,
			type: "pdf",
			size: TWO_PDF.length,
			editingBy: null,
		});
		expect(cols[priv]).toMatchObject({ visibility: "private", type: "txt" });
	});

	it("columns hide a private document's file from a contributor", async () => {
		const cols = await as("contributor").json<Record<string, Record<string, unknown>>>(`${API}/columns?ids=${priv}`);
		expect(cols[priv]).toEqual({ visibility: "private" });
	});

	it("columns need read-drafts", async () => {
		expect((await as("subscriber").get(`${API}/columns?ids=${pub}`)).status).toBe(403);
	});
});

describe("API tokens (scopes map like core content routes)", () => {
	let id: string;
	const tokens: Record<string, string> = {};

	beforeAll(async () => {
		id = await makeDocument(uniq("verify-tokens"));
		for (const scope of ["content:read", "content:write", "admin"]) {
			const data = await as("admin").postJson<{ token: string }>("/_emdash/api/admin/api-tokens", {
				name: `test-${scope}`,
				scopes: [scope],
			});
			tokens[scope] = data.token;
		}
	});

	// Token requests carry no session cookie, so no CSRF header either.
	const bearer = (scope: string) => ({ headers: { Authorization: `Bearer ${tokens[scope]}` }, csrf: false });

	it("content:read token reads the log", async () => {
		expect((await anon().get(`${CONTENT}/${id}/files`, bearer("content:read"))).status).toBe(200);
	});

	it("content:read token can't write", async () => {
		const res = await anon().post(`${CONTENT}/${id}/files/restore`, { n: 1 }, bearer("content:read"));
		expect(res.status).toBe(403);
	});

	it("content:write token uploads", async () => {
		const res = await anon().upload(id, ONE, "text/plain", "token.txt", bearer("content:write"));
		expect(res.status).toBe(201);
	});

	it("content:write token can't reach storage admin", async () => {
		expect((await anon().get(`${API}/storage`, bearer("content:write"))).status).toBe(403);
	});

	it("admin token reaches storage admin", async () => {
		expect((await anon().get(`${API}/storage`, bearer("admin"))).status).toBe(200);
	});
});
