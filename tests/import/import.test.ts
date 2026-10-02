/**
 * The WordPress importer end to end:
 * 1. Boot WordPress in Playground with the released WP Document Revisions,
 *    seed documents (scripts/fixtures/wpdr-seed.php) and run the exporter.
 * 2. Import the bundle into the suite's dev site, twice.
 * 3. Check files, revision numbers, authors, notes, visibility, workflow
 *    states, publish status, oversize handling and idempotency.
 *
 * Needs network for Playground's download.
 */

import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anon, as, BASE, Client, CONTENT, db, type FilesView } from "../support/client";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");
const RUN = String(Date.now());
const WORK = mkdtempSync(join(tmpdir(), "wpdr-import-"));
const BUNDLE = join(WORK, "out/bundle");

interface ExportBundle {
	wpdrVersion: string;
	documents: Array<{ slug: string; revisions: Array<{ file: { size: number } | null }> }>;
}

let exportError: unknown;
let token: string;
const api = () => new Client();
const bearer = () => ({ headers: { Authorization: `Bearer ${token}` }, csrf: false });

async function importBundle(dir: string, ...args: string[]) {
	try {
		const { stdout } = await run("node", [join(ROOT, "scripts/import-wpdr.mjs"), dir, "--site", BASE, ...args], {
			env: { ...process.env, EMDASH_TOKEN: token },
			maxBuffer: 10 * 1024 * 1024,
		});
		return { code: 0, lines: stdout.split("\n") };
	} catch (e) {
		const err = e as { code?: number; stdout?: string };
		return { code: err.code ?? 1, lines: (err.stdout ?? "").split("\n") };
	}
}

beforeAll(async () => {
	mkdirSync(join(WORK, "out"), { recursive: true });
	copyFileSync(join(ROOT, "scripts/fixtures/wpdr-seed.php"), join(WORK, "wpdr-seed.php"));
	writeFileSync(join(WORK, "run.txt"), RUN);
	try {
		await run(
			"npx",
			[
				"-y",
				"@wp-playground/cli@latest",
				"run-blueprint",
				`--blueprint=${join(ROOT, "scripts/fixtures/blueprint.json")}`,
				`--mount=${WORK}:/fixtures`,
				`--mount=${join(WORK, "out")}:/out`,
				`--mount=${join(ROOT, "scripts")}:/scripts`,
			],
			{ cwd: WORK, maxBuffer: 64 * 1024 * 1024, timeout: 480_000 },
		);
	} catch (e) {
		exportError = e;
	}
}, 540_000);

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

