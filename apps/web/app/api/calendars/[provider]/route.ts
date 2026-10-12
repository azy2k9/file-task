import { requireUser } from "@api/auth";
import { disconnectCalendar } from "@api/calendars";
import { endpoint } from "@api/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ provider: string }> };
export async function DELETE(request: Request, context: Context) {
  const { provider } = await context.params;
  return endpoint(async (incoming) => {
    disconnectCalendar(requireUser(incoming).id, provider as "google" | "apple");
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  })(request);
}
