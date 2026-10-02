/**
 * Editor sidebar panel: upload a new revision, check the document out or
 * in, and list past revisions. EmDash only mounts panels on saved entries,
 * so a new document has to be saved once before a file can be attached.
 */

import type { ContentEditorPanelContext, ContentEditorPanelExtension } from "@emdash-cms/admin";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { DocumentLock, RevisionRecord } from "./store";

type Revision = Omit<RevisionRecord, "key">;

const API = "/_emdash/api/plugins/document-revisions";

interface RevisionsResponse {
	revisions: Revision[];
	lock: DocumentLock | null;
	userId: string | null;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function DocumentRevisionsPanel({ entry }: ContentEditorPanelContext) {
	const entryId = String(entry.id);
	const slug = entry.slug ? String(entry.slug) : null;
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
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [entryId]);

	React.useEffect(() => {
		void load();
	}, [load]);

	async function run(action: () => Promise<Response>, fallback: string) {
		setBusy(true);
		setError(undefined);
		try {
			await parseApiResponse(await action(), fallback);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	function upload(file: File) {
		const qs = new URLSearchParams({ entryId, filename: file.name });
		if (note.trim()) qs.set("note", note.trim());
		void run(
			() =>
				apiFetch(`${API}/upload?${qs}`, {
					method: "POST",
					headers: { "Content-Type": file.type || "application/octet-stream" },
					body: file,
				}),
			"Upload failed",
		).then(() => {
			setNote("");
			if (fileInput.current) fileInput.current.value = "";
		});
	}

	function setLock(action: "acquire" | "release") {
		void run(
			() =>
				apiFetch(`${API}/lock`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ entryId, action }),
				}),
			"Could not change checkout",
		);
	}

	const lock = data?.lock;
	const lockedByOther = Boolean(lock && lock.userId !== data?.userId);

	return (
		<div className="space-y-3 text-sm">
			{lock ? (
				<p className={lockedByOther ? "text-kumo-danger" : "text-kumo-subtle"}>
					Checked out by {lockedByOther ? (lock.userName ?? "another user") : "you"} until{" "}
					{new Date(lock.expiresAt).toLocaleTimeString()}
				</p>
			) : null}

			<div className="space-y-2">
				<input
					ref={fileInput}
					type="file"
					disabled={busy || lockedByOther}
					onChange={(e) => {
						const file = e.currentTarget.files?.[0];
						if (file) upload(file);
					}}
				/>
				<input
					type="text"
					className="w-full rounded border px-2 py-1"
					placeholder="Revision note (optional)"
					value={note}
					disabled={busy || lockedByOther}
					onChange={(e) => setNote(e.currentTarget.value)}
				/>
				<p className="text-kumo-subtle">Max 8 MB per upload.</p>
			</div>

			<div className="flex gap-2">
				{lock && !lockedByOther ? (
					<button type="button" className="underline" disabled={busy} onClick={() => setLock("release")}>
						Check in
					</button>
				) : (
					<button type="button" className="underline" disabled={busy} onClick={() => setLock("acquire")}>
						Check out
					</button>
				)}
			</div>

			{error ? (
				<p role="alert" className="text-kumo-danger">
					{error}
				</p>
			) : null}

			{data && data.revisions.length === 0 ? <p className="text-kumo-subtle">No files yet.</p> : null}
			{data && data.revisions.length > 0 ? (
				<ol className="space-y-2">
					{data.revisions.map((r) => (
						<li key={r.n}>
							<div>
								{slug ? (
									<a className="underline" href={`/documents/${slug}/revisions/${r.n}`} target="_blank" rel="noreferrer">
										#{r.n} {r.filename}
									</a>
								) : (
									<span>
										#{r.n} {r.filename}
									</span>
								)}{" "}
								<span className="text-kumo-subtle">({formatSize(r.size)})</span>
							</div>
							<div className="text-kumo-subtle">
								{r.authorName ?? r.authorId} · {new Date(r.createdAt).toLocaleString()}
							</div>
							{r.note ? <div>{r.note}</div> : null}
						</li>
					))}
				</ol>
			) : null}
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
