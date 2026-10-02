/**
 * Direct access to the dev server's local Miniflare state: the D1 database
 * (users, lock rows, collection settings) and the R2 buckets' object index.
 * Only ever used against the suite's own state directory.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface TestUser {
	key: string;
	id: string;
	email: string;
	name: string;
	role: number;
}

/** One real user per role, each with its own session. */
export const TEST_USERS: TestUser[] = [
	{ key: "admin", id: "t-admin", email: "admin@test.local", name: "Test Admin", role: 50 },
	{ key: "editor", id: "t-editor", email: "editor@test.local", name: "Test Editor", role: 40 },
	{ key: "author", id: "t-author", email: "author@test.local", name: "Test Author", role: 30 },
	{ key: "contributor", id: "t-contributor", email: "contributor@test.local", name: "Test Contributor", role: 20 },
	{ key: "subscriber", id: "t-subscriber", email: "subscriber@test.local", name: "Test Subscriber", role: 10 },
	// Owns documents and holds edit locks so ownership and lock checks are
	// about somebody else. Never signed in by the tests themselves.
	{ key: "other", id: "t-other", email: "other@test.local", name: "Other Editor", role: 40 },
	// Its role and disabled flag are changed by the feed tests.
	{ key: "mutable", id: "t-mutable", email: "mutable@test.local", name: "Mutable User", role: 20 },
];

export type UserKey = "admin" | "editor" | "author" | "contributor" | "subscriber" | "other" | "mutable";

export const userId = (key: UserKey) => TEST_USERS.find((u) => u.key === key)!.id;

function sqliteFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
		.map((f) => join(dir, f));
}

export class D1 {
	private db: DatabaseSync;

	constructor(stateDir: string) {
		const dir = join(stateDir, "v3/d1/miniflare-D1DatabaseObject");
		// The site's database is the one with EmDash's users table.
		const file = sqliteFiles(dir).find((f) => {
			const probe = new DatabaseSync(f, { readOnly: true });
			try {
				return Boolean(probe.prepare("select 1 from sqlite_master where name = 'users'").get());
			} finally {
				probe.close();
			}
		});
		if (!file) throw new Error(`No EmDash D1 database under ${dir}`);
		this.db = new DatabaseSync(file, { timeout: 10_000 });
	}

	run(sql: string, ...params: SQLInputValue[]): void {
		this.db.prepare(sql).run(...params);
	}

	get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.db.prepare(sql).get(...params) as T | undefined;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	close(): void {
		this.db.close();
	}
}

/** Objects whose key starts with `prefix`, across the local R2 buckets. */
export function r2Count(stateDir: string, prefix: string): number {
	let n = 0;
	for (const f of sqliteFiles(join(stateDir, "v3/r2/miniflare-R2BucketObject"))) {
		const db = new DatabaseSync(f, { readOnly: true, timeout: 10_000 });
		try {
			const row = db
				.prepare("select count(*) as n from _mf_objects where substr(key, 1, ?) = ?")
				.get(prefix.length, prefix) as { n: number } | undefined;
			n += row?.n ?? 0;
		} catch {
			// Not an object store (no _mf_objects table).
		} finally {
			db.close();
		}
	}
	return n;
}
