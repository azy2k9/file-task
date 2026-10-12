import { requireUser } from "@api/auth";
import { openFile } from "@api/files";
import { endpoint, json } from "@api/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => json(await openFile(requireUser(request).id, id)))(request);
}
