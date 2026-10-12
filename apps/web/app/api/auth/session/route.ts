import { requireUser } from "@api/auth";
import { endpoint, json } from "@api/http";
export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ user: requireUser(request) }));
