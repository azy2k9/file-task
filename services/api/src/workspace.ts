import { randomUUID } from "node:crypto";
import type { WorkspaceItem } from "./items";
import { database } from "./database";
import { HttpError } from "./http";

function fromRow(row: Record<string, unknown>): WorkspaceItem {
  return {
    id: String(row.id), kind: row.kind as WorkspaceItem["kind"], title: String(row.title), details: String(row.details),
    scheduledDate: row.scheduled_date === null ? null : String(row.scheduled_date),
    scheduledTime: row.scheduled_time === null ? null : String(row.scheduled_time),
    completed: row.completed === null ? null : Boolean(row.completed),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function listItems(userId: string) {
  return database().prepare(`SELECT * FROM items WHERE user_id = ?
    ORDER BY scheduled_date IS NULL, scheduled_date, scheduled_time, created_at, id`).all(userId).map(fromRow);
}

export function getItem(userId: string, id: string) {
  const row = database().prepare("SELECT * FROM items WHERE user_id = ? AND id = ?").get(userId, id);
  if (!row) throw new HttpError(404, "This item could not be found.");
  return fromRow(row);
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
  return item;
}

export function deleteItem(userId: string, id: string) {
  const result = database().prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, id);
  if (!result.changes) throw new HttpError(404, "This item could not be found.");
}
