import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

let server;
let deliveryServer;
let directory;
let deliveryBase;
let deliveryRequests = [];
let deliveredKeys = new Set();
let failNextEmail = 0;
let providerRequests = [];
let storageObjects = new Map();
let googleEvents = new Map();
let appleEvents = new Map();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const base = "http://localhost:3107";
let logs = "";

async function startServer() {
  server = spawn(process.execPath, [nextBin, "dev", "--port", "3107"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FILETASKS_DATABASE_PATH: join(directory, "workspace.sqlite"),
      FILETASKS_ORIGIN: base,
      FILETASKS_TIME_ZONE: "UTC",
      FILETASKS_EMAIL_DELIVERY_URL: `${deliveryBase}/email`,
      FILETASKS_PUSH_DELIVERY_URL: `${deliveryBase}/push`,
      FILETASKS_REMINDER_WORKER_SECRET: "test-worker-secret",
      FILETASKS_REMINDER_RETRY_BASE_MS: "1000",
      FILETASKS_CALENDAR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      FILETASKS_PUBLIC_URL: base,
      GOOGLE_CALENDAR_CLIENT_ID: "fake-client",
      GOOGLE_CALENDAR_CLIENT_SECRET: "fake-secret",
      GOOGLE_CALENDAR_REDIRECT_URI: `${base}/api/calendars/google/callback`,
      FILETASKS_GOOGLE_API_ORIGIN: `${deliveryBase}/google`,
      FILETASKS_GOOGLE_TOKEN_URL: `${deliveryBase}/google-token`,
      FILETASKS_GOOGLE_AUTH_URL: `${deliveryBase}/google-auth`,
      FILETASKS_APPLE_CALDAV_ORIGIN: `${deliveryBase}/apple`,
      FILETASKS_R2_ACCOUNT_ID: "fake-account",
      FILETASKS_R2_ACCESS_KEY_ID: "fake-access-key",
      FILETASKS_R2_SECRET_ACCESS_KEY: "fake-secret-key",
      FILETASKS_R2_BUCKET: "filetasks-test",
      FILETASKS_R2_ENDPOINT: `${deliveryBase}/r2`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => { logs += data; });
  server.stderr.on("data", (data) => { logs += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/auth/session`)).status === 401) return; } catch {}
    if (server.exitCode !== null) throw new Error(logs);
    await delay(200);
  }
  throw new Error(`Server did not start: ${logs}`);
}

async function startDeliveryFake() {
  deliveryRequests = [];
  deliveredKeys = new Set();
  failNextEmail = 0;
  providerRequests = [];
  storageObjects = new Map();
  googleEvents = new Map();
  appleEvents = new Map();
  deliveryServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/r2/")) {
      const key = url.pathname;
      const bytes = Buffer.concat(chunks);
      if (request.method === "PUT") {
        storageObjects.set(key, { bytes, contentType: request.headers["content-type"] || "application/octet-stream" });
        response.writeHead(200, { ETag: '"fake-etag"' }).end();
      } else if (request.method === "HEAD") {
        const object = storageObjects.get(key);
        if (!object) response.writeHead(404).end();
        else response.writeHead(200, { "Content-Length": object.bytes.length, "Content-Type": object.contentType }).end();
      } else if (request.method === "GET") {
        const object = storageObjects.get(key);
        if (!object) response.writeHead(404).end();
        else response.writeHead(200, { "Content-Length": object.bytes.length, "Content-Type": object.contentType }).end(object.bytes);
      } else if (request.method === "DELETE") {
        storageObjects.delete(key);
        response.writeHead(204).end();
      } else response.writeHead(405).end();
      return;
    }
    const isJson = request.headers["content-type"]?.includes("application/json");
    const body = isJson && bodyText ? JSON.parse(bodyText) : {};
    providerRequests.push({ path: url.pathname, method: request.method, body, text: bodyText });
    const idempotencyKey = request.headers["idempotency-key"];
    deliveryRequests.push({ path: request.url, body, idempotencyKey });
    if (url.pathname === "/email" && body.operation === "deliver" && failNextEmail > 0) {
      failNextEmail--;
      response.writeHead(503).end();
      return;
    }
    if (url.pathname === "/google-token") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 }));
      return;
    }
    if (url.pathname === "/google/calendar/v3/calendars/primary") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "primary", summary: "Fake Google Calendar" }));
      return;
    }
    if (url.pathname.startsWith("/google/calendar/v3/calendars/primary/events")) {
      const parts = url.pathname.split("/");
      const eventId = parts[parts.length - 1] === "events" || parts.at(-1) === "instances" ? null : parts.at(-1);
      if (request.method === "GET" && url.pathname.endsWith("/events")) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items: [...googleEvents.values()] }));
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/instances")) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items: [] }));
        return;
      }
      if (request.method === "DELETE") {
        googleEvents.delete(eventId);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "PUT" || request.method === "PATCH") {
        if (!googleEvents.has(eventId)) { response.writeHead(404).end(); return; }
        googleEvents.set(eventId, { ...googleEvents.get(eventId), ...body, id: eventId });
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: eventId }));
        return;
      }
      if (request.method === "POST") {
        const id = `google-${crypto.randomUUID()}`;
        googleEvents.set(id, { ...body, id });
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id }));
        return;
      }
    }
    if (url.pathname.startsWith("/apple/")) {
      if (request.method === "PROPFIND") {
        response.writeHead(207, { "Content-Type": "application/xml" }).end("<d:multistatus xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:response><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>");
        return;
      }
      if (request.method === "REPORT") {
        response.writeHead(207, { "Content-Type": "application/xml" }).end("<d:multistatus xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"></d:multistatus>");
        return;
      }
      if (request.method === "PUT") {
        appleEvents.set(url.pathname, bodyText);
        response.writeHead(201).end();
        return;
      }
      if (request.method === "DELETE") {
        appleEvents.delete(url.pathname);
        response.writeHead(204).end();
        return;
      }
    }
    if (body.operation === "register") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ registrationId: `fake-${crypto.randomUUID()}` }));
      return;
    }
    if (body.operation === "deliver") deliveredKeys.add(`${url.pathname}:${idempotencyKey}`);
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise((resolve, reject) => {
    deliveryServer.once("error", reject);
    deliveryServer.listen(0, "127.0.0.1", resolve);
  });
  deliveryBase = `http://127.0.0.1:${deliveryServer.address().port}`;
}

async function stopDeliveryFake() {
  if (deliveryServer?.listening) await new Promise((resolve, reject) => deliveryServer.close((error) => error ? reject(error) : resolve()));
}

async function stopServer() {
  if (server?.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "filetasks-test-"));
  await startDeliveryFake();
  await startServer();
});

after(async () => {
  await stopServer();
  await stopDeliveryFake();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function request(path, { token, cookie, method = "GET", body, headers = {} } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function runReminderWorker() {
  return fetch(`${base}/api/internal/reminders/deliver`, {
    method: "POST",
    headers: { Authorization: "Bearer test-worker-secret" },
  });
}

async function account(email = `person-${crypto.randomUUID()}@example.com`) {
  const response = await request("/api/auth/register", { method: "POST", body: { email, password: "correct-horse-battery" } });
  assert.equal(response.status, 201);
  return { ...(await response.json()), cookie: response.headers.get("set-cookie").split(";")[0] };
}

test("a person can create a Task on one client and view it on another after signing in", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Renew car insurance", details: "Compare the renewal quote",
    scheduledDate: "2026-11-03", scheduledTime: "16:00",
  } });
  assert.equal(created.status, 201);
  const { item } = await created.json();
  assert.equal(item.completed, false);
  const login = await request("/api/auth/login", { method: "POST", body: { email: owner.user.email, password: "correct-horse-battery" } });
  assert.equal(login.status, 200);
  const secondClient = await login.json();
  const listed = await request("/api/items", { token: secondClient.token });
  assert.deepEqual((await listed.json()).items, [item]);
});

