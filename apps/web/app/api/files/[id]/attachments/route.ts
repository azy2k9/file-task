import { requireUser } from "@api/auth";
import { attachFile } from "@api/files";
import { endpoint, json, readBody } from "@api/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    const body = await readBody(request);
    attachFile(requireUser(request).id, id, body.itemId);
    return json({ success: true }, 201);
  })(request);
}
