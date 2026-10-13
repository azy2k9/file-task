import { requireUser } from "@api/auth";
import { endpoint, json, readBody } from "@api/http";
import { HttpError } from "@api/http";
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
    const scope = new URL(request.url).searchParams.get("scope") ?? undefined;
    if (item.seriesId && !["occurrence", "following", "series"].includes(String(scope))) {
      throw new HttpError(400, "Choose whether to delete this Occurrence, following Occurrences, or the whole series.");
    }
    excludeDeletedCalendarImports(user.id,id);
    deleteItem(user.id, id, scope);
    if (item.kind === "event") await syncCalendars(user.id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  })(request);
}
