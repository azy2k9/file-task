import { requireUser } from "@api/auth";
import { createGoogleAuthorization } from "@api/calendars";
import { endpoint } from "@api/http";

export const runtime = "nodejs";
export const GET = endpoint(async (request) => Response.redirect(createGoogleAuthorization(requireUser(request).id), 303));
