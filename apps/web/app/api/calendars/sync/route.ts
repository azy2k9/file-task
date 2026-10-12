import { requireUser } from "@api/auth";
import { syncCalendars } from "@api/calendars";
import { endpoint, json } from "@api/http";

export const runtime = "nodejs";
export const POST = endpoint(async (request) => json(await syncCalendars(requireUser(request).id)));
