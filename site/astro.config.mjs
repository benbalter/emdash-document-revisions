import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { documentRevisions, documentRevisionsRoutes } from "emdash-document-revisions";

export default defineConfig({
	output: "server",
	// The integration tests run their own dev server with its own local state
	// (D1, R2, queues), so `pnpm test` never touches the data under
	// .wrangler/ that `pnpm dev` uses.
	adapter: cloudflare(
		process.env.EDR_STATE_DIR ? { persistState: { path: process.env.EDR_STATE_DIR } } : {},
	),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [documentRevisions()],
		}),
		documentRevisionsRoutes(),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
