import { sameRecurrence } from "./items";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { database } from "./database";
import { HttpError } from "./http";
import type { BrowserSession } from "./auth";
import { calendarSyncLimitations, getItem, listItems, listItemsForCalendarSync } from "./workspace";
import type { RecurrenceRule } from "./items";
import { saveItem } from "./workspace";
import { now, nowMs } from "./clock";
import {
  beginCalendarSync,
  calendarSyncDeliveryStatus,
  completeCalendarSync,
  dueCalendarSyncUsers,
  failCalendarSync,
  type CalendarSyncProvider,
} from "./calendar-sync-state";

type Provider = "google" | "apple";
type Connection = { connection_scope_id: string | null; credential_generation_id: string; user_id: string; provider: Provider; account_label: string; access_token: string | null; refresh_token: string | null; calendar_url: string | null; expires_at: number | null };
type EventItem = ReturnType<typeof listItems>[number];
type GoogleOAuthTransaction = { user_id: string; nonce_hash: string; session_hash: string; expires_at: number };
type ProviderTiming = {
  kind: "allDay" | "timed";
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  startZone?: string;
  endZone?: string;
  startOffsetMinutes?: number;
  endOffsetMinutes?: number;
  startUtc?: boolean;
  endUtc?: boolean;
  durationMs?: number;
  dayCount?: number;
};
type ImportMetadataInput = {
  accountId: string;
  timing: ProviderTiming;
  state: "supported" | "limited";
  limitationCode?: string;
  limitationMessage?: string;
  sourcePayload?: Record<string, unknown>;
  sourceIcs?: string;
  excludedDates?: string[];
};
type ImportMetadataRow = {
  user_id: string;
  provider: Provider;
  external_id: string;
  item_id: string;
  source_account_id: string;
  source_payload_json: string | null;
  source_ics: string | null;
  timing_json: string;
  baseline_json: string;
  state: "supported" | "limited";
  limitation_code: string | null;
  limitation_message: string | null;
};

export const GOOGLE_OAUTH_TRANSACTION_COOKIE = "filetasks_google_oauth";
const googleOAuthTransactionLifetimeMs = 10 * 60_000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function sameDigest(left: string, right: string) {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function googleApiUrl(path: string) {
  const origin = (process.env.FILETASKS_GOOGLE_API_ORIGIN || "https://www.googleapis.com").replace(/\/+$/, "");
  return new URL(path.replace(/^\/+/, ""), `${origin}/`);
}

function googleTokenUrl() {
  return process.env.FILETASKS_GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
}

function appleCalDavOrigin() {
  return process.env.FILETASKS_APPLE_CALDAV_ORIGIN || "https://caldav.icloud.com/";
}

function encryptionKey() {
  const raw = process.env.FILETASKS_CALENDAR_ENCRYPTION_KEY;
  if (!raw) throw new HttpError(503, "Calendar connections need FILETASKS_CALENDAR_ENCRYPTION_KEY configured on the server.");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new HttpError(503, "FILETASKS_CALENDAR_ENCRYPTION_KEY must be a 32-byte base64 or hex key.");
  return key;
}

function isAppleCalDavHost(hostname: string) {
  const configuredHost = process.env.FILETASKS_APPLE_CALDAV_ORIGIN ? new URL(process.env.FILETASKS_APPLE_CALDAV_ORIGIN).hostname : null;
  return hostname === configuredHost || hostname === "icloud.com" || hostname.endsWith(".icloud.com") || hostname === "apple.com" || hostname.endsWith(".apple.com");
}

function isAllowedAppleUrl(url: URL) {
  const configured = process.env.FILETASKS_APPLE_CALDAV_ORIGIN ? new URL(process.env.FILETASKS_APPLE_CALDAV_ORIGIN) : null;
  const configuredOrigin = configured && url.origin === configured.origin;
  return isAppleCalDavHost(url.hostname) && (url.protocol === "https:" || configuredOrigin);
}

function encrypt(value: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decrypt(value: string) {
  try {
    const [iv, tag, encrypted] = value.split("."); const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new HttpError(503, "Calendar credentials could not be decrypted. Check the server encryption key."); }
}

export function calendarConnections(userId: string) {
  return database().prepare("SELECT provider,account_label,connected_at FROM calendar_connections WHERE user_id=? ORDER BY provider").all(userId);
}

export function createGoogleAuthorization(userId: string, sessionHash: string) {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !redirectUri) throw new HttpError(503, "Configure Google Calendar OAuth on the server before connecting an account.");
  if (!/^[0-9a-f]{64}$/i.test(sessionHash)) throw new HttpError(401, "Please sign in to continue.");
  encryptionKey();
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = nowMs() + googleOAuthTransactionLifetimeMs;
  const db = database();
  db.prepare("DELETE FROM calendar_oauth_transactions WHERE expires_at <= ?").run(nowMs());
  db.prepare(`INSERT INTO calendar_oauth_transactions(state_hash,nonce_hash,session_hash,user_id,expires_at)
    VALUES(?,?,?,?,?)`).run(sha256(state),sha256(nonce),sessionHash,userId,expiresAt);
  const url = new URL(process.env.FILETASKS_GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId); url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code"); url.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly");
  url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); url.searchParams.set("state", state);
  return { authorizationUrl: url.toString(), nonce };
}

export function consumeGoogleAuthorization(state: string, nonce: string | null, session: BrowserSession) {
  const invalid = { valid: false as const, clearCookie: false };
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return invalid;
  const db = database();
  const stateHash = sha256(state);
  const transaction = db.prepare(`SELECT user_id,nonce_hash,session_hash,expires_at
    FROM calendar_oauth_transactions WHERE state_hash=?`).get(stateHash) as GoogleOAuthTransaction | undefined;
  if (!transaction) return invalid;

  // Check the browser nonce and the exact FileTasks session before consuming the
  // transaction. A copied authorization URL in another browser cannot complete it.
  if (!sameDigest(transaction.nonce_hash, sha256(nonce))
    || !sameDigest(transaction.session_hash, session.sessionHash)
    || transaction.user_id !== session.id) return invalid;

  const expiresAt = Number(transaction.expires_at);
  if (expiresAt <= nowMs()) {
    db.prepare("DELETE FROM calendar_oauth_transactions WHERE state_hash=?").run(stateHash);
    return { valid: false as const, clearCookie: true };
  }

  const deleted = db.prepare(`DELETE FROM calendar_oauth_transactions
    WHERE state_hash=? AND nonce_hash=? AND session_hash=? AND user_id=? AND expires_at>?`)
    .run(stateHash,transaction.nonce_hash,transaction.session_hash,session.id,nowMs());
  if (!deleted.changes) return invalid;
  return { valid: true as const, clearCookie: true, userId: session.id };
}

export async function finishGoogleAuthorization(userId: string, code: string) {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID!; const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI!;
  if (!clientSecret) throw new HttpError(503, "Configure Google Calendar OAuth on the server before connecting an account.");
  const tokenResponse = await fetch(googleTokenUrl(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
  if (!tokenResponse.ok) throw new HttpError(502, "Google Calendar could not complete the connection.");
  const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tokens.access_token) throw new HttpError(502, "Google did not return an access token.");
  const calendarResponse = await fetch(googleApiUrl("calendar/v3/calendars/primary"), { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!calendarResponse.ok) throw new HttpError(502, "Could not read the primary Google Calendar.");
  const calendar = await calendarResponse.json() as { id?: string; summary?: string };
  const db = database();
  const refreshCipher = tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined;
  if (!refreshCipher || !calendar.id) throw new HttpError(502, "Google did not provide a reusable calendar connection.");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Serialize destination comparison with the credential/scope replacement. OAuth
    // network work is complete, so the lock is held only for these local statements.
    const previous = db.prepare("SELECT calendar_url,connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='google'")
      .get(userId) as { calendar_url: string | null; connection_scope_id: string | null } | undefined;
    const concreteId = (value: string | null | undefined): value is string => Boolean(value && value.trim() && value !== "primary");
    const sameVerifiedDestination = concreteId(previous?.calendar_url) && concreteId(calendar.id)
      && previous.calendar_url === calendar.id && Boolean(previous.connection_scope_id?.trim());
    const connectionScopeId = sameVerifiedDestination ? previous!.connection_scope_id! : randomUUID();
    const credentialGenerationId = randomUUID();
    db.prepare(`INSERT INTO calendar_connections(user_id,provider,account_label,access_token,refresh_token,calendar_url,connected_at,expires_at,connection_scope_id,credential_generation_id)
      VALUES(?,'google',?,?,?,?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET account_label=excluded.account_label,
      access_token=excluded.access_token,refresh_token=excluded.refresh_token,calendar_url=excluded.calendar_url,
      connected_at=excluded.connected_at,expires_at=excluded.expires_at,connection_scope_id=excluded.connection_scope_id,
      credential_generation_id=excluded.credential_generation_id,legacy_identity_eligible=0`).run(userId,calendar.summary ?? "Google Calendar",encrypt(tokens.access_token),refreshCipher,calendar.id,now().toISOString(),nowMs()+Math.max(60,tokens.expires_in ?? 3600)*1000-60_000,connectionScopeId,credentialGenerationId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); }
    catch (rollbackError) { throw new AggregateError([error,rollbackError],"Google Calendar connection update could not be rolled back."); }
    throw error;
  }
}

export async function connectAppleCalendar(userId: string, body: Record<string, unknown>) {
  if (typeof body.username !== "string" || !body.username.trim() || typeof body.password !== "string" || !body.password
    || (body.calendarUrl !== undefined && typeof body.calendarUrl !== "string")) throw new HttpError(400, "Enter your Apple ID and app-specific password.");
  const authorization = `Basic ${Buffer.from(`${body.username.trim()}:${body.password}`).toString("base64")}`;
  let calendarUrl = typeof body.calendarUrl === "string" ? body.calendarUrl.trim() : "";
  let discoveredLabel: string | null = null;
  if (!calendarUrl) {
    const propfind = (properties: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${properties}</d:prop></d:propfind>`;
    const discovery = await fetch(appleCalDavOrigin(),{method:"PROPFIND",headers:{Authorization:authorization,Depth:"0","Content-Type":"application/xml; charset=utf-8"},body:propfind("<d:current-user-principal/>")});
    if (!isAppleCalDavHost(new URL(discovery.url).hostname)) throw new HttpError(502,"Apple CalDAV redirected to an untrusted host.");
    if (discovery.status === 401 || discovery.status === 403) throw new HttpError(400,"Apple Calendar rejected the Apple ID or app-specific password.");
    if (!discovery.ok && discovery.status !== 207) throw new HttpError(502,"Apple CalDAV could not discover the account calendar.");
    const principalXml = await discovery.text(); const principalHref = principalXml.match(/<(?:[\w.-]+:)?current-user-principal[^>]*>[\s\S]*?<(?:[\w.-]+:)?href[^>]*>([^<]+)</i)?.[1];
    if (!principalHref) throw new HttpError(502,"Apple CalDAV did not return an account principal.");
    const principalUrl = new URL(xmlDecode(principalHref),discovery.url);
    if (!isAppleCalDavHost(principalUrl.hostname)) throw new HttpError(502,"Apple CalDAV returned an untrusted account principal.");
    const principalResponse = await fetch(principalUrl,{method:"PROPFIND",headers:{Authorization:authorization,Depth:"0","Content-Type":"application/xml; charset=utf-8"},body:propfind("<c:calendar-home-set/>")});
    if (!principalResponse.ok && principalResponse.status !== 207) throw new HttpError(502,"Apple CalDAV could not find the account calendar collection.");
    const homeHref = (await principalResponse.text()).match(/<(?:[\w.-]+:)?calendar-home-set[^>]*>[\s\S]*?<(?:[\w.-]+:)?href[^>]*>([^<]+)</i)?.[1];
    if (!homeHref) throw new HttpError(502,"Apple CalDAV did not return a calendar collection.");
    const homeUrl = new URL(xmlDecode(homeHref),principalUrl);
    if (!isAppleCalDavHost(homeUrl.hostname)) throw new HttpError(502,"Apple CalDAV returned an untrusted calendar location.");
    const homeResponse = await fetch(homeUrl,{method:"PROPFIND",headers:{Authorization:authorization,Depth:"1","Content-Type":"application/xml; charset=utf-8"},body:propfind("<d:resourcetype/><d:displayname/>")});
    if (!homeResponse.ok && homeResponse.status !== 207) throw new HttpError(502,"Apple CalDAV could not list calendars.");
    const homeXml = await homeResponse.text();
    for (const match of homeXml.matchAll(/<(?:[\w.-]+:)?response[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi)) {
      if (!/<(?:[\w.-]+:)?calendar\s*\/?\s*>/i.test(match[1])) continue;
      const href = match[1].match(/<(?:[\w.-]+:)?href[^>]*>([^<]+)</i)?.[1];
      if (!href) continue;
      calendarUrl = new URL(xmlDecode(href),homeUrl).toString();
      if (!isAppleCalDavHost(new URL(calendarUrl).hostname)) throw new HttpError(502,"Apple CalDAV returned an untrusted calendar location.");
      discoveredLabel = match[1].match(/<(?:[\w.-]+:)?displayname[^>]*>([\s\S]*?)<\//i)?.[1] ? xmlDecode(match[1].match(/<(?:[\w.-]+:)?displayname[^>]*>([\s\S]*?)<\//i)![1]) : null;
      break;
    }
    if (!calendarUrl) throw new HttpError(502,"Apple CalDAV did not find a calendar to connect.");
  }
  let url: URL;
  try { url = new URL(calendarUrl); } catch { throw new HttpError(400,"Enter a valid CalDAV calendar URL."); }
  if (!isAllowedAppleUrl(url)) throw new HttpError(400,"Use an HTTPS Apple iCloud CalDAV calendar URL.");
  const label = typeof body.accountLabel === "string" && body.accountLabel.trim() ? body.accountLabel.trim().slice(0,120) : discoveredLabel || body.username.trim();
  const validation = await fetch(url, { method: "PROPFIND", headers: { Authorization: authorization, Depth: "0", "Content-Type": "application/xml; charset=utf-8" }, body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>` });
  if (validation.status === 401 || validation.status === 403) throw new HttpError(400, "Apple Calendar rejected the Apple ID or app-specific password.");
  if (!validation.ok && validation.status !== 207) throw new HttpError(400, "Could not verify the Apple CalDAV calendar URL.");
  const connectedAt = now().toISOString();
  database().prepare(`INSERT INTO calendar_connections(user_id,provider,account_label,access_token,refresh_token,calendar_url,connected_at,connection_scope_id,credential_generation_id)
    VALUES(?,'apple',?,?,NULL,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET account_label=excluded.account_label,
    access_token=excluded.access_token,calendar_url=excluded.calendar_url,connected_at=excluded.connected_at,connection_scope_id=excluded.connection_scope_id,
    credential_generation_id=excluded.credential_generation_id,legacy_identity_eligible=0`).run(userId,label,encrypt(JSON.stringify({ username: body.username.trim(), password: body.password })),url.toString(),connectedAt,randomUUID(),randomUUID());
  return { provider: "apple", accountLabel: label, connectedAt };
}

export function disconnectCalendar(userId: string, provider: Provider) {
  if (provider !== "google" && provider !== "apple") throw new HttpError(400, "Choose Google Calendar or Apple Calendar.");
  database().prepare("DELETE FROM calendar_connections WHERE user_id=? AND provider=?").run(userId,provider);
}

export function excludeDeletedCalendarImports(userId: string, itemId: string) {
  const db=database();
  for (const row of db.prepare("SELECT provider,external_id,connection_scope_id FROM calendar_imports WHERE user_id=? AND item_id=?").all(userId,itemId)) {
    db.prepare("INSERT OR IGNORE INTO calendar_import_exclusions(user_id,provider,external_id,connection_scope_id) VALUES(?,?,?,?)").run(userId,row.provider,row.external_id,row.connection_scope_id);
  }
}

