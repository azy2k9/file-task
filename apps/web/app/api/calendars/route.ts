import { requireUser } from "@api/auth";
import { calendarConnections, connectAppleCalendar } from "@api/calendars";
import { endpoint, json, readBody } from "@api/http";

export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ calendars: calendarConnections(requireUser(request).id) }));
export const POST = endpoint(async (request) => {
  const user = requireUser(request);
  return json({ calendar: await connectAppleCalendar(user.id, await readBody(request)) }, 201);
});
