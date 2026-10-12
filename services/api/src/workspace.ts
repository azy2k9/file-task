import { randomUUID } from "node:crypto";
import type { RecurrenceRule, ReminderRule, WorkspaceFileSummary, WorkspaceItem } from "./items";
import { database } from "./database";
import { HttpError } from "./http";
import { itemReminderDefaults, reminderSettings } from "./reminder-settings";

const json = <T>(value: unknown, fallback: T): T => {
  try { return (typeof value === "string" ? JSON.parse(value) : value) as T; } catch { return fallback; }
};

function fromRow(row: Record<string, unknown>): WorkspaceItem {
  return {
    id: String(row.id), kind: row.kind as WorkspaceItem["kind"], title: String(row.title), details: String(row.details),
    scheduledDate: row.scheduled_date == null ? null : String(row.scheduled_date),
    scheduledTime: row.scheduled_time == null ? null : String(row.scheduled_time),
    completed: row.completed == null ? null : Boolean(row.completed), files: [],
    recurrence: json(row.root_recurrence_json ?? row.recurrence_json, null),
    reminders: json(row.reminders_json, []),
    seriesId: row.series_root_id == null || (row.root_recurrence_json ?? row.recurrence_json) == null ? null : String(row.series_root_id),
    isOccurrence: row.series_root_id != null && String(row.id) !== String(row.series_root_id),
    occurrenceDate: row.occurrence_date == null ? null : String(row.occurrence_date),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function parseReminders(value: unknown): ReminderRule[] {
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, "Add up to 20 Reminders.");
  return value.map((row) => {
    if (!row || typeof row !== "object") throw new HttpError(400, "Check the Reminder settings.");
    const rule = row as Record<string, unknown>;
    if (!(["notification", "email"].includes(String(rule.delivery))
      && Number.isInteger(rule.amount) && Number(rule.amount) >= 0 && Number(rule.amount) <= 100_000
      && ["minutes", "hours", "days", "weeks", "months"].includes(String(rule.unit))
      && typeof rule.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time))) {
      throw new HttpError(400, "Check each Reminder's delivery, offset and time.");
    }
    return { delivery: rule.delivery as ReminderRule["delivery"], amount: Number(rule.amount), unit: rule.unit as ReminderRule["unit"], time: rule.time };
  });
}

function parseRecurrence(value: unknown, scheduledDate: string | null): RecurrenceRule | null {
  if (value == null) return null;
  if (!scheduledDate || !value || typeof value !== "object") throw new HttpError(400, "A Recurrence rule needs a scheduled date.");
  const rule = value as Record<string, unknown>;
  const end = rule.end as Record<string, unknown> | undefined;
  if (!Number.isInteger(rule.interval) || Number(rule.interval) < 1 || Number(rule.interval) > 100
    || !["days", "weeks", "months", "years"].includes(String(rule.unit)) || !end
    || !["never", "date", "count"].includes(String(end.type))) throw new HttpError(400, "Check the Recurrence rule.");
  let normalizedEnd: RecurrenceRule["end"];
  if (end.type === "never") normalizedEnd = { type: "never" };
  else if (end.type === "date" && validDate(end.date)) normalizedEnd = { type: "date", date: end.date };
  else if (end.type === "count" && Number.isInteger(end.count) && Number(end.count) >= 1 && Number(end.count) <= 10_000) normalizedEnd = { type: "count", count: Number(end.count) };
  else throw new HttpError(400, "Choose a valid Recurrence end date or occurrence count.");
  if (normalizedEnd.type === "date" && normalizedEnd.date < scheduledDate) throw new HttpError(400, "The Recurrence end date must be on or after its first Occurrence.");
  let weekdays: number[] | undefined;
  if (rule.unit === "weeks") {
    if (!Array.isArray(rule.weekdays) || rule.weekdays.length === 0 || rule.weekdays.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) {
      throw new HttpError(400, "Choose at least one weekday for a weekly Recurrence rule.");
    }
    weekdays = [...new Set(rule.weekdays as number[])].sort();
  } else if (rule.weekdays !== undefined) throw new HttpError(400, "Weekday selection is only available for weekly Recurrence rules.");
  return { interval: Number(rule.interval), unit: rule.unit as RecurrenceRule["unit"], ...(weekdays ? { weekdays } : {}), end: normalizedEnd };
}

