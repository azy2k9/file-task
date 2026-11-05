import { sameRecurrence } from "./items";
import { importedScheduleLimitation } from "./calendars";
import { randomUUID } from "node:crypto";
import type { CalendarSyncStatus, RecurrenceRule, ReminderRule, WorkspaceFileSummary, WorkspaceItem } from "./items";
import { database } from "./database";
import { now } from "./clock";
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
    isOccurrence: row.series_root_id != null && String(row.id) !== String(row.series_root_id), calendarSync: [],
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
  let ordinalWeekday: RecurrenceRule["ordinalWeekday"];
  let month: number | undefined;
  let monthDay: number | undefined;
  if (rule.unit === "weeks") {
    if (!Array.isArray(rule.weekdays) || rule.weekdays.length === 0 || rule.weekdays.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) {
      throw new HttpError(400, "Choose at least one weekday for a weekly Recurrence rule.");
    }
    weekdays = [...new Set(rule.weekdays as number[])].sort();
  } else if (rule.weekdays !== undefined) throw new HttpError(400, "Weekday selection is only available for weekly Recurrence rules.");
  if (rule.ordinalWeekday !== undefined) {
    const ordinal = rule.ordinalWeekday as Record<string, unknown>;
    if (rule.unit !== "months" || !ordinal || !Number.isInteger(ordinal.ordinal) || ![-5,-4,-3,-2,-1,1,2,3,4,5].includes(Number(ordinal.ordinal))
      || !Number.isInteger(ordinal.weekday) || Number(ordinal.weekday) < 0 || Number(ordinal.weekday) > 6 || weekdays) {
      throw new HttpError(400, "Check the monthly weekday Recurrence rule.");
    }
    ordinalWeekday = { ordinal:Number(ordinal.ordinal),weekday:Number(ordinal.weekday) };
  }
  if (rule.month !== undefined || rule.monthDay !== undefined) {
    if (rule.unit !== "years" || !Number.isInteger(rule.month) || Number(rule.month) < 1 || Number(rule.month) > 12
      || !Number.isInteger(rule.monthDay) || Number(rule.monthDay) < 1 || Number(rule.monthDay) > 31 || rule.ordinalWeekday) {
      throw new HttpError(400, "Check the yearly month and day Recurrence rule.");
    }
    month = Number(rule.month); monthDay = Number(rule.monthDay);
  }
  return { interval: Number(rule.interval), unit: rule.unit as RecurrenceRule["unit"], ...(weekdays ? { weekdays } : {}),
    ...(ordinalWeekday ? { ordinalWeekday } : {}), ...(month !== undefined ? { month,monthDay } : {}), end: normalizedEnd };
}

