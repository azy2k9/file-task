import { requireBrowserSession } from "@api/auth";
import { createGoogleAuthorization, GOOGLE_OAUTH_TRANSACTION_COOKIE } from "@api/calendars";
import { endpoint } from "@api/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const transactionCookiePath = "/api/calendars/google/callback";

function cookieOptions(request: Request, maxAge: number) {
  const origin = process.env.FILETASKS_ORIGIN || process.env.FILETASKS_PUBLIC_URL || request.url;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(origin).protocol === "https:",
    path: transactionCookiePath,
    maxAge,
  };
}

export const GET = endpoint(async (request) => {
  const session = requireBrowserSession(request);
  const { authorizationUrl, nonce } = createGoogleAuthorization(session.id, session.sessionHash);
  const response = NextResponse.redirect(authorizationUrl, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(GOOGLE_OAUTH_TRANSACTION_COOKIE, nonce, cookieOptions(request, 10 * 60));
  return response;
});
