import { requireUser } from "@api/auth";
import { beginUpload } from "@api/files";
import { endpoint, json, readBody } from "@api/http";

export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const user = requireUser(request);
  return json(await beginUpload(user.id, await readBody(request)), 201);
});
