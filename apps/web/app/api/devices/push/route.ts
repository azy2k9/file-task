import { requireUser } from "@api/auth";
import { endpoint, json, readBody } from "@api/http";
import { registerPushDevice } from "@api/push-devices";

export const runtime = "nodejs";
export const POST = endpoint(async (request) => {
  const device = await registerPushDevice(requireUser(request).id, await readBody(request));
  return json({ device }, 201);
});
