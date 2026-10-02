import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	anon,
	API,
	as,
	cacheControl,
	CONTENT,
	eventually,
	makeDocument,
	ONE,
	setOwner,
	TWO_PDF,
	uniq,
	type FilesView,
} from "../support/client";

describe("Private documents", () => {
	const SLUG = uniq("verify-private");
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(SLUG, { owner: "other" });
	});

	it("set private", async () => {
		expect((await as("admin").setVisibility(id, "private")).status).toBe(200);
	});

	it("private, anonymous", async () => {
		expect((await anon().get(`/documents/${SLUG}`)).status).toBe(404);
	});

	it("private, subscriber", async () => {
		expect((await as("subscriber").get(`/documents/${SLUG}`)).status).toBe(404);
	});

	it("private, contributor (not author)", async () => {
		expect((await as("contributor").get(`/documents/${SLUG}`)).status).toBe(404);
	});

	it("private revision log, contributor", async () => {
		expect((await as("contributor").get(`${CONTENT}/${id}/files`)).status).toBe(403);
	});

	it("private, author role (not this document's author)", async () => {
		expect((await as("author").get(`/documents/${SLUG}`)).status).toBe(404);
	});

	it("private, editor", async () => {
		expect((await as("editor").get(`/documents/${SLUG}`)).status).toBe(200);
	});

	it("private is never publicly cacheable", async () => {
		expect(cacheControl(await as("editor").get(`/documents/${SLUG}`))).toBe("private, no-store");
	});

	it("private, its own author at contributor level", async () => {
		setOwner(id, "contributor");
		try {
			expect((await as("contributor").get(`/documents/${SLUG}`)).status).toBe(200);
		} finally {
			setOwner(id, "other");
		}
	});

	it("private, its own author at subscriber level", async () => {
		setOwner(id, "subscriber");
		try {
			expect((await as("subscriber").get(`/documents/${SLUG}`)).status).toBe(200);
		} finally {
			setOwner(id, "other");
		}
	});
});

describe("Password-protected documents", () => {
	const admin = as("admin");
	const SLUG = uniq("verify-pw");
	const url = `/documents/${SLUG}`;
	const form = (password: string) => new URLSearchParams({ password });
	let id: string;
	const visitor = anon();

	beforeAll(async () => {
		id = await makeDocument(SLUG, {
			files: [
				{ body: ONE, type: "text/plain", name: "one.txt" },
				{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" },
			],
		});
	});

	it("password mode needs a password", async () => {
		expect((await admin.setVisibility(id, "password")).status).toBe(400);
	});

	it("set password", async () => {
		expect((await admin.setVisibility(id, "password", "pw-one")).status).toBe(200);
	});

	it("anonymous gets the password form", async () => {
		const res = await anon().get(url);
		expect(res.status).toBe(401);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(await res.text()).toContain('<input type="password" name="password"');
	});

	it("wrong password", async () => {
		const res = await anon().fetch(url, { method: "POST", body: form("nope") });
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("That password is incorrect.");
	});

	it("cross-site form post", async () => {
		const res = await anon().fetch(url, {
			method: "POST",
			headers: { Origin: "https://evil.example" },
			body: form("pw-one"),
		});
		expect(res.status).toBe(403);
	});

	it("right password redirects", async () => {
		const res = await visitor.fetch(url, { method: "POST", body: form("pw-one") });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(url);
	});

	it("password cookie is HttpOnly and scoped", async () => {
		const res = await anon().fetch(url, { method: "POST", body: form("pw-one") });
		const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`edr_pw_${id}=`));
		expect(cookie).toBeDefined();
		const attrs = cookie!.split(/;\s*/).slice(1);
		expect(attrs).toEqual(expect.arrayContaining(["Path=/documents", "HttpOnly", "SameSite=Lax", "Max-Age=864000"]));
	});

	it("with cookie", async () => {
		const res = await visitor.get(url);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(TWO_PDF);
	});

	it("subscriber gets the password form", async () => {
		expect((await as("subscriber").get(url)).status).toBe(401);
	});

	it("subscriber with cookie", async () => {
		expect((await as("subscriber").addCookies(visitor).get(url)).status).toBe(200);
	});

	it("cookie doesn't open past revisions", async () => {
		expect((await visitor.get(`/documents/${SLUG}-revision-1.txt`)).status).toBe(404);
	});

	it("editor needs no password", async () => {
		expect((await as("editor").get(url)).status).toBe(200);
	});

	it("password log hides the hash", async () => {
		const res = await admin.get(`${CONTENT}/${id}/files`);
		const text = await res.text();
		expect(text).not.toMatch(/passwordHash|"salt"/);
		expect((JSON.parse(text) as { data: FilesView }).data.visibility).toEqual({ mode: "password", hasPassword: true });
	});

	it("change password", async () => {
		expect((await admin.setVisibility(id, "password", "pw-two")).status).toBe(200);
	});

	it("old cookie stops working", async () => {
		expect((await visitor.get(url)).status).toBe(401);
	});

	it("back to public", async () => {
		expect((await admin.setVisibility(id, "public")).status).toBe(200);
	});

	it("public again", async () => {
		expect((await anon().get(url)).status).toBe(200);
	});
});