function escapeIcs(value: string) { return value.replace(/\\/g,"\\\\").replace(/\r?\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;"); }
function compactDate(value: string) { return value.replaceAll("-", ""); }
function filetasksEventUrl(itemId: string) {
  const base = process.env.FILETASKS_PUBLIC_URL || process.env.FILETASKS_ORIGIN;
  return base ? `${base.replace(/\/$/,"")}/?event=${encodeURIComponent(itemId)}` : undefined;
}
function googleOriginalStart(date: string, time?: string | null) {
  if (!time) return date;
  const timeZone = process.env.FILETASKS_TIME_ZONE || "UTC";
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return (localAsUtc - Math.floor(instant / 1000) * 1000) / 60_000;
  };
  let instant = wallClock;
  for (let attempt = 0; attempt < 3; attempt++) instant = wallClock - offsetAt(instant) * 60_000;
  const offset = offsetAt(instant);
  const sign = offset < 0 ? "-" : "+";
  const absoluteOffset = Math.abs(offset);
  const suffix = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2,"0")}:${String(absoluteOffset % 60).padStart(2,"0")}`;
  return `${date}T${time}:00${suffix}`;
}
function plusOneDay(value: string) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+1); return date.toISOString().slice(0,10); }
function oneHourLater(date: string, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + 60;
  const endDate = total >= 1440 ? plusOneDay(date) : date;
  const endTime = `${String(Math.floor(total % 1440 / 60)).padStart(2,"0")}:${String(total % 60).padStart(2,"0")}`;
  return `${endDate}T${endTime}:00`;
}
function offsetText(offset: number) {
  const sign = offset < 0 ? "-" : "+"; const absolute = Math.abs(offset);
  return `${sign}${String(Math.floor(absolute/60)).padStart(2,"0")}:${String(absolute%60).padStart(2,"0")}`;
}
function timingInstant(timing: ProviderTiming, end = false) {
  const date = end ? timing.endDate : timing.startDate;
  const time = end ? timing.endTime : timing.startTime;
  const zone = end ? timing.endZone : timing.startZone;
  const offset = end ? timing.endOffsetMinutes : timing.startOffsetMinutes;
  return date && time ? instantForTiming(date,time,zone,offset) : null;
}
function shiftedTiming(timing: ProviderTiming, item: Pick<EventItem,"scheduledDate"|"scheduledTime">, apple = false): ProviderTiming | { limitation: string } {
  if (!item.scheduledDate || !validDate(item.scheduledDate)) return { limitation:"This imported Event no longer has a valid schedule. Calendar sync is paused until its timing can be reviewed." };
  if (timing.kind === "allDay") {
    if (item.scheduledTime) return { limitation:"This all-day Event was changed to a timed Event. FileTasks cannot infer a safe provider timezone, so Calendar sync is paused." };
    const dayCount = timing.dayCount ?? 1;
    const endDate = new Date(`${item.scheduledDate}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate()+dayCount);
    return { kind:"allDay",startDate:item.scheduledDate,endDate:endDate.toISOString().slice(0,10),dayCount };
  }
  if (!item.scheduledTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.scheduledTime)) {
    return { limitation:"This timed Event was changed to an all-day Event. FileTasks cannot preserve its exact duration safely, so Calendar sync is paused." };
  }
  const time = `${item.scheduledTime}:00`;
  if (apple && !timing.startUtc && timing.startZone && !resolveLocalDateTime(item.scheduledDate,time,timing.startZone)) {
    return { limitation:"This edited Event starts at an ambiguous or nonexistent local time in its Apple Calendar timezone. Calendar sync is paused to preserve its elapsed duration." };
  }
  const startInstant = timing.startZone
    ? resolveLocalDateTime(item.scheduledDate,time,timing.startZone,timing.startOffsetMinutes)?.instant ?? null
    : instantForTiming(item.scheduledDate,time,undefined,timing.startOffsetMinutes);
  if (startInstant === null) return { limitation:"This edited time is ambiguous or does not exist in the imported timezone. Calendar sync is paused rather than choosing a different instant." };
  if (!timing.durationMs || timing.durationMs <= 0) return { limitation:"The imported Event duration could not be preserved safely after this schedule edit. Calendar sync is paused." };
  const endInstant = startInstant+timing.durationMs;
  const localFor = (instant: number, zone: string | undefined, offset: number | undefined) => {
    if (zone) return zoneParts(instant,zone);
    if (offset === undefined) return null;
    const local = new Date(instant+offset*60_000).toISOString();
    return { date:local.slice(0,10),time:local.slice(11,19) };
  };
  const end = localFor(endInstant,timing.endZone ?? timing.startZone,timing.endOffsetMinutes ?? timing.startOffsetMinutes);
  if (!end) return { limitation:"The imported Event has no timezone that can be retained after this schedule edit. Calendar sync is paused." };
  const endZone = timing.endZone ?? timing.startZone;
  if (apple && !timing.endUtc && endZone && !resolveLocalDateTime(end.date,end.time,endZone)) {
    return { limitation:"This edited Event ends at an ambiguous local time in its Apple Calendar timezone. Calendar sync is paused to preserve its elapsed duration." };
  }
  return {
    kind:"timed",startDate:item.scheduledDate,endDate:end.date,startTime:time,endTime:end.time,
    ...(timing.startZone ? {startZone:timing.startZone,endZone:timing.endZone ?? timing.startZone} : {}),
    ...(timing.startOffsetMinutes !== undefined ? {startOffsetMinutes:timing.startOffsetMinutes} : {}),
    ...(timing.endOffsetMinutes !== undefined ? {endOffsetMinutes:timing.endOffsetMinutes} : {}),
    durationMs:timing.durationMs,...(timing.startUtc ? {startUtc:true} : {}),...(timing.endUtc ? {endUtc:true} : {}),
  };
}
export function importedScheduleLimitation(timingJson: string, item: Pick<EventItem,"scheduledDate"|"scheduledTime">, apple = false) {
  const result = shiftedTiming(JSON.parse(timingJson) as ProviderTiming, item, apple);
  return "limitation" in result ? result.limitation : null;
}
function importedTimingForEdit(metadata: ImportMetadataRow, item: EventItem): ProviderTiming | { limitation: string } {
  const timing = JSON.parse(metadata.timing_json) as ProviderTiming;
  const baseline = JSON.parse(metadata.baseline_json) as { scheduledDate:string|null; scheduledTime:string|null; recurrence:RecurrenceRule|null };
  const scheduleEdited = baseline.scheduledDate !== item.scheduledDate || baseline.scheduledTime !== item.scheduledTime;
  const recurrenceEdited = !sameRecurrence(baseline.recurrence ?? null,item.recurrence);
  if (recurrenceEdited) return { limitation:"This imported Recurrence rule was edited in FileTasks. Calendar sync is paused until its original provider representation can be preserved." };
  return scheduleEdited ? shiftedTiming(timing,item,metadata.provider === "apple") : timing;
}
function formatIcsUtc(instant: number) { return new Date(instant).toISOString().replaceAll("-","").replaceAll(":","").replace(/\.\d{3}Z$/,"Z"); }
function icsFor(item: EventItem, uid: string, exceptions: EventItem[] = [], excludedDates: string[] = [], importedTiming?: ProviderTiming, importedFields?: {location?:string;attendees?:string[]}) {
  const stamp = now().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"");
  const fields = [`BEGIN:VCALENDAR`,`VERSION:2.0`,`PRODID:-//FileTasks//Calendar//EN`,`BEGIN:VEVENT`,`UID:${uid}`,`DTSTAMP:${stamp}`];
  if (importedTiming?.kind === "allDay") {
    fields.push(`DTSTART;VALUE=DATE:${compactDate(importedTiming.startDate)}`,`DTEND;VALUE=DATE:${compactDate(importedTiming.endDate)}`);
  } else if (importedTiming?.kind === "timed") {
    const startInstant = timingInstant(importedTiming); const endInstant = importedTiming.durationMs === undefined ? timingInstant(importedTiming,true) : startInstant === null ? null : startInstant+importedTiming.durationMs;
    if (startInstant === null || endInstant === null) throw new HttpError(409,"The imported Event timezone could not be retained for Apple Calendar.");
    fields.push(`DTSTART:${formatIcsUtc(startInstant)}`,`DTEND:${formatIcsUtc(endInstant)}`);
  } else if (item.scheduledDate) {
    if (item.scheduledTime) fields.push(`DTSTART:${compactDate(item.scheduledDate)}T${item.scheduledTime.replace(":","")}00`);
    else fields.push(`DTSTART;VALUE=DATE:${compactDate(item.scheduledDate)}`);
  }
  fields.push(`SUMMARY:${escapeIcs(item.title)}`);
  if (item.details) fields.push(`DESCRIPTION:${escapeIcs(item.details)}`);
  if (importedFields?.location) fields.push(`LOCATION:${escapeIcs(importedFields.location)}`);
  for (const attendee of importedFields?.attendees ?? []) fields.push(attendee);
  const url = filetasksEventUrl(item.id);
  if (url) fields.push(`URL:${url}`);
  if (item.recurrence) fields.push(`RRULE:${rruleFor(item.recurrence,!item.scheduledTime,false)}`);
  for (const date of excludedDates) {
    fields.push(item.scheduledTime
      ? `EXDATE:${compactDate(date)}T${item.scheduledTime.replace(":","")}00`
      : `EXDATE;VALUE=DATE:${compactDate(date)}`);
  }
  fields.push("END:VEVENT","END:VCALENDAR");
  for (const occurrence of exceptions) {
    const recurrenceId = occurrence.occurrenceDate;
    if (!recurrenceId) continue;
    const exception = ["BEGIN:VEVENT",`UID:${uid}`,`DTSTAMP:${stamp}`];
    if (item.scheduledTime) exception.push(`RECURRENCE-ID:${compactDate(recurrenceId)}T${item.scheduledTime.replace(":","")}00`);
    else exception.push(`RECURRENCE-ID;VALUE=DATE:${compactDate(recurrenceId)}`);
    if (occurrence.scheduledDate) {
      if (occurrence.scheduledTime) exception.push(`DTSTART:${compactDate(occurrence.scheduledDate)}T${occurrence.scheduledTime.replace(":","")}00`);
      else exception.push(`DTSTART;VALUE=DATE:${compactDate(occurrence.scheduledDate)}`);
    }
    exception.push(`SUMMARY:${escapeIcs(occurrence.title)}`);
    if (occurrence.details) exception.push(`DESCRIPTION:${escapeIcs(occurrence.details)}`);
    if (url) exception.push(`URL:${url}`);
    exception.push("END:VEVENT");
    fields.splice(fields.length - 1,0,...exception);
  }
  return `${fields.join("\r\n")}\r\n`;
}

function firstEventLines(ics: string) {
  const lines = unfoldedIcsLines(ics);
  const start = lines.findIndex((line) => line.toUpperCase() === "BEGIN:VEVENT");
  if (start < 0) return null;
  const end = lines.findIndex((line,index) => index > start && line.toUpperCase() === "END:VEVENT");
  return end < 0 ? null : { lines,start,end };
}

function propertyLineForTiming(name: "DTSTART"|"DTEND", original: string, timing: ProviderTiming, end: boolean) {
  const separator = original.indexOf(":");
  if (separator < 0) return null;
  const date = end ? timing.endDate : timing.startDate;
  if (timing.kind === "allDay") return `${original.slice(0,separator+1)}${compactDate(date)}`;
  const time = end ? timing.endTime : timing.startTime;
  if (!time) return null;
  const originalProperty = icsPropertyEntry(original,name);
  const originalValue = originalProperty?.value ?? "";
  const useUtc = originalValue.endsWith("Z") && !originalProperty?.params.TZID;
  const instant = useUtc ? timingInstant(timing,end) : null;
  if (useUtc && instant === null) return null;
  const outputValue = useUtc ? formatIcsUtc(instant!) : compactDateTime(date,time);
  return `${original.slice(0,separator+1)}${outputValue}`;
}

function patchImportedAppleIcs(metadata: ImportMetadataRow, item: EventItem) {
  if (!metadata.source_ics) return { limitation:"The original Apple Calendar data is unavailable. Sync is paused to protect the imported Event." };
  const original = metadata.source_ics;
  const timingResult = importedTimingForEdit(metadata,item);
  if ("limitation" in timingResult) return timingResult;
  const parsed = firstEventLines(original);
  if (!parsed) return { limitation:"The original Apple Calendar Event could not be updated safely. Sync is paused to protect its provider data." };
  const changes = new Map<string,string|null>();
  const directIndex = (name: string) => {
    let depth = 0;
    for (let index = parsed.start + 1; index < parsed.end; index++) {
      const line = parsed.lines[index].toUpperCase();
      if (line.startsWith("BEGIN:")) { depth++; continue; }
      if (line.startsWith("END:")) { depth--; continue; }
      if (depth === 0 && (line.startsWith(`${name}:`) || line.startsWith(`${name};`))) return index;
    }
    return -1;
  };
  const baseline = JSON.parse(metadata.baseline_json) as {scheduledDate:string|null;scheduledTime:string|null;title?:string;details?:string};
  if (typeof baseline.title === "string" && baseline.title !== item.title) changes.set("SUMMARY",`SUMMARY:${escapeIcs(item.title)}`);
  if (typeof baseline.details === "string" && baseline.details !== item.details) changes.set("DESCRIPTION",item.details ? `DESCRIPTION:${escapeIcs(item.details)}` : null);
  const implicitAllDayEnd = timingResult.kind === "allDay" && directIndex("DTEND") < 0 && directIndex("DURATION") < 0;
  if (implicitAllDayEnd) changes.set("DTEND",`DTEND;VALUE=DATE:${compactDate(timingResult.endDate)}`);
  if (baseline.scheduledDate !== item.scheduledDate || baseline.scheduledTime !== item.scheduledTime) {
    const startLine = parsed.lines.slice(parsed.start+1,parsed.end).find((line) => /^DTSTART(?:;[^:]*)?:/i.test(line));
    const endLine = parsed.lines.slice(parsed.start+1,parsed.end).find((line) => /^DTEND(?:;[^:]*)?:/i.test(line));
    if (!startLine || (!endLine && !implicitAllDayEnd)) return { limitation:"The original Apple Event has no safe editable end time. Sync is paused to protect its timing." };
    const nextStart = propertyLineForTiming("DTSTART",startLine,timingResult,false);
    const nextEnd = propertyLineForTiming("DTEND",endLine ?? "DTEND;VALUE=DATE:",timingResult,true);
    if (!nextStart || !nextEnd) return { limitation:"The original Apple Event timing could not be updated in its provider timezone. Sync is paused." };
    changes.set("DTSTART",nextStart);
    changes.set("DTEND",nextEnd);
  }
  for (const [name,replacement] of changes) {
    const index = directIndex(name);
    if (replacement === null) { if (index >= 0) { parsed.lines.splice(index,1); parsed.end--; } }
    else if (index >= 0) parsed.lines[index] = replacement;
    else parsed.lines.splice(parsed.end++,0,replacement);
  }
  while (parsed.lines.at(-1) === "") parsed.lines.pop();
  return { ics:`${parsed.lines.join("\r\n")}\r\n` };
}

function googleWritableExtras(metadata: ImportMetadataRow | null) {
  if (!metadata) return {};
  if (metadata.provider === "google" && metadata.source_payload_json) {
    const source = JSON.parse(metadata.source_payload_json) as Record<string,unknown>;
    const extras: Record<string,unknown> = {};
    for (const name of ["status","location","attendees","reminders","transparency","visibility","colorId","guestsCanInviteOthers","guestsCanModify","guestsCanSeeOtherGuests","anyoneCanAddSelf","conferenceData","source","attachments"]) {
      if (source[name] !== undefined) extras[name] = source[name];
    }
    if (source.extendedProperties && typeof source.extendedProperties === "object") extras.extendedProperties = source.extendedProperties;
    return extras;
  }
  if (metadata.provider !== "apple" || !metadata.source_ics) return {};
  const root = firstEventLines(metadata.source_ics);
  if (!root) return {};
  const eventLines = root.lines.slice(root.start+1,root.end);
  const locationLine = eventLines.find((line) => /^LOCATION(?:;[^:]*)?:/i.test(line));
  const attendees = eventLines.filter((line) => /^ATTENDEE(?:;[^:]*)?:/i.test(line)).map((line) => {
    const separator = line.indexOf(":"); const [property,...params] = line.slice(0,separator).split(";");
    const values = Object.fromEntries(params.map((part) => { const index=part.indexOf("="); return index<0?[part.toUpperCase(),""]:[part.slice(0,index).toUpperCase(),part.slice(index+1).replace(/^"|"$/g,"")]; }));
    const email = line.slice(separator+1).replace(/^mailto:/i,"");
    return { email,...(values.CN ? {displayName:unescapeIcs(values.CN)} : {}),...(values.PARTSTAT ? {responseStatus:({ACCEPTED:"accepted",DECLINED:"declined",TENTATIVE:"tentative",DELEGATED:"needsAction"} as Record<string,string>)[values.PARTSTAT.toUpperCase()] ?? "needsAction"} : {}) };
  });
  return {
    ...(locationLine ? {location:icsProperty(metadata.source_ics,"LOCATION") ?? ""} : {}),
    ...(attendees.length ? {attendees} : {}),
  };
}

function rruleFor(rule: NonNullable<EventItem["recurrence"]>, dateOnly = false, untilUsesZulu = true) {
  const freq = { days: "DAILY", weeks: "WEEKLY", months: "MONTHLY", years: "YEARLY" }[rule.unit];
  const parts = [`FREQ=${freq}`,`INTERVAL=${rule.interval}`];
  if (rule.ordinalWeekday) parts.push(`BYDAY=${rule.ordinalWeekday.ordinal}${["SU","MO","TU","WE","TH","FR","SA"][rule.ordinalWeekday.weekday]}`);
  else if (rule.weekdays?.length) parts.push(`BYDAY=${rule.weekdays.map((day) => ["SU","MO","TU","WE","TH","FR","SA"][day]).join(",")}`);
  if (rule.month !== undefined && rule.monthDay !== undefined) parts.push(`BYMONTH=${rule.month}`,`BYMONTHDAY=${rule.monthDay}`);
  if (rule.end.type === "count") parts.push(`COUNT=${rule.end.count}`);
  if (rule.end.type === "date") parts.push(`UNTIL=${compactDate(rule.end.date)}${dateOnly ? "" : `T235959${untilUsesZulu ? "Z" : ""}`}`);
  return parts.join(";");
}

function calendarExclusions(userId: string, rootId: string) {
  return database().prepare("SELECT occurrence_date FROM occurrence_exclusions WHERE user_id=? AND series_root_id=? ORDER BY occurrence_date")
    .all(userId, rootId).map((row) => String(row.occurrence_date));
}

function metadataRowsForItem(userId: string, itemId: string) {
  return database().prepare("SELECT * FROM calendar_import_metadata WHERE user_id=? AND item_id=? ORDER BY captured_at,provider")
    .all(userId,itemId) as ImportMetadataRow[];
}

function metadataForDestination(userId: string, itemId: string, provider: Provider, accountId: string) {
  const rows = metadataRowsForItem(userId,itemId);
  return rows.find((row) => row.provider === provider && row.source_account_id === accountId) ?? rows[0] ?? null;
}

function isScheduleUnchanged(metadata: ImportMetadataRow, item: EventItem) {
  const baseline = JSON.parse(metadata.baseline_json) as {scheduledDate:string|null;scheduledTime:string|null};
  return baseline.scheduledDate === item.scheduledDate && baseline.scheduledTime === item.scheduledTime;
}

function reportSyncLimitation(limits: Map<string,{itemId:string;title:string;provider:Provider;message:string}>, item:EventItem, provider:Provider, message:string) {
  limits.set(`${item.id}:${provider}`,{itemId:item.id,title:item.title,provider,message});
}

function isUndatedImportedSourceCopy(connection: Connection, itemId: string, sourceExternalId: string) {
  if (!connection.connection_scope_id) return false;
  const sourceAccountId = connection.calendar_url ?? (connection.provider === "google" ? "primary" : null);
  if (!sourceAccountId) return false;
  return Boolean(database().prepare(`SELECT 1 FROM calendar_imports i
    LEFT JOIN calendar_import_metadata m ON m.user_id=i.user_id AND m.provider=i.provider AND m.external_id=i.external_id AND m.item_id=i.item_id
    JOIN calendar_copies cp ON cp.user_id=i.user_id AND cp.provider=i.provider AND cp.item_id=i.item_id
    JOIN calendar_connections c ON c.user_id=i.user_id AND c.provider=i.provider
    WHERE i.user_id=? AND i.item_id=? AND i.provider=? AND i.external_id=? AND i.connection_scope_id=?
      AND (m.external_id IS NULL OR (m.connection_scope_id=i.connection_scope_id AND m.source_account_id=?))
      AND cp.connection_scope_id=i.connection_scope_id
      AND (i.provider='google' AND cp.external_id=i.external_id OR i.provider='apple' AND cp.resource_uid=i.external_id)
      AND c.connection_scope_id=i.connection_scope_id AND c.credential_generation_id=?
      AND c.calendar_url IS ?`).get(
        connection.user_id,itemId,connection.provider,sourceExternalId,connection.connection_scope_id,
        sourceAccountId,connection.credential_generation_id,connection.calendar_url,
      ));
}