describe("Export from WordPress (Playground)", () => {
	it("exporter succeeded", () => {
		const e = exportError as { stdout?: string; stderr?: string } | undefined;
		expect(exportError, `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.slice(-3000)).toBeUndefined();
	});

	it("seed stored files in a document directory outside uploads", () => {
		expect(readFileSync(join(WORK, "out/seed-check.txt"), "utf8")).toBe("OFFSITE-OK");
	});

	it("bundle written", () => {
		expect(existsSync(join(BUNDLE, "export.json"))).toBe(true);
	});

	it("documents exported", () => {
		const bundle = JSON.parse(readFileSync(join(BUNDLE, "export.json"), "utf8")) as ExportBundle;
		expect(bundle.documents).toHaveLength(7);
	});

	it("exporter recorded the plugin version", () => {
		const bundle = JSON.parse(readFileSync(join(BUNDLE, "export.json"), "utf8")) as ExportBundle;
		expect(bundle.wpdrVersion).toMatch(/^\d+\.\d+/);
	});
});

describe("Import into EmDash", () => {
	const admin = as("admin");
	const H = `handbook-${RUN}`;
	let hId: string;

	beforeAll(async () => {
		if (exportError) throw new Error("Export failed; not importing");
		// An EmDash user matching the WordPress editor's email, so owner mapping
		// is tested against someone other than the importing admin.
		db().run(
			"insert or ignore into users (id, email, name, role) values ('verify-wp-editor', 'editor@example.com', 'Edna (EmDash)', 40)",
		);
		token = (
			await admin.postJson<{ token: string }>("/_emdash/api/admin/api-tokens", {
				name: `import-${RUN}`,
				scopes: ["admin"],
			})
		).token;
	});

	const item = async (idOrSlug: string) =>
		(
			await api().json<{ item: { id: string; status: string; authorId: string; data: Record<string, string> } }>(
				`${CONTENT}/${idOrSlug}`,
				bearer(),
			)
		).item;

	describe("two runs", () => {
		it("first import imported all 7", async () => {
			// --multipart-over 100: every file over 100 bytes (the fixture PDF
			// included) goes through multipart upload, which the byte-identical
			// PDF check below covers.
			const first = await importBundle(BUNDLE, "--multipart-over", "100");
			expect(first.code, first.lines.join("\n")).toBe(0);
			expect(first.lines).toContain("7 imported");
		});

		it("re-run skips everything", async () => {
			const second = await importBundle(BUNDLE);
			expect(second.code, second.lines.join("\n")).toBe(0);
			expect(second.lines).toContain("7 skipped");
			hId = (await item(H)).id;
		});
	});

	describe("Files and permalinks", () => {
		it("latest file, anonymous", async () => {
			expect(await (await anon().get(`/documents/${H}.txt`)).text()).toBe("Handbook v3\n");
		});

		it("WordPress-style dated revision URL serves the original PDF", async () => {
			const res = await admin.get(`/documents/2026/01/${H}-revision-1.pdf`);
			expect(res.status).toBe(200);
			expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(WORK, "out/fixture.pdf")))).toBe(true);
		});

		it("note-only revision shares the previous file", async () => {
			expect(await (await admin.get(`/documents/${H}-revision-3.txt`)).text()).toBe("Handbook v2\n");
		});

		it("past revision stays private", async () => {
			expect((await anon().get(`/documents/${H}-revision-1.pdf`)).status).toBe(404);
		});
	});

	describe("Revision log", () => {
		let log: FilesView;
		beforeAll(async () => {
			log = await api().json<FilesView>(`${CONTENT}/${hId}/files`, bearer());
		});

		it("revision numbers preserved", () => {
			expect(log.revisions.map((r) => r.n)).toEqual([4, 3, 2, 1]);
		});

		it("authors preserved", () => {
			expect(log.revisions.map((r) => r.authorName)).toEqual(["Ada Admin", "Edna Editor", "Edna Editor", "Ada Admin"]);
		});

		it("notes preserved", () => {
			expect(log.revisions.map((r) => r.note)).toEqual([
				"Final wording",
				"Fixed a typo in the title",
				"Second draft",
				"Initial upload",
			]);
		});

		it("source recorded", () => {
			expect(log.source?.system).toBe("wordpress");
		});
	});

	describe("Document metadata", () => {
		it("title is the current WordPress title", async () => {
			expect((await item(hId)).data.title).toBe("Handbook 2026");
		});

		it("description became the summary", async () => {
			expect((await item(hId)).data.summary).toBe("Policies for all staff.");
		});

		it("published", async () => {
			expect((await item(hId)).status).toBe("published");
		});

		it("owner mapped by email", async () => {
			expect((await item(`proposal-${RUN}`)).authorId).toBe("verify-wp-editor");
		});

		it("private title has no 'Private:' prefix", async () => {
			expect((await item(`minutes-${RUN}`)).data.title).toBe("Board Minutes");
		});

		it("password title has no 'Protected:' prefix", async () => {
			expect((await item(`bands-${RUN}`)).data.title).toBe("Salary Bands");
		});

		it("workflow state assigned", async () => {
			const { terms } = await api().json<{ terms: Array<{ slug: string }> }>(
				`${CONTENT}/${hId}/terms/workflow_state`,
				bearer(),
			);
			expect(terms.map((t) => t.slug)).toEqual(["final"]);
		});
	});

	describe("Visibility and status", () => {
		it("private document, anonymous", async () => {
			expect((await anon().get(`/documents/minutes-${RUN}.txt`)).status).toBe(404);
		});

		it("private document, admin", async () => {
			expect((await admin.get(`/documents/minutes-${RUN}.txt`)).status).toBe(200);
		});

		it("password document asks for the password", async () => {
			expect((await anon().get(`/documents/bands-${RUN}.txt`)).status).toBe(401);
		});

		it("the WordPress password still works", async () => {
			const res = await anon().fetch(`/documents/bands-${RUN}.txt`, {
				method: "POST",
				body: new URLSearchParams({ password: "open-sesame" }),
			});
			expect(res.status).toBe(303);
		});

		it("draft stays a draft", async () => {
			expect((await anon().get(`/documents/proposal-${RUN}.txt`)).status).toBe(404);
		});

		it("draft visible to admin", async () => {
			expect((await admin.get(`/documents/proposal-${RUN}.txt`)).status).toBe(200);
		});

		it("document without files imported", async () => {
			expect((await item(`empty-${RUN}`)).status).toBe("published");
		});

		it("scheduled document is scheduled", async () => {
			expect((await item(`plan-${RUN}`)).status).toBe("scheduled");
		});

		it("trashed document is in the trash", async () => {
			const { items } = await api().json<{ items: Array<{ slug: string }> }>(`${CONTENT}/trash`, bearer());
			expect(items.filter((i) => i.slug === `memo-${RUN}`)).toHaveLength(1);
		});

		it("trashed document's file isn't served", async () => {
			expect((await admin.get(`/documents/memo-${RUN}.txt`)).status).toBe(404);
		});
	});

	describe("Oversized files", () => {
		it("oversized document refused up front", async () => {
			// Fake a 6 GB revision in a copy of the bundle: the importer must
			// refuse the document before creating anything, not fail halfway.
			const bundle = JSON.parse(readFileSync(join(BUNDLE, "export.json"), "utf8")) as ExportBundle;
			const doc = bundle.documents.find((d) => d.slug.startsWith("minutes-"))!;
			doc.slug = `${doc.slug}-big`;
			doc.revisions[0]!.file!.size = 6 * 1024 ** 3; // over the 5 GB multipart cap
			bundle.documents = [doc];
			const big = join(WORK, "big");
			mkdirSync(big, { recursive: true });
			writeFileSync(join(big, "export.json"), JSON.stringify(bundle));
			cpSync(join(BUNDLE, "files"), join(big, "files"), { recursive: true });
			const result = await importBundle(big);
			expect(result.lines.filter((l) => l.startsWith("  too-large"))).toHaveLength(1);
		});

		it("no entry created for it", async () => {
			expect((await api().get(`${CONTENT}/minutes-${RUN}-big`, bearer())).status).toBe(404);
		});
	});

	describe("Import endpoint guards", () => {
		it("import refuses a non-increasing revision number", async () => {
			const res = await api().fetch(`${CONTENT}/${hId}/files/import?n=2&filename=x.txt`, {
				...bearer(),
				method: "POST",
				headers: { ...bearer().headers, "Content-Type": "text/plain" },
				body: "x",
			});
			expect(res.status).toBe(409);
		});

		it("import is Admin-only", async () => {
			const res = await as("editor").fetch(`${CONTENT}/${hId}/files/import?n=9&filename=x.txt`, {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "x",
			});
			expect(res.status).toBe(403);
		});
	});
});
