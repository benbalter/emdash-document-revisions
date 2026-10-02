/**
 * Admin UI:
 * - an editor sidebar panel to upload revisions, restore old ones, set
 *   visibility, and read the combined revision log;
 * - an "Upload document" page, because EmDash only mounts editor panels on
 *   saved entries, so a brand-new document can't take a file from the editor.
 */

import type { ContentEditorPanelContext, ContentEditorPanelExtension } from "@emdash-cms/admin";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { RevisionRecord, VisibilityMode } from "./store";

const API = "/_emdash/api/document-revisions";

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

function uploadFile(entryId: string, file: File, note: string) {
	const qs = new URLSearchParams({ entryId, filename: file.name });
	if (note.trim()) qs.set("note", note.trim());
	return apiFetch(`${API}/upload?${qs}`, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
}

function postJson(path: string, body: unknown) {
	return apiFetch(`${API}/${path}`, {
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

type TimelineItem =
	| { kind: "file"; at: string; revision: Revision }
	| { kind: "edit"; at: string; id: string; authorName: string | null };

function DocumentRevisionsPanel({ entry }: ContentEditorPanelContext) {
	const entryId = String(entry.id);
	const [data, setData] = React.useState<RevisionsResponse>();
	const [error, setError] = React.useState<string>();
	const [busy, setBusy] = React.useState(false);
	const [note, setNote] = React.useState("");
	const fileInput = React.useRef<HTMLInputElement>(null);

	const load = React.useCallback(async () => {
		try {
			const res = await apiFetch(`${API}/revisions?entryId=${encodeURIComponent(entryId)}`);
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
							void run(() => uploadFile(entryId, file, note), "Upload failed").then((done) => {
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
						void run(() => postJson("visibility", { entryId, mode, password }), "Could not save visibility")
					}
				/>
			) : null}

			{busy ? <p className="text-kumo-subtle">Working…</p> : null}
			{error ? (
				<p role="alert" className="text-kumo-danger">
					{error}
				</p>
			) : null}

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
								{canWrite && item.revision.n !== latestN ? (
									<button
										type="button"
										className="underline"
										disabled={busy}
										onClick={() =>
											void run(
												() => postJson("restore", { entryId, n: item.revision.n }),
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

// --- Upload document page -----------------------------------------------

function NewDocumentPage() {
	const [canCreate, setCanCreate] = React.useState<boolean>();
	const [title, setTitle] = React.useState("");
	const [note, setNote] = React.useState("");
	const [file, setFile] = React.useState<File | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string>();

	React.useEffect(() => {
		void (async () => {
			try {
				const me = await parseApiResponse<{ canCreate: boolean }>(await apiFetch(`${API}/me`));
				setCanCreate(me.canCreate);
			} catch (cause) {
				setError(message(cause));
			}
		})();
	}, []);

	async function submit(e: React.SyntheticEvent) {
		e.preventDefault();
		if (!file) return;
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

export const pages: PluginAdminExports["pages"] = {
	"/new": NewDocumentPage,
};