function recordUndatedCopyRemovalFailure(connection: Connection, itemId: string, message: string) {
  if (!connection.connection_scope_id) return;
  database().prepare(`INSERT INTO calendar_destination_limitations(user_id,item_id,provider,connection_scope_id,code,message)
    SELECT ?,?,?,?,'undated-copy-removal-failed',? WHERE EXISTS (
      SELECT 1 FROM calendar_connections c JOIN items i ON i.user_id=c.user_id
      WHERE c.user_id=? AND c.provider=? AND c.connection_scope_id=? AND c.credential_generation_id=?
        AND i.id=? AND i.kind='event' AND i.scheduled_date IS NULL)
    ON CONFLICT(user_id,item_id,provider,connection_scope_id) DO UPDATE SET
      code=excluded.code,message=excluded.message`).run(
        connection.user_id,itemId,connection.provider,connection.connection_scope_id,message,
        connection.user_id,connection.provider,connection.connection_scope_id,connection.credential_generation_id,itemId,
      );
}

function clearUndatedCopyRemovalFailure(connection: Connection, itemId: string) {
  if (!connection.connection_scope_id) return;
  database().prepare(`DELETE FROM calendar_destination_limitations WHERE user_id=? AND item_id=? AND provider=?
    AND connection_scope_id=? AND code='undated-copy-removal-failed'
    AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?)`)
    .run(connection.user_id,itemId,connection.provider,connection.connection_scope_id,
      connection.user_id,connection.provider,connection.connection_scope_id,connection.credential_generation_id);
}

function safeToSyncImportedEvent(userId: string, item: EventItem, destination: Provider, limits: Map<string,{itemId:string;title:string;provider:Provider;message:string}>) {
  const unverified = database().prepare(`SELECT 1 FROM calendar_imports i
    LEFT JOIN calendar_connections c ON c.user_id=i.user_id AND c.provider=i.provider
    LEFT JOIN calendar_import_metadata m ON m.user_id=i.user_id AND m.provider=i.provider AND m.external_id=i.external_id AND m.item_id=i.item_id
    WHERE i.user_id=? AND i.item_id=? AND (c.connection_scope_id IS NULL OR i.connection_scope_id IS NULL OR m.connection_scope_id IS NULL
      OR i.connection_scope_id<>c.connection_scope_id OR m.connection_scope_id<>c.connection_scope_id
      OR m.source_account_id IS NOT COALESCE(c.calendar_url, CASE WHEN i.provider='google' THEN 'primary' END)) LIMIT 1`).get(userId,item.id);
  if (unverified) {
    reportSyncLimitation(limits,item,destination,"The source calendar connection cannot be verified. Sync is paused.");
    return false;
  }
  const pending = database().prepare("SELECT 1 FROM google_inventory_pending WHERE user_id=? AND item_id=? LIMIT 1").get(userId,item.id);
  if (pending) {
    reportSyncLimitation(limits,item,destination,"Google Calendar inventory is incomplete. Sync is paused to protect this Event.");
    return false;
  }
  const sourceLimitation = item.calendarSync.find((status) => status.state === "limited"
    && !(item.scheduledDate && status.limitationCode === "undated-copy-removal-failed"));
  if (sourceLimitation) {
    reportSyncLimitation(limits,item,destination,sourceLimitation.limitation ?? "This Event cannot be synchronized safely.");
    return false;
  }
  return true;
}

function importedOccurrenceChanges(userId: string, item: EventItem, events: EventItem[]) {
  if (!item.calendarSync.length || !item.recurrence) return false;
  const importedExclusions = new Set<string>();
  for (const row of database().prepare("SELECT baseline_json FROM calendar_import_metadata WHERE user_id=? AND item_id=?").all(userId,item.id)) {
    const baseline = JSON.parse(String(row.baseline_json)) as {importedExcludedDates?:unknown};
    if (Array.isArray(baseline.importedExcludedDates)) for (const date of baseline.importedExcludedDates) if (typeof date === "string") importedExclusions.add(date);
  }
  const hasLocalExclusion = calendarExclusions(userId,item.id).some((date) => !importedExclusions.has(date));
  return hasLocalExclusion || events.some((occurrence) => occurrence.seriesId === item.id && occurrence.id !== item.id
    && (occurrence.scheduledDate !== occurrence.occurrenceDate || occurrence.scheduledTime !== item.scheduledTime
      || occurrence.title !== item.title || occurrence.details !== item.details));
}

function formatGoogleDateTime(instant: number, timeZone?: string, fixedOffset?: number) {
  if (timeZone && validTimeZone(timeZone)) {
    const local = zoneParts(instant,timeZone);
    return {dateTime:`${local.date}T${local.time}${offsetText(zoneOffsetMinutes(instant,timeZone))}`,timeZone};
  }
  if (fixedOffset === undefined) return null;
  const local = new Date(instant+fixedOffset*60_000).toISOString().slice(0,19);
  return {dateTime:`${local}${offsetText(fixedOffset)}`};
}

function googleBounds(item: EventItem, metadata: ImportMetadataRow | null) {
  if (!metadata) {
    if (!item.scheduledDate) return {};
    return item.scheduledTime
      ? {start:{dateTime:`${item.scheduledDate}T${item.scheduledTime}:00`,timeZone:process.env.FILETASKS_TIME_ZONE||"UTC"},end:{dateTime:oneHourLater(item.scheduledDate,item.scheduledTime),timeZone:process.env.FILETASKS_TIME_ZONE||"UTC"}}
      : {start:{date:item.scheduledDate},end:{date:plusOneDay(item.scheduledDate)}};
  }
  if (metadata.provider === "google" && isScheduleUnchanged(metadata,item) && metadata.source_payload_json) {
    const source = JSON.parse(metadata.source_payload_json) as {start?:unknown;end?:unknown};
    if (source.start && source.end) return {start:source.start,end:source.end};
  }
  const timing = importedTimingForEdit(metadata,item);
  if ("limitation" in timing) return {limitation:timing.limitation};
  if (timing.kind === "allDay") return {start:{date:timing.startDate},end:{date:timing.endDate}};
  const startInstant = timingInstant(timing);
  const endInstant = timing.durationMs !== undefined && startInstant !== null ? startInstant+timing.durationMs : timingInstant(timing,true);
  if (startInstant === null || endInstant === null) return {limitation:"The imported Event's timezone or duration could not be retained safely. Calendar sync is paused."};
  const start = formatGoogleDateTime(startInstant,timing.startZone,timing.startOffsetMinutes);
  const end = formatGoogleDateTime(endInstant,timing.endZone ?? timing.startZone,timing.endOffsetMinutes ?? timing.startOffsetMinutes);
  return start && end ? {start,end} : {limitation:"The imported Event's timezone could not be retained safely. Calendar sync is paused."};
}

function googleRecurrenceForItem(userId: string, item: EventItem, metadata: ImportMetadataRow | null) {
  if (!item.recurrence) return undefined;
  if (metadata?.provider === "google" && metadata.source_payload_json) {
    const baseline = JSON.parse(metadata.baseline_json) as {recurrence:RecurrenceRule|null};
    const source = JSON.parse(metadata.source_payload_json) as {recurrence?:string[]};
    if (sameRecurrence(baseline.recurrence ?? null,item.recurrence) && source.recurrence) return source.recurrence;
  }
  const timing = metadata ? JSON.parse(metadata.timing_json) as ProviderTiming : null;
  return googleRecurrence(item,calendarExclusions(userId,item.id),timing?.startZone ?? process.env.FILETASKS_TIME_ZONE ?? "UTC");
}

function rawGoogleExtras(metadata: ImportMetadataRow | null, itemId: string) {
  const extras = googleWritableExtras(metadata) as Record<string,unknown>;
  const originalExtended = extras.extendedProperties && typeof extras.extendedProperties === "object"
    ? extras.extendedProperties as Record<string,unknown> : {};
  const originalPrivate = originalExtended.private && typeof originalExtended.private === "object"
    ? originalExtended.private as Record<string,unknown> : {};
  extras.extendedProperties = { ...originalExtended,private:{...originalPrivate,filetasksItemId:itemId} };
  return extras;
}

function appleGoogleAttendees(metadata: ImportMetadataRow | null) {
  if (metadata?.provider !== "apple" || !metadata.source_ics) return undefined;
  const root = firstEventLines(metadata.source_ics);
  if (!root) return undefined;
  const eventLines = root.lines.slice(root.start+1,root.end);
  const attendees = eventLines.filter((line) => /^ATTENDEE(?:;[^:]*)?:/i.test(line)).map((line) => {
    const separator=line.indexOf(":"); const params=line.slice(0,separator).split(";").slice(1);
    const values=Object.fromEntries(params.map((part)=>{const index=part.indexOf("=");return index<0?[part.toUpperCase(),""]:[part.slice(0,index).toUpperCase(),part.slice(index+1).replace(/^"|"$/g,"")];}));
    const email=line.slice(separator+1).replace(/^mailto:/i,"");
    const responseStatus:Record<string,string>={ACCEPTED:"accepted",DECLINED:"declined",TENTATIVE:"tentative",DELEGATED:"needsAction"};
    return {email,...(values.CN?{displayName:unescapeIcs(values.CN)}:{}),...(values.PARTSTAT?{responseStatus:responseStatus[values.PARTSTAT.toUpperCase()]??"needsAction"}:{})};
  });
  return attendees.length ? attendees : undefined;
}

function googleAttendeeLines(metadata: ImportMetadataRow | null) {
  const extras = googleWritableExtras(metadata) as {attendees?:{email?:string;displayName?:string;responseStatus?:string;optional?:boolean}[]};
  return (extras.attendees ?? []).flatMap((attendee) => {
    if (!attendee.email || /[\r\n]/.test(attendee.email)) return [];
    const parameters = [
      ...(attendee.displayName ? [`CN="${attendee.displayName.replace(/[\r\n]+/g," ").replaceAll("\\","\\\\").replaceAll('"','\\"')}"`] : []),
      ...(attendee.optional ? ["ROLE=OPT-PARTICIPANT"] : []),
      ...(attendee.responseStatus ? [`PARTSTAT=${({accepted:"ACCEPTED",declined:"DECLINED",tentative:"TENTATIVE",needsAction:"NEEDS-ACTION"} as Record<string,string>)[attendee.responseStatus] ?? "NEEDS-ACTION"}`] : []),
    ];
    return [`ATTENDEE${parameters.length ? `;${parameters.join(";")}` : ""}:mailto:${attendee.email}`];
  });
}

function googleRecurrence(item: EventItem, excludedDates: string[], timeZone = process.env.FILETASKS_TIME_ZONE || "UTC") {
  if (!item.recurrence) return undefined;
  const recurrence = [`RRULE:${rruleFor(item.recurrence,!item.scheduledTime,true)}`];
  for (const date of excludedDates) {
    recurrence.push(item.scheduledTime
      ? `EXDATE;TZID=${timeZone}:${compactDate(date)}T${item.scheduledTime.replace(":","")}00`
      : `EXDATE;VALUE=DATE:${compactDate(date)}`);
  }
  return recurrence;
}

function assertActiveScope(connection: Connection) {
  const active = database().prepare("SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?")
    .get(connection.user_id,connection.provider,connection.connection_scope_id,connection.credential_generation_id);
  if (!active) throw new HttpError(409, "Calendar connection changed. Please sync again.");
}

// Reserve identity before creating a Google Calendar copy so retries reuse both values.
export function reserveGoogleCreation(connection: Connection, itemId: string) {
  if (connection.provider !== "google" || !connection.connection_scope_id) {
    throw new HttpError(409, "Calendar connection changed. Please sync again.");
  }
  const db = database();
  db.prepare(`INSERT INTO google_creation_reservations
    (user_id,item_id,provider,connection_scope_id,event_id,ownership_token)
    SELECT ?,?,'google',?,?,? WHERE EXISTS (
      SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='google' AND connection_scope_id=? AND credential_generation_id=?
    ) ON CONFLICT(user_id,item_id,provider,connection_scope_id) DO NOTHING`)
    .run(connection.user_id,itemId,connection.connection_scope_id,randomUUID().replaceAll("-", ""),randomBytes(32).toString("hex"),
      connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
  const row = db.prepare(`SELECT r.event_id,r.ownership_token FROM google_creation_reservations r
    JOIN calendar_connections c ON c.user_id=r.user_id AND c.provider=r.provider AND c.connection_scope_id=r.connection_scope_id AND c.credential_generation_id=?
    WHERE r.user_id=? AND r.item_id=? AND r.provider='google' AND r.connection_scope_id=?`)
    .get(connection.credential_generation_id,connection.user_id,itemId,connection.connection_scope_id);
  if (!row) throw new HttpError(409, "Calendar connection changed. Please sync again.");
  return { eventId: String(row.event_id), ownershipToken: String(row.ownership_token) };
}

async function googleAccess(connection: Connection) {
  assertActiveScope(connection);
  if (connection.expires_at && connection.expires_at > nowMs() && connection.access_token) return decrypt(connection.access_token);
  if (!connection.refresh_token) throw new HttpError(503, "Reconnect Google Calendar to continue syncing.");
  assertActiveScope(connection);
  const response = await fetch(googleTokenUrl(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "", refresh_token: decrypt(connection.refresh_token), grant_type: "refresh_token" }) });
  assertActiveScope(connection);
  if (!response.ok) throw new HttpError(502, "Google Calendar authorization expired. Reconnect the calendar.");
  assertActiveScope(connection);
  const tokens = await response.json() as { access_token: string; expires_in: number };
  assertActiveScope(connection);
  const updated = database().prepare("UPDATE calendar_connections SET access_token=?,expires_at=? WHERE user_id=? AND provider='google' AND connection_scope_id=? AND credential_generation_id=?")
    .run(encrypt(tokens.access_token),nowMs()+(tokens.expires_in-60)*1000,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
  if (!updated.changes) throw new HttpError(409, "Calendar connection changed. Please sync again.");
  return tokens.access_token;
}

function alreadyImported(userId: string, provider: Provider, externalId: string) {
  return database().prepare("SELECT item_id FROM calendar_imports WHERE user_id=? AND provider=? AND external_id=?").get(userId,provider,externalId);
}

function recordImport(userId: string, provider: Provider, externalId: string, itemId: string, scope: string, copyUrl?: string) {
  database().prepare("INSERT INTO calendar_imports(user_id,provider,external_id,item_id,connection_scope_id) VALUES(?,?,?,?,?)").run(userId,provider,externalId,itemId,scope);
  database().prepare(`INSERT INTO calendar_copies(user_id,provider,item_id,external_id,resource_uid,connection_scope_id) VALUES(?,?,?,?,?,?)`).run(userId,provider,itemId,copyUrl ?? externalId,provider === "apple" ? externalId : null,scope);
}

function recordImportMetadata(userId: string, provider: Provider, externalId: string, itemId: string, scope: string, baseline: Pick<EventItem,"scheduledDate"|"scheduledTime"|"recurrence"|"title"|"details">, metadata: ImportMetadataInput) {
  database().prepare(`INSERT INTO calendar_import_metadata(user_id,provider,external_id,item_id,source_account_id,
    source_payload_json,source_ics,timing_json,baseline_json,state,limitation_code,limitation_message,captured_at,connection_scope_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,provider,external_id) DO NOTHING`).run(
    userId,provider,externalId,itemId,metadata.accountId,metadata.sourcePayload ? JSON.stringify(metadata.sourcePayload) : null,
    metadata.sourceIcs ?? null,JSON.stringify(metadata.timing),JSON.stringify({
      scheduledDate: baseline.scheduledDate, scheduledTime: baseline.scheduledTime, recurrence: baseline.recurrence, title: baseline.title, details: baseline.details,
      ...(metadata.excludedDates?.length ? { importedExcludedDates: metadata.excludedDates } : {}),
    }),metadata.state,metadata.limitationCode ?? null,metadata.limitationMessage ?? null,now().toISOString(),scope);
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}

function validTimeZone(value: string | undefined): value is string {
  if (!value) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0)); return true; }
  catch { return false; }
}

function dateTimeParts(value: string) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/i);
  if (!match || !validDate(match[1])) return null;
  const [hour, minute, second] = match[2].split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { date: match[1], time: match[2], suffix: match[3] ?? null };
}

function explicitOffsetMinutes(suffix: string | null) {
  if (!suffix) return undefined;
  if (suffix.toUpperCase() === "Z") return 0;
  const match = suffix.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const amount = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -amount : amount;
}

