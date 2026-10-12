import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { database } from "./database";
import { HttpError } from "./http";
import { listItems } from "./workspace";
import type { RecurrenceRule } from "./items";
import { saveItem } from "./workspace";

type Provider = "google" | "apple";
type Connection = { user_id: string; provider: Provider; account_label: string; access_token: string | null; refresh_token: string | null; calendar_url: string | null; expires_at: number | null };
type EventItem = ReturnType<typeof listItems>[number];

function encryptionKey() {
  const raw = process.env.FILETASKS_CALENDAR_ENCRYPTION_KEY;
  if (!raw) throw new HttpError(503, "Calendar connections need FILETASKS_CALENDAR_ENCRYPTION_KEY configured on the server.");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new HttpError(503, "FILETASKS_CALENDAR_ENCRYPTION_KEY must be a 32-byte base64 or hex key.");
  return key;
}

function isAppleCalDavHost(hostname: string) {
  return hostname === "icloud.com" || hostname.endsWith(".icloud.com") || hostname === "apple.com" || hostname.endsWith(".apple.com");
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

export function createGoogleAuthorization(userId: string) {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !redirectUri) throw new HttpError(503, "Configure Google Calendar OAuth on the server before connecting an account.");
  encryptionKey();
  const state = randomBytes(32).toString("base64url");
  database().prepare("DELETE FROM calendar_oauth_states WHERE expires_at <= ?").run(Date.now());
  database().prepare("INSERT INTO calendar_oauth_states(state,user_id,expires_at) VALUES(?,?,?)").run(state,userId,Date.now()+10*60_000);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId); url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code"); url.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly");
  url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); url.searchParams.set("state", state);
  return url.toString();
}

export async function finishGoogleAuthorization(state: string, code: string) {
  const db = database();
  const stateRow = db.prepare("SELECT user_id FROM calendar_oauth_states WHERE state=? AND expires_at>? ").get(state,Date.now());
  db.prepare("DELETE FROM calendar_oauth_states WHERE state=?").run(state);
  if (!stateRow) throw new HttpError(400, "Google Calendar connection expired. Start connecting again.");
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID!; const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI!;
  if (!clientSecret) throw new HttpError(503, "Configure Google Calendar OAuth on the server before connecting an account.");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
  if (!tokenResponse.ok) throw new HttpError(502, "Google Calendar could not complete the connection.");
  const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tokens.access_token) throw new HttpError(502, "Google did not return an access token.");
  const calendarResponse = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!calendarResponse.ok) throw new HttpError(502, "Could not read the primary Google Calendar.");
  const calendar = await calendarResponse.json() as { id?: string; summary?: string };
  const previous = db.prepare("SELECT refresh_token FROM calendar_connections WHERE user_id=? AND provider='google'").get(stateRow.user_id);
  const refreshCipher = tokens.refresh_token ? encrypt(tokens.refresh_token) : (previous?.refresh_token as string | undefined);
  if (!refreshCipher || !calendar.id) throw new HttpError(502, "Google did not provide a reusable calendar connection.");
  db.prepare(`INSERT INTO calendar_connections(user_id,provider,account_label,access_token,refresh_token,calendar_url,connected_at,expires_at)
    VALUES(?,'google',?,?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET account_label=excluded.account_label,
    access_token=excluded.access_token,refresh_token=excluded.refresh_token,calendar_url=excluded.calendar_url,
    connected_at=excluded.connected_at,expires_at=excluded.expires_at`).run(String(stateRow.user_id),calendar.summary ?? "Google Calendar",encrypt(tokens.access_token),refreshCipher,calendar.id,new Date().toISOString(),Date.now()+Math.max(60,tokens.expires_in ?? 3600)*1000-60_000);
}

