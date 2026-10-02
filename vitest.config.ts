import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Three projects:
 * - unit:        plugin modules in the Workers runtime (workerd), with a local
 *                R2 bucket bound as DOCUMENTS. Fast; no dev server.
 * - integration: HTTP tests against a real `astro dev` of the demo site,
 *                started by the project's globalSetup on port 4330.
 * - import:      the WordPress importer end to end (WordPress Playground,
 *                needs network). Not part of `pnpm test`; run `pnpm test:import`.
 */
export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						miniflare: {
							compatibilityDate: "2026-02-24",
							compatibilityFlags: ["nodejs_compat"],
							r2Buckets: ["DOCUMENTS"],
							bindings: {
								// Signs password cookies (access.ts). Test-only value.
								EMDASH_ENCRYPTION_KEY: "unit-test-cookie-secret",
							},
						},
					}),
				],
				resolve: {
					// Astro's virtual module, for the search middleware.
					alias: { "astro:middleware": new URL("tests/unit/shims/astro-middleware.ts", import.meta.url).pathname },
				},
				test: {
					name: "unit",
					include: ["tests/unit/**/*.test.ts"],
				},
			},
			{
				test: {
					name: "integration",
					environment: "node",
					include: ["tests/integration/**/*.test.ts"],
					globalSetup: ["tests/integration/global-setup.ts"],
					// One dev server, and several files change site-wide state
					// (edit locking, the lock table, default visibility, feed keys).
					fileParallelism: false,
					testTimeout: 120_000,
					hookTimeout: 180_000,
				},
			},
			{
				test: {
					name: "import",
					environment: "node",
					include: ["tests/import/**/*.test.ts"],
					globalSetup: ["tests/import/global-setup.ts"],
					fileParallelism: false,
					testTimeout: 120_000,
					hookTimeout: 600_000,
				},
			},
		],
	},
});