function zoneParts(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant)).map(({ type, value }) => [type,value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function zoneOffsetMinutes(instant: number, timeZone: string) {
  const local = zoneParts(instant,timeZone);
  const [year,month,day] = local.date.split("-").map(Number);
  const [hour,minute,second] = local.time.split(":").map(Number);
  return Math.round((Date.UTC(year,month-1,day,hour,minute,second)-Math.floor(instant/1000)*1000)/60_000);
}

function resolveLocalDateTime(date: string, time: string, timeZone: string, preferredOffset?: number) {
  if (!validDate(date) || !validTimeZone(timeZone)) return null;
  const [year,month,day] = date.split("-").map(Number);
  const [hour,minute,second] = time.split(":").map(Number);
  const wallClock = Date.UTC(year,month-1,day,hour,minute,second);
  const offsets = new Set<number>();
  for (let hours=-36; hours<=36; hours+=3) offsets.add(zoneOffsetMinutes(wallClock+hours*3_600_000,timeZone));
  const candidates = [...offsets].map((offset) => ({ instant: wallClock-offset*60_000, offset }))
    .filter(({ instant }) => {
      const parts = zoneParts(instant,timeZone);
      return parts.date === date && parts.time === time;
    });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((candidate) => candidate.offset === preferredOffset) ?? null;
}

function instantForTiming(date: string, time: string, timeZone?: string, offsetMinutes?: number) {
  if (timeZone && validTimeZone(timeZone)) return resolveLocalDateTime(date,time,timeZone,offsetMinutes)?.instant ?? null;
  if (offsetMinutes === undefined) return null;
  const [year,month,day] = date.split("-").map(Number);
  const [hour,minute,second] = time.split(":").map(Number);
  return Date.UTC(year,month-1,day,hour,minute,second)-offsetMinutes*60_000;
}

function parseGoogleTiming(event: Record<string, unknown>) {
  const start = event.start as Record<string, unknown> | undefined;
  const end = event.end as Record<string, unknown> | undefined;
  const invalidBounds = [start,end].some((bound) => !bound || typeof bound !== "object" || Array.isArray(bound) || (bound.date !== undefined && typeof bound.date !== "string") || (bound.dateTime !== undefined && typeof bound.dateTime !== "string") || (bound.timeZone !== undefined && typeof bound.timeZone !== "string") || (bound.date !== undefined && bound.dateTime !== undefined));
  if (invalidBounds) return { timing: { kind:"timed",startDate:"1970-01-01",endDate:"1970-01-01" } satisfies ProviderTiming, state:"limited" as const, limitationCode:"unsupported-timing", limitationMessage:"This imported Event has timing FileTasks cannot safely interpret. The original Google Event is preserved and sync is paused." };
  if (typeof start?.date === "string" && typeof end?.date === "string" && validDate(start.date) && validDate(end.date) && end.date > start.date) {
    const dayCount = Math.round((Date.parse(`${end.date}T00:00:00Z`)-Date.parse(`${start.date}T00:00:00Z`))/86_400_000);
    return { timing: { kind:"allDay",startDate:start.date,endDate:end.date,dayCount } satisfies ProviderTiming, state:"supported" as const };
  }
  const startValue = typeof start?.dateTime === "string" ? dateTimeParts(start.dateTime) : null;
  const endValue = typeof end?.dateTime === "string" ? dateTimeParts(end.dateTime) : null;
  const startZone = typeof start?.timeZone === "string" ? start.timeZone : undefined;
  const endZone = typeof end?.timeZone === "string" ? end.timeZone : undefined;
  if (!startValue || !endValue || (startZone && !validTimeZone(startZone)) || (endZone && !validTimeZone(endZone))) {
    return { timing: { kind:"timed",startDate:startValue?.date ?? "1970-01-01",endDate:endValue?.date ?? "1970-01-01",...(startValue ? {startTime:startValue.time} : {}) } satisfies ProviderTiming,
      state:"limited" as const, limitationCode:"unsupported-timing", limitationMessage:"This imported Event has timing FileTasks cannot safely interpret. The original Google Event is preserved and sync is paused." };
  }
  const startOffset = explicitOffsetMinutes(startValue.suffix);
  const endOffset = explicitOffsetMinutes(endValue.suffix);
  const startInstant = startValue.suffix ? Date.parse(startValue.date+"T"+startValue.time+startValue.suffix)
    : instantForTiming(startValue.date,startValue.time,startZone,startOffset);
  const endInstant = endValue.suffix ? Date.parse(endValue.date+"T"+endValue.time+endValue.suffix)
    : instantForTiming(endValue.date,endValue.time,endZone,endOffset);
  const sameZone = startZone === endZone;
  const zoneMatches = (instant: number | null, parts: {date:string;time:string}, zone?: string, offset?: number) => {
    if (instant === null || !Number.isFinite(instant)) return false;
    if (zone && (zoneParts(instant,zone).date !== parts.date || zoneParts(instant,zone).time !== parts.time)) return false;
    if (zone && offset !== undefined && zoneOffsetMinutes(instant,zone) !== offset) return false;
    return true;
  };
  if (!zoneMatches(startInstant,startValue,startZone,startOffset) || !zoneMatches(endInstant,endValue,endZone,endOffset)
    || !sameZone || startInstant === null || endInstant === null || endInstant <= startInstant) {
    return { timing: { kind:"timed",startDate:startValue.date,endDate:endValue.date,startTime:startValue.time,endTime:endValue.time,
      ...(startZone ? {startZone} : {}),...(endZone ? {endZone} : {}),...(startOffset !== undefined ? {startOffsetMinutes:startOffset} : {}),...(endOffset !== undefined ? {endOffsetMinutes:endOffset} : {}) } satisfies ProviderTiming,
      state:"limited" as const, limitationCode:"unsupported-timing", limitationMessage:"This imported Event has timing FileTasks cannot safely interpret. The original Google Event is preserved and sync is paused." };
  }
  return { timing: { kind:"timed",startDate:startValue.date,endDate:endValue.date,startTime:startValue.time,endTime:endValue.time,
    ...(startZone ? {startZone} : {}),...(endZone ? {endZone} : {}),...(startOffset !== undefined ? {startOffsetMinutes:startOffset} : {}),
    ...(endOffset !== undefined ? {endOffsetMinutes:endOffset} : {}),durationMs:endInstant-startInstant,
    ...(startValue.suffix?.toUpperCase()==="Z" ? {startUtc:true} : {}),...(endValue.suffix?.toUpperCase()==="Z" ? {endUtc:true} : {}) } satisfies ProviderTiming,
    state:"supported" as const };
}

function recurrenceFromRRule(input: string | null, startDate: string): RecurrenceRule | null {
  if (!input) return null;
  const ruleText = input.replace(/^RRULE:/i,""); const pairs = ruleText.split(";").map((part) => { const index=part.indexOf("="); return index<0?[part.toUpperCase(),""]:[part.slice(0,index).toUpperCase(),part.slice(index+1).toUpperCase()]; });
  if (pairs.some(([key]) => !key) || new Set(pairs.map(([key]) => key)).size !== pairs.length) return null;
  const values = Object.fromEntries(pairs);
  const units: Record<string,RecurrenceRule["unit"]> = { DAILY:"days",WEEKLY:"weeks",MONTHLY:"months",YEARLY:"years" };
  const unit = units[values.FREQ]; if (!unit) return null;
  const interval = Number(values.INTERVAL ?? 1); if (!Number.isInteger(interval) || interval < 1 || interval > 100) return null;
  let end: RecurrenceRule["end"] = { type:"never" };
  if (values.COUNT && Number.isInteger(Number(values.COUNT))) end = { type:"count",count:Number(values.COUNT) };
  else if (values.UNTIL) { const match=values.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/); if (match) end = { type:"date",date:`${match[1]}-${match[2]}-${match[3]}` }; }
  const dayNumbers: Record<string,number> = { SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6 };
  const ordinalMatch = unit === "months" ? values.BYDAY?.match(/^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/) : null;
  const ordinalWeekday = ordinalMatch ? { ordinal:Number(ordinalMatch[1]),weekday:dayNumbers[ordinalMatch[2]] } : undefined;
  const weekdays = unit === "weeks" ? (values.BYDAY ? values.BYDAY.split(",").map((day: string) => dayNumbers[day]).filter((day: number | undefined): day is number => day !== undefined) : [new Date(`${startDate}T00:00:00Z`).getUTCDay()]) : undefined;
  const month = unit === "years" && /^\d{1,2}$/.test(values.BYMONTH ?? "") ? Number(values.BYMONTH) : undefined;
  const monthDay = unit === "years" && /^\d{1,2}$/.test(values.BYMONTHDAY ?? "") ? Number(values.BYMONTHDAY) : undefined;
  if ((values.BYDAY && unit === "months" && !ordinalWeekday)
    || (unit === "years" && (values.BYMONTH !== undefined || values.BYMONTHDAY !== undefined)
      && (month === undefined || month < 1 || month > 12 || monthDay === undefined || monthDay < 1 || monthDay > 31))) return null;
  if (end.type === "count" && (end.count < 1 || end.count > 10_000)) return null;
  if (end.type === "date" && (!validDate(end.date) || end.date < startDate)) return null;
  return { interval,unit,...(weekdays?.length ? {weekdays} : {}),...(ordinalWeekday ? {ordinalWeekday} : {}),
    ...(month !== undefined && monthDay !== undefined ? {month,monthDay} : {}),end };
}

function recurrenceSupport(input: string | null, startDate: string) {
  if (!input) return { recurrence:null, state:"supported" as const };
  const text = input.replace(/^RRULE:/i,"");
  const parts = text.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.toUpperCase(),""] : [part.slice(0,index).toUpperCase(),part.slice(index+1).toUpperCase()];
  });
  const values = Object.fromEntries(parts);
  const allowed = new Set(["FREQ","INTERVAL","COUNT","UNTIL","BYDAY","BYMONTH","BYMONTHDAY"]);
  const weeklyDays = values.BYDAY?.split(",") ?? [];
  const simpleDays = weeklyDays.every((day: string) => /^(SU|MO|TU|WE|TH|FR|SA)$/.test(day));
  const monthlyDay = !values.BYDAY || /^[+-]?[1-5](SU|MO|TU|WE|TH|FR|SA)$/.test(values.BYDAY);
  const validYearlyPair = values.FREQ !== "YEARLY" || ((!values.BYMONTH && !values.BYMONTHDAY)
    || (/^\d{1,2}$/.test(values.BYMONTH ?? "") && Number(values.BYMONTH) >= 1 && Number(values.BYMONTH) <= 12
      && /^\d{1,2}$/.test(values.BYMONTHDAY ?? "") && Number(values.BYMONTHDAY) >= 1 && Number(values.BYMONTHDAY) <= 31));
  const simpleUntil = !values.UNTIL || /^\d{8}$/.test(values.UNTIL);
  const supported = parts.every(([key]) => allowed.has(key)) && new Set(parts.map(([key]) => key)).size === parts.length && Boolean(values.FREQ)
    && !(values.COUNT && values.UNTIL) && simpleUntil
    && (!values.BYMONTH || values.FREQ === "YEARLY") && (!values.BYMONTHDAY || values.FREQ === "YEARLY")
    && (!values.BYDAY || (values.FREQ === "WEEKLY" && simpleDays) || (values.FREQ === "MONTHLY" && monthlyDay))
    && (values.FREQ !== "YEARLY" || validYearlyPair) && !(values.FREQ === "MONTHLY" && (values.BYMONTH || values.BYMONTHDAY))
    && !(values.COUNT && !/^\d+$/.test(values.COUNT));
  if (!supported) return { recurrence:null, state:"limited" as const,
    limitationCode:"unsupported-recurrence", limitationMessage:"This imported Event uses a Recurrence rule FileTasks cannot represent yet. Its original calendar data is preserved and sync is paused." };
  const recurrence = recurrenceFromRRule(input,startDate);
  if (input && !recurrence) return { recurrence:null, state:"limited" as const,
    limitationCode:"unsupported-recurrence", limitationMessage:"This imported Event uses a Recurrence rule FileTasks cannot represent yet. Its original calendar data is preserved and sync is paused." };
  return { recurrence, state:"supported" as const };
}

function isIssue20Recurrence(rule: RecurrenceRule | null) {
  return Boolean(rule?.ordinalWeekday || (rule?.unit === "years" && rule.month !== undefined && rule.monthDay !== undefined));
}

function googleExclusionDates(lines: string[], event: {start?:{date?:string;dateTime?:string;timeZone?:string}}) {
  const exclusions = lines.filter((line) => /^EXDATE(?:;[^:]*)?:/i.test(line));
  if (!exclusions.length) return [] as string[];
  const allDay = typeof event.start?.date === "string";
  const sourceStart = event.start?.dateTime?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i);
  const sourceZone = event.start?.timeZone ?? (sourceStart?.[3]?.toUpperCase() === "Z" ? "UTC" : undefined);
  if (!allDay && (!sourceStart || !sourceZone || !validTimeZone(sourceZone))) return null;
  const dates: string[] = [];
  for (const line of exclusions) {
    const match = line.match(/^EXDATE(?:;([^:]*))?:(.*)$/i);
    if (!match) return null;
    const params = Object.fromEntries((match[1] ?? "").split(";").filter(Boolean).map((part) => {
      const index=part.indexOf("="); return index < 0 ? [part.toUpperCase(),""] : [part.slice(0,index).toUpperCase(),part.slice(index+1).replace(/^"|"$/g,"")];
    }));
    if (allDay) {
      if (params.VALUE?.toUpperCase() !== "DATE" || params.TZID) return null;
      for (const value of match[2].split(",")) {
        const dateMatch=value.match(/^(\d{4})(\d{2})(\d{2})$/); if (!dateMatch) return null;
        const date=`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`; if (!validDate(date)) return null; dates.push(date);
      }
    } else {
      if (params.VALUE || (params.TZID ? params.TZID !== sourceZone : sourceZone !== "UTC")) return null;
      for (const value of match[2].split(",")) {
        const valueMatch=value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i); if (!valueMatch) return null;
        const date=`${valueMatch[1]}-${valueMatch[2]}-${valueMatch[3]}`;
        const time=`${valueMatch[4]}:${valueMatch[5]}:${valueMatch[6]}`;
        if (!validDate(date) || time !== sourceStart![2] || (sourceZone === "UTC" && valueMatch[7].toUpperCase() !== "Z")
          || (sourceZone !== "UTC" && valueMatch[7])) return null;
        dates.push(date);
      }
    }
  }
  return [...new Set(dates)];
}

function importEvent(userId: string, title: string, details: string, date: string, time: string | null, recurrence: RecurrenceRule | null = null) {
  const item = saveItem(userId,{ kind: "event", title: title.slice(0,200) || "Untitled Event", details: details.slice(0,10_000), scheduledDate: date, scheduledTime: time,
    ...(recurrence ? { recurrence } : {}) }, undefined, { enqueueCalendarSync: false });
  return item.id;
}

function importEventWithIdentity(
  userId: string,
  provider: Provider,
  externalId: string,
  scope: string,
  title: string,
  details: string,
  date: string,
  time: string | null,
  recurrence: RecurrenceRule | null = null,
  copyUrl?: string,
  sourceMetadata?: ImportMetadataInput,
  activeConnection?: Connection,
) {
  const db = database();
  db.exec("SAVEPOINT calendar_import");
  try {
    const itemId = importEvent(userId,title,details,date,time,recurrence);
    recordImport(userId,provider,externalId,itemId,scope,copyUrl);
    if (sourceMetadata) {
      const persisted = getItem(userId,itemId);
      recordImportMetadata(userId,provider,externalId,itemId,scope,persisted,sourceMetadata);
    }
    for (const excludedDate of sourceMetadata?.excludedDates ?? []) {
      db.prepare("INSERT OR IGNORE INTO occurrence_exclusions(user_id,series_root_id,occurrence_date) VALUES(?,?,?)").run(userId,itemId,excludedDate);
    }
    if (activeConnection) assertActiveScope(activeConnection);
    db.exec("RELEASE calendar_import");
    return itemId;
  } catch (error) {
    try { db.exec("ROLLBACK TO calendar_import"); db.exec("RELEASE calendar_import"); }
    catch (rollbackError) { throw new AggregateError([error,rollbackError],"Calendar import transaction could not be rolled back."); }
    throw error;
  }
}

function importedMetadataExists(userId: string, provider: Provider, externalId: string) {
  return Boolean(database().prepare("SELECT 1 AS found FROM calendar_import_metadata WHERE user_id=? AND provider=? AND external_id=?")
    .get(userId,provider,externalId));
}

function preserveLegacyImport(userId: string, provider: Provider, externalId: string, accountId: string, metadata: Omit<ImportMetadataInput,"accountId"|"state"|"limitationCode"|"limitationMessage">) {
  // Legacy identities cannot safely be associated with the current provider payload.

}