test("a person can edit, complete, reopen and delete a Task using their web session", async () => {
  const owner = await account();
  const options = { cookie: owner.cookie, headers: { Origin: base } };
  const created = await request("/api/items", { ...options, method: "POST", body: { kind: "task", title: "Pay the bill" } });
  const { item } = await created.json();
  const edited = await request(`/api/items/${item.id}`, { ...options, method: "PATCH", body: {
    title: "Pay electricity bill", details: "Use the latest statement", scheduledDate: "2026-12-01", completed: true,
  } });
  assert.equal(edited.status, 200);
  const saved = (await edited.json()).item;
  assert.equal(saved.title, "Pay electricity bill");
  assert.equal(saved.details, "Use the latest statement");
  assert.equal(saved.scheduledDate, "2026-12-01");
  assert.equal(saved.scheduledTime, null);
  assert.equal(saved.completed, true);
  const reopened = await request(`/api/items/${item.id}`, { token: owner.token, method: "PATCH", body: { completed: false } });
  assert.equal((await reopened.json()).item.completed, false);
  assert.equal((await request(`/api/items/${item.id}`, { ...options, method: "DELETE" })).status, 204);
  assert.deepEqual((await (await request("/api/items", { token: owner.token })).json()).items, []);
});

test("Events can be remembered, rescheduled, made undated and deleted without a completion state", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Mum's birthday", details: "Call in the morning", scheduledDate: "2026-11-12",
  } });
  assert.equal(created.status, 201);
  const { item } = await created.json();
  assert.equal(item.completed, null);
  const changed = await request(`/api/items/${item.id}`, { token: owner.token, method: "PATCH", body: {
    title: "Birthday dinner", scheduledTime: "19:30", details: "Book the table",
  } });
  assert.equal((await changed.json()).item.scheduledTime, "19:30");
  assert.equal((await request(`/api/items/${item.id}`, { token: owner.token, method: "PATCH", body: { completed: true } })).status, 400);
  const cleared = await request(`/api/items/${item.id}`, { token: owner.token, method: "PATCH", body: { scheduledDate: null, scheduledTime: null } });
  const undated = (await cleared.json()).item;
  assert.equal(undated.scheduledDate, null);
  assert.equal(undated.scheduledTime, null);
  assert.equal(undated.details, "Book the table");
  assert.equal((await request(`/api/items/${item.id}`, { token: owner.token })).status, 200);
  assert.equal((await request(`/api/items/${item.id}`, { token: owner.token, method: "DELETE" })).status, 204);
});

