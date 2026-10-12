import { requireUser } from "@api/auth";
import { deleteFile } from "@api/files";
import { endpoint } from "@api/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    await deleteFile(requireUser(request).id, id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  })(request);
}