async function importGoogleEvents(connection: Connection) {
  assertActiveScope(connection);
  if (!connection.connection_scope_id) throw new Error("Missing connection scope");
  const db = database();
  const accountId = connection.calendar_url ?? "primary";
  const inventoryId = randomUUID();
  db.prepare(`INSERT INTO google_inventory_pending(user_id,item_id,source_account_id,inventory_id,connection_scope_id)
    SELECT user_id,item_id,source_account_id,?,connection_scope_id FROM calendar_import_metadata
    WHERE user_id=? AND provider='google' AND source_account_id=? AND connection_scope_id=? AND EXISTS (
      SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='google' AND connection_scope_id=? AND credential_generation_id=?
    )
    ON CONFLICT(user_id,item_id) DO UPDATE SET inventory_id=excluded.inventory_id WHERE google_inventory_pending.connection_scope_id=excluded.connection_scope_id
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='google' AND connection_scope_id=? AND credential_generation_id=?)`)
    .run(inventoryId,connection.user_id,accountId,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id,
      connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
  assertActiveScope(connection);
  const access = await googleAccess(connection); const calendarId = encodeURIComponent(accountId);
  assertActiveScope(connection);
  const existing = new Set(database().prepare("SELECT external_id FROM calendar_imports WHERE user_id=? AND provider='google' UNION SELECT external_id FROM calendar_import_exclusions WHERE user_id=? AND provider='google' UNION SELECT external_id FROM calendar_import_metadata WHERE user_id=? AND provider='google'").all(connection.user_id,connection.user_id,connection.user_id).map((row) => String(row.external_id)));
  let pageToken: string | undefined; let imported = 0;
  const exceptionMasters = new Set<string>();
  const inventory: Record<string, any>[] = [];
  const seenTokens = new Set<string>();
  do {
    const url = googleApiUrl(`calendar/v3/calendars/${calendarId}/events`);
    url.searchParams.set("singleEvents","false"); url.searchParams.set("showDeleted","true"); url.searchParams.set("maxResults","2500");
    if (pageToken) url.searchParams.set("pageToken",pageToken);
    assertActiveScope(connection);
    const response = await fetch(url,{ headers: { Authorization: `Bearer ${access}` } });
    assertActiveScope(connection);
    if (!response.ok) throw new HttpError(502,"Could not read Events from Google Calendar.");
    assertActiveScope(connection);
    const result = await response.json() as { nextPageToken?: string; items?: (Record<string, unknown> & { id?: string; status?: string; summary?: string; description?: string; location?: string; start?: { date?: string; dateTime?: string; timeZone?: string }; recurrence?: string[]; extendedProperties?: { private?: { filetasksItemId?: string } } })[] };
    assertActiveScope(connection);
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.items)) throw new HttpError(502,"Malformed Google Calendar inventory.");
    if (result.nextPageToken !== undefined && (typeof result.nextPageToken !== "string" || !result.nextPageToken || seenTokens.has(result.nextPageToken))) throw new HttpError(502,"Malformed Google Calendar pagination.");
    if (result.nextPageToken) seenTokens.add(result.nextPageToken);
    for (const event of result.items ?? []) {
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.id !== "string" || !event.id || (event.status !== undefined && !["confirmed","tentative","cancelled"].includes(event.status)) || (event.summary !== undefined && typeof event.summary !== "string") || (event.description !== undefined && typeof event.description !== "string") || ("recurringEventId" in event && (typeof event.recurringEventId !== "string" || !event.recurringEventId))) throw new HttpError(502,"Malformed Google Calendar inventory.");
      inventory.push(event);
      if (typeof event.recurringEventId === "string") exceptionMasters.add(event.recurringEventId);
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
  const masters = new Set(inventory.filter(event => typeof event.id === "string" && !event.recurringEventId).map(event => event.id));
  // Missing entries remain pending: a bounded inventory cannot verify them.
  db.exec("BEGIN IMMEDIATE");
  try {
  assertActiveScope(connection);
  for (const event of inventory) {
      if (typeof event.recurringEventId === "string") { exceptionMasters.add(event.recurringEventId); continue; }
      if (!event.id || event.status === "cancelled") continue;
      const accountId = connection.calendar_url ?? "primary";
      if (existing.has(event.id)) {
        const identity = db.prepare("SELECT source_account_id FROM calendar_import_metadata WHERE user_id=? AND provider='google' AND external_id=? AND connection_scope_id=? AND EXISTS (SELECT 1 FROM calendar_imports i WHERE i.user_id=calendar_import_metadata.user_id AND i.provider=calendar_import_metadata.provider AND i.external_id=calendar_import_metadata.external_id AND i.item_id=calendar_import_metadata.item_id AND i.connection_scope_id=calendar_import_metadata.connection_scope_id)").get(connection.user_id,event.id,connection.connection_scope_id);
        if (!identity || identity.source_account_id !== accountId) continue;
        const timing = parseGoogleTiming(event);
        const originalPayload = database().prepare("SELECT source_payload_json FROM calendar_import_metadata WHERE user_id=? AND provider='google' AND external_id=? AND connection_scope_id=?")
          .get(connection.user_id,event.id,connection.connection_scope_id);
        const originalRecurrence = originalPayload?.source_payload_json ? (JSON.parse(String(originalPayload.source_payload_json)) as {recurrence?:unknown}).recurrence : undefined;
        const recurrenceChanged = JSON.stringify(event.recurrence ?? null) !== JSON.stringify(originalRecurrence ?? null);
        if (timing.state === "limited" || recurrenceChanged) {
          db.prepare(`UPDATE calendar_import_metadata SET state='limited', limitation_code=?, limitation_message=? WHERE user_id=? AND provider='google' AND source_account_id=? AND external_id=? AND connection_scope_id=?`)
            .run(recurrenceChanged ? "unsupported-recurrence" : (timing.limitationCode ?? "unsupported-timing"), recurrenceChanged ? "The Google recurrence changed outside FileTasks. Its original Calendar representation is preserved and sync is paused." : (timing.limitationMessage ?? "Google Event timing cannot be verified."), connection.user_id,accountId,event.id,connection.connection_scope_id);
        }
        else {
          db.prepare(`UPDATE calendar_import_metadata SET state='supported', limitation_code=NULL, limitation_message=NULL WHERE user_id=? AND provider='google' AND source_account_id=? AND external_id=? AND connection_scope_id=? AND limitation_code='missing-source'`)
            .run(connection.user_id,accountId,event.id,connection.connection_scope_id);
        }
        continue;
      }
      if (event.extendedProperties?.private?.filetasksItemId) continue;
      const start = event.start?.dateTime ?? event.start?.date;
      if (typeof start !== "string" || !start) continue;
      const date = start.slice(0,10); const time = event.start?.dateTime ? start.slice(11,16) : null;
      const details = typeof event.description === "string" ? event.description : "";
      const recurrenceLines: string[] = Array.isArray(event.recurrence) && event.recurrence.every((line: unknown) => typeof line === "string") ? event.recurrence : [];
      const recurrenceLine = recurrenceLines.find((line) => line.toUpperCase().startsWith("RRULE:")) ?? null;
      const recurrenceInfo = recurrenceSupport(recurrenceLine,date);
      const timingInfo = parseGoogleTiming(event);
      const excludedDates = googleExclusionDates(recurrenceLines,event);
      const recurrenceHasExtras = (event.recurrence !== undefined && (!Array.isArray(event.recurrence) || !event.recurrence.every((line: unknown) => typeof line === "string")))
        || recurrenceLines.some((line) => !/^(?:RRULE|EXDATE)(?:;[^:]*)?:/i.test(line))
        || recurrenceLines.filter((line) => line.toUpperCase().startsWith("RRULE:")).length > 1
        || (recurrenceLines.some((line) => /^EXDATE(?:;[^:]*)?:/i.test(line)) && excludedDates === null)
        || (recurrenceLines.some((line) => /^EXDATE(?:;[^:]*)?:/i.test(line)) && !recurrenceLine);
      const textLimited = (event.summary?.length ?? 0) > 200 || details.length > 10_000;
      const recurrenceOutsideIssue20 = Boolean(recurrenceInfo.recurrence && !isIssue20Recurrence(recurrenceInfo.recurrence));
      const state = timingInfo.state === "limited" || recurrenceInfo.state === "limited" || recurrenceHasExtras || recurrenceOutsideIssue20 || textLimited ? "limited" : "supported";
      const limitationMessage = timingInfo.state === "limited" ? timingInfo.limitationMessage
        : recurrenceInfo.state === "limited" ? recurrenceInfo.limitationMessage
          : recurrenceOutsideIssue20 ? "This imported recurring Event uses a Recurrence pattern outside the supported subset. Its original Calendar data is preserved and sync is paused."
          : recurrenceHasExtras ? "This imported Event has recurrence exceptions or rules FileTasks cannot represent yet. Its original Google Event is preserved and sync is paused." : textLimited ? "This imported Event has text longer than FileTasks can display. Its original Google Event is preserved and sync is paused." : undefined;
      const sourceMetadata: ImportMetadataInput = {
        accountId,timing:timingInfo.timing,state,...(excludedDates ? {excludedDates} : {}),
        ...(state === "limited" ? { limitationCode:timingInfo.state === "limited" ? timingInfo.limitationCode : textLimited && !recurrenceOutsideIssue20 ? "unsupported-text" : "unsupported-recurrence",limitationMessage } : {}),
        sourcePayload:event,
      };
      importEventWithIdentity(connection.user_id,"google",event.id,connection.connection_scope_id,event.summary ?? "Untitled Event",details,date,time,recurrenceInfo.recurrence,undefined,sourceMetadata,connection);
      existing.add(event.id); imported++;
    }
  // Keep this restriction durable: a missing instance in a later bounded listing
  // does not prove that the provider series no longer has exceptions.
  for (const masterId of exceptionMasters) {
    database().prepare(`UPDATE calendar_import_metadata SET state='limited', limitation_code='unsupported-recurrence',
      limitation_message=? WHERE user_id=? AND provider='google' AND source_account_id=? AND external_id=? AND connection_scope_id=?`)
      .run("This imported Event has recurrence exceptions FileTasks cannot represent yet. Its original Google Event is preserved and sync is paused.",connection.user_id,connection.calendar_url ?? "primary",masterId,connection.connection_scope_id);
  }
  for (const masterId of masters) {
    if (!exceptionMasters.has(masterId)) db.prepare(`DELETE FROM google_inventory_pending WHERE user_id=? AND source_account_id=? AND inventory_id=? AND connection_scope_id=? AND item_id IN
      (SELECT m.item_id FROM calendar_import_metadata m JOIN calendar_copies c ON c.user_id=m.user_id AND c.item_id=m.item_id AND c.provider='google' AND c.external_id=m.external_id AND c.connection_scope_id=m.connection_scope_id WHERE m.user_id=? AND m.provider='google' AND m.source_account_id=? AND m.external_id=? AND m.connection_scope_id=?)`)
      .run(connection.user_id,accountId,inventoryId,connection.connection_scope_id,connection.user_id,accountId,masterId,connection.connection_scope_id);
  }
  // Only a retained, supported single Event with the original copy identity can
  // proceed to a direct provider check after the complete inventory.
  const pendingRows = db.prepare(`SELECT m.*,c.external_id AS copy_id FROM calendar_import_metadata m JOIN google_inventory_pending p ON p.user_id=m.user_id AND p.item_id=m.item_id
    JOIN calendar_copies c ON c.user_id=m.user_id AND c.item_id=m.item_id AND c.provider='google'
    WHERE m.user_id=? AND m.provider='google' AND m.source_account_id=? AND p.inventory_id=? AND m.state='supported' AND m.connection_scope_id=? AND p.connection_scope_id=m.connection_scope_id AND c.connection_scope_id=m.connection_scope_id`).all(connection.user_id,accountId,inventoryId,connection.connection_scope_id) as (ImportMetadataRow & {copy_id:string})[];
  for (const row of pendingRows) {
    if (exceptionMasters.has(row.copy_id)) continue;
    if (row.copy_id !== row.external_id) {
      const current = inventory.find(event => event.id === row.copy_id && event.status !== "cancelled");
      if (current && (current.recurringEventId || (current.recurrence !== undefined && (!Array.isArray(current.recurrence) || current.recurrence.length)) || parseGoogleTiming(current).state !== "supported")) continue;
    }
    try {
      const source = JSON.parse(row.source_payload_json ?? "null");
      const baseline = JSON.parse(row.baseline_json);
      if (!source || source.id !== row.external_id || source.recurringEventId || (source.recurrence !== undefined && (!Array.isArray(source.recurrence) || source.recurrence.length)) || baseline.recurrence) continue;
      db.prepare("DELETE FROM google_inventory_pending WHERE user_id=? AND item_id=? AND inventory_id=? AND connection_scope_id=?").run(connection.user_id,row.item_id,inventoryId,connection.connection_scope_id);
    } catch { /* Unverifiable retained metadata must remain pending. */ }
  }
  assertActiveScope(connection);
  db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch (rollbackError) { throw new AggregateError([error,rollbackError],"Google inventory transaction could not be rolled back."); }
    throw error;
  }
  return imported;
}

function xmlDecode(value: string) { return value.replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'").replaceAll("&amp;","&"); }
function unfoldedIcsLines(ics: string) { return ics.replace(/\r?\n[ \t]/g,"").split(/\r?\n/); }
function icsPropertyEntry(ics: string, name: string) {
  const event = firstEventLines(ics);
  let depth = 0;
  const lines = event ? event.lines.slice(event.start + 1,event.end) : unfoldedIcsLines(ics);
  const line = lines.find((part) => {
    const upper = part.toUpperCase();
    if (event && upper.startsWith("BEGIN:")) { depth++; return false; }
    if (event && upper.startsWith("END:")) { depth--; return false; }
    return depth === 0 && (upper.startsWith(`${name.toUpperCase()};`) || upper.startsWith(`${name.toUpperCase()}:`));
  });
  if (!line) return null;
  const separator = line.indexOf(":"); if (separator < 0) return null;
  const [property, ...parameters] = line.slice(0,separator).split(";");
  const params = Object.fromEntries(parameters.map((parameter) => {
    const index = parameter.indexOf("=");
    return index < 0 ? [parameter.toUpperCase(),""] : [parameter.slice(0,index).toUpperCase(),parameter.slice(index+1).replace(/^"|"$/g,"")];
  }));
  return { line, property, params, value:line.slice(separator+1) };
}
function unescapeIcs(value: string) { return value.replace(/\\n/gi,"\n").replace(/\\,/g,",").replace(/\\;/g,";").replace(/\\\\/g,"\\"); }
function icsProperty(ics: string, name: string) {
  const property = icsPropertyEntry(ics,name);
  return property ? unescapeIcs(property.value) : null;
}

function compactDateTime(date: string, time: string) { return `${compactDate(date)}T${time.replaceAll(":","")}`; }
function parseIcsDateProperty(property: ReturnType<typeof icsPropertyEntry>) {
  if (!property) return null;
  if (property.params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(property.value)) {
    const match = property.value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return null;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    return validDate(date) ? { kind:"allDay" as const,date } : null;
  }
  const match = property.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const time = `${match[4]}:${match[5]}:${match[6]}`;
  if (!validDate(date) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  const zone = property.params.TZID ?? (match[7].toUpperCase() === "Z" ? "UTC" : undefined);
  return { kind:"timed" as const,date,time,zone,utc:match[7].toUpperCase()==="Z" };
}

function appleExclusionDates(rootText: string, start: NonNullable<ReturnType<typeof parseIcsDateProperty>>) {
  const lines = unfoldedIcsLines(rootText).filter((line) => /^EXDATE(?:;[^:]*)?:/i.test(line));
  const dates: string[] = [];
  for (const line of lines) {
    const property = icsPropertyEntry(`${line}\r\n`,"EXDATE");
    const separator=line.indexOf(":");
    if (!property || separator < 0) return null;
    if (start.kind === "allDay") {
      if (property.params.VALUE?.toUpperCase() !== "DATE" || property.params.TZID) return null;
      for (const value of property.value.split(",")) {
        const parsed=parseIcsDateProperty({...property,value});
        if (!parsed || parsed.kind !== "allDay") return null;
        dates.push(parsed.date);
      }
    } else {
      if (!start.zone) return null;
      if (start.utc ? (property.params.TZID || property.params.VALUE) : (property.params.TZID !== start.zone || property.params.VALUE)) return null;
      for (const value of property.value.split(",")) {
        const parsed=parseIcsDateProperty({...property,value});
        if (!parsed || parsed.kind !== "timed" || parsed.time !== start.time || parsed.zone !== start.zone || parsed.utc !== start.utc) return null;
        dates.push(parsed.date);
      }
    }
  }
  return [...new Set(dates)];
}

function parseAppleTiming(ics: string) {
  const lines = unfoldedIcsLines(ics);
  const events = [] as string[][];
  let current: string[] | null = null;
  let nested = 0;
  for (const line of lines) {
    if (line.toUpperCase() === "BEGIN:VEVENT") { current = []; nested = 0; }
    else if (line.toUpperCase() === "END:VEVENT") { if (current) events.push(current); current = null; }
    else if (current && /^BEGIN:/i.test(line)) nested++;
    else if (current && /^END:/i.test(line)) nested--;
    else if (current && nested === 0) current.push(line);
  }
  const root = events[0] ?? [];
  const rootIcs = root.join("\r\n");
  const start = parseIcsDateProperty(icsPropertyEntry(rootIcs,"DTSTART"));
  const endEntry = icsPropertyEntry(rootIcs,"DTEND");
  const end = parseIcsDateProperty(endEntry);
  if (!start) return { timing:{kind:"allDay",startDate:"1970-01-01",endDate:"1970-01-01"} satisfies ProviderTiming,
    state:"limited" as const,limitationCode:"unsupported-timing",limitationMessage:"This imported Event has timing FileTasks cannot safely interpret. The original Apple Event is preserved and sync is paused." };
  const rootText = root.join("\r\n");
  const recurrenceInput = icsProperty(rootText,"RRULE");
  const recurrenceInfo = recurrenceSupport(recurrenceInput, start.date);
  const excludedDates = appleExclusionDates(rootText,start);
  const hasExceptions = events.length > 1 || /^(?:RDATE|EXRULE)(?:;[^:]*)?:/im.test(rootText) || excludedDates === null
    || (!recurrenceInput && /^EXDATE(?:;[^:]*)?:/im.test(rootText))
    || events.some((event) => event.some((line) => /^RECURRENCE-ID(?:;[^:]*)?:/i.test(line)));
  const duplicateSingleton = ["DTSTART","DTEND","DURATION","RRULE"].some((name) =>
    root.filter((line) => new RegExp(`^${name}(?:;[^:]*)?:`,"i").test(line)).length > 1)
    || (root.some((line) => /^DTEND(?:;[^:]*)?:/i.test(line)) && root.some((line) => /^DURATION(?:;[^:]*)?:/i.test(line)));
  const embeddedTimezone = lines.some((line) => /^BEGIN:VTIMEZONE$/i.test(line));
  const commonUnsupported = embeddedTimezone && start.kind === "timed" && !start.utc
    ? { code:"unsupported-timezone",message:"This imported Event uses embedded timezone rules that FileTasks cannot verify. Its original Apple Event is preserved and sync is paused." }
    : duplicateSingleton
    ? { code:"malformed-event",message:"This imported Event has duplicate or conflicting timing or recurrence properties. Its original Apple Event is preserved and sync is paused." }
    : hasExceptions
    ? { code:"unsupported-recurrence",message:"This imported Event has recurrence exceptions FileTasks cannot represent yet. Its original Apple Event is preserved and sync is paused." }
    : recurrenceInfo.state === "limited" ? { code:recurrenceInfo.limitationCode!,message:recurrenceInfo.limitationMessage! }
      : recurrenceInfo.recurrence && !isIssue20Recurrence(recurrenceInfo.recurrence) ? {code:"unsupported-recurrence",message:"This imported recurring Event uses a Recurrence pattern outside the supported subset. Its original Calendar data is preserved and sync is paused."} : null;
  if (start.kind === "allDay" && !endEntry && !root.some((line) => /^DURATION(?:;[^:]*)?:/i.test(line))) {
    const timing = { kind:"allDay",startDate:start.date,endDate:plusOneDay(start.date),dayCount:1 } satisfies ProviderTiming;
    if (commonUnsupported) return { timing,state:"limited" as const,limitationCode:commonUnsupported.code,limitationMessage:commonUnsupported.message };
    return { timing,state:"supported" as const,recurrence:recurrenceInfo.recurrence,excludedDates };
  }
  if (start.kind === "allDay" && end?.kind === "allDay" && end.date > start.date) {
    const dayCount = Math.round((Date.parse(`${end.date}T00:00:00Z`)-Date.parse(`${start.date}T00:00:00Z`))/86_400_000);
    const timing = { kind:"allDay",startDate:start.date,endDate:end.date,dayCount } satisfies ProviderTiming;
    if (commonUnsupported) return { timing,state:"limited" as const,limitationCode:commonUnsupported.code,limitationMessage:commonUnsupported.message };
    return { timing,state:"supported" as const,recurrence:recurrenceInfo.recurrence,excludedDates };
  }
  if (start.kind === "timed" && end?.kind === "timed" && start.zone === end.zone && validTimeZone(start.zone ?? "")) {
    const startInstant = instantForTiming(start.date,start.time,start.zone,start.utc ? 0 : undefined);
    const endInstant = instantForTiming(end.date,end.time,end.zone,end.utc ? 0 : undefined);
    if (startInstant !== null && endInstant !== null && endInstant > startInstant) {
      const startOffset = zoneOffsetMinutes(startInstant,start.zone!);
      const endOffset = zoneOffsetMinutes(endInstant,end.zone!);
      const timing = { kind:"timed",startDate:start.date,endDate:end.date,startTime:start.time,endTime:end.time,startZone:start.zone,endZone:end.zone,
        startOffsetMinutes:start.utc ? 0 : startOffset,endOffsetMinutes:end.utc ? 0 : endOffset,durationMs:endInstant-startInstant,
        ...(start.utc ? {startUtc:true} : {}),...(end.utc ? {endUtc:true} : {}) } satisfies ProviderTiming;
      if (commonUnsupported) return { timing,state:"limited" as const,limitationCode:commonUnsupported.code,limitationMessage:commonUnsupported.message };
      return { timing,state:"supported" as const,recurrence:recurrenceInfo.recurrence,excludedDates };
    }
  }
  const timing: ProviderTiming = start.kind === "timed" ? {kind:"timed",startDate:start.date,endDate:end?.date ?? start.date,startTime:start.time,...(end?.kind === "timed" ? {endTime:end.time} : {}),...(start.zone ? {startZone:start.zone} : {})}
    : {kind:"allDay",startDate:start.date,endDate:end?.date ?? start.date};
  return { timing,state:"limited" as const,limitationCode:"unsupported-timing",
    limitationMessage:"This imported Event has a floating, missing, or unsupported timezone or end time. Its original Apple Event is preserved and sync is paused." };
}

function appleRecurrenceProperties(ics: string) {
  const event = firstEventLines(ics);
  if (!event) return null;
  return event.lines.slice(event.start+1,event.end).filter((line) => /^(?:RRULE|EXDATE|EXRULE|RDATE)(?:;[^:]*)?:/i.test(line));
}

function directAppleEventComponents(ics: string) {
  const components: string[][] = [];
  let current: string[] | null = null;
  let nested = 0;
  for (const line of unfoldedIcsLines(ics)) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      if (current) return null;
      current = [];
      nested = 0;
    } else if (/^END:VEVENT$/i.test(line)) {
      if (!current || nested) return null;
      components.push(current);
      current = null;
    } else if (current && /^BEGIN:/i.test(line)) nested++;
    else if (current && /^END:/i.test(line)) {
      if (!nested) return null;
      nested--;
    } else if (current && nested === 0) current.push(line);
  }
  return current ? null : components;
}