test("invalid item changes preserve the person's saved Task", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "task", title: "Keep this Task", scheduledDate: "2026-02-28" } });
  const { item } = await created.json();
  for (const body of [
    { kind: null }, { title: "   " }, { details: null }, { scheduledDate: "2026-02-30" },
    { scheduledTime: "25:00" }, { scheduledDate: null, scheduledTime: "09:00" },
    { kind: "event" }, { completed: "yes" }, { userId: "another-person" },
  ]) {
    const response = await request(`/api/items/${item.id}`, { token: owner.token, method: "PATCH", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, "string");
  }
  const saved = await request(`/api/items/${item.id}`, { token: owner.token });
  assert.deepEqual((await saved.json()).item, item);
});

test("Files can be linked, attached to multiple items, removed separately and deleted account-wide", async () => {
  const owner = await account();
  const task = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "task", title: "Submit the form" } });
  const event = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "event", title: "Appointment" } });
  const taskItem = (await task.json()).item;
  const eventItem = (await event.json()).item;
  const created = await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "Application form", url: "https://example.com/application.pdf",
  } });
  assert.equal(created.status, 201);
  const file = (await created.json()).file;
  assert.equal(file.sourceType, "link");
  assert.equal(file.externalUrl, "https://example.com/application.pdf");

  for (const item of [taskItem, eventItem]) {
    const response = await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: item.id } });
    assert.equal(response.status, 201);
  }
  const listedFiles = (await (await request("/api/files", { token: owner.token })).json()).files;
  assert.deepEqual(listedFiles[0].attachments.map(({ itemId }) => itemId).sort(), [taskItem.id, eventItem.id].sort());
  const listedItems = (await (await request("/api/items", { token: owner.token })).json()).items;
  assert.deepEqual(listedItems.find(({ id }) => id === taskItem.id).files, [{ id: file.id, name: file.name, sourceType: "link" }]);
  assert.deepEqual(listedItems.find(({ id }) => id === eventItem.id).files, [{ id: file.id, name: file.name, sourceType: "link" }]);
  assert.equal((await request(`/api/files/${file.id}/open`, { token: owner.token })).status, 200);

  const other = await account();
  assert.deepEqual((await (await request("/api/files", { token: other.token })).json()).files, []);
  assert.equal((await request(`/api/files/${file.id}/open`, { token: other.token })).status, 404);
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: other.token, method: "POST", body: { itemId: taskItem.id } })).status, 404);

  assert.equal((await request(`/api/files/${file.id}/attachments/${taskItem.id}`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.deepEqual((await (await request(`/api/items/${taskItem.id}`, { token: owner.token })).json()).item.files, []);
  assert.equal((await request(`/api/items/${eventItem.id}`, { token: owner.token })).status, 200);
  assert.equal((await request(`/api/items/${eventItem.id}`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.deepEqual((await (await request("/api/files", { token: owner.token })).json()).files[0].attachments, []);
  assert.equal((await request(`/api/files/${file.id}`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.deepEqual((await (await request("/api/files", { token: owner.token })).json()).files, []);
  assert.equal((await request("/api/files", { token: owner.token, method: "POST", body: { name: "bad", url: "javascript:alert(1)" } })).status, 400);
  assert.equal((await request("/api/files/uploads", { token: owner.token, method: "POST", body: {
    name: "Too large", contentType: "application/pdf", sizeBytes: 50_000_001,
  } })).status, 400);
});

test("accounts are private and signing out revokes only the current client", async () => {
  const owner = await account();
  const other = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "task", title: "Private Task" } });
  const { item } = await created.json();
  assert.equal((await request("/api/items")).status, 401);
  assert.deepEqual((await (await request("/api/items", { token: other.token })).json()).items, []);
  for (const method of ["GET", "PATCH", "DELETE"]) {
    assert.equal((await request(`/api/items/${item.id}`, { token: other.token, method, ...(method === "PATCH" ? { body: { title: "Changed" } } : {}) })).status, 404);
  }
  assert.equal((await request("/api/auth/login", { method: "POST", body: { email: owner.user.email, password: "wrong-password-long" } })).status, 401);
  const login = await request("/api/auth/login", { method: "POST", body: { email: owner.user.email.toUpperCase(), password: "correct-horse-battery" } });
  const secondClient = await login.json();
  assert.equal((await request("/api/auth/logout", { token: owner.token, method: "POST" })).status, 204);
  assert.equal((await request("/api/items", { token: owner.token })).status, 401);
  assert.equal((await request("/api/items", { token: secondClient.token })).status, 200);
});

test("web session mutations reject other origins and unverifiable origins", async () => {
  const owner = await account();
  for (const headers of [{ Origin: "https://other.example.com" }, {}]) {
    const response = await request("/api/items", { cookie: owner.cookie, headers, method: "POST", body: { kind: "task", title: "Unwanted Task" } });
    assert.equal(response.status, 403);
  }
  assert.deepEqual((await (await request("/api/items", { cookie: owner.cookie })).json()).items, []);
  assert.equal((await request("/api/auth/logout", { cookie: owner.cookie, headers: { Origin: base }, method: "POST" })).status, 204);
  assert.equal((await request("/api/auth/session", { cookie: owner.cookie })).status, 401);
});

test("Reminder defaults are separate, prefill new items, and update only items still using the old default", async () => {
  const owner = await account();
  const notification = [{ delivery: "notification", amount: 2, unit: "days", time: "09:30" }];
  const email = [{ delivery: "email", amount: 1, unit: "weeks", time: "16:00" }];
  const configured = await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: {
    taskReminders: notification, eventReminders: email, emailEnabled: true, pushEnabled: false, applyToExisting: false,
  } });
  assert.equal(configured.status, 200);
  const taskResponse = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "task", title: "Pay bill" } });
  const eventResponse = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "event", title: "Birthday", scheduledDate: "2026-11-12" } });
  const task = (await taskResponse.json()).item;
  const event = (await eventResponse.json()).item;
  assert.deepEqual(task.reminders, notification);
  assert.deepEqual(event.reminders, email);
  const customized = [{ delivery: "notification", amount: 30, unit: "minutes", time: "08:00" }];
  await request(`/api/items/${task.id}`, { token: owner.token, method: "PATCH", body: { reminders: customized } });
  const nextTaskDefault = [{ delivery: "notification", amount: 3, unit: "days", time: "10:15" }];
  const nextEventDefault = [{ delivery: "notification", amount: 1, unit: "months", time: "09:00" }];
  const changed = await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: {
    taskReminders: nextTaskDefault, eventReminders: nextEventDefault, emailEnabled: false, applyToExisting: true,
  } });
  assert.equal(changed.status, 200);
  assert.deepEqual((await (await request(`/api/items/${task.id}`, { token: owner.token })).json()).item.reminders, customized);
  assert.deepEqual((await (await request(`/api/items/${event.id}`, { token: owner.token })).json()).item.reminders, nextEventDefault);
  assert.equal((await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: { taskReminders: email } })).status, 400);
});

