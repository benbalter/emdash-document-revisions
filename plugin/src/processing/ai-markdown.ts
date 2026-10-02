import type { Processor } from "./index";

/**
 * Workers AI Markdown Conversion handles PDF, Office documents, spreadsheets,
 * HTML and images (OCR plus a generated description) in one call, which
 * replaces WP Document Revisions' separate PDF/DOCX/ODT extractors.
 *
 * Registered only when the site binds `AI`; local dev without a remote
 * Workers AI binding marks these files "skipped".
 * https://developers.cloudflare.com/workers-ai/features/markdown-conversion/
 */
export const aiMarkdownProcessor: Processor = {
	name: "ai-markdown",
	accepts: (_job, env) => typeof env.AI?.toMarkdown === "function",
	run: async (file, job, env) => {
		const result = (await env.AI!.toMarkdown({
			name: job.filename,
			blob: new Blob([await file.arrayBuffer()], { type: job.contentType }),
		})) as { format?: string; data?: string; error?: string };
		if (result.format === "error" || typeof result.data !== "string") {
			throw new Error(result.error ?? "Markdown conversion failed");
		}
		return result.data;
	},
};
