import { authenticate } from "@api/auth";
import { endpoint } from "@api/http";
export const runtime = "nodejs";
export const POST = endpoint((request) => authenticate(request, true));
