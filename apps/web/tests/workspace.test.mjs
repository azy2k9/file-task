import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

let server;
let directory;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const base = "http://localhost:3107";
let logs = "";

async function startServer() {
  server = spawn(process.execPath, [nextBin, "dev", "--port", "3107"], {
    cwd: projectRoot,
    env: { ...process.env, FILETASKS_DATABASE_PATH: join(directory, "workspace.sqlite"), FILETASKS_ORIGIN: base },
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

async function stopServer() {
  if (server?.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "filetasks-test-"));
  await startServer();
});

after(async () => {
  await stopServer();
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
  const response = await request("/api/notifications", { token: owner.token });
  assert.equal(response.status, 200);
  const notification = (await response.json()).notifications.find(({ itemId }) => itemId === item.id);
  assert.ok(notification);
  assert.equal((await request(`/api/notifications/${notification.id}`, { token: owner.token, method: "PATCH" })).status, 200);
  assert.equal((await (await request("/api/notifications", { token: owner.token })).json()).notifications.some(({ id }) => id === notification.id), false);
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
  await request(`/api/items/${occurrenceId}`, { token: owner.token, method: "PATCH", body: { completed: true } });
  const changedOccurrence = await request(`/api/items/${occurrenceId}`, { token: owner.token, method: "PATCH", body: { title: "Water the seedlings", scope: "occurrence" } });
  assert.equal((await changedOccurrence.json()).item.title, "Water the seedlings");
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
  assert.equal(occurrences.find(({ id }) => id === occurrenceId)?.completed, true);
  assert.equal(occurrences.filter(({ title }) => title === "Water the seedlings").length, 1);
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
