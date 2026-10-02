import { describe, expect, it } from "vitest";

import {
	canEdit,
	canReadDrafts,
	canReadPrivate,
	canSeeFiles,
	fileAccess,
	type Access,
	type User,
} from "../../plugin/src/access";
import type { VisibilityMode } from "../../plugin/src/store";
import { entry, manifest, user } from "./helpers";

const ROLES = [undefined, 10, 20, 30, 40, 50] as const;
const roleName = (r: number | undefined) =>
	r === undefined ? "visitor" : ({ 10: "subscriber", 20: "contributor", 30: "author", 40: "editor", 50: "admin" } as const)[r]!;
const viewer = (role: number | undefined, own: boolean): User | undefined =>
	role === undefined ? undefined : user(own ? "owner" : "someone-else", role);

describe("role rules", () => {
	it.each([
		[undefined, false, false],
		[10, false, false],
		[10, true, false],
		[20, true, false],
		[30, false, false],
		[30, true, true],
		[40, false, true],
		[50, false, true],
	] as const)("canEdit: %s, own=%s → %s", (role, own, expected) => {
		expect(canEdit(viewer(role, own), { authorId: "owner" })).toBe(expected);
	});

	it.each([
		[undefined, false],
		[10, false],
		[20, true],
		[30, true],
		[40, true],
		[50, true],
	] as const)("canReadDrafts: %s → %s", (role, expected) => {
		expect(canReadDrafts(viewer(role, false))).toBe(expected);
	});

	it.each([
		[undefined, false, false],
		[10, false, false],
		[10, true, true],
		[20, false, false],
		[20, true, true],
		[30, false, false],
		[30, true, true],
		[40, false, true],
		[50, false, true],
	] as const)("canReadPrivate: %s, own=%s → %s", (role, own, expected) => {
		expect(canReadPrivate(viewer(role, own), { authorId: "owner" })).toBe(expected);
	});

	it("an entry with no author is nobody's own", () => {
		expect(canEdit(user("u", 30), { authorId: null })).toBe(false);
		expect(canReadPrivate(user("u", 30), { authorId: null })).toBe(false);
	});
});

/**
 * The README's "Who can do what" table, written out independently of
 * access.ts: what each viewer gets for the current file (or a past
 * revision) of a document.
 */
function expected(
	role: number | undefined,
	own: boolean,
	mode: VisibilityMode,
	status: "published" | "draft",
	revision: boolean,
	cookie: boolean,
): Access {
	const signedIn = role !== undefined;
	const editor = (role ?? 0) >= 40;
	const editsIt = editor || ((role ?? 0) >= 30 && own);
	const readsPrivate = editor || (signedIn && own);
	const readsDrafts = (role ?? 0) >= 20;

	let current: Access;
	if (status === "draft") {
		const visible = mode === "private" ? readsPrivate : mode === "password" ? editsIt || cookie : true;
		current = readsDrafts && visible ? "allow" : "deny";
	} else if (mode === "public") {
		current = "allow";
	} else if (mode === "private") {
		current = readsPrivate ? "allow" : "deny";
	} else {
		current = editsIt || cookie ? "allow" : "password";
	}
	// Past revisions also need content:read_drafts, never less than the current file.
	if (revision && current === "allow" && !readsDrafts) return "deny";
	return current;
}

type Case = [string, number | undefined, boolean, VisibilityMode, "published" | "draft", boolean, boolean];
const cases: Case[] = [];
for (const role of ROLES)
	for (const own of role === undefined ? [false] : [false, true])
		for (const mode of ["public", "private", "password"] as const)
			for (const status of ["published", "draft"] as const)
				for (const revision of [false, true])
					for (const cookie of [false, true]) {
						const name = `${roleName(role)}${own ? " (author)" : ""}, ${mode} ${status}, ${revision ? "past revision" : "latest"}, cookie ${cookie ? "valid" : "absent"}`;
						cases.push([name, role, own, mode, status, revision, cookie]);
					}

describe("fileAccess matches the README's permission table", () => {
	it.each(cases)(
		"%s",
		(_name, role, own, mode, status, revision, cookie) => {
			const got = fileAccess(viewer(role, own), entry({ status }), manifest(mode), {
				revision,
				passwordCookieValid: cookie,
			});
			expect(got).toBe(expected(role, own, mode, status, revision, cookie));
		},
	);

	it("a manifest without visibility (written before it existed) is public", () => {
		const m = manifest("public");
		delete m.visibility;
		expect(fileAccess(undefined, entry(), m, { revision: false, passwordCookieValid: false })).toBe("allow");
	});

	it("scheduled and other non-published statuses count as drafts", () => {
		for (const status of ["scheduled", "pending"]) {
			expect(fileAccess(undefined, entry({ status }), manifest(), { revision: false, passwordCookieValid: false })).toBe(
				"deny",
			);
			expect(
				fileAccess(user("c", 20), entry({ status }), manifest(), { revision: false, passwordCookieValid: false }),
			).toBe("allow");
		}
	});
});

describe("canSeeFiles: one rule for the log, extracted text and list columns", () => {
	it.each([
		["visitor", undefined, false, "public", false],
		["subscriber", 10, false, "public", false],
		["contributor", 20, false, "public", true],
		["contributor", 20, false, "private", false],
		["contributor (author)", 20, true, "private", true],
		["contributor", 20, false, "password", false],
		["author (author)", 30, true, "password", true],
		["editor", 40, false, "password", true],
	] as const)("%s, published %s → %s", (_n, role, own, mode, expectedSee) => {
		expect(canSeeFiles(viewer(role, own), entry(), manifest(mode))).toBe(expectedSee);
	});

	it("password cookies never open the log", () => {
		// canSeeFiles never takes a cookie: metadata needs edit rights.
		expect(canSeeFiles(user("c", 20), entry(), manifest("password"))).toBe(false);
	});

	it("without a manifest, falls back to content:read_drafts", () => {
		expect(canSeeFiles(user("s", 10), entry(), null)).toBe(false);
		expect(canSeeFiles(user("c", 20), entry(), null)).toBe(true);
	});
});
