import { randomUUID } from "node:crypto";
import { database } from "./database";
import { deleteStoredObject, presignDownload, presignUpload, uploadedObjectMatches } from "./file-storage";
import { HttpError } from "./http";

export type FileSourceType = "upload" | "link";
export interface FileAttachment {
  itemId: string;
  itemKind: "task" | "event";
  itemTitle: string;
  scope: "occurrence" | "following" | "series";
}
export interface WorkspaceFile {
  id: string;
  name: string;
  sourceType: FileSourceType;
  contentType: string | null;
  sizeBytes: number | null;
  externalUrl: string | null;
  createdAt: string;
  attachments: FileAttachment[];
}
interface StoredFile extends WorkspaceFile {
  userId: string;
  objectKey: string | null;
  status: "pending" | "ready";
  uploadExpiresAt: number | null;
}

const maxFileNameLength = 200;
const maxContentTypeLength = 127;
const maxUploadSizeBytes = 50_000_000;

function fromRow(row: Record<string, unknown>): StoredFile {
  return {
    id: String(row.id), userId: String(row.user_id), name: String(row.name),
    sourceType: row.source_type as FileSourceType,
    contentType: row.mime_type === null ? null : String(row.mime_type),
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    objectKey: row.object_key === null ? null : String(row.object_key),
    externalUrl: row.external_url === null ? null : String(row.external_url),
    status: row.status as "pending" | "ready",
    uploadExpiresAt: row.upload_expires_at === null ? null : Number(row.upload_expires_at),
    createdAt: String(row.created_at),
    attachments: [],
  };
}

function publicFile(file: StoredFile): WorkspaceFile {
  const { userId: _userId, objectKey: _objectKey, status: _status, uploadExpiresAt: _expiresAt, ...result } = file;
  return result;
}

function ownedFile(userId: string, id: string, includePending = false): StoredFile {
  const row = database().prepare(`SELECT * FROM files WHERE user_id = ? AND id = ?${includePending ? "" : " AND status = 'ready'"}`)
    .get(userId, id);
  if (!row) throw new HttpError(404, "This File could not be found.");
  return fromRow(row);
}

function validateName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxFileNameLength || /[\u0000-\u001f]/.test(value)) {
    throw new HttpError(400, "Enter a File name of 1 to 200 characters.");
  }
  return value.trim();
}

function validateBodyKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, "Unknown File field.");
}

export function listFiles(userId: string): WorkspaceFile[] {
  const files = database().prepare(`SELECT * FROM files WHERE user_id = ? AND status = 'ready'
    ORDER BY created_at DESC, id`).all(userId).map(fromRow);
  if (files.length === 0) return [];
  const attachments = database().prepare(`SELECT a.file_id, i.id AS item_id, i.kind, i.title, a.scope
    FROM attachments a JOIN files f ON f.id = a.file_id JOIN items i ON i.id = a.item_id
    WHERE f.user_id = ? AND i.user_id = ? AND f.status = 'ready'
    ORDER BY i.scheduled_date IS NULL, i.scheduled_date, i.scheduled_time, i.title COLLATE NOCASE`)
    .all(userId, userId);
  const byFile = new Map<string, FileAttachment[]>();
  for (const row of attachments) {
    const id = String(row.file_id);
    byFile.set(id, [...(byFile.get(id) ?? []), {
      itemId: String(row.item_id), itemKind: row.kind as "task" | "event", itemTitle: String(row.title),
      scope: row.scope as "occurrence" | "series",
    }]);
  }
  const following = database().prepare(`SELECT a.file_id,i.id AS item_id,i.kind,i.title FROM following_attachments a
    JOIN files f ON f.id=a.file_id JOIN items i ON i.id=a.item_id
    WHERE f.user_id=? AND i.user_id=? AND f.status='ready'`).all(userId,userId);
  for (const row of following) {
    const id=String(row.file_id);
    byFile.set(id,[...(byFile.get(id)??[]),{ itemId:String(row.item_id),itemKind:row.kind as "task"|"event",itemTitle:String(row.title),scope:"following" }]);
  }
  return files.map((file) => publicFile({ ...file, attachments: byFile.get(file.id) ?? [] }));
}

export function createLinkFile(userId: string, body: Record<string, unknown>): WorkspaceFile {
  validateBodyKeys(body, ["name", "url"]);
  const name = validateName(body.name);
  if (typeof body.url !== "string" || body.url.length > 2048) throw new HttpError(400, "Enter a valid web link.");
  let url: URL;
  try { url = new URL(body.url.trim()); } catch { throw new HttpError(400, "Enter a valid web link."); }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password) {
    throw new HttpError(400, "Use a web link that starts with http:// or https://.");
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database().prepare(`INSERT INTO files(id,user_id,name,source_type,mime_type,size_bytes,object_key,external_url,status,created_at,upload_expires_at)
    VALUES(?,?,?,'link',NULL,NULL,NULL,?,'ready',?,NULL)`)
    .run(id, userId, name, url.href, createdAt);
  return {
    id, name, sourceType: "link", contentType: null, sizeBytes: null,
    externalUrl: url.href, createdAt, attachments: [],
  };
}

