/**
 * Queue consumer for document processing. Wire it into the site's Worker
 * entry next to EmDash's handlers:
 *
 *   import { documentRevisionsQueue } from "emdash-document-revisions/worker";
 *   export default { ...handler, scheduled: createScheduledHandler(), queue: documentRevisionsQueue };
 *
 * and bind the queue in wrangler.jsonc (producer DOC_JOBS + consumer).
 */

import { MAX_TEXT_CHARS, processors, textKey, type Job, type ProcessorEnv, type TextInfo } from "./processing";
import { bucket, readManifest, updateManifest } from "./store";

async function setText(entryId: string, fileKey: string, text: TextInfo) {
	const b = await bucket();
	const { manifest } = await readManifest(b, entryId);
	if (!manifest) return; // Document deleted meanwhile.
	await updateManifest(b, entryId, manifest.slug, (m) => ({
		...m,
		// Every revision that shares this file shares its text.
		revisions: m.revisions.map((r) => (r.key === fileKey ? { ...r, text } : r)),
	}));
}

export async function processJob(job: Job, env: ProcessorEnv): Promise<TextInfo> {
	const b = await bucket();
	const { manifest } = await readManifest(b, job.entryId);
	const existing = manifest?.revisions.find((r) => r.key === job.key)?.text;
	if (!manifest || !manifest.revisions.some((r) => r.key === job.key)) {
		return { status: "skipped", error: "File no longer in the revision log", updatedAt: new Date().toISOString() };
	}
	if (existing?.status === "done") return existing;

	const skip = async (error?: string) => {
		const info: TextInfo = { status: "skipped", ...(error ? { error } : {}), updatedAt: new Date().toISOString() };
		await setText(job.entryId, job.key, info);
		return info;
	};
	const processor = processors.find((p) => p.accepts(job, env));
	if (!processor) return skip();

	// Size first, so a multi-gigabyte upload never gets read into memory.
	const head = await b.head(job.key);
	if (!head) throw new Error(`File ${job.key} is missing`);
	if (processor.maxBytes && head.size > processor.maxBytes) {
		return skip(`Too large to extract (${Math.round(head.size / 1048576)} MB)`);
	}
	const partial = Boolean(processor.readBytes && head.size > processor.readBytes);
	const file = await b.get(job.key, partial ? { range: { offset: 0, length: processor.readBytes! } } : undefined);
	if (!file) throw new Error(`File ${job.key} is missing`);
	let text = await processor.run(file, job, env);
	const truncated = partial || text.length > MAX_TEXT_CHARS;
	if (truncated) text = text.slice(0, MAX_TEXT_CHARS);
	await b.put(textKey(job.entryId, job.key), text, {
		httpMetadata: { contentType: "text/markdown; charset=utf-8" },
	});
	const info: TextInfo = {
		status: "done",
		processor: processor.name,
		chars: text.length,
		...(truncated ? { truncated } : {}),
		updatedAt: new Date().toISOString(),
	};
	await setText(job.entryId, job.key, info);
	return info;
}

const MAX_ATTEMPTS = 3;

export async function documentRevisionsQueue(batch: MessageBatch<Job>, env: ProcessorEnv): Promise<void> {
	for (const message of batch.messages) {
		try {
			await processJob(message.body, env);
			message.ack();
		} catch (e) {
			if (message.attempts >= MAX_ATTEMPTS) {
				console.error("[document-revisions] processing failed", message.body, e);
				await setText(message.body.entryId, message.body.key, {
					status: "error",
					error: e instanceof Error ? e.message.slice(0, 300) : String(e),
					updatedAt: new Date().toISOString(),
				}).catch(() => undefined);
				message.ack();
			} else {
				message.retry({ delaySeconds: 10 * message.attempts });
			}
		}
	}
}
