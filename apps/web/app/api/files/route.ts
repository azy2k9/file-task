import { requireUser } from "@api/auth";
import { createLinkFile, listFiles } from "@api/files";
import { endpoint, json, readBody } from "@api/http";

export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ files: listFiles(requireUser(request).id) }));
export const POST = endpoint(async (request) => {
  const user = requireUser(request);
  return json({ file: createLinkFile(user.id, await readBody(request)) }, 201);
});
