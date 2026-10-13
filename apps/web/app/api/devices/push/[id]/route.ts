import { requireUser } from "@api/auth";
import { endpoint } from "@api/http";
import { revokePushDevice } from "@api/push-devices";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return endpoint(async (request) => {
    await revokePushDevice(requireUser(request).id, id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  })(request);
}
