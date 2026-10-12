import { requireUser } from "@api/auth";
import { endpoint, json } from "@api/http";
import { listNotifications } from "@api/notifications";

export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ notifications: listNotifications(requireUser(request).id) }));
