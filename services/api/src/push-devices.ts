import { randomUUID } from "node:crypto";
import { database } from "./database";
import { registerPushTarget, revokePushTarget } from "./delivery";
import { HttpError } from "./http";

export async function registerPushDevice(userId: string, body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => !["platform", "token"].includes(key))) throw new HttpError(400, "Check the device registration.");
  const platform = body.platform;
  const token = body.token;
  if (!(platform === "web" || platform === "ios" || platform === "android") || token === undefined || token === null
    || (typeof token !== "string" && (typeof token !== "object" || Array.isArray(token)))
    || JSON.stringify(token).length > 16_384) throw new HttpError(400, "Choose a supported device and provide its push token.");
  const providerId = await registerPushTarget(userId, platform, token);
  const db = database();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO push_devices(id,user_id,provider_id,platform,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,provider_id) DO UPDATE SET platform=excluded.platform,created_at=excluded.created_at`).run(id, userId, providerId, platform, createdAt);
  const row = db.prepare("SELECT id,platform,created_at AS createdAt FROM push_devices WHERE user_id=? AND provider_id=?").get(userId, providerId);
  return row;
}

export async function revokePushDevice(userId: string, id: string) {
  const db = database();
  const row = db.prepare("SELECT provider_id FROM push_devices WHERE user_id=? AND id=?").get(userId, id);
  if (!row) throw new HttpError(404, "This device could not be found.");
  await revokePushTarget(String(row.provider_id));
  db.prepare("DELETE FROM push_devices WHERE user_id=? AND id=?").run(userId, id);
}

