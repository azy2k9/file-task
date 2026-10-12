import { randomUUID } from "node:crypto";
import { database } from "./database";
import { listItems } from "./workspace";

function subtractMonths(date: Date, count: number) {
  const target = new Date(date);
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() - count);
  target.setUTCDate(Math.min(day, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
  return target;
}

function reminderDate(date: string, time: string | null, reminder: { amount: number; unit: string; time: string }) {
  const result = new Date(`${date}T${time ?? reminder.time}:00Z`);
  if (reminder.unit === "minutes") result.setUTCMinutes(result.getUTCMinutes() - reminder.amount);
  else if (reminder.unit === "hours") result.setUTCHours(result.getUTCHours() - reminder.amount);
  else if (reminder.unit === "days") result.setUTCDate(result.getUTCDate() - reminder.amount);
  else if (reminder.unit === "weeks") result.setUTCDate(result.getUTCDate() - reminder.amount * 7);
  else return subtractMonths(result, reminder.amount);
  return result;
}

export function listNotifications(userId: string) {
  const db = database(); const now = Date.now(); const lower = now - 30 * 86_400_000;
  const insert = db.prepare(`INSERT OR IGNORE INTO notifications(id,user_id,item_id,reminder_index,scheduled_at,title)
    VALUES(?,?,?,?,?,?)`);
  for (const item of listItems(userId)) {
    if (!item.scheduledDate) continue;
    item.reminders.forEach((reminder, index) => {
      if (reminder.delivery !== "notification") return;
      const scheduledAt = reminderDate(item.scheduledDate!, item.scheduledTime, reminder);
      if (scheduledAt.getTime() >= lower && scheduledAt.getTime() <= now) {
        insert.run(randomUUID(),userId,item.id,index,scheduledAt.toISOString(),item.title);
      }
    });
  }
  return db.prepare(`SELECT id,item_id AS itemId,title,scheduled_at AS scheduledAt,read_at AS readAt
    FROM notifications WHERE user_id=? AND read_at IS NULL ORDER BY scheduled_at DESC`).all(userId);
}

export function markNotificationRead(userId: string, id: string) {
  const result = database().prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND id=?").run(new Date().toISOString(),userId,id);
  return result.changes > 0;
}