function appleRepresentationSignature(ics: string) {
  const components = directAppleEventComponents(ics);
  if (!components?.length) return null;
  const recurrenceLines = (lines: string[]) => lines.filter((line) => /^(?:RRULE|EXDATE|RDATE|EXRULE)(?:;[^:]*)?:/i.test(line))
    .map((line) => line.replace(/^([^:;]+)(;[^:]*)?:/,(match, name: string, params?: string) => `${name.toUpperCase()}${params ?? ""}:`))
    .sort();
  const timingLines = (lines: string[]) => lines.filter((line) => /^(?:DTSTART|DTEND|DURATION)(?:;[^:]*)?:/i.test(line)).sort();
  const exceptionSignature = (lines: string[]) => lines.filter((line) => !/^DTSTAMP(?:;[^:]*)?:/i.test(line)).sort();
  return JSON.stringify({
    recurrence:recurrenceLines(components[0]),
    timing:timingLines(components[0]),
    exceptions:components.slice(1).map(exceptionSignature).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}

function ensureAppleRepresentationBaselines() {
  database().exec(`CREATE TABLE IF NOT EXISTS apple_copy_representation_baselines (
    user_id TEXT NOT NULL,item_id TEXT NOT NULL,connection_scope_id TEXT NOT NULL,external_id TEXT NOT NULL,representation_json TEXT NOT NULL,
    PRIMARY KEY(user_id,item_id,connection_scope_id),
    FOREIGN KEY(user_id,item_id) REFERENCES items(user_id,id) ON DELETE CASCADE
  )`);
}

function saveAppleRepresentation(connection: Connection, itemId: string, scope: string, href: string, signature: string) {
  ensureAppleRepresentationBaselines();
  database().prepare(`INSERT INTO apple_copy_representation_baselines(user_id,item_id,connection_scope_id,external_id,representation_json)
    SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?)
    ON CONFLICT(user_id,item_id,connection_scope_id) DO UPDATE SET external_id=excluded.external_id,representation_json=excluded.representation_json
    WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?)`)
    .run(connection.user_id,itemId,scope,href,signature,connection.user_id,connection.provider,connection.connection_scope_id,connection.credential_generation_id,
      connection.user_id,connection.provider,connection.connection_scope_id,connection.credential_generation_id);
}

function appleFileTasksRepresentationMatches(connection: Connection, itemId: string, uid: string, ics: string, href: string) {
  const userId = connection.user_id;
  const scope = connection.connection_scope_id;
  if (!scope) return false;
  // This exception is only for FileTasks-owned Events. Imported source Events
  // retain their stricter provider-representation safeguards.
  if (database().prepare(`SELECT 1 FROM calendar_imports WHERE user_id=? AND item_id=?
    UNION ALL SELECT 1 FROM calendar_import_metadata WHERE user_id=? AND item_id=? LIMIT 1`)
    .get(userId,itemId,userId,itemId)) return false;
  const items = listItemsForCalendarSync(userId);
  const item = items.find((entry) => entry.id === itemId && entry.kind === "event");
  if (!item) return false;
  const components = directAppleEventComponents(ics);
  if (!components?.length || icsProperty(components[0].join("\r\n"),"UID") !== uid
    || icsProperty(components[0].join("\r\n"),"URL") !== filetasksEventUrl(item.id)) return false;
  const exceptions = items.filter((occurrence) => occurrence.seriesId === item.id && occurrence.id !== item.id
    && occurrence.occurrenceDate && (occurrence.scheduledDate !== occurrence.occurrenceDate || occurrence.scheduledTime !== item.scheduledTime
      || occurrence.title !== item.title || occurrence.details !== item.details));
  const expected = directAppleEventComponents(icsFor(item,uid,exceptions,calendarExclusions(userId,item.id)));
  if (!expected) return false;
  const actualSignature = appleRepresentationSignature(ics);
  const currentSignature = appleRepresentationSignature(icsFor(item,uid,exceptions,calendarExclusions(userId,item.id)));
  if (!actualSignature || !currentSignature) return false;
  if (actualSignature === currentSignature) {
    saveAppleRepresentation(connection,itemId,scope,href,currentSignature);
    return true;
  }
  ensureAppleRepresentationBaselines();
  const previous = database().prepare(`SELECT representation_json FROM apple_copy_representation_baselines
    WHERE user_id=? AND item_id=? AND connection_scope_id=? AND external_id=?`).get(userId,itemId,scope,href) as {representation_json:string} | undefined;
  return previous?.representation_json === actualSignature;
}

function appleStoredRepresentationMatches(userId: string, itemId: string, scope: string, href: string, ics: string) {
  const actual = appleRepresentationSignature(ics);
  if (!actual) return false;
  const previous = database().prepare(`SELECT representation_json FROM apple_copy_representation_baselines
    WHERE user_id=? AND item_id=? AND connection_scope_id=? AND external_id=?`).get(userId,itemId,scope,href) as {representation_json:string} | undefined;
  return previous?.representation_json === actual;
}

async function importAppleEvents(connection: Connection, verified: Set<string>) {
  assertActiveScope(connection);
  if (!connection.connection_scope_id) throw new Error("Missing connection scope");
  if (!connection.access_token || !connection.calendar_url) throw new HttpError(503,"Reconnect Apple Calendar to continue syncing.");
  const credentials = JSON.parse(decrypt(connection.access_token)) as { username: string; password: string };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const from = new Date(nowMs()-90*86_400_000).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/, "Z");
  const to = new Date(nowMs()+370*86_400_000).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/, "Z");
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${from}" end="${to}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  assertActiveScope(connection);
  const response = await fetch(connection.calendar_url,{ method:"REPORT", headers:{ Authorization:authorization, Depth:"1", "Content-Type":"application/xml; charset=utf-8" }, body });
  assertActiveScope(connection);
  if (!response.ok && response.status !== 207) throw new HttpError(502,"Could not read Events from Apple Calendar.");
  assertActiveScope(connection);
  const xml = await response.text();
  assertActiveScope(connection);
  const existing = new Set(database().prepare(`SELECT external_id FROM calendar_imports WHERE user_id=? AND provider='apple'
    UNION SELECT external_id FROM calendar_import_exclusions WHERE user_id=? AND provider='apple'
    UNION SELECT resource_uid AS external_id FROM calendar_copies WHERE user_id=? AND provider='apple' AND resource_uid IS NOT NULL
    UNION SELECT external_id FROM calendar_import_metadata WHERE user_id=? AND provider='apple'`)
    .all(connection.user_id,connection.user_id,connection.user_id,connection.user_id).map((row) => String(row.external_id)));
  const existingHrefs = new Set(database().prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND provider='apple'")
    .all(connection.user_id).map((row) => String(row.external_id)));
  let imported = 0;
  const missingHrefs = new Set<string>();
  const reportedHrefs = new Set<string>();
  const setDestinationLimit = (itemId: unknown, code: string, message: string) => {
    assertActiveScope(connection);
    return database().prepare(`INSERT INTO calendar_destination_limitations(user_id,item_id,provider,connection_scope_id,code,message)
      SELECT ?,?,'apple',?,?,? WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)
      ON CONFLICT(user_id,item_id,provider,connection_scope_id) DO UPDATE SET code=excluded.code,message=excluded.message
      WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
      .run(connection.user_id,String(itemId),connection.connection_scope_id,code,message,connection.user_id,connection.connection_scope_id,connection.credential_generation_id,
        connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
  };
  const clearDestinationLimit = (itemId: unknown) => {
    assertActiveScope(connection);
    return database().prepare(`DELETE FROM calendar_destination_limitations WHERE user_id=? AND item_id=? AND provider='apple' AND connection_scope_id=?
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
      .run(connection.user_id,String(itemId),connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
  };
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?response[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi)) {
    const href = match[1].match(/<(?:[\w.-]+:)?href[^>]*>([^<]+)</i)?.[1];
    const data = match[1].match(/<(?:[\w.-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?calendar-data>/i)?.[1];
    if (!href || !data) continue;
    const resourceUrl = new URL(xmlDecode(href),connection.calendar_url).toString();
    if (!isAppleCalDavHost(new URL(resourceUrl).hostname)) continue;
    reportedHrefs.add(resourceUrl);
    const ics = xmlDecode(data); const uid = icsProperty(ics,"UID");
    const mappedAtHref = database().prepare("SELECT item_id,resource_uid FROM calendar_copies WHERE user_id=? AND provider='apple' AND external_id=? AND connection_scope_id=?").get(connection.user_id,resourceUrl,connection.connection_scope_id);
    if (mappedAtHref && (!uid || uid !== String(mappedAtHref.resource_uid))) {
      setDestinationLimit(mappedAtHref.item_id,"identity-mismatch","The Apple Calendar copy has a different identity. Sync is paused.");
      database().prepare(`UPDATE calendar_import_metadata SET state='limited',limitation_code='identity-mismatch',limitation_message='The Apple Calendar copy has a different identity. Sync is paused.'
        WHERE user_id=? AND item_id=? AND provider='apple' AND connection_scope_id=?
        AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
        .run(connection.user_id,mappedAtHref.item_id,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
      // A copy without import metadata must also never be overwritten.
      throw new HttpError(409,"An Apple Calendar copy has a different identity. Sync is paused.");
    }
    if (!uid) continue;
    const timingInfo = parseAppleTiming(ics);
    if (existing.has(uid) || existingHrefs.has(resourceUrl)) {
      const summary = icsProperty(ics,"SUMMARY") ?? "Untitled Event";
      const description = icsProperty(ics,"DESCRIPTION") ?? "";
      const recurrence = "recurrence" in timingInfo ? timingInfo.recurrence : recurrenceSupport(icsProperty(ics,"RRULE"),timingInfo.timing.startDate).recurrence;
      const textLimited = summary.length > 200 || description.length > 10_000;
      const importedSourceIcs = database().prepare("SELECT source_ics FROM calendar_import_metadata WHERE user_id=? AND provider='apple' AND external_id=? AND connection_scope_id=?")
        .get(connection.user_id,uid,connection.connection_scope_id)?.source_ics;
      const unchangedSourceRecurrence = typeof importedSourceIcs === "string" && timingInfo.state === "supported"
        && JSON.stringify(appleRecurrenceProperties(importedSourceIcs)) === JSON.stringify(appleRecurrenceProperties(ics));
      const generatedRepresentation = mappedAtHref && !textLimited && (timingInfo.state === "limited" || Boolean(recurrence))
        && (appleFileTasksRepresentationMatches(connection,String(mappedAtHref.item_id),uid,ics,resourceUrl)
          || appleStoredRepresentationMatches(connection.user_id,String(mappedAtHref.item_id),connection.connection_scope_id!,resourceUrl,ics));
      if (generatedRepresentation) {
        clearDestinationLimit(mappedAtHref.item_id);
        verified.add(String(mappedAtHref.item_id));
      }
      else if (timingInfo.state === "limited" || ((Boolean(recurrence) || /^EXDATE(?:;[^:]*)?:/im.test(ics)) && !unchangedSourceRecurrence) || textLimited) {
        const code = textLimited ? "unsupported-text" : recurrence ? "unsupported-recurrence" : timingInfo.limitationCode;
        const message = textLimited ? "This imported Event has text longer than FileTasks can display. Sync is paused." : recurrence ? "Imported recurring Events are paused to preserve external exceptions." : timingInfo.limitationMessage;
        if (mappedAtHref && database().prepare("SELECT 1 FROM items WHERE user_id=? AND id=?").get(connection.user_id,mappedAtHref.item_id)) {
          setDestinationLimit(mappedAtHref.item_id,code ?? "unsupported-timing",message ?? "This Event timing cannot be verified. Sync is paused.");
        }
        assertActiveScope(connection);
        database().prepare(`UPDATE calendar_import_metadata SET state='limited',limitation_code=?,limitation_message=?
          WHERE user_id=? AND provider='apple' AND source_account_id=? AND external_id=? AND connection_scope_id=?
          AND EXISTS (SELECT 1 FROM calendar_imports i WHERE i.user_id=calendar_import_metadata.user_id AND i.provider='apple'
            AND i.external_id=calendar_import_metadata.external_id AND i.item_id=calendar_import_metadata.item_id AND i.connection_scope_id=calendar_import_metadata.connection_scope_id)
          AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
          .run(code ?? "unsupported-timing",message ?? "This Event timing cannot be verified. Sync is paused.",connection.user_id,connection.calendar_url,uid,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
      }
      else if (mappedAtHref && /^BEGIN:VCALENDAR\s*$/im.test(ics) && /^END:VCALENDAR\s*$/im.test(ics) && /^BEGIN:VEVENT\s*$/im.test(ics) && /^END:VEVENT\s*$/im.test(ics)) {
        clearDestinationLimit(mappedAtHref.item_id);
        verified.add(String(mappedAtHref.item_id));
        assertActiveScope(connection);
        database().prepare(`UPDATE calendar_import_metadata SET state='supported',limitation_code=NULL,limitation_message=NULL WHERE user_id=? AND provider='apple' AND item_id=? AND external_id=? AND source_account_id=? AND connection_scope_id=? AND limitation_code IN ('unverifiable-event','transient-verification')
          AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
          .run(connection.user_id,mappedAtHref.item_id,uid,connection.calendar_url,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
      }
      continue;
    }
    const date = timingInfo.timing.startDate;
    const time = timingInfo.timing.kind === "timed" ? timingInfo.timing.startTime?.slice(0,5) ?? null : null;
    const summary = icsProperty(ics,"SUMMARY") ?? "Untitled Event"; const description = icsProperty(ics,"DESCRIPTION") ?? "";
    const recurrence = "recurrence" in timingInfo ? timingInfo.recurrence : recurrenceSupport(icsProperty(ics,"RRULE"),date).recurrence;
    const sourceMetadata: ImportMetadataInput = {
      accountId:connection.calendar_url,timing:timingInfo.timing,state:summary.length > 200 || description.length > 10_000 ? "limited" : timingInfo.state,
      ...("excludedDates" in timingInfo && timingInfo.excludedDates ? {excludedDates:timingInfo.excludedDates} : {}),
      ...(timingInfo.state === "limited" ? { limitationCode:timingInfo.limitationCode,limitationMessage:timingInfo.limitationMessage } : {}),
      ...(summary.length > 200 || description.length > 10_000 ? { limitationCode:"unsupported-text",limitationMessage:"This imported Event has text longer than FileTasks can display. Its original Apple Event is preserved and sync is paused." } : {}),
      sourceIcs:ics,
    };
    importEventWithIdentity(connection.user_id,"apple",uid,connection.connection_scope_id,summary,description,date,time,recurrence,resourceUrl,sourceMetadata,connection);
    existing.add(uid); existingHrefs.add(resourceUrl); imported++;
  }
  // A time-range REPORT can omit a resource that was moved outside the window.
  // Verify every omitted imported copy before any provider is allowed to export it.
  const omitted = database().prepare(`SELECT c.item_id,c.resource_uid AS external_id,c.external_id AS href FROM calendar_copies c
    JOIN items i ON i.user_id=c.user_id AND i.id=c.item_id
    WHERE c.user_id=? AND c.provider='apple' AND c.connection_scope_id=?`)
    .all(connection.user_id,connection.connection_scope_id);
  const collection = new URL(connection.calendar_url);
  for (const row of omitted) {
    const href = String(row.href);
    if (reportedHrefs.has(href)) continue;
    let message = "The original Apple Event could not be verified. Calendar sync is paused.";
    let code = "unverifiable-event";
    try {
      const url = new URL(href);
      if (!isAllowedAppleUrl(collection) || url.origin !== collection.origin || !isAllowedAppleUrl(url)
        || !url.pathname.startsWith(collection.pathname.replace(/\/$/,"") + "/") || url.username || url.password || url.hash) throw new Error("Invalid resource URL");
      assertActiveScope(connection);
      let resource: Response;
      try { resource = await fetch(url.toString(),{method:"GET",headers:{Authorization:authorization},redirect:"error"}); }
      catch { code = "transient-verification"; throw new Error("Resource unavailable"); }
      assertActiveScope(connection);
      if (resource.status === 404 || resource.status === 410) {
        const metadata = database().prepare("SELECT * FROM calendar_import_metadata WHERE user_id=? AND provider='apple' AND item_id=? AND external_id=? AND connection_scope_id=? AND source_account_id=?").get(connection.user_id,row.item_id,row.external_id,connection.connection_scope_id,connection.calendar_url) as ImportMetadataRow | undefined;
        if (!metadata) { clearDestinationLimit(row.item_id); missingHrefs.add(href); continue; }
        if (metadata?.state === "supported") { missingHrefs.add(href); continue; }
        if (metadata?.limitation_code === "transient-verification" && metadata.source_ics) {
          const retained = parseAppleTiming(metadata.source_ics);
          const baseline = JSON.parse(metadata.baseline_json);
          if (retained.state === "supported" && !("recurrence" in retained && retained.recurrence) && !baseline.recurrence && icsProperty(metadata.source_ics,"UID") === String(row.external_id)) {
            assertActiveScope(connection);
            database().prepare(`UPDATE calendar_import_metadata SET state='supported',limitation_code=NULL,limitation_message=NULL WHERE user_id=? AND provider='apple' AND item_id=? AND external_id=? AND connection_scope_id=? AND source_account_id=? AND limitation_code='transient-verification'
              AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
              .run(connection.user_id,row.item_id,row.external_id,connection.connection_scope_id,connection.calendar_url,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
            missingHrefs.add(href); continue;
          }
        }
        throw new Error("Resource unavailable");
      }
      if (!resource.ok) { if (resource.status >= 500 || resource.status === 429) code = "transient-verification"; throw new Error("Resource unavailable"); }
      const ics = await resource.text();
      assertActiveScope(connection);
      if (!/^BEGIN:VCALENDAR\s*$/im.test(ics) || !/^END:VCALENDAR\s*$/im.test(ics)
        || !/^BEGIN:VEVENT\s*$/im.test(ics) || !/^END:VEVENT\s*$/im.test(ics)
        || icsProperty(ics,"UID") !== String(row.external_id)) throw new Error("Invalid resource");
      if (appleFileTasksRepresentationMatches(connection,String(row.item_id),String(row.external_id),ics,href)) {
        clearDestinationLimit(row.item_id);
        verified.add(String(row.item_id));
        continue;
      }
      const timing = parseAppleTiming(ics);
      const recurrence = "recurrence" in timing ? timing.recurrence : recurrenceSupport(icsProperty(ics,"RRULE"),timing.timing.startDate).recurrence;
      const summary = icsProperty(ics,"SUMMARY") ?? "Untitled Event";
      const description = icsProperty(ics,"DESCRIPTION") ?? "";
      if (summary.length > 200 || description.length > 10_000) { code = "unsupported-text"; message = "This imported Event has text longer than FileTasks can display. Sync is paused."; }
      else if (recurrence) { code = "unsupported-recurrence"; message = "Imported recurring Events are paused to preserve external exceptions."; }
      else if (timing.state === "limited") { code = timing.limitationCode ?? code; message = timing.limitationMessage ?? message; }
      else {
        clearDestinationLimit(row.item_id);
        verified.add(String(row.item_id));
        assertActiveScope(connection);
        database().prepare(`UPDATE calendar_import_metadata SET state='supported',limitation_code=NULL,limitation_message=NULL WHERE user_id=? AND provider='apple' AND item_id=? AND external_id=? AND connection_scope_id=? AND source_account_id=? AND limitation_code IN ('unverifiable-event','transient-verification')
          AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
          .run(connection.user_id,row.item_id,row.external_id,connection.connection_scope_id,connection.calendar_url,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
        continue;
      }
    } catch {
      // A changed connection must abort the whole sync, including other providers.
      assertActiveScope(connection);
    }
    assertActiveScope(connection);
    setDestinationLimit(row.item_id,code,message);
    assertActiveScope(connection);
    database().prepare(`UPDATE calendar_import_metadata SET state='limited',limitation_code=?,limitation_message=?
      WHERE user_id=? AND provider='apple' AND item_id=? AND external_id=? AND connection_scope_id=? AND source_account_id=? AND (? NOT IN ('unverifiable-event','transient-verification') OR state='supported' OR limitation_code IN ('unverifiable-event','transient-verification'))
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
      .run(code,message,connection.user_id,row.item_id,row.external_id,connection.connection_scope_id,connection.calendar_url,code,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
  }
  return missingHrefs;
}

function retainedGoogleSingle(metadata: ImportMetadataRow) {
  try {
    const source = JSON.parse(metadata.source_payload_json ?? "null");
    const baseline = JSON.parse(metadata.baseline_json);
    return Boolean(source && source.id === metadata.external_id && !source.recurringEventId
      && (source.recurrence === undefined || (Array.isArray(source.recurrence) && source.recurrence.length === 0)) && !baseline.recurrence);
  } catch { return false; }
}

async function verifyLegacyGoogle(connection: Connection, events: EventItem[]) {
  assertActiveScope(connection);
  const access = await googleAccess(connection); const calendarId = encodeURIComponent(connection.calendar_url ?? "primary");
  assertActiveScope(connection);
  const maps = new Map(database().prepare("SELECT item_id,external_id,connection_scope_id FROM calendar_copies WHERE user_id=? AND provider='google'").all(connection.user_id).map((row) => [String(row.item_id),{ id:String(row.external_id), scope:row.connection_scope_id }]));
  const roots = events.filter((item) => (!item.seriesId || item.id === item.seriesId) && item.scheduledDate);
  // Recover only identities that can be proved to belong to this pre-upgrade connection.
  for (const item of roots) {
    const copy = maps.get(item.id);
    if (!copy || copy.scope !== null || !copy.id || !connection.connection_scope_id) continue;
    const eligible = database().prepare(`SELECT 1 FROM calendar_copies c
      JOIN items i ON i.id=c.item_id AND i.user_id=c.user_id AND i.kind='event'
      JOIN calendar_connections conn ON conn.user_id=c.user_id AND conn.provider=c.provider
      WHERE c.user_id=? AND c.provider='google' AND c.item_id=? AND c.external_id=? AND c.connection_scope_id IS NULL
        AND conn.connection_scope_id=? AND conn.credential_generation_id=? AND conn.legacy_identity_eligible=1 AND conn.calendar_url IS ?
        AND NOT EXISTS (SELECT 1 FROM calendar_imports x WHERE x.user_id=c.user_id AND (x.item_id=c.item_id OR (x.provider=c.provider AND x.external_id=c.external_id)))
        AND NOT EXISTS (SELECT 1 FROM calendar_import_metadata x WHERE x.user_id=c.user_id AND (x.item_id=c.item_id OR (x.provider=c.provider AND x.external_id=c.external_id)))
        AND NOT EXISTS (SELECT 1 FROM calendar_import_exclusions x WHERE x.user_id=c.user_id AND x.provider=c.provider AND x.external_id=c.external_id)`)
      .get(connection.user_id,item.id,copy.id,connection.connection_scope_id,connection.credential_generation_id,connection.calendar_url);
    if (!eligible) continue;
    let verified: { id?: string; status?: string; extendedProperties?: { private?: { filetasksItemId?: string } } };
    try {
      const response = await fetch(googleApiUrl(`calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(copy.id)}`), { headers: { Authorization: `Bearer ${access}` } });
      assertActiveScope(connection);
      if (!response.ok) continue;
      verified = await response.json() as typeof verified;
      assertActiveScope(connection);
    } catch { assertActiveScope(connection); continue; }
    if (verified.id !== copy.id || verified.status === 'cancelled' || verified.extendedProperties?.private?.filetasksItemId !== item.id) continue;
    const result = database().prepare(`UPDATE calendar_copies AS c SET connection_scope_id=?
      WHERE c.user_id=? AND c.provider='google' AND c.item_id=? AND c.external_id=? AND c.connection_scope_id IS NULL
        AND EXISTS (SELECT 1 FROM items i WHERE i.id=c.item_id AND i.user_id=c.user_id AND i.kind='event')
        AND EXISTS (SELECT 1 FROM calendar_connections conn WHERE conn.user_id=c.user_id AND conn.provider=c.provider AND conn.connection_scope_id=? AND conn.credential_generation_id=? AND conn.legacy_identity_eligible=1 AND conn.calendar_url IS ?)
        AND NOT EXISTS (SELECT 1 FROM calendar_imports x WHERE x.user_id=c.user_id AND (x.item_id=c.item_id OR (x.provider=c.provider AND x.external_id=c.external_id)))
        AND NOT EXISTS (SELECT 1 FROM calendar_import_metadata x WHERE x.user_id=c.user_id AND (x.item_id=c.item_id OR (x.provider=c.provider AND x.external_id=c.external_id)))
        AND NOT EXISTS (SELECT 1 FROM calendar_import_exclusions x WHERE x.user_id=c.user_id AND x.provider=c.provider AND x.external_id=c.external_id)`)
      .run(connection.connection_scope_id,connection.user_id,item.id,copy.id,connection.connection_scope_id,connection.credential_generation_id,connection.calendar_url);
    if (result.changes) { copy.scope = connection.connection_scope_id; Object.assign(item,getItem(connection.user_id,item.id)); }
  }
 }

async function verifyLegacyApple(connection: Connection, events: EventItem[]) {
  assertActiveScope(connection);
  if (!connection.access_token || !connection.calendar_url) throw new HttpError(503, "Reconnect Apple Calendar to continue syncing.");
  const credentials = JSON.parse(decrypt(connection.access_token)) as { username: string; password: string };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const maps = new Map(database().prepare("SELECT item_id,external_id,resource_uid,connection_scope_id FROM calendar_copies WHERE user_id=? AND provider='apple'").all(connection.user_id).map((row) => [String(row.item_id),{ href:String(row.external_id),uid:String(row.resource_uid ?? row.external_id),scope:row.connection_scope_id }]));
  const roots = events.filter((item) => (!item.seriesId || item.id === item.seriesId) && item.scheduledDate);
  // A legacy copy is usable only after its exact resource proves its identity.
  for (const item of roots) {
    const copy = maps.get(item.id);
    const backlink = filetasksEventUrl(item.id);
    if (!copy || copy.scope !== null || !backlink || !connection.connection_scope_id) continue;
    const eligible = `c.user_id=? AND c.provider='apple' AND c.item_id=? AND c.external_id=? AND c.resource_uid=? AND c.connection_scope_id IS NULL
      AND EXISTS (SELECT 1 FROM items i WHERE i.id=c.item_id AND i.user_id=c.user_id AND i.kind='event')
      AND EXISTS (SELECT 1 FROM calendar_connections conn WHERE conn.user_id=c.user_id AND conn.provider=c.provider AND conn.connection_scope_id=? AND conn.credential_generation_id=? AND conn.legacy_identity_eligible=1 AND conn.calendar_url IS ?)
      AND NOT EXISTS (SELECT 1 FROM calendar_imports x WHERE x.user_id=c.user_id AND (x.item_id=c.item_id OR (x.provider=c.provider AND (x.external_id=c.external_id OR x.external_id=c.resource_uid))))
      AND NOT EXISTS (SELECT 1 FROM calendar_import_metadata x WHERE x.user_id=c.user_id AND (x.item_id=c.item_id OR (x.provider=c.provider AND (x.external_id=c.external_id OR x.external_id=c.resource_uid))))
      AND NOT EXISTS (SELECT 1 FROM calendar_import_exclusions x WHERE x.user_id=c.user_id AND x.provider=c.provider AND (x.external_id=c.external_id OR x.external_id=c.resource_uid))`;
    const args = [connection.user_id,item.id,copy.href,copy.uid,connection.connection_scope_id,connection.credential_generation_id,connection.calendar_url];
    if (!database().prepare(`SELECT 1 FROM calendar_copies c WHERE ${eligible}`).get(...args)) continue;
    try {
      const url = new URL(copy.href);
      const collection = new URL(connection.calendar_url);
      if (url.toString() !== copy.href || url.origin !== collection.origin || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(collection.pathname.replace(/\/$/,"") + "/") || !isAppleCalDavHost(url.hostname)
        || /%2f|%5c/i.test(url.pathname)) continue;
      const response = await fetch(copy.href,{headers:{Authorization:authorization},redirect:"manual"});
      if (!response.ok) continue;
      const lines = unfoldedIcsLines(await response.text());
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      const upper = lines.map((line) => line.toUpperCase());
      if (upper.filter((line) => line === "BEGIN:VCALENDAR").length !== 1 || upper.filter((line) => line === "END:VCALENDAR").length !== 1
        || upper.filter((line) => line === "BEGIN:VEVENT").length !== 1 || upper.filter((line) => line === "END:VEVENT").length !== 1) continue;
      const start = upper.indexOf("BEGIN:VEVENT"), end = upper.indexOf("END:VEVENT");
      if (upper[0] !== "BEGIN:VCALENDAR" || upper[upper.length-1] !== "END:VCALENDAR" || start < 1 || end <= start) continue;
      const event = lines.slice(start+1,end);
      const uids = event.filter((line) => /^UID:/i.test(line));
      const urls = event.filter((line) => /^URL:/i.test(line));
      if (uids.length !== 1 || urls.length !== 1 || unescapeIcs(uids[0].slice(4)) !== copy.uid || urls[0].slice(4) !== backlink) continue;
      const result = database().prepare(`UPDATE calendar_copies AS c SET connection_scope_id=? WHERE ${eligible}`).run(connection.connection_scope_id,...args);
      if (result.changes) { copy.scope = connection.connection_scope_id; Object.assign(item,getItem(connection.user_id,item.id)); }
    } catch { /* Leave unverifiable legacy copies untouched. */ }
  }
  assertActiveScope(connection);
}

async function syncGoogle(connection: Connection, events: EventItem[], limits: Map<string,{itemId:string;title:string;provider:Provider;message:string}>, verifiedAppleItems: Set<string>) {
  assertActiveScope(connection);
  assertActiveScope(connection);
  const access = await googleAccess(connection); const calendarId = encodeURIComponent(connection.calendar_url ?? "primary");
  assertActiveScope(connection);
  const maps = new Map(database().prepare("SELECT item_id,external_id,connection_scope_id FROM calendar_copies WHERE user_id=? AND provider='google'").all(connection.user_id).map((row) => [String(row.item_id),{ id:String(row.external_id), scope:row.connection_scope_id }]));
  const roots = events.filter((item) => (!item.seriesId || item.id === item.seriesId) && item.scheduledDate);
  const liveIds = new Set(roots.map((item) => item.id));
  for (const [itemId, copy] of maps) if (!liveIds.has(itemId) && copy.scope === connection.connection_scope_id) {
    const item = events.find((entry) => entry.id === itemId);
    if (item && !item.scheduledDate && isUndatedImportedSourceCopy(connection,itemId,copy.id)) {
      reportSyncLimitation(limits,item,"google","This imported Event no longer has a schedule. Its original Google Calendar copy is preserved, while other Calendar copies are removed.");
      continue;
    }
    const eventId = copy.id;
    assertActiveScope(connection);
    let deleted: Response | undefined;
    try { deleted = await fetch(googleApiUrl(`calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`), { method: "DELETE", headers: { Authorization: `Bearer ${access}` } }); } catch { /* Report below and retry on the next sync. */ }
    assertActiveScope(connection);
    if (deleted && (deleted.ok || deleted.status === 404 || deleted.status === 410)) database().prepare(`DELETE FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=? AND connection_scope_id=?
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='google' AND connection_scope_id=? AND credential_generation_id=?)`)
      .run(connection.user_id,itemId,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
    if (deleted && (deleted.ok || deleted.status === 404 || deleted.status === 410)) clearUndatedCopyRemovalFailure(connection,itemId);
    else {
      const message = item && !item.scheduledDate
        ? "This undated Event's dated Google Calendar copy could not be removed. Its identity is retained for retry."
        : "The deleted Event could not be removed from Google Calendar. Its Calendar copy is retained for retry.";
      if (item && !item.scheduledDate) recordUndatedCopyRemovalFailure(connection,itemId,message);
      limits.set(`${itemId}:google`,{itemId,title:"Deleted Event",provider:"google",message});
    }
  }
  for (const item of roots) {
    if (!safeToSyncImportedEvent(connection.user_id,item,"google",limits)) continue;
    if (importedOccurrenceChanges(connection.user_id,item,events)) { reportSyncLimitation(limits,item,"google","This imported Event has edited Occurrences. Calendar sync is paused to preserve its original recurrence."); continue; }
    const metadata = metadataForDestination(connection.user_id,item.id,"google",connection.calendar_url ?? "primary");
    if (metadata?.provider === "google" && metadata.source_account_id !== (connection.calendar_url ?? "primary")) {
      reportSyncLimitation(limits,item,"google","The connected Google account changed after this Event was imported. Sync is paused to protect the original Calendar copy.");
      continue;
    }
    const bounds = googleBounds(item,metadata);
    if ("limitation" in bounds && bounds.limitation) { reportSyncLimitation(limits,item,"google",bounds.limitation); continue; }
    const copy = maps.get(item.id);
    if (copy && copy.scope !== connection.connection_scope_id) { reportSyncLimitation(limits,item,"google","This Calendar copy belongs to an earlier or unknown connection. Sync is paused."); continue; }
    const mapped = copy?.id;
    if (metadata?.provider === "google" && !mapped) { reportSyncLimitation(limits,item,"google","The original Google Event cannot be verified. Sync is paused to preserve it."); continue; }
    const url = googleApiUrl(`calendar/v3/calendars/${calendarId}/events${mapped ? `/${encodeURIComponent(mapped)}` : ""}`);
    const backlink = filetasksEventUrl(item.id);
    const extras = rawGoogleExtras(metadata,item.id);
    const recurrence = googleRecurrenceForItem(connection.user_id,item,metadata);
    if (extras.conferenceData) url.searchParams.set("conferenceDataVersion","1");
    if (extras.attachments) url.searchParams.set("supportsAttachments","true");
    const textBaseline = metadata?.provider === "google" ? JSON.parse(metadata.baseline_json) as {title?:string;details?:string} : null;
    const sourceText = metadata?.provider === "google" && metadata.source_payload_json ? JSON.parse(metadata.source_payload_json) as {summary?:string;description?:string} : null;
    const summary = sourceText && (typeof textBaseline?.title !== "string" || textBaseline.title === item.title) ? sourceText.summary : item.title;
    const details = sourceText && (typeof textBaseline?.details !== "string" || textBaseline.details === item.details) ? sourceText.description ?? "" : item.details;
    const backlinkText = backlink ? `Open in FileTasks: ${backlink}` : "";
    let intent = mapped ? null : reserveGoogleCreation(connection,item.id);
    const mappedReservation = mapped ? database().prepare(`SELECT ownership_token FROM google_creation_reservations
      WHERE user_id=? AND item_id=? AND provider='google' AND connection_scope_id=? AND event_id=?`)
      .get(connection.user_id,item.id,connection.connection_scope_id,mapped) as {ownership_token:string} | undefined : undefined;
    const ownershipToken = intent?.ownershipToken ?? mappedReservation?.ownership_token;
    if (ownershipToken) {
      const extended = extras.extendedProperties as { private: Record<string,unknown> };
      extended.private.filetasksOwnershipToken = ownershipToken;
    }
    const event = { ...extras,...(intent ? { id: intent.eventId } : {}),summary, description: `${details}${backlinkText && !details.includes(backlinkText) ? `\n\n${backlinkText}` : ""}`,
      ...bounds,...(recurrence ? { recurrence } : {}) };
    assertActiveScope(connection);
    let response: Response;
    try {
      response = await fetch(url, { method: mapped ? "PUT" : "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
    } catch (error) {
      if (!intent) throw error;
      response = new Response(null, { status: 409 });
    }
    assertActiveScope(connection);
    if (mapped && response.status === 404 && (!metadata || (metadata.provider === "google" && metadata.source_account_id === (connection.calendar_url ?? "primary") && metadata.state === "supported" && !item.recurrence && retainedGoogleSingle(metadata)) || (metadata.provider === "apple" && metadata.state === "supported" && !item.recurrence && verifiedAppleItems.has(item.id)))) {
      // Rotate only the reservation for the copy whose absence was just confirmed.
      database().prepare(`UPDATE google_creation_reservations SET event_id=?,ownership_token=?
        WHERE user_id=? AND item_id=? AND provider='google' AND connection_scope_id=? AND event_id=?
        AND EXISTS (SELECT 1 FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=? AND connection_scope_id=? AND external_id=?)
        AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='google' AND connection_scope_id=? AND credential_generation_id=?)`)
        .run(randomUUID().replaceAll("-", ""),randomBytes(32).toString("hex"),connection.user_id,item.id,connection.connection_scope_id,mapped,
          connection.user_id,item.id,connection.connection_scope_id,mapped,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
      intent = reserveGoogleCreation(connection,item.id);
      const extended = extras.extendedProperties as { private: Record<string,unknown> };
      extended.private.filetasksOwnershipToken = intent.ownershipToken;
      const recoveryUrl = googleApiUrl(`calendar/v3/calendars/${calendarId}/events`);
      recoveryUrl.search = url.search;
      assertActiveScope(connection);
      try {
        response = await fetch(recoveryUrl, { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...event,id:intent.eventId }) });
      } catch { response = new Response(null, { status: 409 }); }
    }
    let saved: { id: string } | undefined;
    if (response.ok) {
      try { saved = await response.json() as { id: string }; }
      catch { if (!intent) throw new HttpError(502, "An Event could not be synchronized to Google Calendar."); }
    }
    if (intent && (response.status === 409 || (response.ok && !saved))) {
      assertActiveScope(connection);
      const verificationUrl = googleApiUrl(`calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(intent.eventId)}`);
      let verified: { id?: string; status?: string; extendedProperties?: { private?: { filetasksItemId?: string; filetasksOwnershipToken?: string } } };
      try {
        const check = await fetch(verificationUrl, { headers: { Authorization: `Bearer ${access}` } });
        if (!check.ok) throw new Error("Verification failed");
        verified = await check.json() as typeof verified;
      } catch { throw new HttpError(502, "The Google Calendar copy could not be verified. Sync will retry."); }
      assertActiveScope(connection);
      if (verified.id !== intent.eventId || verified.status === "cancelled" || verified.extendedProperties?.private?.filetasksItemId !== item.id || verified.extendedProperties?.private?.filetasksOwnershipToken !== intent.ownershipToken) {
        throw new HttpError(502, "The Google Calendar copy could not be verified. Sync will retry.");
      }
      saved = { id: verified.id };
    }
    if (!saved || (!response.ok && response.status !== 409)) throw new HttpError(502, "An Event could not be synchronized to Google Calendar.");
    assertActiveScope(connection);
    if (intent && saved.id !== intent.eventId) throw new HttpError(502, "The Google Calendar copy could not be verified. Sync will retry.");
    const committed = database().prepare(`INSERT INTO calendar_copies(user_id,provider,item_id,external_id,connection_scope_id)
      SELECT ?,'google',?,?,? WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='google' AND connection_scope_id=? AND credential_generation_id=?)
      ON CONFLICT(user_id,provider,item_id) DO UPDATE SET external_id=excluded.external_id
      WHERE calendar_copies.connection_scope_id=excluded.connection_scope_id AND (? IS NULL OR calendar_copies.external_id=? OR calendar_copies.external_id=excluded.external_id)`)
      .run(connection.user_id,item.id,saved.id,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id,intent?.eventId ?? null,mapped ?? intent?.eventId ?? null);
    if (!committed.changes) throw new HttpError(409, "Calendar connection or copy changed. Please sync again.");
    maps.set(item.id,{id:saved.id,scope:connection.connection_scope_id});
    clearUndatedCopyRemovalFailure(connection,item.id);
  }
  const byId = new Map(roots.map((item) => [item.id,item]));
  for (const occurrence of events.filter((item) => item.seriesId && item.id !== item.seriesId && item.occurrenceDate)) {
    const root = byId.get(occurrence.seriesId!); const rootCopy = maps.get(occurrence.seriesId!); const rootEventId = rootCopy?.scope === connection.connection_scope_id ? rootCopy.id : undefined;
    if (!root || !rootEventId || !occurrence.scheduledDate || !occurrence.occurrenceDate || root.calendarSync.length) continue;
    const changed = occurrence.scheduledDate !== occurrence.occurrenceDate || occurrence.scheduledTime !== root.scheduledTime
      || occurrence.title !== root.title || occurrence.details !== root.details;
    if (!changed) continue;
    const instancesUrl = googleApiUrl(`calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(rootEventId)}/instances`);
    instancesUrl.searchParams.set("originalStart",googleOriginalStart(occurrence.occurrenceDate,root.scheduledTime));
    assertActiveScope(connection);
    const instancesResponse = await fetch(instancesUrl,{headers:{Authorization:`Bearer ${access}`} });
    assertActiveScope(connection);
    if (!instancesResponse.ok) throw new HttpError(502,"Could not synchronize a recurring Event Occurrence to Google Calendar.");
    assertActiveScope(connection);
    const instances = await instancesResponse.json() as { items?: {id:string;originalStartTime?:{date?:string;dateTime?:string}}[] };
    assertActiveScope(connection);
    const instance = instances.items?.find((entry) => (entry.originalStartTime?.dateTime ?? entry.originalStartTime?.date)?.slice(0,10) === occurrence.occurrenceDate);
    if (!instance) continue;
    const start = occurrence.scheduledTime ? {dateTime:`${occurrence.scheduledDate}T${occurrence.scheduledTime}:00`,timeZone:process.env.FILETASKS_TIME_ZONE||"UTC"} : {date:occurrence.scheduledDate};
    const end = occurrence.scheduledTime ? {dateTime:oneHourLater(occurrence.scheduledDate,occurrence.scheduledTime),timeZone:process.env.FILETASKS_TIME_ZONE||"UTC"} : {date:plusOneDay(occurrence.scheduledDate)};
    const occurrenceBacklink = filetasksEventUrl(root.id);
    assertActiveScope(connection);
    const response = await fetch(googleApiUrl(`calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(instance.id)}`),{method:"PATCH",headers:{Authorization:`Bearer ${access}`,"Content-Type":"application/json"},body:JSON.stringify({summary:occurrence.title,description:`${occurrence.details}${occurrenceBacklink ? `\n\nOpen in FileTasks: ${occurrenceBacklink}` : ""}`,start,end})});
    assertActiveScope(connection);
    if (!response.ok) throw new HttpError(502,"A recurring Event Occurrence could not be synchronized to Google Calendar.");
  }
}

async function syncApple(connection: Connection, events: EventItem[], missingHrefs: Set<string>, limits: Map<string,{itemId:string;title:string;provider:Provider;message:string}>, verifiedAppleItems: Set<string>) {
  assertActiveScope(connection);
  ensureAppleRepresentationBaselines();
  if (!connection.access_token || !connection.calendar_url) throw new HttpError(503, "Reconnect Apple Calendar to continue syncing.");
  const credentials = JSON.parse(decrypt(connection.access_token)) as { username: string; password: string };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const maps = new Map(database().prepare("SELECT item_id,external_id,resource_uid,connection_scope_id FROM calendar_copies WHERE user_id=? AND provider='apple'").all(connection.user_id).map((row) => [String(row.item_id),{ href:String(row.external_id),uid:String(row.resource_uid ?? row.external_id),scope:row.connection_scope_id }]));
  const roots = events.filter((item) => (!item.seriesId || item.id === item.seriesId) && item.scheduledDate);
  const liveIds = new Set(roots.map((item) => item.id));
  const resourceUrl = (value: string) => {
    const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(`${connection.calendar_url!.replace(/\/$/,"")}/${encodeURIComponent(value)}.ics`);
    const collection = new URL(connection.calendar_url!);
    if (url.origin !== collection.origin || !url.pathname.startsWith(collection.pathname.replace(/\/$/,"") + "/") || !isAppleCalDavHost(url.hostname)) throw new HttpError(502,"Apple Calendar returned an untrusted Event location.");
    return url.toString();
  };
  for (const [itemId, copy] of maps) if (!liveIds.has(itemId) && copy.scope === connection.connection_scope_id) {
    const item = events.find((entry) => entry.id === itemId);
    if (item && !item.scheduledDate && isUndatedImportedSourceCopy(connection,itemId,copy.uid)) {
      reportSyncLimitation(limits,item,"apple","This imported Event no longer has a schedule. Its original Apple Calendar copy is preserved, while other Calendar copies are removed.");
      continue;
    }
    assertActiveScope(connection);
    let deleted: Response | undefined;
    try { deleted = await fetch(resourceUrl(copy.href), { method: "DELETE", headers: { Authorization: authorization } }); } catch { /* Report below and retry on the next sync. */ }
    assertActiveScope(connection);
    if (deleted && (deleted.ok || deleted.status === 404 || deleted.status === 410)) database().prepare(`DELETE FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=? AND connection_scope_id=?
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
      .run(connection.user_id,itemId,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
    if (deleted && (deleted.ok || deleted.status === 404 || deleted.status === 410)) database().prepare(`DELETE FROM apple_copy_representation_baselines WHERE user_id=? AND item_id=? AND connection_scope_id=?
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
      .run(connection.user_id,itemId,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
    if (deleted && (deleted.ok || deleted.status === 404 || deleted.status === 410)) clearUndatedCopyRemovalFailure(connection,itemId);
    else {
      const message = item && !item.scheduledDate
        ? "This undated Event's dated Apple Calendar copy could not be removed. Its identity is retained for retry."
        : "The deleted Event could not be removed from Apple Calendar. Its Calendar copy is retained for retry.";
      if (item && !item.scheduledDate) recordUndatedCopyRemovalFailure(connection,itemId,message);
      limits.set(`${itemId}:apple`,{itemId,title:"Deleted Event",provider:"apple",message});
    }
  }
  for (const item of roots) {
    if (!safeToSyncImportedEvent(connection.user_id,item,"apple",limits)) continue;
    if (importedOccurrenceChanges(connection.user_id,item,events)) { reportSyncLimitation(limits,item,"apple","This imported Event has edited Occurrences. Calendar sync is paused to preserve its original recurrence."); continue; }
    const metadata = metadataForDestination(connection.user_id,item.id,"apple",connection.calendar_url);
    if (metadata?.provider === "apple" && metadata.source_account_id !== connection.calendar_url) {
      reportSyncLimitation(limits,item,"apple","The connected Apple account changed after this Event was imported. Sync is paused to protect the original Calendar copy.");
      continue;
    }
    if (metadata?.provider === "google" && item.recurrence && item.scheduledTime) {
      reportSyncLimitation(limits,item,"apple","This recurring Event uses a Google timezone rule. Apple export is paused because its daylight-saving behavior cannot be preserved safely yet.");
      continue;
    }
    const mapped = maps.get(item.id);
    if (mapped && mapped.scope !== connection.connection_scope_id) { reportSyncLimitation(limits,item,"apple","This Calendar copy belongs to an earlier or unknown connection. Sync is paused."); continue; }
    const uid = mapped?.uid ?? `${randomUUID()}@filetasks`;
    const targetUrl = mapped ? resourceUrl(mapped.href) : resourceUrl(uid);
    const exceptions = events.filter((occurrence) => occurrence.seriesId === item.id && occurrence.id !== item.id
      && occurrence.occurrenceDate && (occurrence.scheduledDate !== occurrence.occurrenceDate || occurrence.scheduledTime !== item.scheduledTime
        || occurrence.title !== item.title || occurrence.details !== item.details));
    let calendarData: string;
    if (metadata?.provider === "apple") {
      const source = patchImportedAppleIcs(metadata,item);
      if ("limitation" in source) { reportSyncLimitation(limits,item,"apple",source.limitation); continue; }
      calendarData = source.ics;
    } else if (metadata) {
      const timing = importedTimingForEdit(metadata,item);
      if ("limitation" in timing) { reportSyncLimitation(limits,item,"apple",timing.limitation); continue; }
      const extras = googleWritableExtras(metadata) as {location?:string};
      calendarData = icsFor(item,uid,exceptions,calendarExclusions(connection.user_id,item.id),timing,{
        ...(extras.location ? {location:extras.location} : {}),attendees:googleAttendeeLines(metadata),
      });
    } else {
      calendarData = icsFor(item,uid,exceptions,calendarExclusions(connection.user_id,item.id));
    }
    assertActiveScope(connection);
    const response = await fetch(targetUrl, { method: "PUT", headers: { Authorization: authorization, "Content-Type": "text/calendar; charset=utf-8", ...(!mapped || missingHrefs.has(mapped.href) ? {"If-None-Match":"*"} : {}) }, body: calendarData });
    assertActiveScope(connection);
    if (!response.ok) throw new HttpError(502, "An Event could not be synchronized to Apple Calendar.");
    if (metadata?.provider === "apple" && mapped && missingHrefs.has(mapped.href)) verifiedAppleItems.add(item.id);
    const committed = database().prepare(`INSERT INTO calendar_copies(user_id,provider,item_id,external_id,resource_uid,connection_scope_id)
      SELECT ?,'apple',?,?,?,? WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)
      ON CONFLICT(user_id,provider,item_id) DO UPDATE SET external_id=excluded.external_id,resource_uid=excluded.resource_uid
      WHERE calendar_copies.connection_scope_id=excluded.connection_scope_id AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider='apple' AND connection_scope_id=? AND credential_generation_id=?)`)
      .run(connection.user_id,item.id,targetUrl,uid,connection.connection_scope_id,connection.user_id,connection.connection_scope_id,connection.credential_generation_id,
        connection.user_id,connection.connection_scope_id,connection.credential_generation_id);
    if (!committed.changes) throw new HttpError(409, "Calendar connection changed. Please sync again.");
    clearUndatedCopyRemovalFailure(connection,item.id);
    const representation = appleRepresentationSignature(calendarData);
    if (representation && connection.connection_scope_id) saveAppleRepresentation(connection,item.id,connection.connection_scope_id,targetUrl,representation);
  }
}

async function performCalendarSync(userId: string, exportProviders?: ReadonlySet<Provider>) {
  const connections = database().prepare("SELECT * FROM calendar_connections WHERE user_id=?").all(userId) as Connection[];
  if (!connections.length) return { synced: [], message: "Connect a calendar first." };
  const synced: string[] = [];
  const limitations = new Map<string,{itemId:string;title:string;provider:Provider;message:string}>();
  let missingAppleHrefs = new Set<string>();
  const verifiedAppleItems = new Set<string>();
  for (const connection of connections) {
    if (!connection.connection_scope_id) {
      const scope = randomUUID();
      const result = database().prepare("UPDATE calendar_connections SET connection_scope_id=?,legacy_identity_eligible=1 WHERE user_id=? AND provider=? AND connection_scope_id IS NULL AND credential_generation_id=? AND access_token IS ? AND refresh_token IS ? AND calendar_url IS ?")
        .run(scope,connection.user_id,connection.provider,connection.credential_generation_id,connection.access_token,connection.refresh_token,connection.calendar_url);
      if (!result.changes) throw new HttpError(409, "Calendar connection changed. Please sync again.");
      connection.connection_scope_id = scope;
    }
    if (connection.provider === "google") await importGoogleEvents(connection);
    else missingAppleHrefs = await importAppleEvents(connection,verifiedAppleItems);
    assertActiveScope(connection);
  }
  const verificationEvents = listItems(userId).filter((item) => item.kind === "event");
  for (const connection of connections) {
    if (connection.provider === "google") await verifyLegacyGoogle(connection,verificationEvents);
    else await verifyLegacyApple(connection,verificationEvents);
    assertActiveScope(connection);
  }
  const eventCount = listItemsForCalendarSync(userId).filter((item) => item.kind === "event").length;
  for (const connection of [...connections].sort((a,b) => Number(a.provider === "google") - Number(b.provider === "google"))) {
    if (exportProviders && !exportProviders.has(connection.provider)) continue;
    assertActiveScope(connection);
    const events = listItemsForCalendarSync(userId).filter((item) => item.kind === "event");
    if (connection.provider === "google") await syncGoogle(connection,events,limitations,verifiedAppleItems);
    else await syncApple(connection,events,missingAppleHrefs,limitations,verifiedAppleItems);
    assertActiveScope(connection);
    if (![...limitations.values(), ...calendarSyncLimitations(userId)].some((entry) => entry.provider === connection.provider && entry.title === "Deleted Event")) synced.push(connection.provider);
  }
  const syncLimitations = new Map<string,{itemId:string;title:string;provider:Provider;message:string}>();
  for (const limitation of calendarSyncLimitations(userId)) syncLimitations.set(`${limitation.itemId}:${limitation.provider}`,limitation);
  for (const [key,limitation] of limitations) syncLimitations.set(key,limitation);
  return { synced, eventCount, syncLimitations:[...syncLimitations.values()] };
}

export async function syncCalendars(userId: string, providers?: readonly CalendarSyncProvider[]) {
  const selectedProviders = providers === undefined ? undefined : new Set<Provider>(providers);
  const generations = beginCalendarSync(userId,providers);
  try {
    const result = await performCalendarSync(userId,selectedProviders);
    const failedDeletionProviders = new Set((result.syncLimitations ?? [])
      .filter((limitation) => limitation.title === "Deleted Event")
      .map((limitation) => limitation.provider as CalendarSyncProvider));
    for (const generation of generations) {
      if (failedDeletionProviders.has(generation.provider)) failCalendarSync(userId,generation);
      else completeCalendarSync(userId,generation);
    }
    return { ...result, syncDelivery: calendarSyncDeliveryStatus(userId) };
  } catch (error) {
    for (const generation of generations) failCalendarSync(userId,generation);
    throw error;
  }
}

export async function syncCalendarsAfterMutation(userId: string) {
  try {
    await syncCalendars(userId);
  } catch {
    // Event data and its retry state were committed before provider sync started.
  }
}

export async function processDueCalendarSyncs() {
  const dueRows = dueCalendarSyncUsers();
  const dueByUser = new Map<string,Set<CalendarSyncProvider>>();
  for (const { userId,provider } of dueRows) {
    const providers = dueByUser.get(userId) ?? new Set<CalendarSyncProvider>();
    providers.add(provider);
    dueByUser.set(userId,providers);
  }
  let completed = 0;
  let failed = 0;
  for (const [userId,providers] of dueByUser) {
    try {
      await syncCalendars(userId,[...providers]);
      if (calendarSyncDeliveryStatus(userId).some((status) => providers.has(status.provider))) failed++;
      else completed++;
    } catch {
      failed++;
    }
  }
  return { attempted: dueByUser.size, completed, failed };
}
