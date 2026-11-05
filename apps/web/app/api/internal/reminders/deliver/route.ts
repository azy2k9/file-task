import { timingSafeEqual } from "node:crypto";
import { processDueReminders } from "@api/notifications";
import { processDueCalendarSyncs } from "@api/calendars";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.FILETASKS_REMINDER_WORKER_SECRET;
  if (!secret) return Response.json({ error: "Reminder delivery is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(secret);
  const suppliedBytes = Buffer.from(supplied);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return Response.json({ error: "Worker authentication required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const [reminderResult, calendarResult] = await Promise.allSettled([processDueReminders(),processDueCalendarSyncs()]);
    if (reminderResult.status === "rejected" || calendarResult.status === "rejected") {
      throw new Error("Worker processing failed.");
    }
    const reminders = reminderResult.value;
    const calendarSync = calendarResult.value;
    return Response.json({ ...reminders, calendarSync }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Reminder processing failed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
