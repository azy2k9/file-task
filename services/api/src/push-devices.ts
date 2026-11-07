import { randomUUID } from "node:crypto";
import { database } from "./database";
import { registerPushTarget, revokePushTarget } from "./delivery";
import { HttpError } from "./http";
import { nowMs } from "./clock";

export async function registerPushDevice(userId: string, body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => !["platform", "token"].includes(key))) throw new HttpError(400, "Check the device registration.");
  const platform = body.platform;
  const token = body.token;
  if (!(platform === "web" || platform === "ios" || platform === "android") || token === undefined || token === null
    || (typeof token !== "string" && (typeof token !== "object" || Array.isArray(token)))
    || JSON.stringify(token).length > 16_384) throw new HttpError(400, "Choose a supported device and provide its push token.");
  let providerId = await registerPushTarget(userId, platform, token);
  const db = database();
  return withPushOperationLock(providerId, async () => {
    // If cleanup completed while the provider's initial registration request was
    // in flight, restore the registration under the same cross-process lock.
    // A queued (not yet processed) cleanup is instead cancelled below.
    const wasRevoked = db.prepare("SELECT 1 FROM push_cleanup_completed WHERE registration_id=?").get(providerId);
    if (wasRevoked) {
      const restoredProviderId = await registerPushTarget(userId, platform, token);
      if (restoredProviderId !== providerId) {
        throw new HttpError(502, "The push service changed this device's registration identity while restoring it.");
      }
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM push_cleanup_jobs WHERE registration_id=?").run(providerId);
      db.prepare("DELETE FROM push_cleanup_completed WHERE registration_id=?").run(providerId);
      db.prepare(`INSERT INTO push_devices(id,user_id,provider_id,platform,created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,provider_id) DO UPDATE SET platform=excluded.platform,created_at=excluded.created_at`).run(id, userId, providerId, platform, createdAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return db.prepare("SELECT id,platform,created_at AS createdAt FROM push_devices WHERE user_id=? AND provider_id=?").get(userId, providerId);
  });
}

export async function revokePushDevice(userId: string, id: string) {
  const db = database();
  const row = db.prepare("SELECT provider_id FROM push_devices WHERE user_id=? AND id=?").get(userId, id);
  if (!row) throw new HttpError(404, "This device could not be found.");
  const registrationId = String(row.provider_id);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO push_cleanup_jobs(registration_id,created_at,next_attempt_at)
      VALUES(?,?,?) ON CONFLICT(registration_id) DO NOTHING`).run(registrationId, nowMs(), nowMs());
    db.prepare("DELETE FROM reminder_deliveries WHERE channel='push' AND target_id=? AND status='pending'").run(id);
    db.prepare("DELETE FROM push_devices WHERE user_id=? AND id=?").run(userId, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function processPendingPushCleanup() {
  const db = database();
  const currentTime = nowMs();
  const pending = db.prepare(`SELECT registration_id AS registrationId,attempts FROM push_cleanup_jobs
    WHERE next_attempt_at<=? ORDER BY created_at LIMIT 100`).all(currentTime) as {
      registrationId: string; attempts: number;
    }[];
  let attempted = 0;
  let completed = 0;
  for (const job of pending) {
    try {
      await withPushOperationLock(job.registrationId, async () => {
        const currentJob = db.prepare("SELECT attempts FROM push_cleanup_jobs WHERE registration_id=? AND next_attempt_at<=?")
          .get(job.registrationId, nowMs()) as { attempts: number } | undefined;
        if (!currentJob) return;

        // A device may have been recreated before the worker acquired its lock.
        // Never revoke a provider identity that is currently attached to a user.
        const activeDevice = db.prepare("SELECT 1 FROM push_devices WHERE provider_id=? LIMIT 1").get(job.registrationId);
        if (activeDevice) {
          db.prepare("DELETE FROM push_cleanup_jobs WHERE registration_id=?").run(job.registrationId);
          return;
        }

        attempted++;
        await revokePushTarget(job.registrationId);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM push_cleanup_jobs WHERE registration_id=?").run(job.registrationId);
          db.prepare(`INSERT INTO push_cleanup_completed(registration_id,completed_at) VALUES(?,?)
            ON CONFLICT(registration_id) DO UPDATE SET completed_at=excluded.completed_at`).run(job.registrationId, nowMs());
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        completed++;
      });
    } catch (error) {
      const attempts = Number(job.attempts) + 1;
      const retryBase = Math.max(1_000, Number(process.env.FILETASKS_REMINDER_RETRY_BASE_MS) || 30_000);
      const retryDelay = Math.min(3_600_000, retryBase * 2 ** Math.min(attempts - 1, 7));
      const message = error instanceof Error ? error.message.slice(0, 500) : "Push cleanup failed.";
      db.prepare(`UPDATE push_cleanup_jobs SET attempts=?,next_attempt_at=?,last_error=?
        WHERE registration_id=?`).run(attempts, nowMs() + retryDelay, message, job.registrationId);
    }
  }
  return { attempted, completed };
}

async function withPushOperationLock<T>(registrationId: string, operation: () => Promise<T>): Promise<T> {
  const db = database();
  const ownerId = randomUUID();
  const startedAt = Date.now();
  const waitLimitMs = 90_000;
  const leaseMs = 60_000;

  while (true) {
    const currentTime = Date.now();
    db.prepare(`INSERT INTO push_operation_locks(registration_id,owner_id,lease_until)
      VALUES(?,?,0) ON CONFLICT(registration_id) DO NOTHING`).run(registrationId, ownerId);
    const acquired = db.prepare(`UPDATE push_operation_locks SET owner_id=?,lease_until=?
      WHERE registration_id=? AND lease_until<=?`).run(ownerId, currentTime + leaseMs, registrationId, currentTime);
    if (Number(acquired.changes) === 1) break;
    if (currentTime - startedAt >= waitLimitMs) throw new HttpError(503, "Push registration cleanup is still in progress. Try again shortly.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    return await operation();
  } finally {
    db.prepare("DELETE FROM push_operation_locks WHERE registration_id=? AND owner_id=?").run(registrationId, ownerId);
  }
}