export async function connectAppleCalendar(userId: string, body: Record<string, unknown>) {
  if (typeof body.username !== "string" || !body.username.trim() || typeof body.password !== "string" || !body.password
    || (body.calendarUrl !== undefined && typeof body.calendarUrl !== "string")) throw new HttpError(400, "Enter your Apple ID and app-specific password.");
  const authorization = `Basic ${Buffer.from(`${body.username.trim()}:${body.password}`).toString("base64")}`;
  let calendarUrl = typeof body.calendarUrl === "string" ? body.calendarUrl.trim() : "";
  let discoveredLabel: string | null = null;
  if (!calendarUrl) {
    const propfind = (properties: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${properties}</d:prop></d:propfind>`;
    const discovery = await fetch("https://caldav.icloud.com/",{method:"PROPFIND",headers:{Authorization:authorization,Depth:"0","Content-Type":"application/xml; charset=utf-8"},body:propfind("<d:current-user-principal/>")});
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
  if (url.protocol !== "https:" || !isAppleCalDavHost(url.hostname)) throw new HttpError(400,"Use an HTTPS Apple iCloud CalDAV calendar URL.");
  const label = typeof body.accountLabel === "string" && body.accountLabel.trim() ? body.accountLabel.trim().slice(0,120) : discoveredLabel || body.username.trim();
  const validation = await fetch(url, { method: "PROPFIND", headers: { Authorization: authorization, Depth: "0", "Content-Type": "application/xml; charset=utf-8" }, body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>` });
  if (validation.status === 401 || validation.status === 403) throw new HttpError(400, "Apple Calendar rejected the Apple ID or app-specific password.");
  if (!validation.ok && validation.status !== 207) throw new HttpError(400, "Could not verify the Apple CalDAV calendar URL.");
  const now = new Date().toISOString();
  database().prepare(`INSERT INTO calendar_connections(user_id,provider,account_label,access_token,refresh_token,calendar_url,connected_at)
    VALUES(?,'apple',?,?,NULL,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET account_label=excluded.account_label,
    access_token=excluded.access_token,calendar_url=excluded.calendar_url,connected_at=excluded.connected_at`).run(userId,label,encrypt(JSON.stringify({ username: body.username.trim(), password: body.password })),url.toString(),now);
  return { provider: "apple", accountLabel: label, connectedAt: now };
}

export function disconnectCalendar(userId: string, provider: Provider) {
  if (provider !== "google" && provider !== "apple") throw new HttpError(400, "Choose Google Calendar or Apple Calendar.");
  database().prepare("DELETE FROM calendar_connections WHERE user_id=? AND provider=?").run(userId,provider);
}

export function excludeDeletedCalendarImports(userId: string, itemId: string) {
  const db=database();
  for (const row of db.prepare("SELECT provider,external_id FROM calendar_imports WHERE user_id=? AND item_id=?").all(userId,itemId)) {
    db.prepare("INSERT OR IGNORE INTO calendar_import_exclusions(user_id,provider,external_id) VALUES(?,?,?)").run(userId,row.provider,row.external_id);
  }
}

function escapeIcs(value: string) { return value.replace(/\\/g,"\\\\").replace(/\r?\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;"); }
function compactDate(value: string) { return value.replaceAll("-", ""); }
function plusOneDay(value: string) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+1); return date.toISOString().slice(0,10); }
function oneHourLater(date: string, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + 60;
  const endDate = total >= 1440 ? plusOneDay(date) : date;
  const endTime = `${String(Math.floor(total % 1440 / 60)).padStart(2,"0")}:${String(total % 60).padStart(2,"0")}`;
  return `${endDate}T${endTime}:00`;
}
function icsFor(item: EventItem, uid: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/," ").trim();
  const fields = [`BEGIN:VCALENDAR`,`VERSION:2.0`,`PRODID:-//FileTasks//Calendar//EN`,`BEGIN:VEVENT`,`UID:${uid}`,`DTSTAMP:${stamp}`];
  if (item.scheduledDate) {
    if (item.scheduledTime) fields.push(`DTSTART:${compactDate(item.scheduledDate)}T${item.scheduledTime.replace(":","")}00`);
    else fields.push(`DTSTART;VALUE=DATE:${compactDate(item.scheduledDate)}`);
  }
  fields.push(`SUMMARY:${escapeIcs(item.title)}`);
  if (item.details) fields.push(`DESCRIPTION:${escapeIcs(item.details)}`);
  const base = process.env.FILETASKS_PUBLIC_URL || process.env.FILETASKS_ORIGIN;
  if (base) fields.push(`URL:${base.replace(/\/$/,"")}/?event=${encodeURIComponent(item.id)}`);
  if (item.recurrence) fields.push(`RRULE:${rruleFor(item.recurrence)}`);
  fields.push("END:VEVENT","END:VCALENDAR");
  return `${fields.join("\r\n")}\r\n`;
}

function rruleFor(rule: NonNullable<EventItem["recurrence"]>) {
  const freq = { days: "DAILY", weeks: "WEEKLY", months: "MONTHLY", years: "YEARLY" }[rule.unit];
  const parts = [`FREQ=${freq}`,`INTERVAL=${rule.interval}`];
  if (rule.weekdays?.length) parts.push(`BYDAY=${rule.weekdays.map((day) => ["SU","MO","TU","WE","TH","FR","SA"][day]).join(",")}`);
  if (rule.end.type === "count") parts.push(`COUNT=${rule.end.count}`);
  if (rule.end.type === "date") parts.push(`UNTIL=${compactDate(rule.end.date)}T235959Z`);
  return parts.join(";");
}

