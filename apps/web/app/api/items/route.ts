import { requireUser } from "@api/auth";
import { endpoint, json, readBody } from "@api/http";
import { listItems, saveItem } from "@api/workspace";
import { syncCalendars } from "@api/calendars";
export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ items: listItems(requireUser(request).id) }));
export const POST = endpoint(async (request) => {
  const user = requireUser(request);
  const item = saveItem(user.id, await readBody(request));
  if (item.kind === "event") await syncCalendars(user.id);
  return json({ item }, 201);
});