test("due Notification Reminders appear in the in-app notification list and can be marked read", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Reminder due", scheduledDate: "2026-10-12",
    reminders: [{ delivery: "notification", amount: 0, unit: "days", time: "00:00" }],
  } });
  const item = (await created.json()).item;
  assert.equal((await runReminderWorker()).status, 200);
  const response = await request("/api/notifications", { token: owner.token });
  assert.equal(response.status, 200);
  const notification = (await response.json()).notifications.find(({ itemId }) => itemId === item.id);
  assert.ok(notification);
  assert.equal((await request(`/api/notifications/${notification.id}`, { token: owner.token, method: "PATCH" })).status, 200);
  assert.equal((await (await request("/api/notifications", { token: owner.token })).json()).notifications.some(({ id }) => id === notification.id), false);
});

test("the reminder worker honors configured clock times for date offsets and skips undated items", async () => {
  const owner = await account();
  assert.equal((await fetch(`${base}/api/internal/reminders/deliver`, { method: "POST" })).status, 401);
  const timed = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Timed Event", scheduledDate: "2020-01-02", scheduledTime: "08:30",
    reminders: [
      { delivery: "notification", amount: 0, unit: "days", time: "16:45" },
      { delivery: "notification", amount: 0, unit: "minutes", time: "09:00" },
    ],
  } })).json()).item;
  const allDay = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "All-day Event", scheduledDate: "2020-01-03",
    reminders: [{ delivery: "notification", amount: 0, unit: "weeks", time: "11:20" }],
  } })).json()).item;
  const undated = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Undated Task", reminders: [{ delivery: "notification", amount: 0, unit: "days", time: "08:00" }],
  } })).json()).item;
  assert.equal((await runReminderWorker()).status, 200);
  const notifications = (await (await request("/api/notifications", { token: owner.token })).json()).notifications;
  assert.deepEqual(notifications.filter(({ itemId }) => itemId === timed.id).map(({ scheduledAt }) => scheduledAt).sort(), [
    "2020-01-02T08:30:00.000Z", "2020-01-02T16:45:00.000Z",
  ]);
  assert.deepEqual(notifications.find(({ itemId }) => itemId === allDay.id)?.scheduledAt, "2020-01-03T11:20:00.000Z");
  assert.equal(notifications.some(({ itemId }) => itemId === undated.id), false);
});

