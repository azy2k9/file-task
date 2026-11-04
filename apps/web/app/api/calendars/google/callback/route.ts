import { requestCookie, requireBrowserSession } from "@api/auth";
import { consumeGoogleAuthorization, finishGoogleAuthorization, GOOGLE_OAUTH_TRANSACTION_COOKIE } from "@api/calendars";
import { endpoint, HttpError, json } from "@api/http";
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

function finishResponse(response: NextResponse, request: Request, clearTransactionCookie: boolean) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (clearTransactionCookie) {
    response.cookies.set(GOOGLE_OAUTH_TRANSACTION_COOKIE, "", cookieOptions(request, 0));
  }
  return response;
}

function calendarRedirect(origin: string, status: "google-error" | "google-connected", request: Request, clearTransactionCookie: boolean) {
  return finishResponse(NextResponse.redirect(new URL(`/?calendar=${status}`, origin), 303), request, clearTransactionCookie);
}

function consumeCancellation(request: Request, state: string) {
  const nonce = requestCookie(request, GOOGLE_OAUTH_TRANSACTION_COOKIE);
  if (!nonce) return false;
  try {
    const transaction = consumeGoogleAuthorization(state, nonce, requireBrowserSession(request));
    return transaction.valid || transaction.clearCookie;
  } catch {
    return false;
  }
}

export const GET = endpoint(async (request) => {
  const url = new URL(request.url);
  const origin = process.env.FILETASKS_PUBLIC_URL || process.env.FILETASKS_ORIGIN || url.origin;
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.has("error") || !state || !code) {
    const clearTransactionCookie = state ? consumeCancellation(request, state) : false;
    return calendarRedirect(origin, "google-error", request, clearTransactionCookie);
  }

  const transaction = consumeGoogleAuthorization(
    state,
    requestCookie(request, GOOGLE_OAUTH_TRANSACTION_COOKIE),
    requireBrowserSession(request),
  );
  if (!transaction.valid) {
    const response = json({ error: "Google Calendar connection expired. Start connecting again." }, 400);
    return finishResponse(response, request, transaction.clearCookie);
  }

  try {
    await finishGoogleAuthorization(transaction.userId, code);
  } catch (error) {
    if (error instanceof HttpError) {
      return finishResponse(json({ error: error.message }, error.status), request, true);
    }
    throw error;
  }
  return calendarRedirect(origin, "google-connected", request, true);
});
