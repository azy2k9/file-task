import { database } from "./database";
import { HttpError } from "./http";
import type { ReminderRule } from "./items";

export interface ReminderSettings {
  taskReminders: ReminderRule[];
  eventReminders: ReminderRule[];
  pushEnabled: boolean;
  emailEnabled: boolean;
}

const EMPTY: ReminderSettings = { taskReminders: [], eventReminders: [], pushEnabled: false, emailEnabled: false };
function parse(raw: unknown, fallback: ReminderRule[] = []) {
  try { return typeof raw === "string" ? JSON.parse(raw) as ReminderRule[] : fallback; } catch { return fallback; }
}

export function reminderSettings(userId: string): ReminderSettings {
  const row = database().prepare("SELECT * FROM user_preferences WHERE user_id=?").get(userId);
  return row ? {
    taskReminders: parse(row.task_reminders), eventReminders: parse(row.event_reminders),
    pushEnabled: Boolean(row.push_enabled), emailEnabled: Boolean(row.email_enabled),
  } : EMPTY;
}

export function itemReminderDefaults(userId: string, kind: "task" | "event") {
  const settings = reminderSettings(userId);
  return kind === "task" ? settings.taskReminders : settings.eventReminders;
}

export function updateReminderSettings(userId: string, body: Record<string, unknown>) {
  const before = reminderSettings(userId);
  const allowed = ["taskReminders", "eventReminders", "pushEnabled", "emailEnabled", "applyToExisting"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, "Unknown Reminder setting.");
  const validate = (input: unknown, fallback: ReminderRule[]) => {
    if (!Array.isArray(input) || input.length > 20) throw new HttpError(400, "Add up to 20 Reminders.");
    return input.map((row) => {
      if (!row || typeof row !== "object") throw new HttpError(400, "Check the Reminder settings.");
      const rule = row as Record<string, unknown>;
      if (!(["notification", "email"].includes(String(rule.delivery)) && Number.isInteger(rule.amount)
        && Number(rule.amount) >= 0 && Number(rule.amount) <= 100_000
        && ["minutes", "hours", "days", "weeks", "months"].includes(String(rule.unit))
        && typeof rule.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time))) {
        throw new HttpError(400, "Check each Reminder's delivery, offset and time.");
      }
      if (rule.delivery === "email" && body.emailEnabled === false) throw new HttpError(400, "Enable email delivery before adding an Email Reminder.");
      return { delivery: rule.delivery as ReminderRule["delivery"], amount: Number(rule.amount), unit: rule.unit as ReminderRule["unit"], time: rule.time };
    });
  };
  const taskReminders = body.taskReminders === undefined ? before.taskReminders : validate(body.taskReminders, before.taskReminders);
  const eventReminders = body.eventReminders === undefined ? before.eventReminders : validate(body.eventReminders, before.eventReminders);
  const pushEnabled = body.pushEnabled === undefined ? before.pushEnabled : body.pushEnabled;
  const emailEnabled = body.emailEnabled === undefined ? before.emailEnabled : body.emailEnabled;
  if (typeof pushEnabled !== "boolean" || typeof emailEnabled !== "boolean") throw new HttpError(400, "Choose valid delivery settings.");
  if (!emailEnabled && [...taskReminders, ...eventReminders].some((rule) => rule.delivery === "email")) {
    throw new HttpError(400, "Remove Email Reminders before disabling email delivery.");
  }
  if (body.applyToExisting !== undefined && typeof body.applyToExisting !== "boolean") throw new HttpError(400, "Choose whether to apply these defaults to existing items.");
  const db = database();
  const write = db.prepare(`INSERT INTO user_preferences(user_id,task_reminders,event_reminders,push_enabled,email_enabled) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET task_reminders=excluded.task_reminders,event_reminders=excluded.event_reminders,
    push_enabled=excluded.push_enabled,email_enabled=excluded.email_enabled`);
  write.run(userId, JSON.stringify(taskReminders), JSON.stringify(eventReminders), Number(pushEnabled), Number(emailEnabled));
  if (body.applyToExisting === true) {
    const sync = db.prepare("UPDATE items SET reminders_json=? WHERE user_id=? AND kind=? AND uses_reminder_default=1");
    if (JSON.stringify(taskReminders) !== JSON.stringify(before.taskReminders)) sync.run(JSON.stringify(taskReminders), userId, "task");
    if (JSON.stringify(eventReminders) !== JSON.stringify(before.eventReminders)) sync.run(JSON.stringify(eventReminders), userId, "event");
  }
  return reminderSettings(userId);
}
