import { requireUser } from "@api/auth";
import { endpoint, json, readBody } from "@api/http";
import { listItems, saveItem } from "@api/workspace";
export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ items: listItems(requireUser(request).id) }));
export const POST = endpoint(async (request) => {
  const user = requireUser(request);
  return json({ item: saveItem(user.id, await readBody(request)) }, 201);
});