function sameRecurrenceProjection(a: RecurrenceRule | null, b: RecurrenceRule | null) {
  if (!a || !b) return a === b;
  const weekdays = (value: number[] | undefined) => value ? [...new Set(value)].sort((x,y) => x-y) : undefined;
  return a.interval === b.interval && a.unit === b.unit && JSON.stringify(weekdays(a.weekdays)) === JSON.stringify(weekdays(b.weekdays))
    && JSON.stringify(a.end) === JSON.stringify(b.end);
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

function reminderLeadDays(raw: unknown) {
  const reminders = json<ReminderRule[]>(raw, []);
  return reminders.reduce((max, reminder) => {
    const days = reminder.unit === "minutes" || reminder.unit === "hours" ? 0
      : reminder.unit === "days" ? reminder.amount
        : reminder.unit === "weeks" ? reminder.amount * 7
          : reminder.amount * 31;
    return Math.max(max, days);
  }, 0);
}

function occurrenceDates(startValue: string, rule: RecurrenceRule, leadDays = 0) {
  const start = new Date(`${startValue}T00:00:00Z`);
  const horizon = now(); horizon.setUTCDate(horizon.getUTCDate() + Math.max(370, leadDays) + 2);
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
      else if (rule.unit === "months" && rule.ordinalWeekday) {
        const monthStart = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+index*rule.interval,1));
        const intendedYear = monthStart.getUTCFullYear();
        const intendedMonth = monthStart.getUTCMonth();
        const { ordinal,weekday } = rule.ordinalWeekday;
        if (ordinal > 0) {
          monthStart.setUTCDate(1 + ((weekday - monthStart.getUTCDay() + 7) % 7) + (ordinal - 1) * 7);
        } else {
          monthStart.setUTCMonth(monthStart.getUTCMonth()+1); monthStart.setUTCDate(0);
          monthStart.setUTCDate(monthStart.getUTCDate() - ((monthStart.getUTCDay() - weekday + 7) % 7) + (ordinal + 1) * 7);
        }
        // A fifth ordinal may not exist. Date setters normalize overflow into an
        // adjacent month; that candidate must be skipped and must not consume COUNT.
        if (monthStart.getUTCFullYear() !== intendedYear || monthStart.getUTCMonth() !== intendedMonth) continue;
        next = monthStart;
      } else if (rule.unit === "years" && rule.month !== undefined && rule.monthDay !== undefined) {
        const year = start.getUTCFullYear() + index * rule.interval;
        if (Date.UTC(year,0,1) > maxDate.getTime()) break;
        const candidate = new Date(Date.UTC(year,rule.month - 1,rule.monthDay));
        // RFC recurrence candidates on invalid calendar dates are ignored and do
        // not consume COUNT.
        if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== rule.month - 1 || candidate.getUTCDate() !== rule.monthDay) continue;
        next = candidate;
      } else if (rule.unit === "months") next = plusMonths(start, index * rule.interval);
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
    const excluded = new Set(db.prepare("SELECT occurrence_date FROM occurrence_exclusions WHERE series_root_id=?").all(row.id).map((item) => String(item.occurrence_date)));
    for (const date of occurrenceDates(String(row.scheduled_date), rule, reminderLeadDays(row.reminders_json))) {
      if (known.has(date) || excluded.has(date)) continue;
      const id = randomUUID(); const createdAt = now().toISOString();
      db.prepare(`INSERT INTO items(id,user_id,kind,title,details,scheduled_date,scheduled_time,completed,created_at,updated_at,
        recurrence_json,reminders_json,series_root_id,occurrence_date)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, row.kind, row.title, row.details, date, row.scheduled_time,
        row.kind === "task" ? 0 : null, createdAt, createdAt, null, row.reminders_json ?? "[]", row.id, date);
      db.prepare(`INSERT OR IGNORE INTO calendar_import_split_blocks(user_id,item_id,provider)
        SELECT user_id,?,provider FROM calendar_import_split_blocks WHERE user_id=? AND item_id=?`).run(id,userId,row.id);
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
  const calendarSyncByItem = new Map<string, CalendarSyncStatus[]>();
  const currentAccounts = new Map(database().prepare("SELECT provider,calendar_url,connection_scope_id FROM calendar_connections WHERE user_id=?").all(userId)
    .map((row) => [String(row.provider), row]));
  const metadata = database().prepare(`SELECT item_id,provider,state,limitation_code,limitation_message,baseline_json,source_payload_json,source_ics
    ,source_account_id,timing_json,connection_scope_id,external_id FROM calendar_import_metadata WHERE user_id=?`).all(userId);
  for (const row of metadata) {
    const rootId = String(row.item_id);
    const rootRow = database().prepare("SELECT * FROM items WHERE user_id=? AND id=?").get(userId,rootId);
    const item = rootRow ? fromRow(rootRow) : undefined;
    if (!item) continue;
    const baseline = json<{ scheduledDate?: string | null; scheduledTime?: string | null; recurrence?: RecurrenceRule | null }>(row.baseline_json, {});
    const scheduleEdited = (baseline.scheduledDate ?? null) !== item.scheduledDate || (baseline.scheduledTime ?? null) !== item.scheduledTime;
    const recurrenceEdited = !sameRecurrence(baseline.recurrence ?? null,item.recurrence);
    const sourceState = row.state === "limited" ? "limited" : "supported";
    let limitationCode = typeof row.limitation_code === "string" ? row.limitation_code : null;
    let limitation = typeof row.limitation_message === "string" ? row.limitation_message : null;
    let state: CalendarSyncStatus["state"] = sourceState;
    const active = currentAccounts.get(String(row.provider));
    const identity = database().prepare("SELECT 1 FROM calendar_imports WHERE user_id=? AND item_id=? AND provider=? AND external_id=? AND connection_scope_id=?").get(userId,rootId,row.provider,row.external_id,row.connection_scope_id);
    if ((!active || !active.connection_scope_id || !row.connection_scope_id || active.connection_scope_id !== row.connection_scope_id || !identity || (active.calendar_url ?? (row.provider === "google" ? "primary" : null)) !== row.source_account_id) && sourceState !== "limited") {
      state = "limited";
      limitationCode = "source-account-changed";
      limitation = "The connected calendar account changed after this Event was imported. Sync is paused so the original Calendar copy is not replaced with a guess.";
    }
    if (recurrenceEdited && sourceState !== "limited") {
      state = "limited";
      limitationCode = "recurrence-edited";
      limitation = "This imported Recurrence rule was edited in FileTasks. Calendar sync is paused until the original Recurrence representation can be preserved.";
    }
    if (scheduleEdited && state === "supported") {
      const scheduleLimitation = importedScheduleLimitation(String(row.timing_json),item,row.provider === "apple");
      if (scheduleLimitation) {
        state = "limited";
        limitationCode = "schedule-unsupported";
        limitation = scheduleLimitation;
      }
    }
    const importedExcludedDates = new Set<string>(Array.isArray((baseline as { importedExcludedDates?: unknown }).importedExcludedDates)
      ? (baseline as { importedExcludedDates: string[] }).importedExcludedDates : []);
    const localExclusion = item.recurrence && database().prepare("SELECT occurrence_date FROM occurrence_exclusions WHERE user_id=? AND series_root_id=?")
      .all(userId,rootId).some((excluded) => !importedExcludedDates.has(String(excluded.occurrence_date)));
    const occurrenceChanged = item.recurrence && (localExclusion || Boolean(database().prepare(`SELECT 1 FROM items WHERE user_id=? AND series_root_id=? AND id<>? AND
      (scheduled_date IS NOT occurrence_date OR scheduled_time IS NOT ? OR title IS NOT ? OR details IS NOT ?) LIMIT 1`)
      .get(userId,rootId,rootId,item.scheduledTime,item.title,item.details)));
    if (occurrenceChanged && state === "supported") {
      state = "limited"; limitationCode = "occurrence-edited";
      limitation = "This imported Event has edited or deleted Occurrences. Calendar sync is paused to preserve its original recurrence.";
    }
    if (database().prepare("SELECT 1 FROM google_inventory_pending WHERE user_id=? AND item_id=?").get(userId,rootId)) {
      state = "limited"; limitationCode = "inventory-pending";
      limitation = "Google Calendar inventory is incomplete. Sync is paused to protect this Event.";
    }
    let location: string | undefined;
    if (row.provider === "google" && typeof row.source_payload_json === "string") {
      const payload = json<{ location?: unknown }>(row.source_payload_json, {});
      if (typeof payload.location === "string" && payload.location) location = payload.location;
    } else if (row.provider === "apple" && typeof row.source_ics === "string") {
      const match = row.source_ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).find((line) => /^LOCATION(?:;[^:]*)?:/i.test(line));
      if (match) location = match.slice(match.indexOf(":") + 1).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
    }
    const status: CalendarSyncStatus = {
      provider: row.provider as CalendarSyncStatus["provider"], state, scheduleEdited, recurrenceEdited,
      limitationCode, limitation, ...(location ? { location } : {}),
    };
    for (const target of items.filter((candidate) => candidate.id === rootId || candidate.seriesId === rootId))
      calendarSyncByItem.set(target.id, [...(calendarSyncByItem.get(target.id) ?? []), status]);
  }
  for (const row of database().prepare(`SELECT i.item_id,i.provider FROM calendar_imports i
    LEFT JOIN calendar_import_metadata m ON m.user_id=i.user_id AND m.provider=i.provider AND m.external_id=i.external_id
    WHERE i.user_id=? AND m.external_id IS NULL`).all(userId)) {
    for (const target of items.filter((candidate) => candidate.id === String(row.item_id) || candidate.seriesId === String(row.item_id))) {
      const status: CalendarSyncStatus = { provider:row.provider as CalendarSyncStatus["provider"], state:"limited", scheduleEdited:false, recurrenceEdited:false,
        limitationCode:"legacy-import", limitation:"This Event was imported before source timing could be retained. Calendar sync is paused because its original timing cannot be verified." };
      calendarSyncByItem.set(target.id,[...(calendarSyncByItem.get(target.id) ?? []),status]);
    }
  }
  for (const row of database().prepare("SELECT item_id,provider FROM calendar_import_split_blocks WHERE user_id=?").all(userId)) {
    const itemId = String(row.item_id);
    const status: CalendarSyncStatus = { provider: row.provider as CalendarSyncStatus["provider"], state:"limited", scheduleEdited:true,
      recurrenceEdited:true, limitationCode:"imported-series-split", limitation:"This imported series was split in FileTasks. Calendar sync is paused to preserve the original Calendar copy." };
    for (const target of items.filter((candidate) => candidate.id === itemId || candidate.seriesId === itemId)) {
      const existing = calendarSyncByItem.get(target.id) ?? [];
      if (!existing.some((entry) => entry.provider === status.provider && entry.limitationCode === status.limitationCode)) {
        calendarSyncByItem.set(target.id,[...existing,status]);
      }
    }
  }
  for (const row of database().prepare(`SELECT c.item_id,c.provider FROM calendar_copies c
    JOIN calendar_connections conn ON conn.user_id=c.user_id AND conn.provider=c.provider
    WHERE c.user_id=? AND (conn.connection_scope_id IS NULL OR c.connection_scope_id IS NULL OR c.connection_scope_id<>conn.connection_scope_id)`).all(userId)) {
    const status: CalendarSyncStatus = { provider:row.provider as CalendarSyncStatus["provider"], state:"limited", scheduleEdited:false, recurrenceEdited:false,
      limitationCode:"copy-scope-unverified", limitation:"This Calendar copy belongs to an earlier or unknown connection. Sync is paused because its identity cannot be verified." };
    for (const target of items.filter((candidate) => candidate.id === String(row.item_id) || candidate.seriesId === String(row.item_id))) {
      const existing = calendarSyncByItem.get(target.id) ?? [];
      calendarSyncByItem.set(target.id, [...existing.filter((entry) => entry.provider !== status.provider), status]);
    }
  }
  for (const row of database().prepare(`SELECT l.item_id,l.provider,l.code,l.message FROM calendar_destination_limitations l
    JOIN calendar_connections c ON c.user_id=l.user_id AND c.provider=l.provider
      AND c.connection_scope_id=l.connection_scope_id
    JOIN items i ON i.user_id=l.user_id AND i.id=l.item_id AND i.kind='event'
    WHERE l.user_id=?`).all(userId)) {
    const status: CalendarSyncStatus = { provider: row.provider as CalendarSyncStatus["provider"], state: "limited",
      scheduleEdited: false, recurrenceEdited: false, limitationCode: String(row.code), limitation: String(row.message) };
    for (const target of items.filter((candidate) => candidate.kind === "event" &&
      (candidate.id === String(row.item_id) || candidate.seriesId === String(row.item_id)))) {
      calendarSyncByItem.set(target.id, [...(calendarSyncByItem.get(target.id) ?? []), status]);
    }
  }
  return items.map((item) => ({ ...item, files: filesByItem.get(item.id) ?? [], calendarSync: calendarSyncByItem.get(item.id) ?? [] }));
}

export function calendarSyncLimitations(userId: string) {
  const connectedProviders = new Set(database().prepare("SELECT provider FROM calendar_connections WHERE user_id=?").all(userId).map((row) => String(row.provider)));
  const limitations = listItems(userId).flatMap((item) => {
    const limitations = item.calendarSync.filter((status) => status.state === "limited")
      .map((status) => ({ itemId: item.id, title: item.title, provider: status.provider, message: status.limitation ?? "This Event cannot be synchronized safely." }));
    if (item.recurrence && item.scheduledTime && connectedProviders.has("apple") && item.calendarSync.some((status) => status.provider === "google" && status.state === "supported")) {
      limitations.push({itemId:item.id,title:item.title,provider:"apple",message:"This recurring Event uses a Google timezone rule. Apple export is paused because its daylight-saving behavior cannot be preserved safely yet."});
    }
    return limitations;
  });
  for (const row of database().prepare(`SELECT c.item_id,c.provider FROM calendar_copies c
    JOIN calendar_connections conn ON conn.user_id=c.user_id AND conn.provider=c.provider
    WHERE c.user_id=? AND (conn.connection_scope_id IS NULL OR c.connection_scope_id IS NULL OR c.connection_scope_id<>conn.connection_scope_id)
      AND NOT EXISTS (SELECT 1 FROM items i WHERE i.user_id=c.user_id AND i.id=c.item_id)`).all(userId)) {
    limitations.push({ itemId:String(row.item_id), title:"Deleted Event", provider:row.provider as CalendarSyncStatus["provider"],
      message:"The deleted Event has a Calendar copy from an earlier or unknown connection. Its identity cannot be verified, so the copy is retained." });
  }
  return limitations;
}

export function listItems(userId: string) {
  ensureOccurrences(userId);
  const rows = database().prepare(`SELECT i.*, root.recurrence_json AS root_recurrence_json FROM items i
    LEFT JOIN items root ON root.id=i.series_root_id WHERE i.user_id=? AND NOT EXISTS(
      SELECT 1 FROM occurrence_exclusions x WHERE x.user_id=i.user_id AND x.series_root_id=i.series_root_id AND x.occurrence_date=i.occurrence_date)
    ORDER BY i.scheduled_date IS NULL,i.scheduled_date,i.scheduled_time,i.created_at,i.id`).all(userId);
  return withFiles(rows.map(fromRow), userId);
}

export function listItemsForCalendarSync(userId: string) {
  ensureOccurrences(userId);
  const rows = database().prepare(`SELECT i.*, root.recurrence_json AS root_recurrence_json FROM items i
    LEFT JOIN items root ON root.id=i.series_root_id WHERE i.user_id=?
    ORDER BY i.scheduled_date IS NULL,i.scheduled_date,i.scheduled_time,i.created_at,i.id`).all(userId);
  return withFiles(rows.map(fromRow), userId);
}

export function getItem(userId: string, id: string) {
  const row = database().prepare(`SELECT i.*, root.recurrence_json AS root_recurrence_json FROM items i
    LEFT JOIN items root ON root.id=i.series_root_id WHERE i.user_id=? AND i.id=? AND (i.id=i.series_root_id OR NOT EXISTS(
      SELECT 1 FROM occurrence_exclusions x WHERE x.user_id=i.user_id AND x.series_root_id=i.series_root_id AND x.occurrence_date=i.occurrence_date))`).get(userId, id);
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
  let recurrence = body.recurrence === undefined ? existing?.recurrence ?? null : parseRecurrence(body.recurrence, scheduledDate as string | null);
  // Existing native clients only round-trip the simple recurrence projection. Keep
  // the persisted rich pattern when that projection has not actually changed.
  const recurrenceBody = body.recurrence && typeof body.recurrence === "object" ? body.recurrence as Record<string,unknown> : null;
  const includesRichRule = recurrenceBody && ["ordinalWeekday","month","monthDay"].some((key) => Object.hasOwn(recurrenceBody,key));
  if (body.recurrence !== undefined && !includesRichRule && existing?.recurrence && recurrence && sameRecurrenceProjection(existing.recurrence,recurrence)) recurrence = existing.recurrence;
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
  const unchangedEmailRules = existing !== undefined && JSON.stringify(item.reminders) === JSON.stringify(existing.reminders);
  if (body.reminders !== undefined && item.reminders.some((reminder) => reminder.delivery === "email")
    && !reminderSettings(userId).emailEnabled && !unchangedEmailRules) {
    throw new HttpError(400, "Enable email delivery before adding an Email Reminder.");
  }
  const completionOnly = Object.keys(body).every((key) => key === "completed");
  if (existing?.seriesId && !completionOnly && body.scope === undefined) {
    throw new HttpError(400, "Choose whether to edit this Occurrence, following Occurrences, or the whole series.");
  }
  const scope = body.scope ?? (existing?.seriesId ? "occurrence" : "series");
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
    // Retain inherited split safeguards before any Occurrences can become standalone.
    db.prepare(`INSERT OR IGNORE INTO calendar_import_split_blocks(user_id,item_id,provider)
      SELECT i.user_id,i.id,b.provider FROM items i JOIN calendar_import_split_blocks b
        ON b.user_id=i.user_id AND b.item_id=? WHERE i.user_id=? AND i.series_root_id=?`).run(series,userId,series);
    if (scope === "following" && id !== series) {
      db.prepare(`INSERT OR IGNORE INTO calendar_import_split_blocks(user_id,item_id,provider)
        SELECT i.user_id,i.id,p.provider FROM items i JOIN (
          SELECT user_id,provider FROM calendar_imports WHERE user_id=? AND item_id=?
          UNION SELECT user_id,provider FROM calendar_import_split_blocks WHERE user_id=? AND item_id=?
        ) p ON p.user_id=i.user_id WHERE i.user_id=? AND i.series_root_id=?`)
        .run(userId,series,userId,series,userId,series);
    }
    const wholeSeries = scope === "series" || (scope === "following" && id === series);
    const root = db.prepare("SELECT scheduled_date FROM items WHERE user_id=? AND id=?").get(userId,series);
    const scheduleUnchanged = item.scheduledDate === existing?.scheduledDate && item.scheduledTime === existing?.scheduledTime;
    const recurrenceUnchanged = sameRecurrence(existing?.recurrence ?? null,item.recurrence);
    const preservesOccurrenceIdentity = scope === "series" && scheduleUnchanged && recurrenceUnchanged;
    const seriesStart = preservesOccurrenceIdentity ? String(root?.scheduled_date ?? item.scheduledDate) : item.scheduledDate;
    const dates = wholeSeries && !preservesOccurrenceIdentity && item.recurrence && seriesStart
      ? occurrenceDates(seriesStart, item.recurrence, reminderLeadDays(JSON.stringify(item.reminders)))
      : [];
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
        const followingDates = occurrenceDates(item.scheduledDate ?? existing.scheduledDate, splitRule, reminderLeadDays(JSON.stringify(item.reminders)));
        targets.forEach((target,index) => {
          if (index < followingDates.length) db.prepare("UPDATE items SET scheduled_date=?,series_root_id=?,occurrence_date=?,recurrence_json=? WHERE id=?")
            .run(followingDates[index],id,followingDates[index],index===0?JSON.stringify(splitRule):null,target.id);
          else db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId,target.id);
        });
        db.prepare(`INSERT OR IGNORE INTO calendar_import_split_blocks(user_id,item_id,provider)
          SELECT user_id,?,provider FROM calendar_import_metadata WHERE user_id=? AND item_id=?
          UNION SELECT user_id,?,provider FROM calendar_import_split_blocks WHERE user_id=? AND item_id=?`).run(id,userId,series,id,userId,series);
        db.prepare("UPDATE items SET recurrence_json=NULL,series_root_id=? WHERE user_id=? AND id=?").run(series,userId,series);
        db.prepare(`INSERT OR IGNORE INTO attachments(file_id,item_id,created_at,scope)
          SELECT file_id,?,created_at,'series' FROM attachments WHERE item_id=? AND scope='series'`).run(id,series);
      } else {
        for (const target of targets) db.prepare("UPDATE items SET series_root_id=?,recurrence_json=NULL WHERE user_id=? AND id=?").run(series,userId,target.id);
        db.prepare("UPDATE items SET series_root_id=?,recurrence_json=NULL WHERE user_id=? AND id=?").run(series,userId,series);
      }
    }
    if (wholeSeries && !item.recurrence) for (const target of targets) {
      if (String(target.id) !== series) db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId,target.id);
    }
    if (item.recurrence) ensureOccurrences(userId);
    return getItem(userId, id);
  }
  if (existing?.seriesId && scope === "occurrence" && id !== existing.seriesId) {
    write(id, false, item.scheduledDate);
    db.prepare("UPDATE items SET recurrence_json=NULL,series_root_id=?,occurrence_date=? WHERE user_id=? AND id=?")
      .run(existing.seriesId, existing.occurrenceDate ?? existing.scheduledDate, userId, id);
  } else write(id, !rootId || id === rootId);
  if (item.recurrence && !rootId) db.prepare("UPDATE items SET series_root_id=id,occurrence_date=scheduled_date,recurrence_json=? WHERE id=?").run(JSON.stringify(item.recurrence),id);
  if (existing?.recurrence && !item.recurrence) db.prepare("DELETE FROM items WHERE series_root_id=? AND id<>?").run(existing.id,id);
  if (item.recurrence) ensureOccurrences(userId);
  return getItem(userId, id);
}

export function deleteItem(userId: string, id: string, scope?: unknown) {
  const db = database();
  const item = getItem(userId, id);
  if (!item.seriesId) {
    db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, id);
    return;
  }
  if (scope !== "occurrence" && scope !== "following" && scope !== "series") {
    throw new HttpError(400, "Choose whether to delete this Occurrence, following Occurrences, or the whole series.");
  }
  const rootId = item.seriesId;
  if (scope === "series" || (scope === "following" && id === rootId)) {
    db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, rootId);
    return;
  }
  const selectedDate = item.occurrenceDate ?? item.scheduledDate;
  if (!selectedDate) throw new HttpError(400, "This Occurrence has no scheduled date.");
  if (scope === "occurrence") {
    db.prepare("INSERT OR IGNORE INTO occurrence_exclusions(user_id,series_root_id,occurrence_date) VALUES(?,?,?)").run(userId, rootId, selectedDate);
    if (id !== rootId) db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, id);
    else {
      const root = db.prepare("SELECT recurrence_json FROM items WHERE user_id=? AND id=?").get(userId, rootId);
      const rule = json<RecurrenceRule | null>(root?.recurrence_json, null);
      if (rule?.end.type === "count" && rule.end.count <= 1) db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, rootId);
    }
    return;
  }
  const previous = db.prepare(`SELECT occurrence_date FROM items WHERE user_id=? AND series_root_id=? AND occurrence_date<?
    ORDER BY occurrence_date DESC LIMIT 1`).get(userId, rootId, selectedDate);
  if (!previous) {
    db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(userId, rootId);
    return;
  }
  const root = db.prepare("SELECT recurrence_json FROM items WHERE user_id=? AND id=?").get(userId, rootId);
  const rule = json<RecurrenceRule | null>(root?.recurrence_json, null);
  if (!rule) throw new HttpError(400, "The Recurrence rule could not be found.");
  const shortened: RecurrenceRule = { ...rule, end: { type: "date", date: String(previous.occurrence_date) } };
  db.prepare("UPDATE items SET recurrence_json=?,updated_at=? WHERE user_id=? AND id=?")
    .run(JSON.stringify(shortened), new Date().toISOString(), userId, rootId);
  db.prepare("DELETE FROM items WHERE user_id=? AND series_root_id=? AND occurrence_date>=?").run(userId, rootId, selectedDate);
}
