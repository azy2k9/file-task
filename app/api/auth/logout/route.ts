import { logout } from "@/lib/server/auth";
import { endpoint } from "@/lib/server/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => logout(request));