test("Email and push deliveries retry with a stable idempotency key and can be revoked", async () => {
  const owner = await account();
  const settings = await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: {
    emailEnabled: true, pushEnabled: true,
  } });
  assert.equal(settings.status, 200);
  const savedSettings = (await settings.json()).settings;
  assert.equal(savedSettings.emailAvailable, true);
  assert.equal(savedSettings.pushAvailable, true);

  const deviceResponse = await request("/api/devices/push", { token: owner.token, method: "POST", body: {
    platform: "ios", token: "fake-device-token",
  } });
  assert.equal(deviceResponse.status, 201);
  const { device } = await deviceResponse.json();
  const item = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Delivery retry", scheduledDate: "2020-02-03",
    reminders: [{ delivery: "email", amount: 0, unit: "days", time: "10:00" }],
  } })).json()).item;

  const startIndex = deliveryRequests.length;
  failNextEmail = 1;
  const firstRun = await runReminderWorker();
  assert.deepEqual(await firstRun.json(), { attempted: 2, sent: 1, failed: 1 });
  await delay(1_100);
  const retry = await runReminderWorker();
  assert.deepEqual(await retry.json(), { attempted: 1, sent: 1, failed: 0 });
  assert.deepEqual(await (await runReminderWorker()).json(), { attempted: 0, sent: 0, failed: 0 });

  const sentRequests = deliveryRequests.slice(startIndex).filter(({ body }) => body.operation === "deliver");
  const emailRequests = sentRequests.filter(({ path }) => path === "/email");
  const pushRequests = sentRequests.filter(({ path }) => path === "/push");
  assert.equal(emailRequests.length, 2);
  assert.equal(emailRequests[0].idempotencyKey, emailRequests[1].idempotencyKey);
  assert.equal(new Set(emailRequests.map(({ idempotencyKey }) => idempotencyKey)).size, 1);
  assert.equal(pushRequests.length, 1);
  assert.equal(deliveredKeys.size, 2);

  assert.equal((await request(`/api/devices/push/${device.id}`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal(deliveryRequests.some(({ body }) => body.operation === "revoke" && body.registrationId), true);
  assert.equal((await request(`/api/devices/push/${device.id}`, { token: owner.token, method: "DELETE" })).status, 404);
  assert.equal(item.kind, "event");
});

test("long-lead Reminders extend rolling Occurrence materialization beyond the former horizon", async () => {
  const owner = await account();
  const today = new Date().toISOString().slice(0, 10);
  const root = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Long lead task", scheduledDate: today,
    recurrence: { interval: 1, unit: "months", end: { type: "never" } },
    reminders: [{ delivery: "notification", amount: 500, unit: "days", time: "12:00" }],
  } })).json()).item;
  const items = (await (await request("/api/items", { token: owner.token })).json()).items;
  const longLeadOccurrences = items.filter(({ seriesId, scheduledDate }) => seriesId === root.id && scheduledDate > today);
  assert.equal(longLeadOccurrences.some(({ scheduledDate }) => Date.parse(`${scheduledDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) > 370 * 86_400_000), true);
  assert.equal((await runReminderWorker()).status, 200);
  const notifications = (await (await request("/api/notifications", { token: owner.token })).json()).notifications;
  assert.equal(longLeadOccurrences.some(({ id }) => notifications.some(({ itemId }) => itemId === id)), true);
});

test("recurring item deletion requires a scope and preserves the requested range", async () => {
  const owner = await account();
  const root = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Scoped deletion", scheduledDate: "2026-11-02",
    recurrence: { interval: 1, unit: "weeks", weekdays: [1], end: { type: "count", count: 4 } },
  } })).json()).item;
  let occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === root.id).sort((left, right) => left.scheduledDate.localeCompare(right.scheduledDate));
  assert.equal((await request(`/api/items/${occurrences[1].id}`, { token: owner.token, method: "DELETE" })).status, 400);

  assert.equal((await request(`/api/items/${root.id}?scope=occurrence`, { token: owner.token, method: "DELETE" })).status, 204);
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
  assert.equal(occurrences.some(({ scheduledDate }) => scheduledDate === "2026-11-02"), false);
  assert.equal(occurrences.length, 3);

  const selected = occurrences.find(({ scheduledDate }) => scheduledDate === "2026-11-16");
  assert.ok(selected);
  assert.equal((await request(`/api/items/${selected.id}?scope=following`, { token: owner.token, method: "DELETE" })).status, 204);
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
  assert.deepEqual(occurrences.map(({ scheduledDate }) => scheduledDate).sort(), ["2026-11-09"]);
  assert.equal((await request(`/api/items/${occurrences[0].id}?scope=series`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal((await (await request("/api/items", { token: owner.token })).json()).items.some(({ seriesId }) => seriesId === root.id), false);
});

test("uploaded Files transfer through the fake object store and open from another client", async () => {
  const owner = await account();
  const bytes = Buffer.from("FileTasks shared file bytes");
  const targetResponse = await request("/api/files/uploads", { token: owner.token, method: "POST", body: {
    name: "Shared document.pdf", contentType: "application/pdf", sizeBytes: bytes.length,
  } });
  assert.equal(targetResponse.status, 201);
  const target = await targetResponse.json();
  const uploaded = await fetch(target.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes });
  assert.equal(uploaded.status, 200);
  const completed = await request(`/api/files/${target.uploadId}/complete`, { token: owner.token, method: "POST" });
  assert.equal(completed.status, 200);
  const file = (await completed.json()).file;
  assert.equal(file.name, "Shared document.pdf");
  assert.equal(storageObjects.size, 1);

  const secondClient = await (await request("/api/auth/login", { method: "POST", body: {
    email: owner.user.email, password: "correct-horse-battery",
  } })).json();
  const opened = await request(`/api/files/${file.id}/open`, { token: secondClient.token });
  assert.equal(opened.status, 200);
  const openTarget = await opened.json();
  const downloaded = await fetch(openTarget.url);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await request(`/api/files/${file.id}`, { token: secondClient.token, method: "DELETE" })).status, 204);
  assert.equal(storageObjects.size, 0);
});

test("Google and Apple Calendar copies sync through fake provider boundaries", async () => {
  const owner = await account();
  const calendarRequestsStart = providerRequests.length;
  const authorization = await fetch(`${base}/api/calendars/google/connect`, {
    headers: { Authorization: `Bearer ${owner.token}` }, redirect: "manual",
  });
  assert.equal(authorization.status, 303);
  const authUrl = new URL(authorization.headers.get("location"));
  const state = authUrl.searchParams.get("state");
  assert.ok(state);
  assert.equal((await fetch(`${base}/api/calendars/google/callback?state=${encodeURIComponent(state)}&code=fake-code`, { redirect: "manual" })).status, 303);

  const apple = await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } });
  assert.equal(apple.status, 201);

  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Cross-provider review", details: "Bring the notes", scheduledDate: "2027-01-14", scheduledTime: "14:30",
  } });
  assert.equal(created.status, 201);
  const event = (await created.json()).item;
  assert.equal(googleEvents.size, 1);
  assert.equal(appleEvents.size, 1);
  const firstGoogleCopy = [...googleEvents.values()][0];
  assert.equal(firstGoogleCopy.extendedProperties.private.filetasksItemId, event.id);
  assert.equal(firstGoogleCopy.description.includes(`?event=${event.id}`), true);

  const edited = await request(`/api/items/${event.id}`, { token: owner.token, method: "PATCH", body: {
    title: "Updated cross-provider review", scope: "series",
  } });
  assert.equal(edited.status, 200);
  assert.equal([...googleEvents.values()][0].summary, "Updated cross-provider review");
  assert.equal([...appleEvents.values()][0].includes("SUMMARY:Updated cross-provider review"), true);

  const googleId = [...googleEvents.keys()][0];
  googleEvents.set(googleId, { ...googleEvents.get(googleId), summary: "External edit" });
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(googleEvents.get(googleId).summary, "Updated cross-provider review");
  googleEvents.clear();
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(googleEvents.size, 1);
  appleEvents.clear();
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(appleEvents.size, 1);

  assert.equal((await request(`/api/items/${event.id}`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal(googleEvents.size, 0);
  assert.equal(appleEvents.size, 0);
  const calendarRequests = providerRequests.slice(calendarRequestsStart);
  assert.equal(calendarRequests.some(({ method, path }) => method === "PUT" && path.startsWith("/google/calendar/")), true);
  assert.equal(calendarRequests.some(({ method }) => method === "REPORT"), true);
  assert.equal(calendarRequests.some(({ method }) => method === "DELETE"), true);
});

test("recurring items create independent Occurrences and honor occurrence and series edit scopes", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Water plants", scheduledDate: "2026-11-02", scheduledTime: "08:00",
    recurrence: { interval: 1, unit: "weeks", weekdays: [1, 3], end: { type: "count", count: 4 } },
    reminders: [{ delivery: "notification", amount: 1, unit: "days", time: "09:00" }],
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  assert.equal(root.recurrence.unit, "weeks");
  let occurrences = (await (await request("/api/items", { token: owner.token })).json()).items;
  occurrences = occurrences.filter(({ seriesId }) => seriesId === root.id).sort((left, right) => left.scheduledDate.localeCompare(right.scheduledDate));
  assert.deepEqual(occurrences.map(({ scheduledDate }) => scheduledDate), ["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11"]);
  const occurrenceId = occurrences[1].id;
  const missingScope = await request(`/api/items/${occurrenceId}`, { token: owner.token, method: "PATCH", body: { title: "Should not silently edit" } });
  assert.equal(missingScope.status, 400);
  await request(`/api/items/${occurrenceId}`, { token: owner.token, method: "PATCH", body: { completed: true } });
  const changedOccurrence = await request(`/api/items/${occurrenceId}`, { token: owner.token, method: "PATCH", body: { title: "Water the seedlings", scope: "occurrence" } });
  assert.equal((await changedOccurrence.json()).item.title, "Water the seedlings");
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
  assert.equal(occurrences.find(({ id }) => id === occurrenceId)?.completed, true);
  assert.equal(occurrences.filter(({ title }) => title === "Water the seedlings").length, 1);
  const moved = await request(`/api/items/${occurrenceId}`, { token: owner.token, method: "PATCH", body: { scheduledDate: "2026-11-07", scope: "occurrence" } });
  assert.equal(moved.status, 200);
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
  assert.equal(occurrences.length, 4);
  assert.equal(occurrences.filter(({ scheduledDate }) => scheduledDate === "2026-11-07").length, 1);
  assert.equal(occurrences.some(({ scheduledDate }) => scheduledDate === "2026-11-04"), false);
  const reminderEdit = await request(`/api/items/${occurrenceId}`, { token: owner.token, method: "PATCH", body: {
    reminders: [{ delivery: "notification", amount: 2, unit: "days", time: "10:00" }], scope: "series",
  } });
  assert.equal(reminderEdit.status, 200);
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id)
    .sort((left, right) => left.scheduledDate.localeCompare(right.scheduledDate));
  assert.deepEqual(occurrences.map(({ scheduledDate }) => scheduledDate), ["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11"]);
  assert.equal(occurrences.every(({ reminders }) => reminders[0]?.amount === 2), true);
  const seriesEdit = await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: { title: "Water all the plants", scope: "series" } });
  assert.equal(seriesEdit.status, 200);
  const afterSeriesEdit = (await (await request("/api/items", { token: owner.token })).json()).items;
  assert.equal(afterSeriesEdit.filter(({ seriesId, title }) => seriesId === root.id && title === "Water all the plants").length, 4);
  assert.equal(afterSeriesEdit.find(({ id }) => id === occurrenceId)?.completed, true);
});

test("a series Attachment is available from every Occurrence and can be removed from the whole series", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Monthly review", scheduledDate: "2026-11-01",
    recurrence: { interval: 1, unit: "months", end: { type: "count", count: 3 } },
  } });
  const series = (await created.json()).item;
  const fileResponse = await request("/api/files", { token: owner.token, method: "POST", body: { name: "Review notes", url: "https://example.com/review" } });
  const file = (await fileResponse.json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: series.id, scope: "series" } })).status, 201);
  const occurrences = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === series.id);
  assert.equal(occurrences.length, 3);
  for (const occurrence of occurrences) assert.deepEqual(occurrence.files.map(({ id }) => id), [file.id]);
  assert.equal((await request(`/api/files/${file.id}/attachments/${occurrences[1].id}?scope=occurrence`, { token: owner.token, method: "DELETE" })).status, 204);
  const afterOccurrenceRemoval = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === series.id);
  assert.deepEqual(afterOccurrenceRemoval.map(({ files }) => files.length), [1, 0, 1]);
  assert.deepEqual((await (await request("/api/files", { token: owner.token })).json()).files[0].attachments.map(({ scope }) => scope), ["series"]);
  assert.equal((await request(`/api/files/${file.id}/attachments/${series.id}?scope=series`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.deepEqual((await (await request(`/api/items/${occurrences[1].id}`, { token: owner.token })).json()).item.files, []);
});

test("a following Attachment and edit apply from the selected Occurrence onward", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Weekly filing", scheduledDate: "2026-11-02",
    recurrence: { interval: 1, unit: "weeks", weekdays: [1], end: { type: "count", count: 4 } },
  } });
  const series = (await created.json()).item;
  const occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  const selected = occurrences[1];
  const file = (await (await request("/api/files", { token: owner.token, method: "POST", body: { name: "New process", url: "https://example.com/process" } })).json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: selected.id, scope: "following" } })).status, 201);
  assert.equal((await request(`/api/items/${selected.id}`, { token: owner.token, method: "PATCH", body: { title: "Quarterly filing", scope: "following" } })).status, 200);
  const after = (await (await request("/api/items", { token: owner.token })).json()).items;
  const renamed = after.filter(({ title }) => title === "Quarterly filing");
  assert.equal(renamed.length, 3);
  assert.equal(after.find(({ id }) => id === occurrences[0].id)?.title, "Weekly filing");
  assert.equal(renamed.every(({ files }) => files.some(({ id }) => id === file.id)), true);
  assert.equal(after.find(({ id }) => id === occurrences[0].id)?.files.some(({ id }) => id === file.id), false);
});

test("Calendar sync is account-scoped and is a safe no-op before a provider is connected", async () => {
  const owner = await account();
  assert.deepEqual((await (await request("/api/calendars", { token: owner.token })).json()).calendars, []);
  const response = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { synced: [], message: "Connect a calendar first." });
  assert.equal((await request("/api/calendars", { method: "POST", body: { username: "a@example.com", password: "secret" } })).status, 401);
});

test("a person can manage Tasks and Events through the browser and see another client's changes", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") browserErrors.push(entry.text()); });
  page.on("requestfailed", (entry) => browserErrors.push(`${entry.url()}: ${entry.failure()?.errorText}`));
  try {
    await page.goto(base);
    await page.getByRole("group", { name: "Account action" }).getByRole("button", { name: "Create account", exact: true }).click();
    const email = `browser-${crypto.randomUUID()}@example.com`;
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.locator("form").getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByRole("button", { name: "New Task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Renew car insurance");
    await page.getByLabel(/^Details\b/).fill("Compare the renewal quote");
    await page.getByLabel(/^Date\b/).fill("2026-11-03");
    await page.getByLabel(/^Time\b/).fill("16:00");
    await page.getByRole("button", { name: "Save Task", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Renew car insurance", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Complete Task: Renew car insurance", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reopen Task: Renew car insurance", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit Renew car insurance", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Compare car insurance");
    await page.getByRole("button", { name: "Save Task", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Compare car insurance", exact: true })).toBeVisible();
    const login = await request("/api/auth/login", { method: "POST", body: { email, password: "correct-horse-battery" } });
    const native = await login.json();
    const saved = (await (await request("/api/items", { token: native.token })).json()).items[0];
    assert.equal(saved.title, "Compare car insurance");
    assert.equal(saved.completed, true);
    await request("/api/items", { token: native.token, method: "POST", body: { kind: "event", title: "Birthday dinner", scheduledDate: "2026-11-12" } });
    await page.getByRole("button", { name: /Refresh/ }).click();
    await expect(page.getByRole("heading", { name: "Birthday dinner", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Events", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Compare car insurance", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Complete Task: Birthday dinner", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Birthday dinner", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Compare car insurance", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Agenda", exact: true }).click();
    await page.getByRole("button", { name: "Edit Birthday dinner", exact: true }).click();
    await page.getByLabel(/^Details\b/).fill("Book a table");
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByText("Book a table", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Add a link", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Application form");
    await page.getByLabel("Web link", { exact: true }).fill("https://example.com/application.pdf");
    await page.getByRole("button", { name: "Add link", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Application form", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await page.getByLabel("Choose a Task or Event", { exact: true }).selectOption({ label: "Task: Compare car insurance" });
    await page.getByRole("button", { name: "Add Attachment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Task: Compare car insurance", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await page.getByLabel("Choose a Task or Event", { exact: true }).selectOption({ label: "Event: Birthday dinner" });
    await page.getByRole("button", { name: "Add Attachment", exact: true }).click();
    await expect(page.getByText("Event: Birthday dinner", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove Attachment from Compare car insurance", exact: true }).click();
    await expect(page.getByText("Deleting this File removes it from 2 Tasks or Events.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Event: Birthday dinner", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(page.getByRole("button", { name: "Events", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Remove Attachment from Compare car insurance", exact: true }).click();
    await page.getByRole("button", { name: "Remove Attachment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Task: Compare car insurance", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Event: Birthday dinner", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Agenda", exact: true }).click();
    await page.getByRole("button", { name: "New Event", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Remember this moment");
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Remember this moment", exact: true })).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: "Edit Remember this moment", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Keep this draft");
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keep this draft");
    await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    await context.setOffline(false);
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Keep this draft", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delete Keep this draft", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Keep this draft", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("form").getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  } catch (error) {
    await page.screenshot({ path: join(tmpdir(), "filetasks-browser-failure.png"), fullPage: true }).catch(() => {});
    if (browserErrors.length) console.error("Browser errors:", browserErrors);
    console.error("Recent server output:", logs.slice(-4000));
    throw error;
  } finally { await browser.close(); }
});

test("a person's account and saved items remain available after the server restarts", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Annual family gathering", details: "Bring the photo album", scheduledDate: "2027-01-02",
  } });
  assert.equal(created.status, 201);
  const { item } = await created.json();
  await stopServer();
  await startServer();
  const response = await request("/api/items", { token: owner.token });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, [item]);
  const login = await request("/api/auth/login", { method: "POST", body: { email: owner.user.email, password: "correct-horse-battery" } });
  assert.equal(login.status, 200);
});
