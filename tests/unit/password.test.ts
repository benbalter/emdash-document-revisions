import { afterEach, describe, expect, it } from "vitest";

import {
	hashPassword,
	passwordCookieHeader,
	passwordCookieName,
	passwordCookieValid,
	verifyPassword,
} from "../../plugin/src/access";
import type { Manifest } from "../../plugin/src/store";
import { env, manifest } from "./helpers";

const withPassword = async (password: string): Promise<Manifest> => ({
	...manifest("password"),
	visibility: { mode: "password", ...(await hashPassword(password)) },
});

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

/** PBKDF2-SHA256 the way access.ts does, for building hashes by hand. */
async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	return b64url(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

describe("password hashing", () => {
	afterEach(() => {
		delete env.DOCUMENT_PASSWORD_ITERATIONS;
	});

	it("hashes with a random salt and stores the iteration count", async () => {
		const a = await hashPassword("pw");
		const b = await hashPassword("pw");
		expect(a.iterations).toBe(20_000);
		expect(a.salt).not.toBe(b.salt);
		expect(a.passwordHash).not.toBe(b.passwordHash);
		expect(a.passwordHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it.each([
		["50000", 50_000],
		["5", 10_000],
		["1000000", 100_000],
		["12345.9", 12_345],
		["not a number", 20_000],
		["-1", 20_000],
	])("DOCUMENT_PASSWORD_ITERATIONS=%s → %i iterations", async (value, iterations) => {
		env.DOCUMENT_PASSWORD_ITERATIONS = value;
		expect((await hashPassword("pw")).iterations).toBe(iterations);
	});

	it("verifies the right password and rejects others", async () => {
		const m = await withPassword("open sesame");
		expect(await verifyPassword(m, "open sesame")).toBe(true);
		expect(await verifyPassword(m, "open sesame ")).toBe(false);
		expect(await verifyPassword(m, "")).toBe(false);
	});

	it("verifies with the hash's own count after the setting changes", async () => {
		env.DOCUMENT_PASSWORD_ITERATIONS = "30000";
		const m = await withPassword("pw");
		env.DOCUMENT_PASSWORD_ITERATIONS = "90000";
		expect(await verifyPassword(m, "pw")).toBe(true);
	});

	it("hashes from before the count was stored use the legacy 60,000", async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const legacy: Manifest = {
			...manifest("password"),
			visibility: { mode: "password", passwordHash: await pbkdf2("old", salt, 60_000), salt: b64url(salt) },
		};
		expect(await verifyPassword(legacy, "old")).toBe(true);
		// The same hash read with today's default count doesn't match.
		const relabeled: Manifest = { ...legacy, visibility: { ...legacy.visibility!, iterations: 20_000 } };
		expect(await verifyPassword(relabeled, "old")).toBe(false);
	});

	it("only password-mode documents verify", async () => {
		const m = await withPassword("pw");
		expect(await verifyPassword({ ...m, visibility: { ...m.visibility!, mode: "public" } }, "pw")).toBe(false);
		expect(await verifyPassword(manifest("password"), "pw")).toBe(false); // no hash stored
	});
});

describe("password cookies", () => {
	const cookieValue = (header: string) => header.split(";")[0]!.split("=").slice(1).join("=");

	it("are named per document", () => {
		expect(passwordCookieName("abc")).toBe("edr_pw_abc");
	});

	it("are HttpOnly, scoped to /documents, and last ten days", async () => {
		const header = await passwordCookieHeader(await withPassword("pw"), false);
		expect(header).toMatch(/^edr_pw_e1=[A-Za-z0-9_-]{43}; /);
		expect(header.split("; ").slice(1)).toEqual(["Path=/documents", "Max-Age=864000", "HttpOnly", "SameSite=Lax"]);
		expect(await passwordCookieHeader(await withPassword("pw"), true)).toMatch(/; Secure$/);
	});

	it("validate for their document and password", async () => {
		const m = await withPassword("pw");
		const value = cookieValue(await passwordCookieHeader(m, false));
		expect(await passwordCookieValid(m, value)).toBe(true);
		expect(await passwordCookieValid(m, `${value.slice(0, -1)}x`)).toBe(false);
		expect(await passwordCookieValid(m, undefined)).toBe(false);
		expect(await passwordCookieValid({ ...m, entryId: "other" }, value)).toBe(false);
	});

	it("stop working when the password changes", async () => {
		const m = await withPassword("pw");
		const value = cookieValue(await passwordCookieHeader(m, false));
		expect(await passwordCookieValid(await withPassword("pw"), value)).toBe(false);
	});

	it("mean nothing once the document isn't password-protected", async () => {
		const m = await withPassword("pw");
		const value = cookieValue(await passwordCookieHeader(m, false));
		expect(await passwordCookieValid({ ...m, visibility: { ...m.visibility!, mode: "public" } }, value)).toBe(false);
	});

	it("depend on EMDASH_ENCRYPTION_KEY", async () => {
		const m = await withPassword("pw");
		const value = cookieValue(await passwordCookieHeader(m, false));
		const secret = env.EMDASH_ENCRYPTION_KEY;
		try {
			env.EMDASH_ENCRYPTION_KEY = "another-secret";
			expect(await passwordCookieValid(m, value)).toBe(false);
			env.EMDASH_ENCRYPTION_KEY = "";
			await expect(passwordCookieHeader(m, false)).rejects.toThrow(/EMDASH_ENCRYPTION_KEY/);
		} finally {
			env.EMDASH_ENCRYPTION_KEY = secret;
		}
	});
});
