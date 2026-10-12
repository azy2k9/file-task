import { requireUser } from "@api/auth";
import { removeAttachment } from "@api/files";
import { endpoint } from "@api/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; itemId: string }> };
export async function DELETE(request: Request, context: Context) {
  const { id, itemId } = await context.params;
  return endpoint(async (request) => {
    removeAttachment(requireUser(request).id, id, itemId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  })(request);
}
