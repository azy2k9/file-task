import { createHash } from "node:crypto";
import { HttpError } from "./http";

export type DeliveryChannel = "email" | "push";

function serviceUrl(channel: DeliveryChannel) {
  const raw = process.env[channel === "email" ? "FILETASKS_EMAIL_DELIVERY_URL" : "FILETASKS_PUSH_DELIVERY_URL"];
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) return null;
    return url;
  } catch {
    return null;
  }
}

export function deliveryAvailability() {
  return { emailAvailable: serviceUrl("email") !== null, pushAvailable: serviceUrl("push") !== null };
}

async function postTo(channel: DeliveryChannel, payload: Record<string, unknown>, idempotencyKey: string) {
  const url = serviceUrl(channel);
  if (!url) throw new Error(`${channel} delivery is not configured.`);
  const token = process.env[channel === "email" ? "FILETASKS_EMAIL_DELIVERY_TOKEN" : "FILETASKS_PUSH_DELIVERY_TOKEN"];
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${channel} delivery service returned HTTP ${response.status}.`);
  return response;
}

export async function sendReminderDelivery(channel: DeliveryChannel, payload: Record<string, unknown>, idempotencyKey: string) {
  await postTo(channel, { operation: "deliver", ...payload }, idempotencyKey);
}

export async function registerPushTarget(userId: string, platform: "web" | "ios" | "android", token: unknown) {
  if (!serviceUrl("push")) throw new HttpError(503, "Push delivery is not available on this server.");
  const fingerprint = createHash("sha256").update(`${userId}\n${platform}\n${JSON.stringify(token)}`).digest("hex");
  let response: Response;
  try {
    response = await postTo("push", { operation: "register", userId, platform, token }, `register-${fingerprint}`);
  } catch {
    throw new HttpError(502, "The push service could not register this device.");
  }
  const result = await response.json().catch(() => null) as { registrationId?: unknown } | null;
  if (!result || typeof result.registrationId !== "string" || !result.registrationId || result.registrationId.length > 500) {
    throw new HttpError(502, "The push service returned an invalid device registration.");
  }
  return result.registrationId;
}

export async function revokePushTarget(registrationId: string) {
  if (!serviceUrl("push")) throw new HttpError(503, "Push delivery is not available on this server.");
  try {
    await postTo("push", { operation: "revoke", registrationId }, `revoke-${registrationId}`);
  } catch {
    throw new HttpError(502, "The push service could not revoke this device.");
  }
}