async function googleAccess(connection: Connection) {
  if (connection.expires_at && connection.expires_at > Date.now() && connection.access_token) return decrypt(connection.access_token);
  if (!connection.refresh_token) throw new HttpError(503, "Reconnect Google Calendar to continue syncing.");
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "", refresh_token: decrypt(connection.refresh_token), grant_type: "refresh_token" }) });
  if (!response.ok) throw new HttpError(502, "Google Calendar authorization expired. Reconnect the calendar.");
  const tokens = await response.json() as { access_token: string; expires_in: number };
  database().prepare("UPDATE calendar_connections SET access_token=?,expires_at=? WHERE user_id=? AND provider='google'").run(encrypt(tokens.access_token),Date.now()+(tokens.expires_in-60)*1000,connection.user_id);
  return tokens.access_token;
}

function alreadyImported(userId: string, provider: Provider, externalId: string) {
  return database().prepare("SELECT item_id FROM calendar_imports WHERE user_id=? AND provider=? AND external_id=?").get(userId,provider,externalId);
}

function recordImport(userId: string, provider: Provider, externalId: string, itemId: string) {
  database().prepare("INSERT OR IGNORE INTO calendar_imports(user_id,provider,external_id,item_id) VALUES(?,?,?,?)").run(userId,provider,externalId,itemId);
  database().prepare(`INSERT INTO calendar_copies(user_id,provider,item_id,external_id) VALUES(?,?,?,?)
    ON CONFLICT(user_id,provider,item_id) DO UPDATE SET external_id=excluded.external_id`).run(userId,provider,itemId,externalId);
}

function recurrenceFromRRule(input: string | null, startDate: string): RecurrenceRule | null {
  if (!input) return null;
  const ruleText = input.replace(/^RRULE:/i,""); const values = Object.fromEntries(ruleText.split(";").map((part) => { const index=part.indexOf("="); return index<0?[part,""]:[part.slice(0,index).toUpperCase(),part.slice(index+1)]; }));
  const units: Record<string,RecurrenceRule["unit"]> = { DAILY:"days",WEEKLY:"weeks",MONTHLY:"months",YEARLY:"years" };
  const unit = units[values.FREQ]; if (!unit) return null;
  const interval = Number(values.INTERVAL ?? 1); if (!Number.isInteger(interval) || interval < 1 || interval > 100) return null;
  let end: RecurrenceRule["end"] = { type:"never" };
  if (values.COUNT && Number.isInteger(Number(values.COUNT))) end = { type:"count",count:Number(values.COUNT) };
  else if (values.UNTIL) { const match=values.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/); if (match) end = { type:"date",date:`${match[1]}-${match[2]}-${match[3]}` }; }
  const dayNumbers: Record<string,number> = { SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6 };
  const weekdays = unit === "weeks" && values.BYDAY ? values.BYDAY.split(",").map((day: string) => dayNumbers[day.slice(-2)]).filter((day: number | undefined): day is number => day !== undefined) : undefined;
  if (end.type === "date" && end.date < startDate) return null;
  return { interval,unit,...(weekdays?.length ? {weekdays} : {}),end };
}

function importEvent(userId: string, externalId: string, title: string, details: string, date: string, time: string | null, recurrence: RecurrenceRule | null = null) {
  const item = saveItem(userId,{ kind: "event", title: title.slice(0,200) || "Untitled Event", details: details.slice(0,10_000), scheduledDate: date, scheduledTime: time,
    ...(recurrence ? { recurrence } : {}) });
  return item.id;
}

