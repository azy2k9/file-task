import { randomUUID } from "node:crypto";
import { database } from "./database";
import { deliveryAvailability, sendReminderDelivery } from "./delivery";
import { listItems } from "./workspace";
import { reminderSettings } from "./reminder-settings";
import type { ReminderRule, WorkspaceItem } from "./items";

function zonedWallTime(date: string, time: string) {
  const zone = process.env.FILETASKS_TIME_ZONE || "UTC";
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallAsUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const representedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
    const adjustment = wallAsUtc - representedAsUtc;
    if (adjustment === 0) break;
    instant += adjustment;
  }
  return new Date(instant);
}

function subtractMonths(date: Date, count: number) {
  const target = new Date(date);
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() - count);
  target.setUTCDate(Math.min(day, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
  return target;
}

function reminderDate(item: WorkspaceItem, reminder: ReminderRule) {
  if (!item.scheduledDate) return null;
  const dateBased = ["days", "weeks", "months"].includes(reminder.unit);
  if (dateBased) {
    const targetDate = new Date(`${item.scheduledDate}T00:00:00Z`);
    if (reminder.unit === "days") targetDate.setUTCDate(targetDate.getUTCDate() - reminder.amount);
    else if (reminder.unit === "weeks") targetDate.setUTCDate(targetDate.getUTCDate() - reminder.amount * 7);
    else {
      const previous = subtractMonths(targetDate, reminder.amount);
      targetDate.setTime(previous.getTime());
    }
    return zonedWallTime(targetDate.toISOString().slice(0, 10), reminder.time);
  }
  const result = zonedWallTime(item.scheduledDate, item.scheduledTime ?? reminder.time);
  if (reminder.unit === "minutes") result.setTime(result.getTime() - reminder.amount * 60_000);
  else result.setTime(result.getTime() - reminder.amount * 3_600_000);
  return result;
}

function scheduleExternalDelivery(
  userId: string,
  item: WorkspaceItem,
  reminderIndex: number,
  channel: "email" | "push",
  targetId: string,
  scheduledAt: string,
  now: number,
) {
  const db = database();
  db.prepare(`INSERT OR IGNORE INTO reminder_deliveries
    (id,user_id,item_id,reminder_index,channel,target_id,scheduled_at,next_attempt_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), userId, item.id, reminderIndex, channel, targetId, scheduledAt, now);
  return db.prepare(`SELECT id FROM reminder_deliveries
    WHERE item_id=? AND reminder_index=? AND channel=? AND target_id=? AND scheduled_at=?`).get(item.id, reminderIndex, channel, targetId, scheduledAt)?.id as string | undefined;
}

function deliverableJobs(userId: string, items: WorkspaceItem[], now: number) {
  const db = database();
  const settings = reminderSettings(userId);
  const devices = settings.pushEnabled
    ? db.prepare("SELECT id,provider_id AS providerId FROM push_devices WHERE user_id=?").all(userId) as { id: string; providerId: string }[]
    : [];
  const currentJobIds = new Set<string>();
  for (const item of items) {
    if (!item.scheduledDate) continue;
    item.reminders.forEach((reminder, reminderIndex) => {
      const due = reminderDate(item, reminder);
      if (!due || due.getTime() > now) return;
      const scheduledAt = due.toISOString();
      if (reminder.delivery === "notification") {
        db.prepare(`INSERT OR IGNORE INTO notifications(id,user_id,item_id,reminder_index,scheduled_at,title)
          VALUES(?,?,?,?,?,?)`).run(randomUUID(), userId, item.id, reminderIndex, scheduledAt, item.title);
      }
      if (reminder.delivery === "email" && settings.emailEnabled && deliveryAvailability().emailAvailable) {
        const id = scheduleExternalDelivery(userId, item, reminderIndex, "email", "", scheduledAt, now);
        if (id) currentJobIds.add(id);
      }
      if (settings.pushEnabled && deliveryAvailability().pushAvailable) {
        for (const device of devices) {
          const id = scheduleExternalDelivery(userId, item, reminderIndex, "push", device.id, scheduledAt, now);
          if (id) currentJobIds.add(id);
        }
      }
    });
  }
  return currentJobIds;
}

export async function processDueReminders() {
  const db = database();
  const now = Date.now();
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  const accounts = db.prepare("SELECT id FROM users").all() as { id: string }[];
  const pendingIds = new Set<string>();
  for (const { id: userId } of accounts) {
    for (const id of deliverableJobs(userId, listItems(userId), now)) pendingIds.add(id);
  }
  if (!pendingIds.size) return { attempted, sent, failed };
  const pending = db.prepare(`SELECT d.id,d.channel,d.target_id AS targetId,d.item_id AS itemId,
      d.scheduled_at AS scheduledAt,d.reminder_index AS reminderIndex,d.attempts,
      i.title,i.reminders_json AS reminders,u.email,p.provider_id AS providerId
    FROM reminder_deliveries d JOIN items i ON i.id=d.item_id JOIN users u ON u.id=d.user_id
    LEFT JOIN push_devices p ON p.id=d.target_id AND p.user_id=d.user_id
    WHERE d.status='pending' AND d.next_attempt_at<=?`).all(now) as {
      id: string; channel: "email" | "push"; targetId: string; itemId: string; scheduledAt: string;
      reminderIndex: number; attempts: number; title: string; reminders: string; email: string; providerId: string | null;
    }[];
  for (const job of pending) {
    if (!pendingIds.has(job.id)) continue;
    attempted++;
    try {
      if (job.channel === "push" && !job.providerId) throw new Error("The registered push device is no longer available.");
      const rules = JSON.parse(job.reminders) as ReminderRule[];
      const reminder = rules[job.reminderIndex];
      if (!reminder) continue;
      const payload = {
        recipient: job.channel === "email" ? { email: job.email } : undefined,
        registrationId: job.channel === "push" ? job.providerId : undefined,
        reminder: {
          itemId: job.itemId,
          title: job.title,
          scheduledAt: job.scheduledAt,
          rule: reminder,
        },
      };
      await sendReminderDelivery(job.channel, payload, job.id);
      db.prepare("UPDATE reminder_deliveries SET status='sent',sent_at=?,attempts=attempts+1,last_error=NULL WHERE id=? AND status='pending'")
        .run(new Date().toISOString(), job.id);
      sent++;
    } catch (error) {
      failed++;
      const attempts = Number(job.attempts) + 1;
      const retryBase = Math.max(1_000, Number(process.env.FILETASKS_REMINDER_RETRY_BASE_MS) || 30_000);
      const retryDelay = Math.min(3_600_000, retryBase * 2 ** Math.min(attempts - 1, 7));
      const message = error instanceof Error ? error.message.slice(0, 500) : "Delivery failed.";
      db.prepare("UPDATE reminder_deliveries SET attempts=?,next_attempt_at=?,last_error=? WHERE id=? AND status='pending'")
        .run(attempts, now + retryDelay, message, job.id);
    }
  }
  return { attempted, sent, failed };
}

export function listNotifications(userId: string) {
  return database().prepare(`SELECT id,item_id AS itemId,title,scheduled_at AS scheduledAt,read_at AS readAt
    FROM notifications WHERE user_id=? AND read_at IS NULL ORDER BY scheduled_at DESC`).all(userId);
}

export function markNotificationRead(userId: string, id: string) {
  const result = database().prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND id=?").run(new Date().toISOString(), userId, id);
  return result.changes > 0;
}
