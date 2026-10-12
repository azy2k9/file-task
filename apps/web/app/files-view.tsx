"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { FileAttachment, WorkspaceFile } from "@api/files";
import type { WorkspaceItem } from "@api/items";

type Dialog =
  | { type: "link" }
  | { type: "attach"; file: WorkspaceFile }
  | { type: "delete"; file: WorkspaceFile }
  | { type: "remove"; file: WorkspaceFile; attachment: FileAttachment }
  | null;

async function responseError(response: Response, fallback: string) {
  try {
    const result: unknown = await response.json();
    if (result && typeof result === "object" && "error" in result && typeof result.error === "string") return result.error;
  } catch { /* Keep the local message when the response has no JSON body. */ }
  return fallback;
}

function formatSize(size: number | null) {
  if (size === null) return "External link";
  if (size < 1_000_000) return `${Math.max(1, Math.round(size / 1_000))} KB`;
  return `${(size / 1_000_000).toFixed(size < 10_000_000 ? 1 : 0)} MB`;
}

export default function FilesView({
  items,
  focusFileId,
  onOpenItem,
  onItemsChanged,
  onCountChange,
}: {
  items: WorkspaceItem[];
  focusFileId: string | null;
  onOpenItem: (itemId: string) => void;
  onItemsChanged: () => void;
  onCountChange: (count: number) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [linkName, setLinkName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedScope, setSelectedScope] = useState<"occurrence" | "following" | "series">("occurrence");
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadFiles() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/files", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "Could not load your Files."));
      const result = await response.json() as { files: WorkspaceFile[] };
      setFiles(result.files);
      onCountChange(result.files.length);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your Files.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadFiles(); }, []);

  useEffect(() => {
    if (!focusFileId) return;
    document.getElementById(`file-${focusFileId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusFileId, files]);

  async function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    let uploadId: string | undefined;
    try {
      const begin = await fetch("/api/files/uploads", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size }),
      });
      if (!begin.ok) throw new Error(await responseError(begin, "Could not prepare this upload."));
      const target = await begin.json() as { uploadId: string; uploadUrl: string };
      uploadId = target.uploadId;
      const uploaded = await fetch(target.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!uploaded.ok) throw new Error("The File could not be uploaded. Check the connection and try again.");
      const completed = await fetch(`/api/files/${encodeURIComponent(uploadId)}/complete`, { method: "POST", credentials: "same-origin" });
      if (!completed.ok) throw new Error(await responseError(completed, "The upload could not be verified."));
      await loadFiles();
      onItemsChanged();
    } catch (reason) {
      if (uploadId) void fetch(`/api/files/${encodeURIComponent(uploadId)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
      setError(reason instanceof Error ? reason.message : "The File could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  async function addLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/files", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: linkName, url: linkUrl }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not save this link."));
      setLinkName("");
      setLinkUrl("");
      setDialog(null);
      await loadFiles();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this link.");
    } finally {
      setBusy(false);
    }
  }

  async function attach(file: WorkspaceFile, itemId: string) {
    await mutateFile(
      () => fetch(`/api/files/${encodeURIComponent(file.id)}/attachments`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, scope: selectedScope }),
      }),
      "Could not add this Attachment.",
    );
  }

  async function removeAttachment(file: WorkspaceFile, attachment: FileAttachment) {
    await mutateFile(
      () => fetch(`/api/files/${encodeURIComponent(file.id)}/attachments/${encodeURIComponent(attachment.itemId)}?scope=${attachment.scope}`, {
        method: "DELETE", credentials: "same-origin",
      }),
      "Could not remove this Attachment.",
    );
  }

  async function deleteFile(file: WorkspaceFile) {
    await mutateFile(
      () => fetch(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE", credentials: "same-origin" }),
      "Could not delete this File.",
    );
  }

  async function mutateFile(request: () => Promise<Response>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) throw new Error(await responseError(response, fallback));
      setDialog(null);
      await loadFiles();
      onItemsChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function openFile(file: WorkspaceFile) {
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setError("Allow pop-ups to open this File in a new tab.");
      return;
    }
    tab.opener = null;
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/open`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "Could not open this File."));
      const result = await response.json() as { url: string };
      tab.location.replace(result.url);
    } catch (reason) {
      tab.close();
      setError(reason instanceof Error ? reason.message : "Could not open this File.");
    }
  }

  const availableItems = dialog?.type === "attach"
    ? items.filter((item) => !item.files.some((attached) => attached.id === dialog.file.id))
    : [];

  return (
    <section className="files-section" aria-label="Files">
      <div className="files-toolbar">
        <div>
          <h2>Your Files</h2>
          <p>Keep documents and links beside the Tasks and Events they belong to.</p>
        </div>
        <div className="files-toolbar-actions">
          <input ref={fileInput} className="visually-hidden" type="file" onChange={uploadFile} aria-label="Choose a File to upload" />
          <button className="refresh-button" type="button" disabled={loading || busy} onClick={() => void loadFiles()} aria-label="Refresh Files">Refresh</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => setDialog({ type: "link" })}>Add a link</button>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
            <span className="plus-icon" aria-hidden="true">+</span> Upload File
          </button>
        </div>
      </div>
      {error && <div className="notice notice-error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss message" onClick={() => setError(null)}>×</button></div>}
      {loading && files.length === 0 ? <div className="list-loading" role="status"><span className="loading-mark" />Loading your Files…</div> : files.length === 0 ? (
        <div className="files-empty">
          <span className="file-empty-icon" aria-hidden="true">▤</span>
          <h2>Your Files have a home here.</h2>
          <p>Upload a document or add a link, then attach it to any Task or Event.</p>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Upload your first File</button>
        </div>
      ) : (
        <div className="files-list">
          {files.map((file) => (
            <article className={`file-card${focusFileId === file.id ? " file-card-focused" : ""}`} id={`file-${file.id}`} key={file.id}>
              <div className="file-card-main">
                <span className={`file-type-icon ${file.sourceType === "link" ? "file-type-link" : ""}`} aria-hidden="true">{file.sourceType === "link" ? "↗" : "▤"}</span>
                <div className="file-card-copy">
                  <h3>{file.name}</h3>
                  <p>{formatSize(file.sizeBytes)}{file.contentType ? ` · ${file.contentType}` : ""}</p>
                </div>
                <div className="file-card-actions">
                  <button className="button button-secondary button-small" type="button" disabled={busy} onClick={() => void openFile(file)}>Open</button>
                  <button className="button button-secondary button-small" type="button" disabled={busy || items.every((item) => item.files.some((attached) => attached.id === file.id))} onClick={() => { setSelectedItemId(""); setSelectedScope("occurrence"); setDialog({ type: "attach", file }); }}>Attach</button>
                  <button className="icon-button icon-button-delete" type="button" aria-label={`Delete File ${file.name}`} title="Delete File" disabled={busy} onClick={() => setDialog({ type: "delete", file })}>×</button>
                </div>
              </div>
              <div className="file-attachments">
                <span className="file-attachments-label">Attached to</span>
                {file.attachments.length === 0 ? <span className="file-unattached">No Tasks or Events yet</span> : file.attachments.map((attachment) => (
                  <span className="file-attachment" key={attachment.itemId}>
                    <button className="text-link" type="button" onClick={() => onOpenItem(attachment.itemId)}>{attachment.itemKind === "task" ? "Task" : "Event"}: {attachment.itemTitle}</button>
                    <button className="attachment-remove" type="button" aria-label={`Remove Attachment from ${attachment.itemTitle}`} disabled={busy} onClick={() => setDialog({ type: "remove", file, attachment })}>×</button>
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}

      {dialog && <div className="files-dialog-scrim">
        <section className="files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title">
          {dialog.type === "link" ? <form onSubmit={addLink}>
            <p className="eyebrow">FILES SECTION</p><h2 id="files-dialog-title">Add an external link</h2>
            <label className="field-label" htmlFor="link-name">Name</label>
            <input id="link-name" className="text-input" value={linkName} onChange={(event) => setLinkName(event.target.value)} maxLength={200} required />
            <label className="field-label field-label-spaced" htmlFor="link-url">Web link</label>
            <input id="link-url" className="text-input" type="url" placeholder="https://…" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} maxLength={2048} required />
            <div className="files-dialog-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Add link"}</button></div>
          </form> : dialog.type === "attach" ? <>
            <p className="eyebrow">FILES SECTION</p><h2 id="files-dialog-title">Attach {dialog.file.name}</h2>
            {availableItems.length === 0 ? <p>Every Task and Event already has this File attached.</p> : <>
              <label className="field-label" htmlFor="attach-item">Choose a Task or Event</label>
              <select id="attach-item" className="text-input" value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)}>
                <option value="">Choose an item</option>
                {availableItems.map((item) => <option key={item.id} value={item.id}>{item.kind === "task" ? "Task" : "Event"}: {item.title}{item.seriesId && item.scheduledDate ? ` · ${item.scheduledDate}` : ""}</option>)}
              </select>
              {items.find((item) => item.id === selectedItemId)?.seriesId && <>
                <label className="field-label field-label-spaced" htmlFor="attach-scope">Attach to</label>
                <select id="attach-scope" className="text-input" value={selectedScope} onChange={(event) => setSelectedScope(event.target.value as "occurrence" | "following" | "series")}>
                  <option value="occurrence">This Occurrence</option><option value="following">This and following Occurrences</option><option value="series">Whole series</option>
                </select>
              </>}
            </>}
            <div className="files-dialog-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setDialog(null)}>Close</button><button className="button button-primary" type="button" disabled={busy || !selectedItemId} onClick={() => void attach(dialog.file, selectedItemId)}>{busy ? "Attaching…" : "Add Attachment"}</button></div>
          </> : dialog.type === "remove" ? <>
            <p className="eyebrow">ATTACHMENT</p><h2 id="files-dialog-title">Remove this Attachment?</h2>
            <p>Choose whether to remove <strong>{dialog.file.name}</strong> from {dialog.attachment.scope === "series" ? `the whole ${dialog.attachment.itemKind} series “${dialog.attachment.itemTitle}”` : dialog.attachment.scope === "following" ? `${dialog.attachment.itemKind} Occurrences from “${dialog.attachment.itemTitle}” onward` : `${dialog.attachment.itemKind} “${dialog.attachment.itemTitle}”`}, or delete the File from your Files section.</p>
            {dialog.file.attachments.length > 1 && <p className="file-delete-warning">Deleting this File removes it from {dialog.file.attachments.length} Tasks or Events.</p>}
            <div className="files-dialog-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="button button-secondary" type="button" disabled={busy} onClick={() => void removeAttachment(dialog.file, dialog.attachment)}>Remove Attachment</button><button className="button button-danger" type="button" disabled={busy} onClick={() => void deleteFile(dialog.file)}>{busy ? "Deleting…" : "Delete File"}</button></div>
          </> : <>
            <p className="eyebrow">FILES SECTION</p><h2 id="files-dialog-title">Delete this File?</h2>
            <p><strong>{dialog.file.name}</strong> will be deleted from your Files section.</p>
            {dialog.file.attachments.length > 1 && <p className="file-delete-warning">This File is attached to {dialog.file.attachments.length} Tasks or Events. Deleting it removes all of those Attachments.</p>}
            {dialog.file.attachments.length === 1 && <p>This also removes its Attachment from “{dialog.file.attachments[0].itemTitle}”.</p>}
            <div className="files-dialog-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="button button-danger" type="button" disabled={busy} onClick={() => void deleteFile(dialog.file)}>{busy ? "Deleting…" : "Delete File"}</button></div>
          </>}
          {error && <p className="files-dialog-error" role="alert">{error}</p>}
        </section>
      </div>}
    </section>
  );
}
