/**
 * Admin UI:
 * - an editor sidebar panel to upload revisions, restore old ones, set
 *   visibility, and read the combined revision log;
 * - an "Upload document" page, because EmDash only mounts editor panels on
 *   saved entries, so a brand-new document can't take a file from the editor.
 */

import type {
	ContentEditorPanelContext,
	ContentEditorPanelExtension,
	ContentListColumnCellContext,
	ContentListColumnExtension,
} from "@emdash-cms/admin";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { RevisionRecord, VisibilityMode } from "./store";

const API = "/_emdash/api/document-revisions";
const filesApi = (entryId: string) => `/_emdash/api/content/documents/${encodeURIComponent(entryId)}/files`;

type Revision = Omit<RevisionRecord, "key"> & { url: string | null };

interface RevisionsResponse {
	entryId: string;
	slug: string | null;
	status: string;
	visibility: { mode: VisibilityMode; hasPassword: boolean };
	lock: { userId: string; userName: string | null; expiresAt: string } | null;
	userId: string;
	canEdit: boolean;
	maxUploadBytes: number;
	permalink: string | null;
	revisions: Revision[];
	edits: Array<{ id: string; createdAt: string; authorName: string | null }>;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Above this, upload in parts: one request must stay under Cloudflare's body limit. */
const SINGLE_REQUEST_MAX = 95 * 1024 * 1024;

/**
 * Upload a file as a new revision. Large files go through R2 multipart
 * upload in parts, each retried up to three times; a failure aborts the
 * upload so no partial file is left behind.
 */
async function uploadFile(
	entryId: string,
	file: File,
	note: string,
	onProgress?: (fraction: number) => void,
): Promise<Response> {
	const contentType = file.type || "application/octet-stream";
	if (file.size <= SINGLE_REQUEST_MAX) {
		const qs = new URLSearchParams({ filename: file.name });
		if (note.trim()) qs.set("note", note.trim());
		return apiFetch(`${filesApi(entryId)}?${qs}`, {
			method: "POST",
			headers: { "Content-Type": contentType },
			body: file,
		});
	}

	const { uploadId, key, partBytes } = await parseApiResponse<{ uploadId: string; key: string; partBytes: number }>(
		await postJson(`${filesApi(entryId)}/uploads`, { contentType, size: file.size }),
		"Could not start the upload",
	);
	const base = `${filesApi(entryId)}/uploads/${encodeURIComponent(uploadId)}`;
	const keyQs = `key=${encodeURIComponent(key)}`;
	const total = Math.ceil(file.size / partBytes);
	const parts: Array<{ partNumber: number; etag: string }> = [];
	try {
		for (let i = 0; i < total; i++) {
			const blob = file.slice(i * partBytes, Math.min(file.size, (i + 1) * partBytes));
			for (let attempt = 1; ; attempt++) {
				try {
					parts.push(
						await parseApiResponse(
							await apiFetch(`${base}/parts/${i + 1}?${keyQs}`, { method: "PUT", body: blob }),
							`Part ${i + 1} failed`,
						),
					);
					break;
				} catch (cause) {
					if (attempt >= 3) throw cause;
				}
			}
			onProgress?.((i + 1) / total);
		}
		return await postJson(`${base}/complete`, { key, parts, filename: file.name, note: note.trim() });
	} catch (cause) {
		await apiFetch(`${base}?${keyQs}`, { method: "DELETE" }).catch(() => undefined);
		throw cause;
	}
}

function postJson(url: string, body: unknown) {
	return apiFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// --- Editor panel -------------------------------------------------------

function VisibilityControl({
	data,
	disabled,
	onSave,
}: {
	data: RevisionsResponse;
	disabled: boolean;
	onSave: (mode: VisibilityMode, password: string) => void;
}) {
	const [mode, setMode] = React.useState<VisibilityMode>(data.visibility.mode);
	const [password, setPassword] = React.useState("");
	React.useEffect(() => setMode(data.visibility.mode), [data.visibility.mode]);
	const dirty = mode !== data.visibility.mode || (mode === "password" && password !== "");

	return (
		<fieldset className="space-y-2" disabled={disabled}>
			<legend className="font-medium">Visibility</legend>
			{(["public", "private", "password"] as const).map((m) => (
				<label key={m} className="mr-3 inline-flex items-center gap-1">
					<input type="radio" name="edr-visibility" checked={mode === m} onChange={() => setMode(m)} />
					{m === "public" ? "Public" : m === "private" ? "Private" : "Password protected"}
				</label>
			))}
			{mode === "password" ? (
				<input
					type="password"
					className="w-full rounded border px-2 py-1"
					autoComplete="new-password"
					placeholder={data.visibility.hasPassword ? "New password (leave blank to keep)" : "Password"}
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
				/>
			) : null}
			{dirty ? (
				<button
					type="button"
					className="underline"
					onClick={() => {
						onSave(mode, password);
						setPassword("");
					}}
				>
					Save visibility
				</button>
			) : null}
			<p className="text-kumo-subtle">
				{data.status === "published"
					? mode === "private"
						? "Only editors and the author can open the file."
						: mode === "password"
							? "Visitors need the password to open the file."
							: "Anyone with the link can open the file."
					: "Drafts are only visible to signed-in contributors and up."}
			</p>
		</fieldset>
	);
}

/** Extraction state for a revision's file (see processing/). */
function TextStatus({ text }: { text?: Revision["text"] }) {
	const label =
		!text || text.status === "pending"
			? "Text: processing…"
			: text.status === "done"
				? `Text: extracted (${(text.chars ?? 0).toLocaleString()} characters${text.truncated ? ", truncated" : ""})`
				: text.status === "skipped"
					? "Text: not extracted for this file type"
					: `Text: extraction failed${text.error ? ` (${text.error})` : ""}`;
	return <div className="text-kumo-subtle">{label}</div>;
}

/**
 * Per-user revision feed link. Feed readers can't send session cookies, so
 * the URL carries a secret key; it's shown once when created.
 */
function FeedLink({ slug }: { slug: string }) {
	const [hasKey, setHasKey] = React.useState<boolean>();
	const [key, setKey] = React.useState<string>();
	const [error, setError] = React.useState<string>();

	React.useEffect(() => {
		void (async () => {
			try {
				const r = await parseApiResponse<{ hasKey: boolean }>(await apiFetch(`${API}/feed-key`));
				setHasKey(r.hasKey);
			} catch (cause) {
				setError(message(cause));
			}
		})();
	}, []);

	async function create() {
		try {
			const r = await parseApiResponse<{ key: string }>(await postJson(`${API}/feed-key`, {}), "Could not create a feed link");
			setKey(r.key);
			setHasKey(true);
		} catch (cause) {
			setError(message(cause));
		}
	}

	async function revoke() {
		try {
			await parseApiResponse(await apiFetch(`${API}/feed-key`, { method: "DELETE" }), "Could not revoke");
			setKey(undefined);
			setHasKey(false);
		} catch (cause) {
			setError(message(cause));
		}
	}

	if (hasKey === undefined && !error) return null;
	const url = key ? `${window.location.origin}/documents/${encodeURIComponent(slug)}/feed?key=${key}` : null;
	return (
		<div className="space-y-1">
			<h4 className="font-medium">Revision feed</h4>
			{url ? (
				<>
					<input className="w-full rounded border px-2 py-1" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
					<p className="text-kumo-subtle">Copy it now; it won't be shown again. The key works for every document you can read.</p>
				</>
			) : hasKey ? (
				<p className="text-kumo-subtle">You have a feed key. Create a new link to see it again (the old one stops working).</p>
			) : null}
			<div className="flex gap-3">
				<button type="button" className="underline" onClick={() => void create()}>
					{hasKey ? "New feed link" : "Get feed link"}
				</button>
				{hasKey ? (
					<button type="button" className="underline" onClick={() => void revoke()}>
						Revoke
					</button>
				) : null}
			</div>
			{error ? <p className="text-kumo-danger">{error}</p> : null}
		</div>
	);
}

type TimelineItem =
	| { kind: "file"; at: string; revision: Revision }
	| { kind: "edit"; at: string; id: string; authorName: string | null };

function DocumentRevisionsPanel({ entry }: ContentEditorPanelContext) {
	const entryId = String(entry.id);
	const [data, setData] = React.useState<RevisionsResponse>();
	const [error, setError] = React.useState<string>();
	const [busy, setBusy] = React.useState(false);
	const [progress, setProgress] = React.useState<number | null>(null);
	const [note, setNote] = React.useState("");
	const fileInput = React.useRef<HTMLInputElement>(null);

	const load = React.useCallback(async () => {
		try {
			const res = await apiFetch(filesApi(entryId));
			setData(await parseApiResponse<RevisionsResponse>(res, "Could not load revisions"));
		} catch (cause) {
			setError(message(cause));
		}
	}, [entryId]);

	React.useEffect(() => {
		void load();
	}, [load]);

	async function run(action: () => Promise<Response>, fallback: string): Promise<boolean> {
		setBusy(true);
		setError(undefined);
		try {
			await parseApiResponse(await action(), fallback);
			await load();
			return true;
		} catch (cause) {
			setError(message(cause));
			return false;
		} finally {
			setBusy(false);
		}
	}

	if (!data) return error ? <p className="text-kumo-danger">{error}</p> : <p className="text-sm">Loading…</p>;

	const lockedBy = data.lock && data.lock.userId !== data.userId ? data.lock : null;
	const canWrite = data.canEdit && !lockedBy;
	const latestN = data.revisions[0]?.n;

	const timeline: TimelineItem[] = [
		...data.revisions.map((r) => ({ kind: "file" as const, at: r.createdAt, revision: r })),
		...data.edits.map((e) => ({ kind: "edit" as const, at: e.createdAt, id: e.id, authorName: e.authorName })),
	].sort((a, b) => b.at.localeCompare(a.at));

	return (
		<div className="space-y-4 text-sm">
			{lockedBy ? (
				<p className="text-kumo-danger">
					{lockedBy.userName ?? "Another editor"} is editing this document. Uploads are paused until they
					finish.
				</p>
			) : null}

			{data.permalink ? (
				<p>
					<a className="underline" href={data.permalink} target="_blank" rel="noreferrer">
						{data.permalink}
					</a>
				</p>
			) : null}

			{data.canEdit ? (
				<div className="space-y-2">
					<input
						ref={fileInput}
						type="file"
						aria-label="Upload new version"
						disabled={busy || !canWrite}
						onChange={(e) => {
							const file = e.currentTarget.files?.[0];
							if (!file) return;
							if (file.size > data.maxUploadBytes) {
								setError(`Files are limited to ${formatSize(data.maxUploadBytes)}.`);
								return;
							}
							void run(() => uploadFile(entryId, file, note, setProgress), "Upload failed").then((done) => {
								setProgress(null);
								if (done) setNote("");
								if (fileInput.current) fileInput.current.value = "";
							});
						}}
					/>
					<input
						type="text"
						className="w-full rounded border px-2 py-1"
						placeholder="Revision note (optional)"
						value={note}
						disabled={busy || !canWrite}
						onChange={(e) => setNote(e.currentTarget.value)}
					/>
					<p className="text-kumo-subtle">Max {formatSize(data.maxUploadBytes)} per file.</p>
				</div>
			) : null}

			{data.canEdit ? (
				<VisibilityControl
					data={data}
					disabled={busy || !canWrite}
					onSave={(mode, password) =>
						void run(() => postJson(`${filesApi(entryId)}/visibility`, { mode, password }), "Could not save visibility")
					}
				/>
			) : null}

			{busy ? (
				<p className="text-kumo-subtle">
					{progress === null ? "Working…" : `Uploading… ${Math.round(progress * 100)}%`}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-kumo-danger">
					{error}
				</p>
			) : null}

			{data.slug ? <FeedLink slug={data.slug} /> : null}

			<div>
				<h4 className="font-medium">Revision log</h4>
				{timeline.length === 0 ? <p className="text-kumo-subtle">No files yet.</p> : null}
				<ol className="space-y-2">
					{timeline.map((item) =>
						item.kind === "file" ? (
							<li key={`f${item.revision.n}`}>
								<div>
									{item.revision.url ? (
										<a className="underline" href={item.revision.url} target="_blank" rel="noreferrer">
											#{item.revision.n} {item.revision.filename}
										</a>
									) : (
										<span>
											#{item.revision.n} {item.revision.filename}
										</span>
									)}{" "}
									<span className="text-kumo-subtle">({formatSize(item.revision.size)})</span>
									{item.revision.n === latestN ? <span className="text-kumo-subtle"> · current</span> : null}
								</div>
								<div className="text-kumo-subtle">
									{item.revision.authorName ?? item.revision.authorId} ·{" "}
									{new Date(item.revision.createdAt).toLocaleString()}
								</div>
								{item.revision.note ? <div>{item.revision.note}</div> : null}
								<TextStatus text={item.revision.text} />
								{canWrite && item.revision.n !== latestN ? (
									<button
										type="button"
										className="underline"
										disabled={busy}
										onClick={() =>
											void run(
												() => postJson(`${filesApi(entryId)}/restore`, { n: item.revision.n }),
												"Could not restore",
											)
										}
									>
										Restore
									</button>
								) : null}
							</li>
						) : (
							<li key={`e${item.id}`} className="text-kumo-subtle">
								Details saved by {item.authorName ?? "unknown"} · {new Date(item.at).toLocaleString()}
							</li>
						),
					)}
				</ol>
			</div>
		</div>
	);
}

export const contentEditorPanels = [
	{
		id: "document-revisions",
		title: "Document revisions",
		component: DocumentRevisionsPanel,
		collections: ["documents"],
		order: 1,
	},
] satisfies readonly ContentEditorPanelExtension[];

// --- Content-list columns -------------------------------------------------

interface ColumnData {
	visibility: VisibilityMode;
	revisions?: number;
	type?: string | null;
	size?: number | null;
	editingBy?: string | null;
}

/**
 * One request per visible page of rows, shared by every cell: the cache is
 * keyed by the sorted IDs, so N cells make one call.
 */
const columnCache = new Map<string, Promise<Record<string, ColumnData>>>();
function loadColumns(ids: string[]): Promise<Record<string, ColumnData>> {
	const cacheKey = [...ids].sort().join(",");
	let pending = columnCache.get(cacheKey);
	if (!pending) {
		pending = apiFetch(`${API}/columns?ids=${encodeURIComponent(cacheKey)}`)
			.then((res) => parseApiResponse<Record<string, ColumnData>>(res))
			.catch(() => ({}));
		columnCache.set(cacheKey, pending);
		// Short-lived: lists re-render after edits, and locks change.
		setTimeout(() => columnCache.delete(cacheKey), 15_000);
	}
	return pending;
}

function useColumn({ item, visibleItems }: ContentListColumnCellContext): ColumnData | undefined {
	const [row, setRow] = React.useState<ColumnData>();
	const ids = visibleItems.map((i) => String(i.id));
	const id = String(item.id);
	React.useEffect(() => {
		let live = true;
		void loadColumns(ids).then((all) => live && setRow(all[id]));
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id, ids.join(",")]);
	return row;
}

function FileCell(ctx: ContentListColumnCellContext) {
	const row = useColumn(ctx);
	if (!row) return <span className="text-kumo-subtle">…</span>;
	if (!row.revisions) return <span className="text-kumo-subtle">No file</span>;
	return (
		<span>
			{(row.type ?? "file").toUpperCase()} · {formatSize(row.size ?? 0)}
			{row.revisions > 1 ? <span className="text-kumo-subtle"> · {row.revisions} revisions</span> : null}
		</span>
	);
}

function AccessCell(ctx: ContentListColumnCellContext) {
	const row = useColumn(ctx);
	if (!row) return <span className="text-kumo-subtle">…</span>;
	const label = row.visibility === "password" ? "Password" : row.visibility === "private" ? "Private" : "Public";
	return (
		<span>
			{label}
			{row.editingBy ? <span className="text-kumo-danger"> · {row.editingBy} editing</span> : null}
		</span>
	);
}

export const contentListColumns = [
	{ id: "document-file", label: "File", cell: FileCell, collections: ["documents"], order: 10 },
	{ id: "document-access", label: "Access", cell: AccessCell, collections: ["documents"], order: 11 },
] satisfies readonly ContentListColumnExtension[];

// --- Upload document page -----------------------------------------------

function NewDocumentPage() {
	const [canCreate, setCanCreate] = React.useState<boolean>();
	const [maxUploadBytes, setMaxUploadBytes] = React.useState<number>();
	const [title, setTitle] = React.useState("");
	const [note, setNote] = React.useState("");
	const [file, setFile] = React.useState<File | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string>();

	React.useEffect(() => {
		void (async () => {
			try {
				const me = await parseApiResponse<{ canCreate: boolean; maxUploadBytes: number }>(
					await apiFetch(`${API}/me`),
				);
				setCanCreate(me.canCreate);
				setMaxUploadBytes(me.maxUploadBytes);
			} catch (cause) {
				setError(message(cause));
			}
		})();
	}, []);

	async function submit(e: React.SyntheticEvent) {
		e.preventDefault();
		if (!file) return;
		// Check before creating the entry, so an oversized file doesn't leave an
		// empty document behind.
		if (maxUploadBytes && file.size > maxUploadBytes) {
			setError(`Files are limited to ${formatSize(maxUploadBytes)}.`);
			return;
		}
		setBusy(true);
		setError(undefined);
		let entryId: string | null = null;
		try {
			const created = await parseApiResponse<{ item: { id: string } }>(
				await apiFetch("/_emdash/api/content/documents", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ data: { title: title.trim() || file.name.replace(/\.[^.]+$/, "") } }),
				}),
				"Could not create the document",
			);
			entryId = created.item.id;
			await parseApiResponse(await uploadFile(entryId, file, note), "Upload failed");
			window.location.assign(`/_emdash/admin/content/documents/${encodeURIComponent(entryId)}`);
		} catch (cause) {
			// Don't leave an empty document behind when the upload fails.
			if (entryId) {
				await apiFetch(`/_emdash/api/content/documents/${encodeURIComponent(entryId)}`, {
					method: "DELETE",
				}).catch(() => undefined);
			}
			setError(message(cause));
			setBusy(false);
		}
	}

	if (canCreate === false) {
		return (
			<section className="space-y-4">
				<h1 className="text-2xl font-semibold">Upload document</h1>
				<p>Uploading documents requires the Author role or higher.</p>
			</section>
		);
	}

	return (
		<section className="max-w-xl space-y-4">
			<h1 className="text-2xl font-semibold">Upload document</h1>
			<form className="space-y-3" onSubmit={(e) => void submit(e)}>
				<label className="block">
					<span className="block font-medium">File</span>
					<input type="file" required disabled={busy} onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
				</label>
				<label className="block">
					<span className="block font-medium">Title</span>
					<input
						type="text"
						className="w-full rounded border px-2 py-1"
						placeholder={file ? file.name.replace(/\.[^.]+$/, "") : "Defaults to the file name"}
						value={title}
						disabled={busy}
						onChange={(e) => setTitle(e.currentTarget.value)}
					/>
				</label>
				<label className="block">
					<span className="block font-medium">Revision note</span>
					<input
						type="text"
						className="w-full rounded border px-2 py-1"
						value={note}
						disabled={busy}
						onChange={(e) => setNote(e.currentTarget.value)}
					/>
				</label>
				<button type="submit" className="rounded border px-3 py-1" disabled={busy || !file || canCreate !== true}>
					{busy ? "Uploading…" : "Upload"}
				</button>
				{error ? (
					<p role="alert" className="text-kumo-danger">
						{error}
					</p>
				) : null}
				<p className="text-kumo-subtle">
					Creates a draft document with this file as revision 1, then opens it in the editor.
				</p>
			</form>
		</section>
	);
}

