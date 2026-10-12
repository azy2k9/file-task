import { logout } from "@api/auth";
import { endpoint } from "@api/http";
export const runtime = "nodejs";
export const POST = endpoint(async (request) => logout(request));
