import { requireUser } from "@/lib/server/auth";
import { endpoint, json, readBody } from "@/lib/server/http";
import { deleteItem, getItem, saveItem } from "@/lib/server/workspace";
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
    return json({ item: saveItem(user.id, await readBody(request), id) });
  })(request);
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    deleteItem(requireUser(request).id, id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  })(request);
}