// --- Document storage page ---------------------------------------------

interface StorageStats {
	documents: number;
	orphans: number;
	objects: number;
	bytes: number;
	purgeAllConfirmation: string;
}

/**
 * EmDash never runs `plugin:uninstall` for native plugins, so this page is
 * how an administrator cleans up: delete files left behind by documents
 * deleted while the plugin was off, or delete everything before removing it.
 */
function StoragePage() {
	const [stats, setStats] = React.useState<StorageStats>();
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [busy, setBusy] = React.useState(false);
	const [confirm, setConfirm] = React.useState("");
	const [defaultVisibility, setDefaultVisibility] = React.useState<"public" | "private">();

	const load = React.useCallback(async () => {
		try {
			const settings = await parseApiResponse<{ defaultVisibility: "public" | "private" }>(
				await apiFetch(`${API}/settings`),
			);
			setDefaultVisibility(settings.defaultVisibility);
			setStats(await parseApiResponse<StorageStats>(await apiFetch(`${API}/storage`), "Could not load storage"));
		} catch (cause) {
			setError(message(cause));
		}
	}, []);

	React.useEffect(() => {
		void load();
	}, [load]);

	async function purge(action: "purge-orphans" | "purge-all", body: unknown) {
		setBusy(true);
		setError(undefined);
		setNotice(undefined);
		try {
			const res = await parseApiResponse<{ objects: number }>(
				await postJson(`${API}/${action}`, body),
				"Could not delete files",
			);
			setNotice(`Deleted ${res.objects} stored objects.`);
			setConfirm("");
			await load();
		} catch (cause) {
			setError(message(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="max-w-xl space-y-4">
			<h1 className="text-2xl font-semibold">Document settings</h1>
			{defaultVisibility ? (
				<label className="block space-y-1">
					<span className="block font-medium">New documents are</span>
					<select
						className="rounded border px-2 py-1"
						value={defaultVisibility}
						disabled={busy}
						onChange={async (e) => {
							const value = e.currentTarget.value as "public" | "private";
							setDefaultVisibility(value);
							try {
								await parseApiResponse(await postJson(`${API}/settings`, { defaultVisibility: value }), "Could not save");
								setNotice("Saved.");
							} catch (cause) {
								setError(message(cause));
							}
						}}
					>
						<option value="private">Private (editors and the author only)</option>
						<option value="public">Public once published</option>
					</select>
					<span className="block text-kumo-subtle">
						WP Document Revisions makes new documents private by default. Each document can change it in its
						panel.
					</span>
				</label>
			) : null}
			<h2 className="text-lg font-semibold">Storage</h2>
			{stats ? (
				<p>
					{stats.documents} documents with files, {stats.objects} stored objects ({formatSize(stats.bytes)}).
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-kumo-danger">
					{error}
				</p>
			) : null}
			{notice ? <p>{notice}</p> : null}

			{stats ? (
				<div className="space-y-2">
					<h2 className="text-lg font-semibold">Orphaned files</h2>
					<p className="text-kumo-subtle">
						Files whose document no longer exists, for example because it was deleted while this plugin was
						turned off.
					</p>
					<button
						type="button"
						className="rounded border px-3 py-1"
						disabled={busy || stats.orphans === 0}
						onClick={() => void purge("purge-orphans", {})}
					>
						{stats.orphans === 0 ? "No orphaned files" : `Delete files of ${stats.orphans} deleted documents`}
					</button>
				</div>
			) : null}

			{stats ? (
				<div className="space-y-2">
					<h2 className="text-lg font-semibold">Delete all document files</h2>
					<p className="text-kumo-subtle">
						Removes every stored file and revision log, for example before removing this plugin. Documents stay
						in EmDash but lose their files. This can't be undone. Type{" "}
						<strong>{stats.purgeAllConfirmation}</strong> to confirm.
					</p>
					<input
						type="text"
						className="w-full rounded border px-2 py-1"
						aria-label="Confirmation"
						value={confirm}
						disabled={busy}
						onChange={(e) => setConfirm(e.currentTarget.value)}
					/>
					<button
						type="button"
						className="rounded border px-3 py-1 text-kumo-danger"
						disabled={busy || confirm !== stats.purgeAllConfirmation}
						onClick={() => void purge("purge-all", { confirm })}
					>
						Delete all document files
					</button>
				</div>
			) : null}
		</section>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/new": NewDocumentPage,
	"/storage": StoragePage,
};