function formatDate(date: Date) { return date.toISOString().slice(0, 10); }
function plusMonths(date: Date, count: number) {
  const target = new Date(date);
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + count);
  target.setUTCDate(Math.min(day, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
  return target;
}

function occurrenceDates(startValue: string, rule: RecurrenceRule) {
  const start = new Date(`${startValue}T00:00:00Z`);
  const horizon = new Date(); horizon.setUTCDate(horizon.getUTCDate() + 370);
  const stop = rule.end.type === "date" ? new Date(`${rule.end.date}T00:00:00Z`) : horizon;
  const maxDate = rule.end.type === "date" && stop < horizon ? stop : horizon;
  const dates = [startValue];
  if (rule.end.type === "count" && rule.end.count <= 1) return dates;
  if (rule.unit === "weeks") {
    const weekdays = rule.weekdays ?? [start.getUTCDay()];
    let cursor = new Date(start);
    while (cursor <= maxDate && dates.length < (rule.end.type === "count" ? rule.end.count : 10_000)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const weeks = Math.floor((cursor.getTime() - start.getTime()) / 604_800_000);
      if (weeks % rule.interval === 0 && weekdays.includes(cursor.getUTCDay()) && cursor > start) dates.push(formatDate(cursor));
    }
  } else {
    for (let index = 1; dates.length < (rule.end.type === "count" ? rule.end.count : 10_000); index++) {
      let next: Date;
      if (rule.unit === "days") { next = new Date(start); next.setUTCDate(next.getUTCDate() + index * rule.interval); }
      else if (rule.unit === "months") next = plusMonths(start, index * rule.interval);
      else next = plusMonths(start, index * rule.interval * 12);
      if (next > maxDate) break;
      dates.push(formatDate(next));
    }
  }
  return dates;
}

function ensureOccurrences(userId: string) {
  const db = database();
  const roots = db.prepare("SELECT * FROM items WHERE user_id=? AND series_root_id=id AND recurrence_json IS NOT NULL").all(userId);
  for (const row of roots) {
    const rule = json<RecurrenceRule | null>(row.recurrence_json, null);
    if (!rule || typeof row.scheduled_date !== "string") continue;
    const exists = db.prepare("SELECT occurrence_date FROM items WHERE series_root_id=?").all(row.id).map((item) => String(item.occurrence_date));
    const known = new Set(exists);
    for (const date of occurrenceDates(String(row.scheduled_date), rule)) {
      if (known.has(date)) continue;
      const id = randomUUID(); const now = new Date().toISOString();
      db.prepare(`INSERT INTO items(id,user_id,kind,title,details,scheduled_date,scheduled_time,completed,created_at,updated_at,
        recurrence_json,reminders_json,series_root_id,occurrence_date)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, row.kind, row.title, row.details, date, row.scheduled_time,
        row.kind === "task" ? 0 : null, now, now, null, row.reminders_json ?? "[]", row.id, date);
    }
  }
}

function withFiles(items: WorkspaceItem[], userId: string) {
  if (items.length === 0) return items;
  const filesByItem = new Map<string, WorkspaceFileSummary[]>();
  const rows = database().prepare(`SELECT target.id AS item_id, f.id, f.name, f.source_type FROM attachments a
    JOIN items i ON i.id=a.item_id JOIN items target ON target.user_id=i.user_id AND
      (target.id=i.id OR (a.scope='series' AND target.series_root_id=i.id))
    JOIN files f ON f.id=a.file_id AND f.user_id=i.user_id
    WHERE i.user_id=? AND f.status='ready' AND NOT EXISTS(
      SELECT 1 FROM attachment_exclusions x JOIN items excluded ON excluded.id=x.item_id
      WHERE x.file_id=f.id AND ((x.scope='occurrence' AND x.item_id=target.id)
        OR (x.scope='following' AND excluded.series_root_id=target.series_root_id AND target.occurrence_date>=excluded.occurrence_date)))
    UNION
    SELECT target.id AS item_id, f.id, f.name, f.source_type FROM following_attachments a
    JOIN items anchor ON anchor.id=a.item_id JOIN items target ON target.user_id=anchor.user_id
      AND target.series_root_id=anchor.series_root_id AND target.occurrence_date>=anchor.occurrence_date
    JOIN files f ON f.id=a.file_id AND f.user_id=anchor.user_id
    WHERE anchor.user_id=? AND f.status='ready' AND NOT EXISTS(
      SELECT 1 FROM attachment_exclusions x JOIN items excluded ON excluded.id=x.item_id
      WHERE x.file_id=f.id AND ((x.scope='occurrence' AND x.item_id=target.id)
        OR (x.scope='following' AND excluded.series_root_id=target.series_root_id AND target.occurrence_date>=excluded.occurrence_date)))`).all(userId,userId);
  for (const row of rows) {
    const itemId = String(row.item_id);
    filesByItem.set(itemId, [...(filesByItem.get(itemId) ?? []), { id: String(row.id), name: String(row.name), sourceType: row.source_type as "upload" | "link" }]);
  }
  return items.map((item) => ({ ...item, files: filesByItem.get(item.id) ?? [] }));
}

export function listItems(userId: string) {
  ensureOccurrences(userId);
  const rows = database().prepare(`SELECT i.*, root.recurrence_json AS root_recurrence_json FROM items i
    LEFT JOIN items root ON root.id=i.series_root_id WHERE i.user_id=?
    ORDER BY i.scheduled_date IS NULL,i.scheduled_date,i.scheduled_time,i.created_at,i.id`).all(userId);
  return withFiles(rows.map(fromRow), userId);
}

export function getItem(userId: string, id: string) {
  const row = database().prepare(`SELECT i.*, root.recurrence_json AS root_recurrence_json FROM items i
    LEFT JOIN items root ON root.id=i.series_root_id WHERE i.user_id=? AND i.id=?`).get(userId, id);
  if (!row) throw new HttpError(404, "This item could not be found.");
  return withFiles([fromRow(row)], userId)[0];
}

function validate(body: Record<string, unknown>, existing?: WorkspaceItem) {
  const allowed = ["kind", "title", "details", "scheduledDate", "scheduledTime", "completed", "recurrence", "reminders", "scope"];
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
  if (scheduledDate !== null && !validDate(scheduledDate)) throw new HttpError(400, "Choose a valid calendar date.");
  if (scheduledTime !== null && (typeof scheduledTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduledTime) || !scheduledDate)) throw new HttpError(400, "A valid time requires a date.");
  if (body.completed !== undefined && (kind !== "task" || typeof body.completed !== "boolean")) throw new HttpError(400, "Only Tasks can be marked complete.");
  const recurrence = body.recurrence === undefined ? existing?.recurrence ?? null : parseRecurrence(body.recurrence, scheduledDate as string | null);
  const reminders = body.reminders === undefined ? existing?.reminders ?? [] : parseReminders(body.reminders);
  const now = new Date().toISOString();
  return { id: existing?.id ?? randomUUID(), kind: kind as "task" | "event", title: title.trim(), details, scheduledDate: scheduledDate as string | null,
    scheduledTime: scheduledTime as string | null, completed: kind === "task" ? (body.completed as boolean | undefined) ?? existing?.completed ?? false : null,
    recurrence, reminders, createdAt: existing?.createdAt ?? now, updatedAt: now };
}

export function saveItem(userId: string, body: Record<string, unknown>, id?: string) {
  const db = database();
  const existing = id ? getItem(userId, id) : undefined;
  const item = validate(body, existing);
  if (item.reminders.some((reminder) => reminder.delivery === "email") && !reminderSettings(userId).emailEnabled) {
    throw new HttpError(400, "Enable email delivery before adding an Email Reminder.");
  }
  const scope = body.scope ?? "series";
  if (existing?.seriesId && !["occurrence", "following", "series"].includes(String(scope))) throw new HttpError(400, "Choose whether to edit this Occurrence, following Occurrences, or the whole series.");
  if (!id) {
    const defaults = itemReminderDefaults(userId, item.kind);
    if (body.reminders === undefined) item.reminders = defaults;
    const usesDefault = body.reminders === undefined || JSON.stringify(item.reminders) === JSON.stringify(defaults);
    const rootId = item.recurrence ? item.id : null;
    db.prepare(`INSERT INTO items(id,user_id,kind,title,details,scheduled_date,scheduled_time,completed,created_at,updated_at,
      recurrence_json,reminders_json,series_root_id,occurrence_date,uses_reminder_default) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      item.id,userId,item.kind,item.title,item.details,item.scheduledDate,item.scheduledTime,item.completed === null ? null : Number(item.completed),
      item.createdAt,item.updatedAt,item.recurrence ? JSON.stringify(item.recurrence) : null,JSON.stringify(item.reminders),rootId,item.recurrence ? item.scheduledDate : null,Number(usesDefault));
    return getItem(userId, item.id);
  }
  const rootId = existing?.seriesId ?? (existing?.recurrence ? existing.id : null);
  const write = (targetId: string, root: boolean, scheduledDate = item.scheduledDate) => {
    const old = db.prepare("SELECT reminders_json,uses_reminder_default,completed FROM items WHERE user_id=? AND id=?").get(userId,targetId);
    const reminders = body.reminders === undefined ? String(old?.reminders_json ?? "[]") : JSON.stringify(item.reminders);
    const followsDefault = body.reminders === undefined ? Number(old?.uses_reminder_default ?? 1) : Number(JSON.stringify(item.reminders) === JSON.stringify(itemReminderDefaults(userId,item.kind)));
    const completed = body.completed === undefined ? old?.completed ?? (item.completed === null ? null : Number(item.completed)) : item.completed === null ? null : Number(item.completed);
    return db.prepare(`UPDATE items SET title=?,details=?,scheduled_date=?,scheduled_time=?,completed=?,updated_at=?,reminders_json=?,uses_reminder_default=?,
      recurrence_json=?,series_root_id=?,occurrence_date=? WHERE user_id=? AND id=?`).run(item.title,item.details,scheduledDate,item.scheduledTime,
      completed,item.updatedAt,reminders,followsDefault,root && item.recurrence ? JSON.stringify(item.recurrence) : null,
      item.recurrence ? (rootId ?? existing!.id) : null,item.recurrence ? scheduledDate : null,userId,targetId);
  };
  if (existing?.seriesId && scope !== "occurrence") {
    const series = scope === "series" ? existing.seriesId : existing.seriesId;
    const comparison = scope === "following" ? " AND occurrence_date >= ?" : "";
    const params: (string | null)[] = scope === "following" ? [userId, series, existing.scheduledDate] : [userId, series];
    const targets = db.prepare(`SELECT id,occurrence_date FROM items WHERE user_id=? AND series_root_id=?${comparison} ORDER BY occurrence_date,id`).all(...params);
    const wholeSeries = scope === "series" || (scope === "following" && id === series);
    const root = db.prepare("SELECT scheduled_date FROM items WHERE user_id=? AND id=?").get(userId,series);
    const remindersOnly = scope === "series" && body.scheduledDate === undefined && body.scheduledTime === undefined && body.recurrence === undefined;
    const seriesStart = remindersOnly ? String(root?.scheduled_date ?? item.scheduledDate) : item.scheduledDate;
    const dates = wholeSeries && item.recurrence && seriesStart ? occurrenceDates(seriesStart, item.recurrence) : [];
    if (dates.length > 0) {
      targets.forEach((target, index) => {
        if (index < dates.length) write(String(target.id), String(target.id) === series, dates[index]);
        else db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, target.id);
      });
    } else {
      for (const target of targets) write(String(target.id), String(target.id) === series, String(target.occurrence_date ?? item.scheduledDate));
    }
    if (scope === "following" && id !== series) {
      if (item.recurrence && existing?.scheduledDate) {
        const earlierCount = Number(db.prepare("SELECT COUNT(*) AS count FROM items WHERE user_id=? AND series_root_id=? AND occurrence_date < ?").get(userId,series,existing.scheduledDate)?.count ?? 0);
        const splitRule: RecurrenceRule = item.recurrence.end.type === "count"
          ? { ...item.recurrence,end:{type:"count",count:Math.max(1,item.recurrence.end.count-earlierCount)} }
          : item.recurrence;
        const followingDates = occurrenceDates(item.scheduledDate ?? existing.scheduledDate,splitRule);
        targets.forEach((target,index) => {
          if (index < followingDates.length) db.prepare("UPDATE items SET scheduled_date=?,series_root_id=?,occurrence_date=?,recurrence_json=? WHERE id=?")
            .run(followingDates[index],id,followingDates[index],index===0?JSON.stringify(splitRule):null,target.id);
          else db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId,target.id);
        });
        db.prepare("UPDATE items SET recurrence_json=NULL,series_root_id=? WHERE user_id=? AND id=?").run(series,userId,series);
        db.prepare(`INSERT OR IGNORE INTO attachments(file_id,item_id,created_at,scope)
          SELECT file_id,?,created_at,'series' FROM attachments WHERE item_id=? AND scope='series'`).run(id,series);
      } else {
        for (const target of targets) db.prepare("UPDATE items SET series_root_id=?,recurrence_json=NULL WHERE user_id=? AND id=?").run(series,userId,target.id);
        db.prepare("UPDATE items SET series_root_id=?,recurrence_json=NULL WHERE user_id=? AND id=?").run(series,userId,series);
      }
    }
    if (scope === "series" && !item.recurrence) for (const target of targets) {
      if (String(target.id) !== series) db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId,target.id);
    }
    if (item.recurrence) ensureOccurrences(userId);
    return getItem(userId, id);
  }
  if (existing?.seriesId && scope === "occurrence" && id !== existing.seriesId) {
    write(id, false, item.scheduledDate);
    db.prepare("UPDATE items SET recurrence_json=NULL,series_root_id=?,occurrence_date=? WHERE user_id=? AND id=?")
      .run(existing.seriesId, existing.scheduledDate, userId, id);
  } else write(id, !rootId || id === rootId);
  if (item.recurrence && !rootId) db.prepare("UPDATE items SET series_root_id=id,occurrence_date=scheduled_date,recurrence_json=? WHERE id=?").run(JSON.stringify(item.recurrence),id);
  if (existing?.recurrence && !item.recurrence) db.prepare("DELETE FROM items WHERE series_root_id=? AND id<>?").run(existing.id,id);
  if (item.recurrence) ensureOccurrences(userId);
  return getItem(userId, id);
}

export function deleteItem(userId: string, id: string) {
  const result = database().prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId,id);
  if (!result.changes) throw new HttpError(404, "This item could not be found.");
}