/** A draft keeps its visibility: password-protected drafts need edit rights. */
describe("Password-protected drafts", () => {
	const SLUG = uniq("verify-pw-draft");
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(SLUG, { visibility: "password", password: "draft-pw", publish: false, owner: "other" });
	});

	it("editor opens a password-protected draft", async () => {
		expect((await as("editor").get(`/documents/${SLUG}`)).status).toBe(200);
	});

	it("contributor (not author) can't open a password-protected draft", async () => {
		expect((await as("contributor").get(`/documents/${SLUG}`)).status).toBe(404);
	});

	it("contributor (not author) can't read a password-protected draft's log", async () => {
		expect((await as("contributor").get(`${CONTENT}/${id}/files`)).status).toBe(403);
	});
});

describe("Password rate limit", () => {
	const SLUG = uniq("verify-rl");

	beforeAll(async () => {
		await makeDocument(SLUG, { visibility: "password", password: "rl-secret" });
	});

	it("sixth wrong password in a minute is throttled", async () => {
		const codes: number[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await anon().fetch(`/documents/${SLUG}`, {
				method: "POST",
				body: new URLSearchParams({ password: "wrong" }),
			});
			codes.push(res.status);
			if (res.status === 429) expect(res.headers.get("retry-after")).toBe("60");
		}
		expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
	});
});

describe("Default visibility for new documents", () => {
	const admin = as("admin");

	afterAll(async () => {
		// Back to the product default (private, as in WP Document Revisions).
		await admin.post(`${API}/settings`, { defaultVisibility: "private" });
	});

	it("product default is private", async () => {
		const settings = await admin.json<{ defaultVisibility: string }>(`${API}/settings`);
		expect(settings.defaultVisibility).toBe("private");
	});

	it("new document is private when the default is private", async () => {
		await admin.postJson(`${API}/settings`, { defaultVisibility: "private" });
		const id = await admin.createDocument(uniq("verify-dv"), "Default private");
		expect((await admin.files(id)).visibility.mode).toBe("private");
	});

	it("settings are Admin-only", async () => {
		expect((await as("editor").get(`${API}/settings`)).status).toBe(403);
	});

	it("settings reject an unknown default", async () => {
		expect((await admin.post(`${API}/settings`, { defaultVisibility: "password" })).status).toBe(400);
	});

	it("new document is public when the default is public", async () => {
		await admin.postJson(`${API}/settings`, { defaultVisibility: "public" });
		const id = await admin.createDocument(uniq("verify-dv2"), "Default public");
		expect((await admin.files(id)).visibility.mode).toBe("public");
	});
});

describe("File metadata follows the file rule", () => {
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(uniq("verify-meta"), {
			owner: "other",
			visibility: "password",
			password: "meta-secret",
		});
		// Let extraction finish so the text endpoint has something to refuse.
		await eventually(async () => {
			const status = (await as("admin").files(id)).revisions[0]!.text?.status;
			return status && status !== "pending" ? status : undefined;
		});
	});

	it("contributor (not author) can't read a password document's log", async () => {
		expect((await as("contributor").get(`${CONTENT}/${id}/files`)).status).toBe(403);
	});

	it("...or its extracted text", async () => {
		expect((await as("contributor").get(`${CONTENT}/${id}/files/text`)).status).toBe(403);
	});

	it("...and list columns show only its visibility", async () => {
		const cols = await as("contributor").json<Record<string, Record<string, unknown>>>(`${API}/columns?ids=${id}`);
		expect(cols[id]).toEqual({ visibility: "password" });
	});

	it("editor can read its extracted text", async () => {
		const res = await as("editor").get(`${CONTENT}/${id}/files/text`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { data: { text: string } }).data.text).toBe(ONE);
	});

	it("its author can read the log", async () => {
		setOwner(id, "author");
		try {
			expect((await as("author").get(`${CONTENT}/${id}/files`)).status).toBe(200);
		} finally {
			setOwner(id, "other");
		}
	});
});
