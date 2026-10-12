import { authenticate } from "@/lib/server/auth";
import { endpoint } from "@/lib/server/http";
export const runtime = "nodejs";
export const POST = endpoint((request) => authenticate(request, false));