export async function beginUpload(userId: string, body: Record<string, unknown>) {
  validateBodyKeys(body, ["name", "contentType", "sizeBytes"]);
  const name = validateName(body.name);
  const contentType = body.contentType;
  const sizeBytes = body.sizeBytes;
  if (typeof contentType !== "string" || contentType.length > maxContentTypeLength
    || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType)) {
    throw new HttpError(400, "Choose a supported file type.");
  }
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxUploadSizeBytes) {
    throw new HttpError(400, "Files must be at most 50 MB.");
  }
  const id = randomUUID();
  const objectKey = randomUUID();
  const createdAt = new Date().toISOString();
  const uploadExpiresAt = Date.now() + 10 * 60_000;
  const uploadUrl = await presignUpload(objectKey, contentType);
  database().prepare(`INSERT INTO files(id,user_id,name,source_type,mime_type,size_bytes,object_key,external_url,status,created_at,upload_expires_at)
    VALUES(?,?,?,'upload',?,?,?,NULL,'pending',?,?)`)
    .run(id, userId, name, contentType, sizeBytes, objectKey, createdAt, uploadExpiresAt);
  return { uploadId: id, uploadUrl, expiresInSeconds: 5 * 60 };
}

export async function completeUpload(userId: string, id: string) {
  const file = ownedFile(userId, id, true);
  if (file.status !== "pending" || file.sourceType !== "upload" || !file.objectKey || !file.contentType || file.sizeBytes === null) {
    throw new HttpError(409, "This upload is no longer waiting for a file.");
  }
  if (file.uploadExpiresAt !== null && file.uploadExpiresAt <= Date.now()) {
    await deleteStoredObject(file.objectKey);
    database().prepare("DELETE FROM files WHERE user_id=? AND id=? AND status='pending'").run(userId, id);
    throw new HttpError(410, "This upload expired. Choose the File again to retry.");
  }
  if (!await uploadedObjectMatches(file.objectKey, file.sizeBytes, file.contentType)) {
    throw new HttpError(409, "The uploaded File is not ready or its size and type do not match.");
  }
  database().prepare("UPDATE files SET status='ready', upload_expires_at=NULL WHERE user_id=? AND id=? AND status='pending'")
    .run(userId, id);
  return publicFile(ownedFile(userId, id));
}

export function attachFile(userId: string, fileId: string, itemId: unknown, scope: unknown = "occurrence") {
  if (typeof itemId !== "string" || !itemId.trim()) throw new HttpError(400, "Choose a Task or Event.");
  if (scope !== "occurrence" && scope !== "following" && scope !== "series") throw new HttpError(400, "Choose an Attachment scope.");
  ownedFile(userId, fileId);
  const item = database().prepare("SELECT id,series_root_id,recurrence_json FROM items WHERE user_id=? AND id=?").get(userId, itemId);
  item
    || (() => { throw new HttpError(404, "This Task or Event could not be found."); })();
  let targetId = itemId;
  if (scope === "series" || scope === "following") {
    targetId = String(item.series_root_id ?? item.id);
    const root = database().prepare("SELECT recurrence_json FROM items WHERE user_id=? AND id=?").get(userId,targetId);
    if (!root?.recurrence_json) throw new HttpError(400, "Choose an Occurrence in a recurring series for this Attachment scope.");
  }
  if (scope === "following") {
    database().prepare("INSERT OR IGNORE INTO following_attachments(file_id,item_id,created_at) VALUES(?,?,?)").run(fileId,itemId,new Date().toISOString());
    return;
  }
  database().prepare("INSERT INTO attachments(file_id,item_id,created_at,scope) VALUES(?,?,?,?) ON CONFLICT(file_id,item_id) DO UPDATE SET scope=excluded.scope")
    .run(fileId, targetId, new Date().toISOString(), scope);
}

export function removeAttachment(userId: string, fileId: string, itemId: string, scope: unknown = "occurrence") {
  if (scope !== "occurrence" && scope !== "following" && scope !== "series") throw new HttpError(400, "Choose an Attachment scope.");
  if (scope === "following") {
    const result=database().prepare(`DELETE FROM following_attachments WHERE file_id=? AND item_id=?
      AND EXISTS(SELECT 1 FROM files WHERE id=? AND user_id=?) AND EXISTS(SELECT 1 FROM items WHERE id=? AND user_id=?)`)
      .run(fileId,itemId,fileId,userId,itemId,userId);
    if (!result.changes) throw new HttpError(404,"This Attachment could not be found.");
    return;
  }
  const target = database().prepare("SELECT series_root_id FROM items WHERE user_id=? AND id=?").get(userId,itemId);
  const targetId = scope === "series" ? String(target?.series_root_id ?? itemId) : itemId;
  const result = database().prepare(`DELETE FROM attachments WHERE file_id=? AND item_id=? AND scope=?
    AND EXISTS (SELECT 1 FROM files WHERE id=? AND user_id=?)
    AND EXISTS (SELECT 1 FROM items WHERE id=? AND user_id=?)`)
    .run(fileId, targetId, scope, fileId, userId, targetId, userId);
  if (!result.changes) throw new HttpError(404, "This Attachment could not be found.");
}

export async function openFile(userId: string, id: string) {
  const file = ownedFile(userId, id);
  if (file.sourceType === "link") {
    if (!file.externalUrl) throw new HttpError(404, "This File could not be found.");
    return { url: file.externalUrl, name: file.name, contentType: null, sourceType: "link" as const };
  }
  if (!file.objectKey || !file.contentType) throw new HttpError(404, "This File could not be found.");
  const url = await presignDownload(file.objectKey, file.contentType, file.name);
  return { url, name: file.name, contentType: file.contentType, sourceType: "upload" as const };
}

export async function deleteFile(userId: string, id: string) {
  const file = ownedFile(userId, id, true);
  if (file.objectKey) await deleteStoredObject(file.objectKey);
  const result = database().prepare("DELETE FROM files WHERE user_id=? AND id=?").run(userId, id);
  if (!result.changes) throw new HttpError(404, "This File could not be found.");
}
