import { requireUser } from "@api/auth";
import { completeUpload } from "@api/files";
import { endpoint, json } from "@api/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => json({ file: await completeUpload(requireUser(request).id, id) }))(request);
}
