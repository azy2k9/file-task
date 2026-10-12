import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { database } from "./database";
import { HttpError, json, readBody } from "./http";

const derive = promisify(scrypt);
const sessionSeconds = 60 * 60 * 24 * 30;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export function requestToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization) return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("filetasks_session="))?.slice("filetasks_session=".length) || "";
}

export function requireUser(request: Request): { id: string; email: string } {
  const token = requestToken(request);
  const user = token && database().prepare(`SELECT users.id, users.email FROM sessions
    JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?`)
    .get(digest(token), Date.now());
  if (!user) throw new HttpError(401, "Please sign in to continue.");
  return { id: String(user.id), email: String(user.email) };
}

function setSessionCookie(response: NextResponse, token: string, request: Request, maxAge = sessionSeconds) {
  const origin = process.env.FILETASKS_ORIGIN || request.url;
  response.cookies.set("filetasks_session", token, {
    httpOnly: true, sameSite: "lax", secure: new URL(origin).protocol === "https:", path: "/", maxAge,
  });
}

export async function authenticate(request: Request, register: boolean) {
  const body = await readBody(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body.password;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new HttpError(400, "Use a password between 12 and 1024 characters.");
  }
  const db = database();
  db.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").run(Date.now());
  const attempts = db.prepare("SELECT attempts FROM login_attempts WHERE email = ?").get(email);
  if (attempts && Number(attempts.attempts) >= 10) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  const existing = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
  let id: string;
  if (register) {
    if (existing) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    const salt = randomBytes(16).toString("hex");
    const key = await derive(password, salt, 64) as Buffer;
    id = randomUUID();
    // Concurrent registration can finish password hashing after another request saved the email.
    const inserted = db.prepare("INSERT OR IGNORE INTO users(id,email,password_hash) VALUES(?,?,?)")
      .run(id, email, `${salt}:${key.toString("hex")}`);
    if (!inserted.changes) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  } else {
    const [salt, stored] = String(existing?.password_hash || `${"0".repeat(32)}:${"0".repeat(128)}`).split(":");
    const key = await derive(password, salt, 64) as Buffer;
    if (!existing || !timingSafeEqual(key, Buffer.from(stored, "hex"))) {
      db.prepare(`INSERT INTO login_attempts(email,attempts,expires_at) VALUES(?,1,?)
        ON CONFLICT(email) DO UPDATE SET attempts = attempts + 1`).run(email, Date.now() + 15 * 60_000);
      throw new HttpError(401, "Email or password is incorrect.");
    }
    id = String(existing.id);
  }
  db.prepare("DELETE FROM login_attempts WHERE email = ?").run(email);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .run(digest(token), id, Date.now() + sessionSeconds * 1000);
  const response = json({ token, user: { id, email } }, register ? 201 : 200);
  setSessionCookie(response, token, request);
  return response;
}

export function logout(request: Request) {
  const token = requestToken(request);
  if (token) database().prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  setSessionCookie(response, "", request, 0);
  return response;
}
