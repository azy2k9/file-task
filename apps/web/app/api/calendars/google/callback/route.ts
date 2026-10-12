import { finishGoogleAuthorization } from "@api/calendars";
import { endpoint } from "@api/http";

export const runtime = "nodejs";
export const GET = endpoint(async (request) => {
  const url = new URL(request.url);
  const origin = process.env.FILETASKS_PUBLIC_URL || process.env.FILETASKS_ORIGIN || url.origin;
  if (url.searchParams.has("error")) return Response.redirect(new URL("/?calendar=google-error", origin), 303);
  const state = url.searchParams.get("state") ?? ""; const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return Response.redirect(new URL("/?calendar=google-error", origin), 303);
  await finishGoogleAuthorization(state, code);
  return Response.redirect(new URL("/?calendar=google-connected", origin), 303);
});
