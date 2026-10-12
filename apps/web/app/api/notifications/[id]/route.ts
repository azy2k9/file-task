import { requireUser } from "@api/auth";
import { endpoint, json } from "@api/http";
import { markNotificationRead } from "@api/notifications";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (incoming) => {
    if (!markNotificationRead(requireUser(incoming).id,id)) return json({ error: "This Notification could not be found." },404);
    return json({ success: true });
  })(request);
}
