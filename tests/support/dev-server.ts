/**
 * Starts the demo site under `astro dev` for the integration and import
 * suites, with its own Miniflare state, and logs in one user per role.
 *
 * - Its own state directory (EDR_STATE_DIR, read by site/astro.config.mjs),
 *   wiped on every run, so tests never touch the D1/R2 data that `pnpm dev`
 *   uses under site/.wrangler/.
 * - `--ignore-lock` keeps astro in the foreground (it otherwise backgrounds
 *   itself when it detects a coding agent) and leaves the project's dev-server
 *   lock file alone, so a `pnpm dev` already running in the same checkout is
 *   unaffected. We own the child process and kill its group on teardown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import type { TestProject } from "vitest/node";

import { D1, type TestUser, TEST_USERS } from "./db";

export const SITE_DIR = resolve(import.meta.dirname, "../../site");

/**
 * Ports for the suites' dev servers: integration on the base port, import on
 * the next. Set EDR_TEST_PORT to move both, e.g. when another checkout or
 * worktree is running the tests at the same time.
 */
export const testPort = (offset: 0 | 1): number => (Number(process.env.EDR_TEST_PORT) || 4330) + offset;

export interface DevServerOptions {
	port: number;
	/** Directory under site/ for this suite's Miniflare state. */
	stateName: string;
}

declare module "vitest" {
	export interface ProvidedContext {
		baseUrl: string;
		stateDir: string;
		/** Cookie header per test user, keyed by TestUser key. */
		sessions: Record<string, string>;
	}
}

async function portFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const s = createServer()
			.once("error", () => done(false))
			.once("listening", () => s.close(() => done(true)))
			.listen(port, "localhost");
	});
}

/**
 * Password cookies are signed with EMDASH_ENCRYPTION_KEY, so the dev server
 * needs one. A fresh checkout (and CI) has none: generate a throwaway key in
 * site/.dev.vars (gitignored). Never overwrites a key the developer set.
 */
function ensureEncryptionKey(): () => void {
	const devVars = join(SITE_DIR, ".dev.vars");
	if (existsSync(devVars) || existsSync(join(SITE_DIR, ".env"))) return () => {};
	const key = `emdash_enc_v1_${randomBytes(32).toString("base64url")}`;
	writeFileSync(devVars, `# Written by the test suite; deleted when it finishes.\nEMDASH_ENCRYPTION_KEY=${key}\n`);
	return () => rmSync(devVars, { force: true });
}

async function waitForServer(base: string, child: ChildProcess, log: () => string): Promise<void> {
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`astro dev exited (${child.exitCode}):\n${log()}`);
		try {
			const res = await fetch(base, { signal: AbortSignal.timeout(30_000) });
			if (res.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`astro dev didn't answer at ${base} within 3 minutes:\n${log()}`);
}

/**
 * Real sessions per role. EmDash's dev-bypass signs in whichever user has
 * the dev email, and sessions store only the user ID (the role is read from
 * D1 on every request). So: hand each test user the dev email in turn, sign
 * in, and put the emails back.
 */
async function signIn(base: string, db: D1, user: TestUser): Promise<string> {
	const devId = db.get<{ id: string }>("select id from users where email = 'dev@emdash.local'")!.id;
	db.run("update users set email = 'dev-parked@test.local' where id = ?", devId);
	db.run("update users set email = 'dev@emdash.local' where id = ?", user.id);
	try {
		const res = await fetch(`${base}/_emdash/api/auth/dev-bypass`, {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
		});
		const body = (await res.json()) as { data?: { user?: { id: string } } };
		if (!res.ok || body.data?.user?.id !== user.id) {
			throw new Error(`dev-bypass for ${user.key} failed: ${res.status} ${JSON.stringify(body)}`);
		}
		return res.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
	} finally {
		db.run("update users set email = ? where id = ?", user.email, user.id);
		db.run("update users set email = 'dev@emdash.local' where id = ?", devId);
	}
}

export function devServerSetup({ port, stateName }: DevServerOptions) {
	return async function setup(project: TestProject) {
		const base = `http://localhost:${port}`;
		const stateDir = join(SITE_DIR, stateName);
		if (!(await portFree(port))) {
			throw new Error(`Port ${port} is already in use; stop whatever is listening there and rerun.`);
		}
		rmSync(stateDir, { recursive: true, force: true });
		mkdirSync(stateDir, { recursive: true });
		const removeKey = ensureEncryptionKey();

		const output: string[] = [];
		const child = spawn(
			join(SITE_DIR, "node_modules/.bin/astro"),
			["dev", "--port", String(port), "--ignore-lock"],
			{
				cwd: SITE_DIR,
				env: { ...process.env, EDR_STATE_DIR: stateDir, ASTRO_TELEMETRY_DISABLED: "1" },
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const keep = (b: Buffer) => {
			output.push(b.toString());
			if (output.length > 200) output.shift();
		};
		child.stdout!.on("data", keep);
		child.stderr!.on("data", keep);
		if (process.env.EDR_DEV_LOG) {
			child.stdout!.pipe(process.stderr);
			child.stderr!.pipe(process.stderr);
		}

		const teardown = async () => {
			if (child.exitCode === null && child.pid) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					// Already gone.
				}
				await new Promise((r) => {
					const t = setTimeout(() => {
						try {
							process.kill(-child.pid!, "SIGKILL");
						} catch {
							// Already gone.
						}
						r(undefined);
					}, 5000);
					child.once("exit", () => {
						clearTimeout(t);
						r(undefined);
					});
				});
			}
			removeKey();
		};

		try {
			await waitForServer(base, child, () => output.join(""));
			// Apply the seed (collections, taxonomies) and create the dev admin.
			const setupRes = await fetch(`${base}/_emdash/api/setup/dev-bypass`, {
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
			});
			if (!setupRes.ok) throw new Error(`setup dev-bypass failed: ${setupRes.status} ${await setupRes.text()}`);

			const db = new D1(stateDir);
			const sessions: Record<string, string> = {};
			for (const user of TEST_USERS) {
				db.run(
					"insert into users (id, email, name, role) values (?, ?, ?, ?)",
					user.id,
					user.email,
					user.name,
					user.role,
				);
			}
			for (const user of TEST_USERS) sessions[user.key] = await signIn(base, db, user);
			db.close();

			// Warm the routes the suites hit first, so Vite's dependency
			// optimizer doesn't reload the server in the middle of a test.
			for (const path of ["/", "/documents", "/search", "/documents/warm-up"]) {
				await fetch(`${base}${path}`, { headers: { cookie: sessions.admin! } }).catch(() => undefined);
			}

			project.provide("baseUrl", base);
			project.provide("stateDir", stateDir);
			project.provide("sessions", sessions);
		} catch (e) {
			await teardown();
			throw e;
		}
		return teardown;
	};
}
