import { randomUUID } from "node:crypto";
import type { WorkspaceFileSummary, WorkspaceItem } from "./items";
import { database } from "./database";
import { HttpError } from "./http";

function fromRow(row: Record<string, unknown>): WorkspaceItem {
  return {
    id: String(row.id), kind: row.kind as WorkspaceItem["kind"], title: String(row.title), details: String(row.details),
    scheduledDate: row.scheduled_date === null ? null : String(row.scheduled_date),
    scheduledTime: row.scheduled_time === null ? null : String(row.scheduled_time),
    completed: row.completed === null ? null : Boolean(row.completed),
    files: [],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function listItems(userId: string) {
  const items = database().prepare(`SELECT * FROM items WHERE user_id = ?
    ORDER BY scheduled_date IS NULL, scheduled_date, scheduled_time, created_at, id`).all(userId).map(fromRow);
  if (items.length === 0) return items;
  const filesByItem = new Map<string, WorkspaceFileSummary[]>();
  const rows = database().prepare(`SELECT a.item_id, f.id, f.name, f.source_type
    FROM attachments a
    JOIN items i ON i.id = a.item_id
    JOIN files f ON f.id = a.file_id AND f.user_id = i.user_id
    WHERE i.user_id = ? AND f.status = 'ready'
    ORDER BY f.created_at DESC, f.id`).all(userId);
  for (const row of rows) {
    const itemId = String(row.item_id);
    filesByItem.set(itemId, [...(filesByItem.get(itemId) ?? []), {
      id: String(row.id), name: String(row.name), sourceType: row.source_type as "upload" | "link",
    }]);
  }
  return items.map((item) => ({ ...item, files: filesByItem.get(item.id) ?? [] }));
}

export function getItem(userId: string, id: string) {
  const row = database().prepare("SELECT * FROM items WHERE user_id = ? AND id = ?").get(userId, id);
  if (!row) throw new HttpError(404, "This item could not be found.");
  const item = fromRow(row);
  item.files = database().prepare(`SELECT f.id, f.name, f.source_type
    FROM attachments a JOIN files f ON f.id = a.file_id
    WHERE a.item_id = ? AND f.user_id = ? AND f.status = 'ready' ORDER BY f.created_at DESC, f.id`)
    .all(id, userId).map((file) => ({
      id: String(file.id), name: String(file.name), sourceType: file.source_type as "upload" | "link",
    }));
  return item;
}

function validate(body: Record<string, unknown>, existing?: WorkspaceItem): WorkspaceItem {
  const allowed = ["kind", "title", "details", "scheduledDate", "scheduledTime", "completed"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, "Unknown item field.");
  const kind = body.kind === undefined ? existing?.kind : body.kind;
  if (kind !== "task" && kind !== "event") throw new HttpError(400, "Choose Task or Event.");
  if (existing && kind !== existing.kind) throw new HttpError(400, "An item's type cannot be changed.");
  const title = body.title === undefined ? existing?.title : body.title;
  const details = body.details === undefined ? (existing?.details ?? "") : body.details;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200) throw new HttpError(400, "Enter a title of 1 to 200 characters.");
  if (typeof details !== "string" || details.length > 10_000) throw new HttpError(400, "Details must be at most 10,000 characters.");
  const scheduledDate = body.scheduledDate === undefined ? (existing?.scheduledDate ?? null) : body.scheduledDate;
  const scheduledTime = body.scheduledTime === undefined ? (existing?.scheduledTime ?? null) : body.scheduledTime;
  if (scheduledDate !== null && (typeof scheduledDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)
    || !Number.isFinite(Date.parse(`${scheduledDate}T00:00:00Z`))
    || new Date(`${scheduledDate}T00:00:00Z`).toISOString().slice(0, 10) !== scheduledDate)) {
    throw new HttpError(400, "Choose a valid calendar date.");
  }
  if (scheduledTime !== null && (typeof scheduledTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduledTime) || !scheduledDate)) {
    throw new HttpError(400, "A valid time requires a date.");
  }
  if (body.completed !== undefined && (kind !== "task" || typeof body.completed !== "boolean")) {
    throw new HttpError(400, "Only Tasks can be marked complete.");
  }
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? randomUUID(), kind, title: title.trim(), details, scheduledDate, scheduledTime,
    completed: kind === "task" ? (body.completed as boolean | undefined) ?? existing?.completed ?? false : null,
    files: existing?.files ?? [],
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
}

export function saveItem(userId: string, body: Record<string, unknown>, id?: string) {
  const item = validate(body, id ? getItem(userId, id) : undefined);
  if (id) {
    database().prepare(`UPDATE items SET title=?, details=?, scheduled_date=?, scheduled_time=?, completed=?, updated_at=?
      WHERE user_id=? AND id=?`).run(item.title, item.details, item.scheduledDate, item.scheduledTime,
        item.completed === null ? null : Number(item.completed), item.updatedAt, userId, id);
  } else {
    database().prepare(`INSERT INTO items(id,user_id,kind,title,details,scheduled_date,scheduled_time,completed,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(item.id, userId, item.kind, item.title, item.details, item.scheduledDate,
        item.scheduledTime, item.completed === null ? null : Number(item.completed), item.createdAt, item.updatedAt);
  }
  return id ? getItem(userId, id) : item;
}

export function deleteItem(userId: string, id: string) {
  const result = database().prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, id);
  if (!result.changes) throw new HttpError(404, "This item could not be found.");
}
