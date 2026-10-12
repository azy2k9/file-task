import { requireUser } from "@api/auth";
import { endpoint, json, readBody } from "@api/http";
import { deleteItem, getItem, saveItem } from "@api/workspace";
import { excludeDeletedCalendarImports, syncCalendars } from "@api/calendars";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => json({ item: getItem(requireUser(request).id, id) }))(request);
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    const user = requireUser(request);
    const item = saveItem(user.id, await readBody(request), id);
    if (item.kind === "event") await syncCalendars(user.id);
    return json({ item });
  })(request);
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    const user = requireUser(request);
    const item = getItem(user.id, id);
    excludeDeletedCalendarImports(user.id,id);
    deleteItem(user.id, id);
    if (item.kind === "event") await syncCalendars(user.id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  })(request);
}
