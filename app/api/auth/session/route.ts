import { requireUser } from "@/lib/server/auth";
import { endpoint, json } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ user: requireUser(request) }));
