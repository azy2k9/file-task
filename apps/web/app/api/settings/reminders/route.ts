import { requireUser } from "@api/auth";
import { endpoint, json, readBody } from "@api/http";
import { reminderSettings, updateReminderSettings } from "@api/reminder-settings";

export const runtime = "nodejs";
export const GET = endpoint(async (request) => json({ settings: reminderSettings(requireUser(request).id) }));
export const PATCH = endpoint(async (request) => json({ settings: updateReminderSettings(requireUser(request).id, await readBody(request)) }));
