/**
 * Post-upload processing: turn each stored file into text once, so search,
 * diffs, AI summaries and agents can use it.
 *
 * Producers (upload, multipart complete, restore, import) enqueue a job on
 * the DOC_JOBS queue; the consumer (../worker.ts) runs the first processor
 * that accepts the file. Text is keyed by the file's storage key, so
 * revisions that share a file (restores, WordPress note-only revisions)
 * share one extraction.
 *
 * Processors:
 * - text:        plain-text formats, stored as-is. Works everywhere.
 * - ai-markdown: Workers AI toMarkdown (PDF, Office, images with OCR and
 *                captions, HTML). Only when the site binds `AI`.
 */

import { aiMarkdownProcessor } from "./ai-markdown";
import { textProcessor } from "./text";

export interface Job {
	entryId: string;
	n: number;
	key: string;
	contentType: string;
	filename: string;
}

export interface ProcessorEnv {
	AI?: { toMarkdown: (doc: { name: string; blob: Blob }) => Promise<unknown> };
}

export interface Processor {
	name: string;
	accepts(job: Job, env: ProcessorEnv): boolean;
	/**
	 * Memory bounds (a Worker has ~128 MB). Files over `maxBytes` are
	 * skipped; with `readBytes`, only that much is read and the text is
	 * marked truncated instead.
	 */
	maxBytes?: number;
	readBytes?: number;
	/** Returns the extracted text. Throws to fail the job (it is retried). */
	run(file: R2ObjectBody, job: Job, env: ProcessorEnv): Promise<string>;
}

/** Order matters: the cheap exact path first. */
export const processors: Processor[] = [textProcessor, aiMarkdownProcessor];

/** Extracted text above this is truncated; it's for search and diffs, not archiving. */
export const MAX_TEXT_CHARS = 2_000_000;

export type TextStatus = "pending" | "done" | "skipped" | "error";

export interface TextInfo {
	status: TextStatus;
	processor?: string;
	chars?: number;
	truncated?: boolean;
	error?: string;
	updatedAt: string;
}

/** Where a file's extracted text lives. One per stored file, not per revision. */
export function textKey(entryId: string, fileKey: string): string {
	const fileId = fileKey.split("/").pop() ?? fileKey;
	return `entries/${entryId}/text/${fileId}.md`;
}

/** Enqueue a processing job if the site binds DOC_JOBS; a no-op otherwise. */
export async function enqueue(job: Job): Promise<boolean> {
	const { env } = await import("cloudflare:workers");
	const queue = (env as Record<string, unknown>).DOC_JOBS as Queue<Job> | undefined;
	if (!queue) return false;
	await queue.send(job);
	return true;
}