async function importGoogleEvents(connection: Connection) {
  const access = await googleAccess(connection); const calendarId = encodeURIComponent(connection.calendar_url ?? "primary");
  const existing = new Set(database().prepare("SELECT external_id FROM calendar_imports WHERE user_id=? AND provider='google' UNION SELECT external_id FROM calendar_import_exclusions WHERE user_id=? AND provider='google'").all(connection.user_id,connection.user_id).map((row) => String(row.external_id)));
  const now = new Date(); const timeMin = new Date(now.getTime()-90*86_400_000).toISOString(); const timeMax = new Date(now.getTime()+370*86_400_000).toISOString();
  let pageToken: string | undefined; let imported = 0;
  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
    url.searchParams.set("singleEvents","false"); url.searchParams.set("maxResults","2500"); url.searchParams.set("timeMin",timeMin); url.searchParams.set("timeMax",timeMax);
    if (pageToken) url.searchParams.set("pageToken",pageToken);
    const response = await fetch(url,{ headers: { Authorization: `Bearer ${access}` } });
    if (!response.ok) throw new HttpError(502,"Could not read Events from Google Calendar.");
    const result = await response.json() as { nextPageToken?: string; items?: { id?: string; status?: string; summary?: string; description?: string; location?: string; start?: { date?: string; dateTime?: string }; recurrence?: string[]; extendedProperties?: { private?: { filetasksItemId?: string } } }[] };
    for (const event of result.items ?? []) {
      if (!event.id || event.status === "cancelled" || existing.has(event.id) || event.extendedProperties?.private?.filetasksItemId) continue;
      const start = event.start?.dateTime ?? event.start?.date;
      if (!start) continue;
      const date = start.slice(0,10); const time = event.start?.dateTime ? start.slice(11,16) : null;
      const details = [event.description,event.location ? `Location: ${event.location}` : ""].filter(Boolean).join("\n\n");
      const recurrence = recurrenceFromRRule(event.recurrence?.find((line) => line.startsWith("RRULE:")) ?? null,date);
      const itemId = importEvent(connection.user_id,event.id,event.summary ?? "Untitled Event",details,date,time,recurrence);
      recordImport(connection.user_id,"google",event.id,itemId); existing.add(event.id); imported++;
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
  return imported;
}

function xmlDecode(value: string) { return value.replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'").replaceAll("&amp;","&"); }
function icsProperty(ics: string, name: string) {
  const line = ics.replace(/\r?\n[ \t]/g,"").split(/\r?\n/).find((part) => part.toUpperCase().startsWith(`${name.toUpperCase()};`) || part.toUpperCase().startsWith(`${name.toUpperCase()}:`));
  if (!line) return null;
  const separator = line.indexOf(":"); return separator < 0 ? null : line.slice(separator+1).replace(/\\n/gi,"\n").replace(/\\,/g,",").replace(/\\;/g,";").replace(/\\\\/g,"\\");
}

async function importAppleEvents(connection: Connection) {
  if (!connection.access_token || !connection.calendar_url) throw new HttpError(503,"Reconnect Apple Calendar to continue syncing.");
  const credentials = JSON.parse(decrypt(connection.access_token)) as { username: string; password: string };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const from = new Date(Date.now()-90*86_400_000).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/, "Z");
  const to = new Date(Date.now()+370*86_400_000).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/, "Z");
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${from}" end="${to}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const response = await fetch(connection.calendar_url,{ method:"REPORT", headers:{ Authorization:authorization, Depth:"1", "Content-Type":"application/xml; charset=utf-8" }, body });
  if (!response.ok && response.status !== 207) throw new HttpError(502,"Could not read Events from Apple Calendar.");
  const xml = await response.text(); const existing = new Set(database().prepare("SELECT external_id FROM calendar_imports WHERE user_id=? AND provider='apple' UNION SELECT external_id FROM calendar_import_exclusions WHERE user_id=? AND provider='apple'").all(connection.user_id,connection.user_id).map((row) => String(row.external_id)));
  let imported = 0;
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?calendar-data>/gi)) {
    const ics = xmlDecode(match[1]); const uid = icsProperty(ics,"UID");
    if (!uid || existing.has(uid)) continue;
    const startLine = ics.replace(/\r?\n[ \t]/g,"").split(/\r?\n/).find((line) => /^DTSTART(?:;[^:]*)?:/i.test(line));
    if (!startLine) continue;
    const startValue = startLine.slice(startLine.indexOf(":")+1); const dateMatch = startValue.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!dateMatch) continue;
    const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`; const timeMatch = startValue.match(/^\d{8}T(\d{2})(\d{2})/);
    const summary = icsProperty(ics,"SUMMARY") ?? "Untitled Event"; const description = icsProperty(ics,"DESCRIPTION") ?? "";
    const recurrence = recurrenceFromRRule(icsProperty(ics,"RRULE"),date);
    const itemId = importEvent(connection.user_id,uid,summary,description,date,timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null,recurrence);
    recordImport(connection.user_id,"apple",uid,itemId); existing.add(uid); imported++;
  }
  return imported;
}

async function syncGoogle(connection: Connection, events: EventItem[]) {
  const access = await googleAccess(connection); const calendarId = encodeURIComponent(connection.calendar_url ?? "primary");
  const maps = new Map(database().prepare("SELECT item_id,external_id FROM calendar_copies WHERE user_id=? AND provider='google'").all(connection.user_id).map((row) => [String(row.item_id),String(row.external_id)]));
  const liveIds = new Set(events.map((item) => item.id));
  for (const [itemId, eventId] of maps) if (!liveIds.has(itemId)) {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${access}` } });
    database().prepare("DELETE FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=?").run(connection.user_id,itemId);
  }
  for (const item of events) {
    const mapped = maps.get(item.id); const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events${mapped ? `/${encodeURIComponent(mapped)}` : ""}`;
    const event = { summary: item.title, description: `${item.details}${process.env.FILETASKS_PUBLIC_URL || process.env.FILETASKS_ORIGIN ? `\n\nOpen in FileTasks: ${(process.env.FILETASKS_PUBLIC_URL || process.env.FILETASKS_ORIGIN)!.replace(/\/$/,"")}/?event=${encodeURIComponent(item.id)}` : ""}`,
      ...(item.scheduledDate ? item.scheduledTime ? { start: { dateTime: `${item.scheduledDate}T${item.scheduledTime}:00`, timeZone: process.env.FILETASKS_TIME_ZONE || "UTC" }, end: { dateTime: oneHourLater(item.scheduledDate,item.scheduledTime), timeZone: process.env.FILETASKS_TIME_ZONE || "UTC" } } : { start: { date: item.scheduledDate }, end: { date: plusOneDay(item.scheduledDate) } } : {}),
      ...(item.recurrence ? { recurrence: [`RRULE:${rruleFor(item.recurrence)}`] } : {}), extendedProperties: { private: { filetasksItemId: item.id } } };
    let response = await fetch(url, { method: mapped ? "PUT" : "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
    if (mapped && response.status === 404) response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
    if (!response.ok) throw new HttpError(502, "An Event could not be synchronized to Google Calendar.");
    const saved = await response.json() as { id: string };
    database().prepare(`INSERT INTO calendar_copies(user_id,provider,item_id,external_id) VALUES(?,'google',?,?)
      ON CONFLICT(user_id,provider,item_id) DO UPDATE SET external_id=excluded.external_id`).run(connection.user_id,item.id,saved.id);
  }
}

async function syncApple(connection: Connection, events: EventItem[]) {
  if (!connection.access_token || !connection.calendar_url) throw new HttpError(503, "Reconnect Apple Calendar to continue syncing.");
  const credentials = JSON.parse(decrypt(connection.access_token)) as { username: string; password: string };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const maps = new Map(database().prepare("SELECT item_id,external_id FROM calendar_copies WHERE user_id=? AND provider='apple'").all(connection.user_id).map((row) => [String(row.item_id),String(row.external_id)]));
  const liveIds = new Set(events.map((item) => item.id));
  for (const [itemId, uid] of maps) if (!liveIds.has(itemId)) {
    await fetch(`${connection.calendar_url!.replace(/\/$/,"")}/${encodeURIComponent(uid)}.ics`, { method: "DELETE", headers: { Authorization: authorization } });
    database().prepare("DELETE FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=?").run(connection.user_id,itemId);
  }
  for (const item of events) {
    const uid = maps.get(item.id) ?? `${randomUUID()}@filetasks`;
    const response = await fetch(`${connection.calendar_url.replace(/\/$/,"")}/${encodeURIComponent(uid)}.ics`, { method: "PUT", headers: { Authorization: authorization, "Content-Type": "text/calendar; charset=utf-8" }, body: icsFor(item,uid) });
    if (!response.ok) throw new HttpError(502, "An Event could not be synchronized to Apple Calendar.");
    database().prepare(`INSERT INTO calendar_copies(user_id,provider,item_id,external_id) VALUES(?,'apple',?,?)
      ON CONFLICT(user_id,provider,item_id) DO UPDATE SET external_id=excluded.external_id`).run(connection.user_id,item.id,uid);
  }
}

export async function syncCalendars(userId: string) {
  const connections = database().prepare("SELECT * FROM calendar_connections WHERE user_id=?").all(userId) as Connection[];
  if (!connections.length) return { synced: [], message: "Connect a calendar first." };
  const synced: string[] = [];
  let eventCount = 0;
  for (const connection of connections) {
    if (connection.provider === "google") await importGoogleEvents(connection);
    else await importAppleEvents(connection);
    const events = listItems(userId).filter((item) => item.kind === "event" && (!item.seriesId || item.id === item.seriesId));
    eventCount = events.length;
    if (connection.provider === "google") await syncGoogle(connection,events);
    else await syncApple(connection,events);
    synced.push(connection.provider);
  }
  return { synced, eventCount };
}
