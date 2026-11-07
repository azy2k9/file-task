import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { stopTrackedProcessGroups, terminateProcessGroup, waitForProcessGroupExit } from "../../../scripts/test-ios-ui.mjs";
import { setEmulatorRunning } from "../../../scripts/emulator-control.mjs";

let server;
let sharedUIOwner;
let deliveryServer;
let deliveryStopPromise;
let uiAcceptanceBrowser;
let uiAcceptanceBrowserClosePromise;
let uiAcceptanceContext;
let uiAcceptanceContextClosePromise;
let directory;
let deliveryBase;
let deliveryRequests = [];
let deliveredKeys = new Set();
let failNextEmail = 0;
let failNextPushRevoke = 0;
let holdNextPushRevoke = null;
let pushRegistrationIds = new Map();
let activePushRegistrations = new Set();
let failNextGoogleRequest = null;
let failGoogleRequests = [];
let holdNextGoogleFailure = null;
let failNextAppleRequest = null;
let loseNextGooglePostResponse = false;
let googleInventoryBarrier = null;
let appleInventoryBarrier = null;
let providerRequests = [];
let storageRequests = [];
let storageObjects = new Map();
let googleEventPages = null;
let googleEvents = new Map();
let googleCalendarId = "primary";
let googleEventVersions = new Map();
let googleInstances = new Map();
let googleInstanceVersions = new Map();
let googleExceptions = new Map();
let googleInstanceRequests = [];
let appleEvents = new Map();
let appleEventVersions = new Map();
let holdNextCalendarUpdate = null;
let holdNextAppleBody = null;
let holdNextAppleDelete = null;
let holdNextCalendarCreation = null;
let omittedAppleReports = new Set();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const testPort = Number(process.env.FILETASKS_TEST_PORT ?? 3107);
const base = `http://localhost:${testPort}`;
let logs = "";
let clockFile;
let testClock = new Date("2026-10-13T12:00:00.000Z");
let serverTimeZone = "UTC";
const serverReadinessTimeoutMs = 120_000;
const serverReadinessProbeTimeoutMs = 10_000;
const serverShutdownTimeoutMs = process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1" ? 10_000 : 2_000;
const setupShutdownTimeoutMs = 10_000;
const commandShutdownTimeoutMs = 2_000;
const browserShutdownTimeoutMs = 5_000;
const activeCommands = new Set();
const runnerProcessGroupStatePath = process.env.FILETASKS_IOS_UI_PROCESS_GROUPS_PATH;
const runnerOwnedProcessGroups = new Set();
let interruptedSignal;
let harnessCleanupPromise;
const setupGate = createSetupGate();

function appleProperty(component, name) {
  return component.flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator < 0) return [];
    const [property, ...parameterParts] = line.slice(0, separator).split(";");
    if (property.toUpperCase() !== name.toUpperCase()) return [];
    const parameters = Object.fromEntries(parameterParts.map((parameter) => {
      const equals = parameter.indexOf("=");
      return equals < 0 ? [parameter.toUpperCase(), ""] : [parameter.slice(0, equals).toUpperCase(), parameter.slice(equals + 1)];
    }));
    return [{ value: line.slice(separator + 1), parameters }];
  });
}

function validCompactDate(value) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validCompactDateTime(value, requireZulu = false) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match || (requireZulu && match[7] !== "Z")) return false;
  const [, year, month, day, hour, minute, second] = match.map((part) => Number(part || 0));
  return validCompactDate(`${String(year).padStart(4, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`)
    && hour < 24 && minute < 60 && second < 60;
}

function validIcsDateValue(value, parameters = {}) {
  return parameters.VALUE?.toUpperCase() === "DATE" ? validCompactDate(value) : validCompactDateTime(value);
}

function validAppleCalendar(ics) {
  if (!ics.endsWith("\r\n") || /(^|[^\r])\n|\r(?!\n)/.test(ics)) return false;
  const rawLines = ics.slice(0, -2).split("\r\n");
  const lines = [];
  for (const line of rawLines) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  if (lines[0] !== "BEGIN:VCALENDAR" || lines.at(-1) !== "END:VCALENDAR") return false;

  let currentEvent = null;
  let nested = 0;
  let events = [];
  const calendarProperties = [];
  for (const line of lines.slice(1, -1)) {
    if (line === "BEGIN:VEVENT") {
      if (currentEvent) return false;
      currentEvent = [];
    } else if (line === "END:VEVENT") {
      if (!currentEvent || nested) return false;
      events.push(currentEvent);
      currentEvent = null;
    } else if (currentEvent && /^BEGIN:/i.test(line)) nested++;
    else if (currentEvent && /^END:/i.test(line) && nested > 0) nested--;
    else if (/^(?:BEGIN|END):/i.test(line)) return false;
    else if (currentEvent && nested === 0) currentEvent.push(line);
    else calendarProperties.push(line);
  }
  if (currentEvent || !events.length) return false;
  if (appleProperty(calendarProperties, "VERSION").length !== 1 || appleProperty(calendarProperties, "VERSION")[0].value !== "2.0") return false;
  if (appleProperty(calendarProperties, "PRODID").length !== 1 || !appleProperty(calendarProperties, "PRODID")[0].value) return false;

  const rootStarts = appleProperty(events[0], "DTSTART");
  if (rootStarts.length !== 1 || !validIcsDateValue(rootStarts[0].value, rootStarts[0].parameters)) return false;
  const rootStart = rootStarts[0];
  const rootIsDate = rootStart.parameters.VALUE?.toUpperCase() === "DATE";
  const rootIsZulu = !rootIsDate && rootStart.value.endsWith("Z");
  const uid = appleProperty(events[0], "UID")[0]?.value;
  if (!uid || /[\r\n]/.test(uid)) return false;
  for (const [index, event] of events.entries()) {
    const eventUid = appleProperty(event, "UID");
    const stamps = appleProperty(event, "DTSTAMP");
    const starts = appleProperty(event, "DTSTART");
    const recurrenceIds = appleProperty(event, "RECURRENCE-ID");
    if (eventUid.length !== 1 || eventUid[0].value !== uid || stamps.length !== 1 || !validCompactDateTime(stamps[0].value, true)) return false;
    if (starts.length !== 1 || !validIcsDateValue(starts[0].value, starts[0].parameters)) return false;
    const startIsDate = starts[0].parameters.VALUE?.toUpperCase() === "DATE";
    if (startIsDate !== rootIsDate || (!startIsDate && starts[0].value.endsWith("Z") !== rootIsZulu)) return false;
    if (index === 0 ? recurrenceIds.length !== 0 : recurrenceIds.length !== 1) return false;
    if (recurrenceIds.length === 1) {
      const recurrenceIsDate = recurrenceIds[0].parameters.VALUE?.toUpperCase() === "DATE";
      if (!validIcsDateValue(recurrenceIds[0].value, recurrenceIds[0].parameters) || recurrenceIsDate !== rootIsDate
        || (!recurrenceIsDate && recurrenceIds[0].value.endsWith("Z") !== rootIsZulu)) return false;
    }
    for (const exclusion of appleProperty(event, "EXDATE")) {
      const exclusionIsDate = exclusion.parameters.VALUE?.toUpperCase() === "DATE";
      if (exclusionIsDate !== rootIsDate || !exclusion.value.split(",").every((value) => validIcsDateValue(value, exclusion.parameters)
        && (exclusionIsDate || value.endsWith("Z") === rootIsZulu))) return false;
    }
    for (const rule of appleProperty(event, "RRULE")) {
      const until = rule.value.split(";").find((part) => part.toUpperCase().startsWith("UNTIL="))?.slice(6);
      if (until && (rootIsDate ? !validCompactDate(until)
        : rootIsZulu ? !validCompactDateTime(until, true) : until.endsWith("Z") || !validCompactDateTime(until))) return false;
    }
  }
  return true;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function appleCalendarFixture({ uid, date = "20270114", timestamp = "20261013T120000Z", recurrence = null, exceptionUid = uid, exdate = null } = {}) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FileTasks Test//Calendar//EN", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${timestamp}`, `DTSTART;VALUE=DATE:${date}`, "SUMMARY:Imported calendar event"];
  if (recurrence) lines.push(`RRULE:${recurrence}`);
  if (exdate) lines.push(exdate);
  lines.push("END:VEVENT");
  if (recurrence && exceptionUid) lines.push("BEGIN:VEVENT", `UID:${exceptionUid}`, `DTSTAMP:${timestamp}`, `RECURRENCE-ID;VALUE=DATE:${date}`,
    `DTSTART;VALUE=DATE:${date}`, "SUMMARY:Imported calendar exception", "END:VEVENT");
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

function writeRunnerProcessGroupState() {
  if (runnerProcessGroupStatePath) {
    writeFileSync(runnerProcessGroupStatePath, `${JSON.stringify([...runnerOwnedProcessGroups])}\n`);
  }
}

function trackRunnerOwnedProcessGroup(pid) {
  if (!runnerProcessGroupStatePath || process.platform === "win32" || !pid) return;
  runnerOwnedProcessGroups.add(pid);
  writeRunnerProcessGroupState();
}

function forgetRunnerOwnedProcessGroup(pid) {
  if (!runnerProcessGroupStatePath || process.platform === "win32" || !pid) return;
  runnerOwnedProcessGroups.delete(pid);
  writeRunnerProcessGroupState();
}

function createSetupGate() {
  let closedReason;
  const pending = new Map();

  return {
    begin(label) {
      if (closedReason) throw new Error(`Cannot start ${label}: setup admission closed by ${closedReason}.`);
      const key = Symbol(label);
      let finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      pending.set(key, { label, finished });
      let isFinished = false;
      return {
        assertOpen() {
          if (closedReason) throw new Error(`Cannot finish ${label}: setup admission closed by ${closedReason}.`);
        },
        finish() {
          if (isFinished) return;
          isFinished = true;
          pending.delete(key);
          finish();
        },
      };
    },
    closeAdmission(reason = "harness cleanup") {
      closedReason ??= reason;
    },
    async waitForPending(timeoutMs) {
      if (pending.size === 0) return;
      const waiting = Promise.all([...pending.values()].map(({ finished }) => finished)).then(() => true);
      const completed = await Promise.race([
        waiting,
        delay(timeoutMs, false, { ref: false }),
      ]);
      if (!completed) {
        const labels = [...pending.values()].map(({ label }) => label).join(", ");
        throw new Error(`Timed out after ${timeoutMs}ms waiting for setup to settle: ${labels}.`);
      }
    },
  };
}

function settledWithin(promise, timeoutMs) {
  return Promise.race([
    promise.then(() => true),
    delay(timeoutMs, false, { ref: false }),
  ]);
}

function formatCleanupError(error) {
  if (error instanceof AggregateError) {
    return `${error.message}\n${[...error.errors].map(formatCleanupError).join("\n")}`;
  }
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedSignal) return;
    interruptedSignal = signal;
    setupGate.closeAdmission(signal);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    void cleanupHarness(signal).catch((error) => {
      process.exitCode = 1;
      process.stderr.write(`Interrupted acceptance harness cleanup failed: ${formatCleanupError(error)}\n`);
    });
  });
}

async function setTestClock(value) {
  const setup = setupGate.begin("test clock update");
  try {
    testClock = new Date(value);
    await writeFile(clockFile, testClock.toISOString());
    setup.assertOpen();
  } finally {
    setup.finish();
  }
}

async function advanceTestClock(milliseconds) {
  await setTestClock(testClock.getTime() + milliseconds);
}

async function startServer() {
  const setup = setupGate.begin("Next.js dev server startup");
  try {
    return await startServerDuringSetup(setup);
  } finally {
    setup.finish();
  }
}

async function startServerDuringSetup(setup) {
  logs = "";
  let child;
  try {
    child = spawn(process.execPath, [nextBin, "dev", ...(process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1" ? ["--webpack"] : []), "--port", String(testPort)], {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        FILETASKS_DATABASE_PATH: join(directory, "workspace.sqlite"),
        FILETASKS_ORIGIN: base,
        FILETASKS_TIME_ZONE: serverTimeZone,
        FILETASKS_EMAIL_DELIVERY_URL: `${deliveryBase}/email`,
        FILETASKS_PUSH_DELIVERY_URL: `${deliveryBase}/push`,
        FILETASKS_REMINDER_WORKER_SECRET: "test-worker-secret",
        FILETASKS_REMINDER_RETRY_BASE_MS: "1000",
        FILETASKS_TEST_CLOCK_PATH: clockFile,
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
  } catch (error) {
    throw new Error(`Could not spawn the Next.js dev server: ${error.message}`);
  }
  const generation = { child, ready: false, spawnError: null, exit: null, output: "" };
  generation.closed = new Promise((resolve) => child.once("close", resolve));
  server = generation;
  child.once("error", (error) => { generation.spawnError = error; });
  child.once("exit", (code, signal) => { generation.exit = { code, signal }; });
  const collectOutput = (data) => {
    generation.output += data.toString("utf8");
    generation.ready ||= generation.output.includes("Ready in ");
    if (server === generation) logs = generation.output;
  };
  child.stdout.on("data", collectOutput);
  child.stderr.on("data", collectOutput);

  const startedAt = Date.now();
  let lastProbeStatus;
  let lastProbeError;
  try {
    trackRunnerOwnedProcessGroup(child.pid);
    while (Date.now() - startedAt < serverReadinessTimeoutMs) {
      setup.assertOpen();
      if (generation.spawnError) throw new Error(`Could not spawn the Next.js dev server: ${generation.spawnError.message}`);
      if (interruptedSignal) throw new Error(`The acceptance harness was interrupted by ${interruptedSignal}.`);
      if (generation.exit || child.exitCode !== null || child.signalCode !== null) {
        const reason = generation.exit?.signal ? `signal ${generation.exit.signal}` : `exit code ${generation.exit?.code ?? child.exitCode}`;
        throw new Error(`Next.js dev server exited before becoming ready (${reason}).`);
      }

      // Next prints this only after binding. Waiting for this child generation's
      // own Ready line prevents a stale listener on the fixed port passing the probe.
      if (generation.ready) {
        try {
          const remainingMs = serverReadinessTimeoutMs - (Date.now() - startedAt);
          const response = await appFetch("/api/auth/session", {
            signal: AbortSignal.timeout(Math.max(1, Math.min(serverReadinessProbeTimeoutMs, remainingMs))),
          });
          lastProbeStatus = response.status;
          await response.body?.cancel();
          if (response.status === 401) {
            if (generation.exit || child.exitCode !== null || child.signalCode !== null) {
              throw new Error("Next.js dev server exited while its readiness probe was completing.");
            }
            setup.assertOpen();
            return;
          }
        } catch (error) {
          lastProbeError = error;
        }
      }
      await delay(200);
    }

    const lastProbe = lastProbeStatus === undefined ? "no HTTP probe completed" : `last HTTP status ${lastProbeStatus}`;
    const probeError = lastProbeError ? `; last probe error: ${lastProbeError.message}` : "";
    throw new Error(`Next.js dev server did not become ready within ${serverReadinessTimeoutMs}ms (expected its Ready line and an API HTTP 401; ${lastProbe}${probeError}).`);
  } catch (error) {
    const startupError = error instanceof Error ? error : new Error(String(error));
    try {
      await stopServer(generation);
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], `${startupError.message}\nNext.js output:\n${logs}`);
    }
    throw new Error(`${startupError.message}\nNext.js output:\n${logs}`);
  }
}

async function startCalendarApiReplica(port, extraEnv = {}) {
  const child = spawn(process.execPath,[nextBin,"dev",...(process.env.FILETASKS_RUN_SHARED_ACCEPTANCE==="1"?["--webpack"]:[]),"--port",String(port)],{
    cwd:projectRoot,detached:process.platform!=="win32",
    env:{...process.env,FILETASKS_DATABASE_PATH:join(directory,"workspace.sqlite"),FILETASKS_ORIGIN:base,FILETASKS_TIME_ZONE:serverTimeZone,
      FILETASKS_EMAIL_DELIVERY_URL:`${deliveryBase}/email`,FILETASKS_PUSH_DELIVERY_URL:`${deliveryBase}/push`,FILETASKS_REMINDER_WORKER_SECRET:"test-worker-secret",
      FILETASKS_REMINDER_RETRY_BASE_MS:"1000",FILETASKS_TEST_CLOCK_PATH:clockFile,FILETASKS_CALENDAR_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64"),
      FILETASKS_PUBLIC_URL:base,GOOGLE_CALENDAR_CLIENT_ID:"fake-client",GOOGLE_CALENDAR_CLIENT_SECRET:"fake-secret",
      GOOGLE_CALENDAR_REDIRECT_URI:`${base}/api/calendars/google/callback`,FILETASKS_GOOGLE_API_ORIGIN:`${deliveryBase}/google`,
      FILETASKS_GOOGLE_TOKEN_URL:`${deliveryBase}/google-token`,FILETASKS_GOOGLE_AUTH_URL:`${deliveryBase}/google-auth`,
      FILETASKS_APPLE_CALDAV_ORIGIN:`${deliveryBase}/apple`,FILETASKS_R2_ACCOUNT_ID:"fake-account",FILETASKS_R2_ACCESS_KEY_ID:"fake-access-key",
      FILETASKS_R2_SECRET_ACCESS_KEY:"fake-secret-key",FILETASKS_R2_BUCKET:"filetasks-test",FILETASKS_R2_ENDPOINT:`${deliveryBase}/r2`,
      FILETASKS_TEST_NEXT_DIST_DIR:".next-test-replica",...extraEnv},
    stdio:["ignore","pipe","pipe"],
  });
  const output=[];
  child.stdout.on("data",(chunk)=>output.push(chunk.toString("utf8")));
  child.stderr.on("data",(chunk)=>output.push(chunk.toString("utf8")));
  const closed=new Promise((resolve)=>child.once("close",resolve));
  if(child.pid) trackRunnerOwnedProcessGroup(child.pid);
  const replica={child,closed,output,port};
  const started=Date.now();
  while(Date.now()-started<serverReadinessTimeoutMs){
    if(child.exitCode!==null||child.signalCode!==null){
      await rm(join(projectRoot,".next-test-replica"),{recursive:true,force:true});
      throw new Error(`Calendar API replica exited early: ${output.join("")}`);
    }
    if(output.join("").includes("Ready in ")){
      try { const response=await fetch(`http://localhost:${port}/api/auth/session`,{signal:AbortSignal.timeout(serverReadinessProbeTimeoutMs)}); await response.body?.cancel(); if(response.status===401)return replica; }
      catch {}
    }
    await delay(100);
  }
  await stopCalendarApiReplica(replica);
  throw new Error(`Calendar API replica did not become ready: ${output.join("")}`);
}

async function stopCalendarApiReplica(replica) {
  if(!replica)return;
  if(replica.child.pid!==undefined&&process.platform==="win32") await runCommand("taskkill",["/PID",String(replica.child.pid),"/T","/F"],process.env,repoRoot,{cleanup:true});
  else if(replica.child.pid!==undefined) await terminateProcessGroup(replica.child.pid,"SIGTERM",{graceMs:serverShutdownTimeoutMs,killWaitMs:serverShutdownTimeoutMs});
  const closed=await Promise.race([replica.closed.then(()=>true),delay(serverShutdownTimeoutMs,false,{ref:false})]);
  if(!closed) throw new Error(`Calendar API replica ${replica.child.pid} did not stop.`);
  if(replica.child.pid&&process.platform!=="win32"&&runnerProcessGroupStatePath){
    if(!(await waitForProcessGroupExit(replica.child.pid,0)))throw new Error(`Calendar API replica process group ${replica.child.pid} remained after shutdown.`);
    forgetRunnerOwnedProcessGroup(replica.child.pid);
  }
  await rm(join(projectRoot,".next-test-replica"),{recursive:true,force:true});
}

async function startDeliveryFake() {
  const setup = setupGate.begin("provider fake startup");
  try {
    return await startDeliveryFakeDuringSetup(setup);
  } catch (error) {
    try {
      await stopDeliveryFake();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Could not start or stop the provider fake.");
    }
    throw error;
  } finally {
    setup.finish();
  }
}

async function startDeliveryFakeDuringSetup(setup) {
  deliveryStopPromise = undefined;
  deliveryRequests = [];
  deliveredKeys = new Set();
  failNextEmail = 0;
  failNextPushRevoke = 0;
  holdNextPushRevoke = null;
  pushRegistrationIds = new Map();
  activePushRegistrations = new Set();
  failNextGoogleRequest = null;
  failGoogleRequests = [];
  holdNextGoogleFailure = null;
  failNextAppleRequest = null;
  providerRequests = [];
  storageRequests = [];
  storageObjects = new Map();
  googleEventPages = null;
  googleInventoryBarrier = null;
  appleInventoryBarrier = null;
  googleEvents = new Map();
  googleInstances = new Map();
  googleInstanceVersions = new Map();
  googleExceptions = new Map();
  googleInstanceRequests = [];
  appleEvents = new Map();
  appleEventVersions = new Map();
  holdNextCalendarCreation = null;
  holdNextAppleBody = null;
  holdNextAppleDelete = null;
  deliveryServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/r2/")) {
      const key = url.pathname;
      const bytes = Buffer.concat(chunks);
      storageRequests.push({ method: request.method, key });
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
    if (request.method === "GET" && url.pathname === "/test/google-events") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([...googleEvents.values()]));
      return;
    }
    if (url.pathname === "/google-auth") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri || !state) {
        response.writeHead(400).end("Missing Google authorization parameters.");
        return;
      }
      const success = new URL(redirectUri);
      if (success.origin !== base || success.pathname !== "/api/calendars/google/callback") {
        response.writeHead(400).end("Unexpected Google authorization callback.");
        return;
      }
      success.searchParams.set("state", state);
      success.searchParams.set("code", "fake-code");
      const cancellation = new URL(success);
      cancellation.searchParams.delete("code");
      cancellation.searchParams.set("error", "access_denied");
      const escapeAttribute = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        `<!doctype html>
<html lang="en">
  <head><meta name="viewport" content="width=device-width"><title>Google Calendar test authorization</title></head>
  <body>
    <h1>Google Calendar access</h1>
    <p>Choose whether to authorize this FileTasks account.</p>
    <p><a href="${escapeAttribute(cancellation.href)}">Cancel authorization</a></p>
    <p><a href="${escapeAttribute(success.href)}">Allow Google Calendar</a></p>
  </body>
</html>`,
      );
      return;
    }
    if (url.pathname === "/__acceptance/apple-copy") {
      const uid = url.searchParams.get("uid") ?? body.uid;
      const collectionPath = String(url.searchParams.get("collectionPath") ?? body.collectionPath ?? "/apple/calendar/").replace(/\/+$/, "") + "/";
      if (request.method === "POST") {
        const path = `${collectionPath}${uid}.ics`;
        if (body.action === "failApple") {
          failNextAppleRequest = { method: body.method ?? "PROPFIND", path: body.path ?? collectionPath, status: body.status ?? 503 };
        } else if (body.action === "seed") {
          const title = String(body.title ?? "Imported acceptance Event");
          appleEvents.set(path, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;VALUE=DATE:20270114\r\nDTEND;VALUE=DATE:20270115\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
        } else if (body.action === "edit") {
          const original = appleEvents.get(path);
          if (original) appleEvents.set(path, original.replace(`SUMMARY:${body.title}`, `SUMMARY:${body.changedTitle}`));
        } else if (body.action === "delete") {
          appleEvents.delete(path);
        } else {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method === "GET") {
        const copies = [...appleEvents.entries()].filter(([path]) => path.startsWith(collectionPath) && path.endsWith(`/${uid}.ics`))
          .map(([path, calendarData]) => ({ path, calendarData }));
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ copies }));
        return;
      }
      response.writeHead(405).end();
      return;
    }
    providerRequests.push({ path: url.pathname, method: request.method, body, text: bodyText, query: url.search, headers: request.headers });
    const idempotencyKey = request.headers["idempotency-key"];
    deliveryRequests.push({ path: request.url, body, idempotencyKey });
    const matchesGoogleFailure = (failure) => failure.path === url.pathname && failure.method === request.method
      && (!failure.summary || failure.summary === body.summary);
    const queuedGoogleFailureIndex = failGoogleRequests.findIndex(matchesGoogleFailure);
    const matchingGoogleFailure = failNextGoogleRequest && matchesGoogleFailure(failNextGoogleRequest)
      ? failNextGoogleRequest : queuedGoogleFailureIndex >= 0 ? failGoogleRequests[queuedGoogleFailureIndex] : null;
    if (holdNextGoogleFailure?.path === url.pathname && holdNextGoogleFailure.method === request.method) {
      const gate = holdNextGoogleFailure;
      holdNextGoogleFailure = null;
      gate.started();
      await gate.releasePromise;
      response.writeHead(gate.status).end();
      return;
    }
    if (matchingGoogleFailure) {
      const { status = 503 } = matchingGoogleFailure;
      if (matchingGoogleFailure === failNextGoogleRequest) failNextGoogleRequest = null;
      else failGoogleRequests.splice(queuedGoogleFailureIndex,1);
      response.writeHead(status).end();
      return;
    }
    if (url.pathname === "/email" && body.operation === "deliver" && failNextEmail > 0) {
      failNextEmail--;
      response.writeHead(503).end();
      return;
    }
    if (url.pathname === "/push" && body.operation === "revoke" && failNextPushRevoke > 0) {
      failNextPushRevoke--;
      response.writeHead(503).end();
      return;
    }
    if (url.pathname === "/push" && body.operation === "revoke" && holdNextPushRevoke) {
      const gate = holdNextPushRevoke;
      holdNextPushRevoke = null;
      gate.started();
      await gate.releasePromise;
      activePushRegistrations.delete(body.registrationId);
      response.writeHead(200).end();
      return;
    }
    if (url.pathname === "/google-token") {
      const authorizationCode = new URLSearchParams(bodyText).get("code");
      const tokens = authorizationCode === "reconnect-code"
        ? { access_token: "reconnected-access", refresh_token: "reconnected-refresh", expires_in: 3600 }
        : { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 };
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(tokens));
      return;
    }
    if (url.pathname === "/google/calendar/v3/calendars/primary") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: googleCalendarId, summary: "Fake Google Calendar" }));
      return;
    }
    if (url.pathname.startsWith(`/google/calendar/v3/calendars/${googleCalendarId}/events`) || url.pathname.startsWith("/google/calendar/v3/calendars/primary/events")) {
      const privateProperties = body.extendedProperties?.private;
      if (privateProperties !== undefined && (privateProperties === null || typeof privateProperties !== "object" || Array.isArray(privateProperties)
        || Object.values(privateProperties).some(value => typeof value !== "string"))) {
        response.writeHead(400).end("Google private extended property values must be strings.");
        return;
      }
      const parts = url.pathname.split("/");
      const eventId = parts[parts.length - 1] === "events" || parts.at(-1) === "instances" ? null : parts.at(-1);
      if (request.method === "GET" && url.pathname.endsWith("/events")) {
        if (googleInventoryBarrier) {
          const barrier = googleInventoryBarrier;
          if (++barrier.arrivals === 2) barrier.release();
          barrier.arrived?.();
          await barrier.ready;
        }
        if (googleEventPages) {
          const page = googleEventPages[url.searchParams.get("pageToken") ?? "first"];
          if (page?.status) { response.writeHead(page.status).end(); return; }
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(page));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items: [...googleEvents.values()] }));
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/instances")) {
        const originalStart = url.searchParams.get("originalStart");
        googleInstanceRequests.push({ rootEventId: parts.at(-2), originalStart, timeMin: url.searchParams.get("timeMin"), timeMax: url.searchParams.get("timeMax") });
        const items = [...googleInstances.values()].filter((instance) => {
          if (!originalStart) return true;
          const original = instance.originalStartTime?.dateTime ?? instance.originalStartTime?.date;
          return original?.includes("T") && originalStart.includes("T")
            ? Date.parse(original) === Date.parse(originalStart)
            : original === originalStart;
        });
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items }));
        return;
      }
      if (request.method === "GET" && eventId && googleInstances.has(eventId)) {
        const instance = googleInstances.get(eventId);
        const version = googleInstanceVersions.get(eventId) ?? 1;
        googleInstanceVersions.set(eventId,version);
        response.writeHead(200,{"Content-Type":"application/json",ETag:`"google-instance-${eventId}-${version}"`})
          .end(JSON.stringify({...instance,id:eventId}));
        return;
      }
      if (request.method === "GET" && eventId) {
        const event = googleEvents.get(eventId);
        if (!event) {
          response.writeHead(404).end(); return;
        }
        const version = googleEventVersions.get(eventId) ?? 1;
        googleEventVersions.set(eventId,version);
        response.writeHead(200, { "Content-Type": "application/json", ETag: `"google-${eventId}-${version}"` }).end(JSON.stringify(event));
        return;
      }
      if (request.method === "DELETE") {
        googleEvents.delete(eventId);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "PUT" || request.method === "PATCH") {
        if (!googleEvents.has(eventId)) {
          if (!googleInstances.has(eventId)) {
            response.writeHead(404).end(); return;
          }
          const gate = holdNextCalendarUpdate?.provider === "google" && (!holdNextCalendarUpdate.eventId || holdNextCalendarUpdate.eventId === eventId) ? holdNextCalendarUpdate : null;
          if (gate) { holdNextCalendarUpdate = null; gate.started(); await gate.releasePromise; }
          const version = googleInstanceVersions.get(eventId) ?? 1;
          if (request.headers["if-match"] && request.headers["if-match"] !== `"google-instance-${eventId}-${version}"`) { response.writeHead(412).end(); return; }
          googleExceptions.set(eventId, { ...body, id: eventId });
          googleInstances.set(eventId, { ...googleInstances.get(eventId), ...body, id: eventId });
          googleInstanceVersions.set(eventId,version+1);
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: eventId }));
          return;
        }
        const gate = holdNextCalendarUpdate?.provider === "google" ? holdNextCalendarUpdate : null;
        if (gate) { holdNextCalendarUpdate = null; gate.started(); await gate.releasePromise; }
        const version = googleEventVersions.get(eventId) ?? 1;
        if (request.headers["if-match"] && request.headers["if-match"] !== `"google-${eventId}-${version}"`) { response.writeHead(412).end(); return; }
        googleEvents.set(eventId, { ...googleEvents.get(eventId), ...body, id: eventId });
        googleEventVersions.set(eventId,version+1);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: eventId }));
        return;
      }
      if (request.method === "POST") {
        if ((body.conferenceData && url.searchParams.get("conferenceDataVersion") !== "1") || (body.attachments && url.searchParams.get("supportsAttachments") !== "true")) { response.writeHead(400).end(); return; }
        const id = body.id ?? `google-${crypto.randomUUID()}`;
        if (googleEvents.has(id)) { response.writeHead(409).end(); return; }
        if (holdNextCalendarCreation?.provider === "google") {
          const gate = holdNextCalendarCreation;
          holdNextCalendarCreation = null;
          if (gate.beforeCommit) { gate.created(); await gate.releasePromise; }
          googleEvents.set(id, { ...body, id });
          googleEventVersions.set(id,1);
          if (!gate.beforeCommit) { gate.created(); await gate.releasePromise; }
        } else {
          googleEvents.set(id, { ...body, id });
          googleEventVersions.set(id,1);
        }
        if (loseNextGooglePostResponse) { loseNextGooglePostResponse = false; response.writeHead(200, { "Content-Type": "application/json" }).end("{"); return; }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id }));
        return;
      }
    }
    if (url.pathname.startsWith("/apple/")) {
      if (failNextAppleRequest?.path === url.pathname && failNextAppleRequest.method === request.method) {
        const { status = 503 } = failNextAppleRequest;
        failNextAppleRequest = null;
        response.writeHead(status).end();
        return;
      }
      if (request.method === "PROPFIND") {
        response.writeHead(207, { "Content-Type": "application/xml" }).end("<d:multistatus xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:response><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>");
        return;
      }
      if (request.method === "REPORT") {
        if (appleInventoryBarrier) {
          const barrier = appleInventoryBarrier;
          if (++barrier.arrivals === 2) barrier.release();
          barrier.arrived?.();
          await barrier.ready;
        }
        const calendarPath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
        const resources = [...appleEvents.entries()].filter(([path]) => path.startsWith(calendarPath) && !omittedAppleReports.has(path));
        const entries = resources.map(([path, calendarData], index) => `<d:response><d:href>${escapeXml(path)}</d:href><d:propstat><d:prop><d:getetag>"apple-${index + 1}"</d:getetag><c:calendar-data>${escapeXml(calendarData)}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
        response.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" })
          .end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${entries}</d:multistatus>`);
        return;
      }
      if (request.method === "GET") {
        const resource = appleEvents.get(url.pathname);
        if (resource === undefined) response.writeHead(404).end();
        else {
          const version = appleEventVersions.get(url.pathname) ?? 1;
          appleEventVersions.set(url.pathname,version);
          const gate = holdNextAppleBody?.path === url.pathname ? holdNextAppleBody : null;
          if (gate) holdNextAppleBody = null;
          response.writeHead(200, { "Content-Type": "text/calendar", ETag: `"apple-${version}"` });
          if (gate) {
            const split = Math.max(1,Math.floor(resource.length/2));
            response.write(resource.slice(0,split));
            gate.started();
            await gate.releasePromise;
            response.end(resource.slice(split));
          } else response.end(resource);
        }
        return;
      }
      if (request.method === "PUT") {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("text/calendar")) {
          response.writeHead(415).end("Expected a text/calendar resource.");
          return;
        }
        if (!validAppleCalendar(bodyText)) {
          response.writeHead(400).end("Invalid iCalendar resource.");
          return;
        }
        const existed = appleEvents.has(url.pathname);
        const gate = holdNextCalendarUpdate?.provider === "apple" && existed ? holdNextCalendarUpdate : null;
        if (gate) { holdNextCalendarUpdate = null; gate.started(); await gate.releasePromise; }
        const version = appleEventVersions.get(url.pathname) ?? 1;
        if (request.headers["if-none-match"] === "*" && existed) { response.writeHead(412).end(); return; }
        if (request.headers["if-match"] && (!existed || request.headers["if-match"] !== `"apple-${version}"`)) {
          gate?.completed?.();
          response.writeHead(412).end();
          return;
        }
        if (holdNextCalendarCreation?.provider === "apple") {
          const gate = holdNextCalendarCreation;
          holdNextCalendarCreation = null;
          if (gate.beforeCommit) { gate.created(); await gate.releasePromise; }
          appleEvents.set(url.pathname, bodyText);
          appleEventVersions.set(url.pathname,1);
          if (!gate.beforeCommit) { gate.created(); await gate.releasePromise; }
        } else {
          appleEvents.set(url.pathname, bodyText);
          appleEventVersions.set(url.pathname,version+1);
        }
        response.writeHead(existed ? 204 : 201).end();
        gate?.completed?.();
        return;
      }
      if (request.method === "DELETE") {
        const version = appleEventVersions.get(url.pathname) ?? 1;
        if (request.headers["if-match"] && (!appleEvents.has(url.pathname) || request.headers["if-match"] !== `"apple-${version}"`)) {
          response.writeHead(412).end();
          return;
        }
        appleEvents.delete(url.pathname);
        appleEventVersions.set(url.pathname,version+1);
        const gate = holdNextAppleDelete?.path === url.pathname ? holdNextAppleDelete : null;
        if (gate) { holdNextAppleDelete = null; gate.started(); await gate.releasePromise; }
        response.writeHead(204).end();
        return;
      }
    }
    if (url.pathname === "/push" && body.operation === "register") {
      let registrationId = pushRegistrationIds.get(idempotencyKey);
      if (!registrationId) {
        registrationId = `fake-${crypto.randomUUID()}`;
        pushRegistrationIds.set(idempotencyKey, registrationId);
      }
      activePushRegistrations.add(registrationId);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ registrationId }));
      return;
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
  setup.assertOpen();
  deliveryBase = `http://127.0.0.1:${deliveryServer.address().port}`;
}

async function stopDeliveryFake() {
  if (!deliveryServer?.listening) return;
  if (!deliveryStopPromise) {
    deliveryStopPromise = new Promise((resolve, reject) => deliveryServer.close((error) => error ? reject(error) : resolve()));
  }
  if (!(await settledWithin(deliveryStopPromise, serverShutdownTimeoutMs))) {
    deliveryServer.closeAllConnections?.();
    if (!(await settledWithin(deliveryStopPromise, serverShutdownTimeoutMs))) {
      throw new Error(`Provider fake server did not close within ${serverShutdownTimeoutMs * 2}ms.`);
    }
  }
  deliveryServer = undefined;
  deliveryStopPromise = undefined;
}

function stopServer(generation = server) {
  if (!generation) return;
  if (!generation.stopPromise) generation.stopPromise = stopServerGeneration(generation);
  return generation.stopPromise;
}

async function stopServerGeneration(generation) {
  const { child } = generation;
  if (child.pid !== undefined && process.platform === "win32") {
    // Node's Windows child.kill terminates only the CLI, leaving its worker.
    try {
      await runCommand("taskkill", ["/PID", String(child.pid), "/T", "/F"], process.env, repoRoot, { cleanup: true });
    } catch (error) {
      if (!generation.exit && child.exitCode === null && child.signalCode === null) throw error;
    }
  } else if (child.pid !== undefined) {
    await terminateProcessGroup(child.pid, "SIGTERM", { graceMs: serverShutdownTimeoutMs, killWaitMs: serverShutdownTimeoutMs });
  }

  // Wait for the CLI and its inherited stdout/stderr pipes to close before
  // starting another generation, including when spawning failed.
  const closed = await Promise.race([
    generation.closed.then(() => true),
    delay(serverShutdownTimeoutMs, undefined, { ref: false }).then(() => false),
  ]);
  if (!closed) throw new Error(`Next.js dev server process ${child.pid ?? "(not spawned)"} did not close its output.`);
  if (child.pid && process.platform !== "win32" && runnerProcessGroupStatePath) {
    if (!(await waitForProcessGroupExit(child.pid, 0))) {
      throw new Error(`Next.js dev server process group ${child.pid} remained after shutdown.`);
    }
    forgetRunnerOwnedProcessGroup(child.pid);
  }
  if (server === generation) server = undefined;
}

async function runCommand(command, args, env = process.env, cwd = repoRoot, { detached = true, cleanup = false } = {}) {
  const setup = cleanup ? undefined : setupGate.begin(`${command} command`);
  return new Promise((resolve, reject) => {
    let spawnError;
    let trackingError;
    let output = "";
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: detached && process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      setup?.finish();
      reject(error);
      return;
    }
    let finishInvocation;
    const invocation = {
      command,
      args,
      child,
      detached: detached && process.platform !== "win32",
      finished: new Promise((resolveFinished) => { finishInvocation = resolveFinished; }),
    };
    activeCommands.add(invocation);
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", async (code, signal) => {
      let groupError;
      if (child.pid && detached && process.platform !== "win32") {
        try {
          if (!(await waitForProcessGroupExit(child.pid, serverShutdownTimeoutMs))) {
            await terminateProcessGroup(child.pid, "SIGTERM", { graceMs: serverShutdownTimeoutMs, killWaitMs: serverShutdownTimeoutMs });
            groupError = new Error(`${command} exited while owned child processes remained; they were terminated.`);
          }
        } catch (error) {
          groupError = error;
        }
        if (runnerProcessGroupStatePath) {
          try {
            if (!(await waitForProcessGroupExit(child.pid, 0))) {
              groupError ??= new Error(`Owned process group ${child.pid} remained after command shutdown.`);
            } else {
              forgetRunnerOwnedProcessGroup(child.pid);
            }
          } catch (error) {
            groupError ??= error;
          }
        }
      }
      activeCommands.delete(invocation);
      finishInvocation();
      setup?.finish();
      if (trackingError) reject(trackingError);
      else if (spawnError) reject(spawnError);
      else if (groupError) reject(new Error(`${command} ${args.join(" ")} process cleanup failed: ${groupError.message}\n${output.slice(-6000)}`));
      else if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `code ${code}`}:\n${output.slice(-30000)}`));
    });

    if (invocation.detached && child.pid && runnerProcessGroupStatePath) {
      try {
        trackRunnerOwnedProcessGroup(child.pid);
      } catch (error) {
        trackingError = new Error(`Could not record owned command ${command} process group ${child.pid}: ${error.message}`);
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        child.kill("SIGKILL");
      }
    }
  });
}

async function stopActiveCommands(signal = "SIGTERM") {
  const invocations = [...activeCommands];
  const results = await Promise.allSettled(invocations.map(async (invocation) => {
    const { child, detached, finished, command, args } = invocation;
    if (child.pid === undefined) {
      if (!(await settledWithin(finished, commandShutdownTimeoutMs))) {
        throw new Error(`Owned command ${command} (pid unknown) did not finish closing.`);
      }
      return;
    }

    if (process.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (!(await settledWithin(finished, commandShutdownTimeoutMs))) {
          throw new Error(`Owned command ${command} (pid ${child.pid}) did not finish closing.`);
        }
        return;
      }
      try {
        await runCommand("taskkill", ["/PID", String(child.pid), "/T", "/F"], process.env, repoRoot, { cleanup: true });
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) throw error;
      }
    } else if (detached) {
      let terminationError;
      try {
        await terminateProcessGroup(child.pid, signal, {
          graceMs: commandShutdownTimeoutMs,
          killWaitMs: commandShutdownTimeoutMs + 1_000,
        });
      } catch (error) {
        terminationError = error;
      }

      if (!(await settledWithin(finished, commandShutdownTimeoutMs))) {
        try {
          await terminateProcessGroup(child.pid, "SIGKILL", { graceMs: 0, killWaitMs: commandShutdownTimeoutMs });
        } catch (error) {
          terminationError ??= error;
        }
      }
      if (!(await settledWithin(finished, commandShutdownTimeoutMs))) {
        throw new Error(`Owned command ${command} ${args.join(" ")} (pid ${child.pid}) did not exit after ${signal} and SIGKILL${terminationError ? `: ${terminationError.message}` : "."}`);
      }
      if (terminationError) throw new Error(`Could not confirm cleanup of owned command ${command} (pid ${child.pid}): ${terminationError.message}`);
      return;
    } else {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      if (!(await settledWithin(finished, commandShutdownTimeoutMs))) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (!(await settledWithin(finished, commandShutdownTimeoutMs + 1_000))) {
          throw new Error(`Owned command ${command} ${args.join(" ")} (pid ${child.pid}) did not exit after ${signal} and SIGKILL.`);
        }
      }
      return;
    }

    if (!(await settledWithin(finished, commandShutdownTimeoutMs + 1_000))) {
      throw new Error(`Owned command ${command} ${args.join(" ")} (pid ${child.pid}) did not close after termination.`);
    }
  }));

  const failures = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
  if (failures.length) throw new AggregateError(failures, "Could not stop every owned acceptance command.");
}

async function closeUIAcceptanceBrowser() {
  const errors = [];
  try {
    await closeUIAcceptanceContext();
  } catch (error) {
    errors.push(error);
  }
  if (uiAcceptanceBrowser) {
    try {
      if (!uiAcceptanceBrowserClosePromise) uiAcceptanceBrowserClosePromise = uiAcceptanceBrowser.close();
      if (!(await settledWithin(uiAcceptanceBrowserClosePromise, browserShutdownTimeoutMs))) {
        throw new Error(`UI acceptance browser did not close within ${browserShutdownTimeoutMs}ms.`);
      }
      uiAcceptanceBrowser = undefined;
      uiAcceptanceBrowserClosePromise = undefined;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Could not close the UI acceptance browser cleanly.");
}

async function closeUIAcceptanceContext() {
  if (!uiAcceptanceContext) return;
  if (!uiAcceptanceContextClosePromise) uiAcceptanceContextClosePromise = uiAcceptanceContext.close();
  if (!(await settledWithin(uiAcceptanceContextClosePromise, browserShutdownTimeoutMs))) {
    throw new Error(`UI acceptance browser context did not close within ${browserShutdownTimeoutMs}ms.`);
  }
  uiAcceptanceContext = undefined;
  uiAcceptanceContextClosePromise = undefined;
}

async function launchUIAcceptanceBrowser() {
  const setup = setupGate.begin("UI acceptance browser startup");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    setup.assertOpen();
    uiAcceptanceBrowser = browser;
    return browser;
  } catch (error) {
    if (browser && uiAcceptanceBrowser !== browser) await browser.close().catch(() => {});
    throw error;
  } finally {
    setup.finish();
  }
}

async function createUIAcceptanceContext(browser) {
  const setup = setupGate.begin("UI acceptance browser context startup");
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    setup.assertOpen();
    uiAcceptanceContext = context;
    return context;
  } catch (error) {
    if (context && uiAcceptanceContext !== context) await context.close().catch(() => {});
    throw error;
  } finally {
    setup.finish();
  }
}

async function createUIAcceptancePage(context) {
  const setup = setupGate.begin("UI acceptance page startup");
  try {
    const page = await context.newPage();
    setup.assertOpen();
    return page;
  } finally {
    setup.finish();
  }
}

function cleanupHarness(signal) {
  if (harnessCleanupPromise) return harnessCleanupPromise;
  setupGate.closeAdmission(signal ?? "harness cleanup");
  harnessCleanupPromise = (async () => {
    const errors = [];
    try { await stopActiveCommands(signal ?? "SIGTERM"); } catch (error) { errors.push(error); }
    try { await setupGate.waitForPending(setupShutdownTimeoutMs); } catch (error) { errors.push(error); }
    try { await closeUIAcceptanceBrowser(); } catch (error) { errors.push(error); }
    try { await stopServer(); } catch (error) { errors.push(error); }
    try { await stopDeliveryFake(); } catch (error) { errors.push(error); }
    try { if (directory) await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) {
      throw new AggregateError(errors, `Could not completely clean up the temporary acceptance harness:\n${errors.map(formatCleanupError).join("\n")}`);
    }
  })();
  return harnessCleanupPromise;
}

before(async () => {
  const setup = setupGate.begin("temporary acceptance harness startup");
  try {
    directory = await mkdtemp(join(tmpdir(), "filetasks-test-"));
    setup.assertOpen();
    clockFile = join(directory, "clock.txt");
    await setTestClock(testClock);
    setup.assertOpen();
    await startDeliveryFake();
    setup.assertOpen();
    await startServer();
    setup.assertOpen();
  } catch (error) {
    if (directory && (interruptedSignal || harnessCleanupPromise)) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      directory = undefined;
    }
    throw error;
  } finally {
    setup.finish();
  }
});

after(async () => {
  await cleanupHarness();
});

afterEach(async () => {
  if (interruptedSignal) return;
  if (serverTimeZone !== "UTC") {
    serverTimeZone = "UTC";
    await stopServer();
    await startServer();
  }
});

async function request(path, { token, cookie, method = "GET", body, headers = {}, redirect = "follow" } = {}) {
  return appFetch(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect,
  });
}

async function appFetch(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Connection", "close");
  return fetch(`${base}${path}`, { ...options, headers });
}

async function runReminderWorker() {
  return appFetch("/api/internal/reminders/deliver", {
    method: "POST",
    headers: { Authorization: "Bearer test-worker-secret" },
  });
}

async function account(email = `person-${crypto.randomUUID()}@example.com`) {
  const response = await request("/api/auth/register", { method: "POST", body: { email, password: "correct-horse-battery" } });
  assert.equal(response.status, 201);
  return { ...(await response.json()), cookie: responseCookie(response, "filetasks_session") };
}

function responseCookie(response, name) {
  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const cookie = setCookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `response should set ${name}`);
  return cookie.split(";", 1)[0];
}

function mergeCookies(...cookieHeaders) {
  const cookies = new Map();
  for (const header of cookieHeaders) {
    for (const pair of (header ?? "").split(";")) {
      const value = pair.trim();
      if (!value) continue;
      const separator = value.indexOf("=");
      if (separator > 0) cookies.set(value.slice(0, separator), value.slice(separator + 1));
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function beginGoogleAuthorization(owner) {
  const response = await request("/api/calendars/google/connect", { cookie: owner.cookie, redirect: "manual" });
  assert.equal(response.status, 303);
  const authorizationUrl = new URL(response.headers.get("location"));
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);
  const transactionCookie = responseCookie(response, "filetasks_google_oauth");
  return {
    response,
    authorizationUrl,
    state,
    transactionCookie,
    cookie: mergeCookies(owner.cookie, transactionCookie),
  };
}

test("the iOS UI Google authorization fake offers cancel and approve callbacks", async () => {
  const state = "ios-ui-browser-state";
  const authorizationUrl = new URL(`${deliveryBase}/google-auth`);
  authorizationUrl.searchParams.set("redirect_uri", `${base}/api/calendars/google/callback`);
  authorizationUrl.searchParams.set("state", state);
  const response = await fetch(authorizationUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => new URL(href.replaceAll("&amp;", "&")));
  assert.equal(links.length, 2);
  assert.equal(links[0].searchParams.get("state"), state);
  assert.equal(links[0].searchParams.get("error"), "access_denied");
  assert.equal(links[0].searchParams.has("code"), false);
  assert.equal(links[1].searchParams.get("state"), state);
  assert.equal(links[1].searchParams.get("code"), "fake-code");
  assert.equal(links[1].searchParams.has("error"), false);
  assert.match(html, /Cancel authorization/);
  assert.match(html, /Allow Google Calendar/);
});

function removeProviderCopyForTest(db, userId, provider, itemId) {
  const copy=db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND provider=? AND item_id=?").get(userId,provider,itemId);
  if (!copy) return;
  db.prepare("DELETE FROM calendar_copies WHERE user_id=? AND provider=? AND item_id=?").run(userId,provider,itemId);
  if (provider === "google") googleEvents.delete(copy.external_id);
  else appleEvents.delete(new URL(copy.external_id).pathname);
}

function deferOtherCalendarRetriesForTest(db, userId) {
  const notDue=Number.MAX_SAFE_INTEGER;
  db.prepare("UPDATE calendar_sync_state SET next_attempt_at=? WHERE user_id<>? AND state IN ('pending','failed')").run(notDue,userId);
  db.prepare("UPDATE calendar_creation_cleanup SET next_attempt_at=? WHERE user_id<>?").run(notDue,userId);
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

test("custom recurring Reminders survive default updates and future Occurrence generation", async () => {
  const owner = await account();
  const initialDefault = [{ delivery: "notification", amount: 1, unit: "days", time: "09:00" }];
  const intermediateDefault = [{ delivery: "notification", amount: 3, unit: "days", time: "09:00" }];
  const customized = [{ delivery: "notification", amount: 2, unit: "days", time: "09:00" }];
  const finalDefault = [{ delivery: "notification", amount: 9, unit: "days", time: "09:00" }];

  assert.equal((await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: {
    taskReminders: initialDefault, applyToExisting: false,
  } })).status, 200);
  const defaultTask = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Default following Task",
  } })).json()).item;
  const series = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Customized series", scheduledDate: "2026-10-20",
    recurrence: { interval: 1, unit: "weeks", weekdays: [2], end: { type: "never" } },
  } })).json()).item;
  let occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id);
  assert.ok(occurrences.length > 1, "the recurring series should have generated existing Occurrences");
  const existingOccurrenceIds = new Set(occurrences.map(({ id }) => id));

  // Future-only changes affect new items, while current Tasks keep the default
  // that was active when they were created.
  assert.equal((await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: {
    taskReminders: intermediateDefault, applyToExisting: false,
  } })).status, 200);
  assert.deepEqual((await (await request(`/api/items/${defaultTask.id}`, { token: owner.token })).json()).item.reminders, initialDefault);
  const futureOnlyTask = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Future default Task",
  } })).json()).item;
  assert.deepEqual(futureOnlyTask.reminders, intermediateDefault);

  // Explicitly changing the whole series to two days makes the root and all
  // already generated children customized, even though they were generated
  // while following the earlier account default.
  const customize = await request(`/api/items/${series.id}`, { token: owner.token, method: "PATCH", body: {
    reminders: customized, scope: "series",
  } });
  assert.equal(customize.status, 200, await customize.clone().text());

  assert.equal((await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: {
    taskReminders: finalDefault, applyToExisting: true,
  } })).status, 200);
  assert.deepEqual((await (await request(`/api/items/${series.id}`, { token: owner.token })).json()).item.reminders, customized);
  assert.deepEqual((await (await request(`/api/items/${defaultTask.id}`, { token: owner.token })).json()).item.reminders, finalDefault);
  assert.deepEqual((await (await request(`/api/items/${futureOnlyTask.id}`, { token: owner.token })).json()).item.reminders, finalDefault);
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id);
  assert.ok(occurrences.length > 1);
  assert.ok(occurrences.every(({ reminders }) => JSON.stringify(reminders) === JSON.stringify(customized)));

  const previousClock = new Date(testClock);
  try {
    await setTestClock(previousClock.getTime() + 372 * 86_400_000);
    occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
      .filter(({ seriesId }) => seriesId === series.id);
    const generatedAfterDefaultChange = occurrences.filter(({ id }) => !existingOccurrenceIds.has(id));
    assert.ok(generatedAfterDefaultChange.length > 0, "advancing the clock should generate new Occurrences");
    assert.ok(generatedAfterDefaultChange.every(({ reminders }) => JSON.stringify(reminders) === JSON.stringify(customized)));
  } finally { await setTestClock(previousClock); }
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
  assert.equal((await appFetch("/api/internal/reminders/deliver", { method: "POST" })).status, 401);
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

test("the controlled clock leaves timed and all-day Reminders pending until their configured times", async () => {
  const owner = await account();
  await setTestClock("2026-10-13T12:00:00.000Z");
  const timed = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Timed future Event", scheduledDate: "2026-10-14", scheduledTime: "08:30",
    reminders: [{ delivery: "notification", amount: 1, unit: "days", time: "16:45" }],
  } })).json()).item;
  const allDay = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "All-day future Event", scheduledDate: "2026-10-14",
    reminders: [{ delivery: "notification", amount: 0, unit: "days", time: "11:20" }],
  } })).json()).item;

  assert.deepEqual(await (await runReminderWorker()).json(), { attempted: 0, sent: 0, failed: 0, calendarSync: { attempted: 0, completed: 0, failed: 0 } });
  assert.equal((await (await request("/api/notifications", { token: owner.token })).json()).notifications.length, 0);
  await setTestClock("2026-10-13T16:44:00.000Z");
  await runReminderWorker();
  assert.equal((await (await request("/api/notifications", { token: owner.token })).json()).notifications.length, 0);
  await setTestClock("2026-10-13T16:45:00.000Z");
  await runReminderWorker();
  let notifications = (await (await request("/api/notifications", { token: owner.token })).json()).notifications;
  assert.equal(notifications.some(({ itemId }) => itemId === timed.id), true);
  assert.equal(notifications.some(({ itemId }) => itemId === allDay.id), false);

  await setTestClock("2026-10-14T11:19:00.000Z");
  await runReminderWorker();
  notifications = (await (await request("/api/notifications", { token: owner.token })).json()).notifications;
  assert.equal(notifications.some(({ itemId }) => itemId === allDay.id), false);
  await setTestClock("2026-10-14T11:20:00.000Z");
  await runReminderWorker();
  notifications = (await (await request("/api/notifications", { token: owner.token })).json()).notifications;
  assert.equal(notifications.some(({ itemId }) => itemId === allDay.id), true);
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
  assert.deepEqual(await firstRun.json(), { attempted: 2, sent: 1, failed: 1, calendarSync: { attempted: 0, completed: 0, failed: 0 } });
  await advanceTestClock(1_100);
  const retry = await runReminderWorker();
  assert.deepEqual(await retry.json(), { attempted: 1, sent: 1, failed: 0, calendarSync: { attempted: 0, completed: 0, failed: 0 } });
  assert.deepEqual(await (await runReminderWorker()).json(), { attempted: 0, sent: 0, failed: 0, calendarSync: { attempted: 0, completed: 0, failed: 0 } });

  const sentRequests = deliveryRequests.slice(startIndex).filter(({ body }) => body.operation === "deliver");
  const emailRequests = sentRequests.filter(({ path }) => path === "/email");
  const pushRequests = sentRequests.filter(({ path }) => path === "/push");
  assert.equal(emailRequests.length, 2);
  assert.equal(emailRequests[0].idempotencyKey, emailRequests[1].idempotencyKey);
  assert.equal(new Set(emailRequests.map(({ idempotencyKey }) => idempotencyKey)).size, 1);
  assert.equal(pushRequests.length, 1);
  assert.equal(deliveredKeys.size, 2);

  assert.equal((await request(`/api/devices/push/${device.id}`, { token: owner.token, method: "DELETE" })).status, 204);
  const cleanupDb = new DatabaseSync(join(directory, "workspace.sqlite"));
  assert.equal(cleanupDb.prepare("SELECT count(*) AS count FROM push_cleanup_jobs").get().count, 1,
    "revocation should be durably queued before provider cleanup runs");
  cleanupDb.close();
  await runReminderWorker();
  assert.equal(deliveryRequests.some(({ body }) => body.operation === "revoke" && body.registrationId), true);
  assert.equal((await request(`/api/devices/push/${device.id}`, { token: owner.token, method: "DELETE" })).status, 404);
  assert.equal(item.kind, "event");
});

test("push revoke is durable during provider outages and remains scoped to the signed-out device", async () => {
  const owner = await account();
  const providerStart = providerRequests.length;
  const anotherSession = await request("/api/auth/login", { method: "POST", body: {
    email: owner.user.email, password: "correct-horse-battery",
  } });
  const otherSession = await anotherSession.json();
  const otherAccount = await account();
  await request("/api/settings/reminders", { token: owner.token, method: "PATCH", body: { pushEnabled: true } });
  await request("/api/settings/reminders", { token: otherAccount.token, method: "PATCH", body: { pushEnabled: true } });
  const revokedResponse = await request("/api/devices/push", { token: owner.token, method: "POST", body: {
    platform: "ios", token: `revoked-${crypto.randomUUID()}`,
  } });
  const retainedResponse = await request("/api/devices/push", { token: owner.token, method: "POST", body: {
    platform: "ios", token: `retained-${crypto.randomUUID()}`,
  } });
  const otherDeviceResponse = await request("/api/devices/push", { token: otherAccount.token, method: "POST", body: {
    platform: "android", token: `other-${crypto.randomUUID()}`,
  } });
  const revoked = (await revokedResponse.json()).device;
  const retained = (await retainedResponse.json()).device;
  const otherDevice = (await otherDeviceResponse.json()).device;
  const beforeRevokeDb = new DatabaseSync(join(directory, "workspace.sqlite"));
  const revokedRegistrationId = beforeRevokeDb.prepare("SELECT provider_id AS providerId FROM push_devices WHERE id=?").get(revoked.id).providerId;
  const retainedRegistrationId = beforeRevokeDb.prepare("SELECT provider_id AS providerId FROM push_devices WHERE id=?").get(retained.id).providerId;
  const otherRegistrationId = beforeRevokeDb.prepare("SELECT provider_id AS providerId FROM push_devices WHERE id=?").get(otherDevice.id).providerId;
  beforeRevokeDb.close();

  await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Push after sign-out", scheduledDate: "2020-02-03",
    reminders: [{ delivery: "notification", amount: 0, unit: "days", time: "10:00" }],
  } });
  failNextPushRevoke = 1;
  const revoke = await request(`/api/devices/push/${revoked.id}`, { token: owner.token, method: "DELETE" });
  assert.equal(revoke.status, 204, "provider availability must not block local revocation");
  assert.equal((await request("/api/auth/logout", { token: owner.token, method: "POST" })).status, 204);
  assert.equal((await request("/api/items", { token: owner.token })).status, 401);
  assert.equal((await request("/api/items", { token: otherSession.token })).status, 200,
    "signing out one session must leave another session for the same account valid");
  assert.equal((await request("/api/items", { token: otherAccount.token })).status, 200);

  await runReminderWorker();
  const pushCalls = providerRequests.slice(providerStart).filter(({ path }) => path === "/push");
  const ownerDeliveries = pushCalls.filter(({ body }) => body.operation === "deliver");
  assert.ok(ownerDeliveries.some(({ body }) => body.registrationId === retainedRegistrationId), "the still-registered device should continue receiving sends");
  assert.equal(ownerDeliveries.some(({ body }) => body.registrationId === revokedRegistrationId), false,
    "the revoked device must not receive a newly scheduled send");
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM push_devices WHERE id=?").get(revoked.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM push_devices WHERE provider_id=?").get(otherRegistrationId).count, 1,
    "another account's registered device should remain unaffected");
  assert.equal(db.prepare("SELECT count(*) AS count FROM push_cleanup_jobs").get().count, 1,
    "failed provider cleanup must remain durable after the sign-out bearer is invalidated");
  db.close();

  await stopServer();
  await stopDeliveryFake();
  await startDeliveryFake();
  await startServer();
  await advanceTestClock(1_100);
  await runReminderWorker();
  const recoveredCleanup = providerRequests.find(({ body }) => body.operation === "revoke");
  assert.equal(recoveredCleanup?.body.registrationId, revokedRegistrationId,
    "the restarted worker should recover the right cleanup without the signed-out bearer token");
  const restartedDb = new DatabaseSync(join(directory, "workspace.sqlite"));
  assert.equal(restartedDb.prepare("SELECT count(*) AS count FROM push_cleanup_jobs").get().count, 0);
  restartedDb.close();
  assert.equal(otherDevice.platform, "android");
  assert.equal(retained.platform, "ios");
});

test("a concurrent re-registration survives an in-flight push cleanup", async () => {
  const owner = await account();
  const registration = { platform: "ios", token: `reused-${crypto.randomUUID()}` };
  const firstResponse = await request("/api/devices/push", { token: owner.token, method: "POST", body: registration });
  const firstDevice = (await firstResponse.json()).device;
  const firstDb = new DatabaseSync(join(directory, "workspace.sqlite"));
  const registrationId = firstDb.prepare("SELECT provider_id AS providerId FROM push_devices WHERE id=?").get(firstDevice.id).providerId;
  firstDb.close();
  assert.equal((await request(`/api/devices/push/${firstDevice.id}`, { token: owner.token, method: "DELETE" })).status, 204);

  let signalRevokeStarted;
  let finishRevoke;
  const revokeStarted = new Promise((resolve) => { signalRevokeStarted = resolve; });
  const revokeRelease = new Promise((resolve) => { finishRevoke = resolve; });
  holdNextPushRevoke = { started: signalRevokeStarted, releasePromise: revokeRelease };
  const cleanupPromise = runReminderWorker();
  await revokeStarted;

  const reRegistrationPromise = request("/api/devices/push", { token: owner.token, method: "POST", body: registration });
  await delay(100);
  finishRevoke();
  assert.equal((await cleanupPromise).status, 200);
  const reRegistration = await reRegistrationPromise;
  assert.equal(reRegistration.status, 201);

  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  const currentRegistration = db.prepare("SELECT provider_id AS providerId FROM push_devices WHERE user_id=?").get(owner.user.id);
  assert.equal(currentRegistration.providerId, registrationId);
  assert.equal(activePushRegistrations.has(registrationId), true,
    "registration must be restored after a cleanup request that was already in flight");
  assert.equal(db.prepare("SELECT count(*) AS count FROM push_cleanup_jobs WHERE registration_id=?").get(registrationId).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM push_cleanup_completed WHERE registration_id=?").get(registrationId).count, 0);
  db.close();
});

test("long-lead Reminders extend rolling Occurrence materialization beyond the former horizon", async () => {
  const owner = await account();
  const today = testClock.toISOString().slice(0, 10);
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

test("Google OAuth requires the initiating browser transaction, session, and one-time state", async () => {
  const attacker = await account();
  const victim = await account();
  const stolenFlow = await beginGoogleAuthorization(attacker);
  const setCookie = stolenFlow.response.headers.getSetCookie?.().find((value) => value.startsWith("filetasks_google_oauth=")) ?? "";
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\/api\/calendars\/google\/callback/i);
  assert.match(setCookie, /Max-Age=600/i);
  for (const secret of [attacker.token, "fake-secret", "fake-access", "fake-refresh"]) {
    assert.equal(stolenFlow.authorizationUrl.href.includes(secret), false);
  }
  assert.equal(stolenFlow.authorizationUrl.searchParams.has("nonce"), false);

  const googleTokenRequests = () => providerRequests.filter(({ path }) => path === "/google-token").length;
  const beforeAttacks = googleTokenRequests();
  const copiedUrlInVictimBrowser = await request(`/api/calendars/google/callback?state=${encodeURIComponent(stolenFlow.state)}&code=attacker-code`, {
    cookie: victim.cookie, redirect: "manual",
  });
  assert.equal(copiedUrlInVictimBrowser.status, 400);
  const mismatchedAccount = await request(`/api/calendars/google/callback?state=${encodeURIComponent(stolenFlow.state)}&code=attacker-code`, {
    cookie: mergeCookies(victim.cookie, stolenFlow.transactionCookie), redirect: "manual",
  });
  assert.equal(mismatchedAccount.status, 400);
  assert.equal(googleTokenRequests(), beforeAttacks, "a copied authorization URL must not exchange an OAuth code");
  assert.deepEqual((await (await request("/api/calendars", { cookie: victim.cookie })).json()).calendars, []);

  const otherSession = await request("/api/auth/login", { method: "POST", body: {
    email: attacker.user.email, password: "correct-horse-battery",
  } });
  assert.equal(otherSession.status, 200);
  const otherSessionCookie = responseCookie(otherSession, "filetasks_session");
  const mismatchedSession = await request(`/api/calendars/google/callback?state=${encodeURIComponent(stolenFlow.state)}&code=attacker-code`, {
    cookie: mergeCookies(otherSessionCookie, stolenFlow.transactionCookie), redirect: "manual",
  });
  assert.equal(mismatchedSession.status, 400, "the callback must use the exact initiating session, even for the same account");
  assert.equal(googleTokenRequests(), beforeAttacks);

  const connected = await request(`/api/calendars/google/callback?state=${encodeURIComponent(stolenFlow.state)}&code=fake-code`, {
    cookie: stolenFlow.cookie, redirect: "manual",
  });
  assert.equal(connected.status, 303);
  assert.equal(new URL(connected.headers.get("location")).searchParams.get("calendar"), "google-connected");
  assert.match(connected.headers.getSetCookie?.().join("; ") ?? "", /Max-Age=0/i);
  assert.equal(googleTokenRequests(), beforeAttacks + 1);

  const replay = await request(`/api/calendars/google/callback?state=${encodeURIComponent(stolenFlow.state)}&code=fake-code`, {
    cookie: stolenFlow.cookie, redirect: "manual",
  });
  assert.equal(replay.status, 400);
  assert.equal(googleTokenRequests(), beforeAttacks + 1, "a consumed state cannot be exchanged twice");

  const attackerCalendars = await request("/api/calendars", { cookie: attacker.cookie });
  const victimCalendars = await request("/api/calendars", { cookie: victim.cookie });
  const attackerCalendarsText = await attackerCalendars.text();
  assert.deepEqual(JSON.parse(attackerCalendarsText).calendars.map(({ provider }) => provider), ["google"]);
  assert.equal(attackerCalendarsText.includes("fake-access"), false, "public connection status must not expose provider tokens");
  assert.deepEqual((await victimCalendars.json()).calendars, []);

  const cancellation = await beginGoogleAuthorization(victim);
  const beforeCancellation = googleTokenRequests();
  const cancelled = await request(`/api/calendars/google/callback?state=${encodeURIComponent(cancellation.state)}&error=access_denied`, {
    cookie: cancellation.cookie, redirect: "manual",
  });
  assert.equal(cancelled.status, 303);
  assert.equal(new URL(cancelled.headers.get("location")).searchParams.get("calendar"), "google-error");
  assert.match(cancelled.headers.getSetCookie?.().join("; ") ?? "", /Max-Age=0/i);
  const cancelledReplay = await request(`/api/calendars/google/callback?state=${encodeURIComponent(cancellation.state)}&code=fake-code`, {
    cookie: cancellation.cookie, redirect: "manual",
  });
  assert.equal(cancelledReplay.status, 400);
  assert.equal(googleTokenRequests(), beforeCancellation, "a cancelled transaction cannot later be completed");

  const nativeBearerStart = await request("/api/calendars/google/connect", { token: victim.token, redirect: "manual" });
  assert.equal(nativeBearerStart.status, 401, "native clients must start the web handoff in an authenticated browser");
  assert.equal(nativeBearerStart.headers.has("location"), false);
});

test("Google OAuth callback rejects expired browser transactions and clears their cookie", async () => {
  const owner = await account();
  const authorization = await beginGoogleAuthorization(owner);
  const initialClock = new Date(testClock);
  const before = providerRequests.filter(({ path }) => path === "/google-token").length;
  try {
    await advanceTestClock(10 * 60_000 + 1);
    const expired = await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    });
    assert.equal(expired.status, 400);
    assert.match(expired.headers.getSetCookie?.().join("; ") ?? "", /Max-Age=0/i);
    assert.equal(providerRequests.filter(({ path }) => path === "/google-token").length, before);
    assert.deepEqual((await (await request("/api/calendars", { cookie: owner.cookie })).json()).calendars, []);
  } finally {
    await setTestClock(initialClock);
  }
});

test("Google and Apple Calendar copies sync through fake provider boundaries", async () => {
  const owner = await account();
  const calendarRequestsStart = providerRequests.length;
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
    cookie: authorization.cookie, redirect: "manual",
  })).status, 303);

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
  const contextFileResponse = await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "Review agenda", url: "https://example.com/review-agenda.pdf",
  } });
  assert.equal(contextFileResponse.status, 201);
  const contextFile = (await contextFileResponse.json()).file;
  assert.equal((await request(`/api/files/${contextFile.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: event.id } })).status, 201);

  for (let attempt = 0; attempt < 2; attempt++) {
    const sync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(sync.status, 200);
    assert.deepEqual((await sync.json()).synced.sort(), ["apple", "google"]);
  }
  assert.equal(googleEvents.size, 1);
  assert.equal(appleEvents.size, 1);
  const afterRepeatedSync = (await (await request("/api/items", { token: owner.token })).json()).items;
  assert.deepEqual(afterRepeatedSync.map(({ id }) => id), [event.id]);
  assert.deepEqual(afterRepeatedSync[0].files, [{ id: contextFile.id, name: "Review agenda", sourceType: "link" }]);
  const fileContext = (await (await request("/api/files", { token: owner.token })).json()).files;
  assert.deepEqual(fileContext.find(({ id }) => id === contextFile.id).attachments.map(({ itemId }) => itemId), [event.id]);
  const firstGoogleCopy = [...googleEvents.values()][0];
  assert.equal(firstGoogleCopy.extendedProperties.private.filetasksItemId, event.id);
  assert.equal(firstGoogleCopy.description.includes(`?event=${event.id}`), true);
  const firstAppleCopy = [...appleEvents.values()][0];
  assert.ok(firstAppleCopy.includes(`URL:${base}/?event=${event.id}`));
  assert.match(firstAppleCopy, /^DTSTAMP:\d{8}T\d{6}Z$/m);

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
  const appleCopyPath = [...appleEvents.keys()][0];
  appleEvents.set(appleCopyPath, appleEvents.get(appleCopyPath).replace("SUMMARY:Updated cross-provider review", "SUMMARY:External edit"));
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(appleEvents.get(appleCopyPath).includes("SUMMARY:Updated cross-provider review"), true);
  assert.equal(appleEvents.get(appleCopyPath).includes("SUMMARY:External edit"), false);
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

test("Google DELETE failure preserves mapping and retries on sync", async () => {
  const priorGoogleEvents=googleEvents;
  googleEvents=new Map();
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, { cookie: auth.cookie, redirect: "manual" })).status, 303);
  const create = async (title) => (await (await request("/api/items", { token: owner.token, method: "POST", body: { kind: "event", title, scheduledDate: "2027-01-14" } })).json()).item;
  const event = await create("Delete failure");
  const other = await create("Unrelated event");
  const [copyId] = [...googleEvents.entries()].find(([, copy]) => copy.extendedProperties.private.filetasksItemId === event.id);
  const path = `/google/calendar/v3/calendars/primary/events/${copyId}`;
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    const mapping = () => db.prepare("SELECT * FROM calendar_copies WHERE user_id=? AND item_id=?").all(owner.user.id, event.id);
    const before = mapping();
    assert.equal(before.length, 1);
    failNextGoogleRequest = { method: "DELETE", path, status: 500 };
    await request(`/api/items/${event.id}`, { token: owner.token, method: "DELETE" });
    assert.deepEqual(mapping(), before);
    assert.equal(googleEvents.has(copyId), true);
    const [otherId, otherCopy] = [...googleEvents.entries()].find(([, copy]) => copy.extendedProperties.private.filetasksItemId === other.id);
    googleEvents.set(otherId, { ...otherCopy, summary: "External change" });
    failNextGoogleRequest = { method: "DELETE", path, status: 500 };
    const failed = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    const result = await failed.json();
    assert.equal(failed.status, 200, JSON.stringify(result));
    assert.equal(failNextGoogleRequest, null, "the fake DELETE failure was exercised");
    assert.deepEqual(mapping(), before);
    assert.equal(googleEvents.has(copyId), true);
    assert.equal(googleEvents.get(otherId).summary, "Unrelated event");
    assert.ok(result.syncLimitations.some((limitation) => limitation.itemId === event.id && limitation.provider === "google" && /could not be removed/i.test(limitation.message)), "sync must visibly report the provider failure");
    assert.ok(!result.synced?.includes("google"), "failed provider must not be reported as synced");
    assert.deepEqual(mapping(), before);
    assert.equal(googleEvents.has(copyId), true);
    assert.ok([...googleEvents.values()].some((copy) => copy.extendedProperties.private.filetasksItemId === other.id));
    const retry = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(retry.status, 200);
    assert.ok((await retry.json()).synced.includes("google"));
    assert.equal(googleEvents.has(copyId), false);
    assert.equal(mapping().length, 0);
  } finally {
    failNextGoogleRequest = null;
    googleEvents=priorGoogleEvents;
    db.close();
  }
});

test("clearing a local Event date retries Google and Apple copy removal after restart", async () => {
  const owner = await account();
  const other = await account();
  const previousGoogleEvents = googleEvents;
  const previousAppleEvents = appleEvents;
  const initialClock = new Date(testClock);
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  googleEvents = new Map();
  appleEvents = new Map();
  try {
    const authorization = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    })).status, 303);
    assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
      username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
    } })).status, 201);

    const dated = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "Keep the dated Event", scheduledDate: "2027-02-10",
    } })).json()).item;
    const toUnschedule = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "Remember locally", details: "Keep its File", scheduledDate: "2027-02-11",
    } })).json()).item;
    const file = (await (await request("/api/files", { token: owner.token, method: "POST", body: {
      name: "Event notes", url: "https://example.com/event-notes.pdf",
    } })).json()).file;
    assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: toUnschedule.id } })).status, 201);
    const newlyUndated = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "Local only", scheduledDate: null,
    } })).json()).item;

    const googleId = (itemId) => [...googleEvents.entries()].find(([, event]) => event.extendedProperties?.private?.filetasksItemId === itemId)?.[0];
    const appleEntry = (itemId) => [...appleEvents.entries()].find(([, calendarData]) => calendarData.includes(`URL:${base}/?event=${itemId}`));
    const googleCopyId = googleId(toUnschedule.id);
    const appleCopy = appleEntry(toUnschedule.id);
    assert.ok(googleCopyId && appleCopy, "the dated Event should have copies in both connected calendars");
    assert.ok(googleId(dated.id) && appleEntry(dated.id), "the other dated Event should synchronize alongside it");
    assert.equal(googleId(newlyUndated.id), undefined, "a newly undated Event must not create an invalid Google export");
    assert.equal(appleEntry(newlyUndated.id), undefined, "a newly undated Event must not create an invalid Apple export");

    const googlePath = `/google/calendar/v3/calendars/primary/events/${googleCopyId}`;
    const applePath = appleCopy[0];
    failNextGoogleRequest = { method: "DELETE", path: googlePath, status: 503 };
    failNextAppleRequest = { method: "DELETE", path: applePath, status: 503 };
    const cleared = await request(`/api/items/${toUnschedule.id}`, { token: owner.token, method: "PATCH", body: {
      scheduledDate: null, scheduledTime: null,
    } });
    assert.equal(cleared.status, 200);
    assert.equal(failNextGoogleRequest, null, "the Google removal failure should be exercised");
    assert.equal(failNextAppleRequest, null, "the Apple removal failure should be exercised");
    const retained = (await (await request(`/api/items/${toUnschedule.id}`, { token: owner.token })).json()).item;
    assert.equal(retained.scheduledDate, null);
    assert.deepEqual(retained.files, [{ id: file.id, name: file.name, sourceType: "link" }]);
    assert.deepEqual(retained.calendarSync.filter((status) => status.limitationCode === "undated-copy-removal-failed")
      .map((status) => status.provider).sort(), ["apple", "google"], "the failed removals should be visible on the undated Event");
    assert.equal((await (await request("/api/files", { token: owner.token })).json()).files
      .find((entry) => entry.id === file.id).attachments.some((attachment) => attachment.itemId === toUnschedule.id), true);
    assert.equal(googleEvents.has(googleCopyId), true);
    assert.equal(appleEvents.has(applePath), true);
    assert.equal(db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='google'")
      .get(owner.user.id, toUnschedule.id)?.external_id, googleCopyId, "failed Google removal must retain its identity");
    assert.equal(db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='apple'")
      .get(owner.user.id, toUnschedule.id)?.external_id, new URL(`http://localhost${applePath}`).toString().replace("http://localhost", deliveryBase),
    "failed Apple removal must retain its identity");
    const delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    assert.deepEqual(delivery.map((entry) => entry.provider).sort(), ["apple", "google"]);
    assert.equal(delivery.some((entry) => entry.reauthorizationRequired), false,
      "transient DELETE failures must remain distinct from authorization failures");
    assert.deepEqual((await (await request("/api/calendars", { token: other.token })).json()).syncDelivery, [],
      "another account must not see this retry state");
    assert.equal(googleId(dated.id) !== undefined, true, "the dated Event must continue to synchronize");
    assert.equal(appleEntry(dated.id) !== undefined, true, "the dated Event must continue to synchronize");

    await stopServer();
    await startServer();
    await advanceTestClock(60_000);
    assert.equal((await runReminderWorker()).status, 200, "the worker should retry both removals after restart");
    assert.equal(googleEvents.has(googleCopyId), false);
    assert.equal(appleEvents.has(applePath), false);
    assert.equal(db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='google'")
      .get(owner.user.id, toUnschedule.id), undefined);
    assert.equal(db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='apple'")
      .get(owner.user.id, toUnschedule.id), undefined);
    assert.deepEqual((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery, []);
    const afterRetry = (await (await request(`/api/items/${toUnschedule.id}`, { token: owner.token })).json()).item;
    assert.equal(afterRetry.scheduledDate, null);
    assert.deepEqual(afterRetry.files, [{ id: file.id, name: file.name, sourceType: "link" }]);
    assert.equal(afterRetry.calendarSync.some((status) => status.limitationCode === "undated-copy-removal-failed"), false,
      "successful retries should clear the Event's cleanup limitation");
  } finally {
    failNextGoogleRequest = null;
    failNextAppleRequest = null;
    googleEvents = previousGoogleEvents;
    appleEvents = previousAppleEvents;
    await setTestClock(initialClock);
    db.close();
  }
});

test("clearing a verified supported imported Event date removes its source and exported copies", async () => {
  const owner = await account();
  const originalGoogleEvents = googleEvents;
  const originalAppleEvents = appleEvents;
  googleEvents = new Map();
  appleEvents = new Map();
  try {
    const source = { id: "imported-source-to-unschedule", summary: "Imported Event", start: { date: "2027-02-12" }, end: { date: "2027-02-13" } };
    googleEvents.set(source.id, structuredClone(source));
    const authorization = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    })).status, 303);
    assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
      username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
    } })).status, 201);
    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    const imported = (await (await request("/api/items", { token: owner.token })).json()).items
      .find((item) => item.title === "Imported Event");
    assert.ok(imported);
    const appleCopy = [...appleEvents.entries()].find(([, calendarData]) => calendarData.includes(`URL:${base}/?event=${imported.id}`));
    assert.ok(appleCopy, "the imported Event should have an exported Apple copy before its date is cleared");

    const cleared = await request(`/api/items/${imported.id}`, { token: owner.token, method: "PATCH", body: {
      scheduledDate: null, scheduledTime: null,
    } });
    assert.equal(cleared.status, 200);
    assert.equal(googleEvents.has(source.id), false, "the verified supported Google source copy must be removed after its date is cleared");
    assert.equal(appleEvents.has(appleCopy[0]), false, "the FileTasks-owned Apple copy must be removed");
    const retained = (await (await request(`/api/items/${imported.id}`, { token: owner.token })).json()).item;
    assert.equal(retained.scheduledDate, null);
    const googleStatus = retained.calendarSync.find((status) => status.provider === "google");
    assert.equal(googleStatus?.state, "supported",
      "a verified supported source representation should not retain a derived schedule limitation after its copy is removed");
  } finally {
    googleEvents = originalGoogleEvents;
    appleEvents = originalAppleEvents;
  }
});

test("an omitted recurring Google import remains protected while inventory verification is pending", async () => {
  const owner = await account();
  const originalGoogleEvents = googleEvents;
  const originalGooglePages = googleEventPages;
  googleEvents = new Map([[
    "recurring-source-pending-inventory",
    { id: "recurring-source-pending-inventory", summary: "Imported recurring Event", start: { date: "2027-02-12" }, end: { date: "2027-02-13" }, recurrence: ["RRULE:FREQ=DAILY;COUNT=3"] },
  ]]);
  try {
    const authorization = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    })).status, 303);
    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    const imported = (await (await request("/api/items", { token: owner.token })).json()).items
      .find((item) => item.title === "Imported recurring Event");
    assert.ok(imported?.recurrence, "the source recurring Event should be imported");
    const sourceId = "recurring-source-pending-inventory";
    const db = new DatabaseSync(join(directory, "workspace.sqlite"));
    try {
      db.prepare("UPDATE items SET scheduled_date=NULL,scheduled_time=NULL WHERE user_id=? AND id=?").run(owner.user.id, imported.id);
      googleEventPages = { first: { items: [] } };
      const sync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
      assert.equal(sync.status, 200);
      const result = await sync.json();
      assert.equal(googleEvents.has(sourceId), true, "an omitted source must not be deleted while the inventory is incomplete");
      assert.ok(db.prepare("SELECT 1 FROM google_inventory_pending WHERE user_id=? AND item_id=?").get(owner.user.id, imported.id),
        "the incomplete inventory marker should remain durable");
      assert.ok(result.syncLimitations.some((limitation) => limitation.itemId === imported.id && limitation.provider === "google"
        && /original Google Calendar copy is preserved/i.test(limitation.message)),
      "the incomplete verification should be surfaced as a preservation limitation");
    } finally { db.close(); }
  } finally {
    googleEventPages = originalGooglePages;
    googleEvents = originalGoogleEvents;
  }
});

test("a held DELETE authorization result survives a newer Event generation and rejects reconnected credentials", async () => {
  const owner = await account();
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
    cookie: authorization.cookie, redirect: "manual",
  })).status, 303);
  const removedEvent = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Held authorization cleanup", scheduledDate: "2027-02-14",
  } })).json()).item;
  const otherEvent = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Event changed during cleanup", scheduledDate: "2027-02-15",
  } })).json()).item;
  const removedCopy = [...googleEvents.entries()].find(([, value]) => value.extendedProperties?.private?.filetasksItemId === removedEvent.id);
  assert.ok(removedCopy);
  const deletePath = `/google/calendar/v3/calendars/primary/events/${removedCopy[0]}`;
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    let signalDeleteStarted;
    let releaseDelete;
    const deleteStarted = new Promise((resolve) => { signalDeleteStarted = resolve; });
    const deleteRelease = new Promise((resolve) => { releaseDelete = resolve; });
    holdNextGoogleFailure = { path: deletePath, method: "DELETE", status: 401, started: signalDeleteStarted, releasePromise: deleteRelease };
    const firstMutation = request(`/api/items/${removedEvent.id}`, { token: owner.token, method: "PATCH", body: {
      scheduledDate: null, scheduledTime: null,
    } });
    await deleteStarted;

    const generationAtDelete = db.prepare("SELECT generation FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id).generation;
    failGoogleRequests = Array.from({length:10}, () => ({ path: deletePath, method: "DELETE", status: 503 }));
    const newerMutation = request(`/api/items/${otherEvent.id}`, { token: owner.token, method: "PATCH", body: {
      title: "Newer Event generation",
    } });
    await expect.poll(() => db.prepare("SELECT generation FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id).generation)
      .toBeGreaterThan(generationAtDelete);
    releaseDelete();
    assert.equal((await firstMutation).status, 200);
    assert.equal((await newerMutation).status, 200);
    assert.ok(failGoogleRequests.length < 10, "the newer sync generation should retry the failed deletion");
    assert.equal(googleEvents.has(removedCopy[0]), true, "the denied DELETE should retain its provider identity");

    let delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    let status = delivery.find((entry) => entry.provider === "google");
    assert.equal(status?.reauthorizationRequired, true,
      "the authorization result must persist even though Event generation N+1 replaced generation N");
    assert.match(status?.lastError ?? "", /Reauthorize Google Calendar/i);
    assert.equal(status?.state, "failed", "the newer generic retry state should remain intact");

    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    status = delivery.find((entry) => entry.provider === "google");
    assert.equal(status?.reauthorizationRequired, true,
      "a later generic failure must preserve matching authorization evidence");
    assert.equal(googleEvents.has(removedCopy[0]), true);
  } finally {
    holdNextGoogleFailure = null;
    failGoogleRequests = [];
    db.close();
  }

  const reconnectOwner = await account();
  const originalAuthorization = await beginGoogleAuthorization(reconnectOwner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(originalAuthorization.state)}&code=fake-code`, {
    cookie: originalAuthorization.cookie, redirect: "manual",
  })).status, 303);
  const reconnectEvent = (await (await request("/api/items", { token: reconnectOwner.token, method: "POST", body: {
    kind: "event", title: "Stale authorization response", scheduledDate: "2027-02-16",
  } })).json()).item;
  const reconnectCopy = [...googleEvents.entries()].find(([, value]) => value.extendedProperties?.private?.filetasksItemId === reconnectEvent.id);
  assert.ok(reconnectCopy);
  let signalStaleDeleteStarted;
  let releaseStaleDelete;
  const staleDeleteStarted = new Promise((resolve) => { signalStaleDeleteStarted = resolve; });
  const staleDeleteRelease = new Promise((resolve) => { releaseStaleDelete = resolve; });
  holdNextGoogleFailure = {
    path: `/google/calendar/v3/calendars/primary/events/${reconnectCopy[0]}`,
    method: "DELETE", status: 403, started: signalStaleDeleteStarted, releasePromise: staleDeleteRelease,
  };
  const staleMutation = request(`/api/items/${reconnectEvent.id}`, { token: reconnectOwner.token, method: "PATCH", body: {
    scheduledDate: null, scheduledTime: null,
  } });
  await staleDeleteStarted;
  const reconnection = await beginGoogleAuthorization(reconnectOwner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(reconnection.state)}&code=reconnect-code`, {
    cookie: reconnection.cookie, redirect: "manual",
  })).status, 303);
  releaseStaleDelete();
  assert.equal((await staleMutation).status, 200);
  const newCredentialStatus = (await (await request("/api/calendars", { token: reconnectOwner.token })).json()).syncDelivery
    .find((entry) => entry.provider === "google");
  assert.notEqual(newCredentialStatus?.reauthorizationRequired, true,
    "a 403 from the replaced connection must not mark its new credentials as unauthorized");
  assert.equal(googleEvents.has(reconnectCopy[0]), true, "the stale response must not remove the provider copy");
  holdNextGoogleFailure = null;
});

test("an authorization failure while removing an undated Event copy stays visible and retains identity", async () => {
  const originalGoogleCalendarId = googleCalendarId;
  const expectedCalendarId = "authorization-recovery-calendar-id";
  googleCalendarId = expectedCalendarId;
  const googleEventsPath = `/google/calendar/v3/calendars/${googleCalendarId}/events`;
  try {
    const owner = await account();
    const authorization = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    })).status, 303);
    const event = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "Requires calendar reauthorization", scheduledDate: "2027-02-14",
    } })).json()).item;
    const copy = [...googleEvents.entries()].find(([, value]) => value.extendedProperties?.private?.filetasksItemId === event.id);
    assert.ok(copy);
    const db = new DatabaseSync(join(directory, "workspace.sqlite"));
    try {
      assert.equal(db.prepare("SELECT calendar_url FROM calendar_connections WHERE user_id=? AND provider='google'")
        .get(owner.user.id)?.calendar_url, expectedCalendarId,
      "authorization recovery should use the verified concrete Google calendar ID from account discovery");
      const mapping = () => db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='google'")
        .get(owner.user.id, event.id)?.external_id;
      assert.equal(mapping(), copy[0]);
      failNextGoogleRequest = { method: "DELETE", path: `${googleEventsPath}/${copy[0]}`, status: 401 };
      assert.equal((await request(`/api/items/${event.id}`, { token: owner.token, method: "PATCH", body: {
        scheduledDate: null, scheduledTime: null,
      } })).status, 200);
      assert.equal(failNextGoogleRequest, null);
      assert.equal(googleEvents.has(copy[0]), true);
      assert.equal(mapping(), copy[0], "authorization failure must not clear the copy identity");
      const retained = (await (await request(`/api/items/${event.id}`, { token: owner.token })).json()).item;
      assert.ok(retained.calendarSync.some((status) => status.provider === "google"
        && status.limitationCode === "undated-copy-removal-failed"), "the Event should surface an authorization-related cleanup limitation");
      let delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
      const authorizationFailure = delivery.find((status) => status.provider === "google");
      assert.equal(authorizationFailure?.reauthorizationRequired, true, "DELETE 401 must be classified as a reauthorization failure");
      assert.match(authorizationFailure?.lastError ?? "", /Reauthorize Google Calendar/i);
      assert.ok(Number.isFinite(Date.parse(authorizationFailure?.nextAttemptAt ?? "")), "authorization failures must retain scheduled retries");
      await stopServer();
      await startServer();
      delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
      assert.equal(delivery.find((status) => status.provider === "google")?.reauthorizationRequired, true,
        "the authorization classification must persist across an API restart");

      failNextGoogleRequest = { method: "DELETE", path: `${googleEventsPath}/${copy[0]}`, status: 403 };
      const response = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(failNextGoogleRequest, null);
      assert.ok(result.syncLimitations.some((limitation) => limitation.title === "Deleted Event" && limitation.itemId === event.id
        && limitation.provider === "google" && /identity is retained and retries continue automatically/i.test(limitation.message)),
      "a permanent or authorization DELETE failure must remain a visible cleanup limitation");
      assert.equal(googleEvents.has(copy[0]), true);
      assert.equal(mapping(), copy[0]);
      assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
        .some((status) => status.provider === "google" && status.state === "failed"), true);
      assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
        .find((status) => status.provider === "google")?.reauthorizationRequired, true,
      "DELETE 403 must continue to be classified separately from transient failures");
      const reconnection = await beginGoogleAuthorization(owner);
      assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(reconnection.state)}&code=fake-code`, {
        cookie: reconnection.cookie, redirect: "manual",
      })).status, 303);
      assert.equal(mapping(), copy[0], "reauthorizing the same Google destination must preserve the pending copy identity");
      assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
      assert.equal(googleEvents.has(copy[0]), false, "a retry after reauthorization should remove the provider copy");
      assert.equal(mapping(), undefined, "successful retry should clear the retained mapping");
      assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
        .some((status) => status.provider === "google"), false, "successful cleanup should clear the authorization recovery state");
    } finally {
      failNextGoogleRequest = null;
      db.close();
    }
  } finally {
    googleCalendarId = originalGoogleCalendarId;
  }
});

test("a DELETE authorization failure remains classified if a later Google operation fails", async () => {
  const owner = await account();
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
    cookie: authorization.cookie, redirect: "manual",
  })).status, 303);
  const deletedEvent = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Pending deletion authorization", scheduledDate: "2027-02-14",
  } })).json()).item;
  const editedEvent = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Before later update failure", scheduledDate: "2027-02-15",
  } })).json()).item;
  const deletedCopy = [...googleEvents.entries()].find(([, value]) => value.extendedProperties?.private?.filetasksItemId === deletedEvent.id);
  const editedCopy = [...googleEvents.entries()].find(([, value]) => value.extendedProperties?.private?.filetasksItemId === editedEvent.id);
  assert.ok(deletedCopy && editedCopy);
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    db.prepare("UPDATE items SET scheduled_date=NULL,scheduled_time=NULL WHERE user_id=? AND id=?").run(owner.user.id, deletedEvent.id);
    db.prepare("UPDATE items SET title=? WHERE user_id=? AND id=?").run("Changed while offline", owner.user.id, editedEvent.id);
    failGoogleRequests = [
      { method: "DELETE", path: `/google/calendar/v3/calendars/primary/events/${deletedCopy[0]}`, status: 401 },
      { method: "PUT", path: `/google/calendar/v3/calendars/primary/events/${editedCopy[0]}`, status: 503 },
    ];
    const failed = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(failed.status, 502, "the later provider update failure should fail this sync pass");
    assert.equal(failGoogleRequests.length, 0, "both the DELETE authorization and later update failures should be exercised");
    assert.equal(googleEvents.has(deletedCopy[0]), true, "the failed deletion should retain its provider copy");
    let delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    assert.equal(delivery.find((entry) => entry.provider === "google")?.reauthorizationRequired, true,
      "the DELETE authorization result must be persisted before the later failure aborts the pass");

    failGoogleRequests = [
      { method: "DELETE", path: `/google/calendar/v3/calendars/primary/events/${deletedCopy[0]}`, status: 503 },
    ];
    const retry = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(retry.status, 200);
    assert.equal(failGoogleRequests.length, 0);
    delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    assert.equal(delivery.find((entry) => entry.provider === "google")?.reauthorizationRequired, true,
      "a later generic DELETE failure must not erase an unresolved authorization classification");
    failGoogleRequests = [
      { method: "DELETE", path: `/google/calendar/v3/calendars/primary/events/${deletedCopy[0]}`, status: 503 },
    ];
    assert.equal((await request(`/api/items/${editedEvent.id}`, { token: owner.token, method: "PATCH", body: {
      title: "Another Event changed while authorization is unresolved",
    } })).status, 200);
    assert.equal(failGoogleRequests.length, 0);
    delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    assert.equal(delivery.find((entry) => entry.provider === "google")?.reauthorizationRequired, true,
      "enqueueing another Event mutation must preserve unresolved authorization through a generic failure");
  } finally {
    failGoogleRequests = [];
    db.close();
  }
});

test("Apple DELETE authorization failures persist recovery and keep the copy identity through reauthorization", async () => {
  const owner = await account();
  const previousAppleEvents = appleEvents;
  appleEvents = new Map();
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    const calendarUrl = `${deliveryBase}/apple/calendar/`;
    assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
      username: "person@example.com", password: "app-specific-password", calendarUrl,
    } })).status, 201);
    const event = (await (await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "Apple calendar reauthorization", scheduledDate: "2027-02-14",
    } })).json()).item;
    const copy = [...appleEvents.entries()].find(([, value]) => value.includes(`URL:${base}/?event=${event.id}`));
    assert.ok(copy);
    const mapping = () => db.prepare("SELECT external_id,resource_uid,connection_scope_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='apple'")
      .get(owner.user.id, event.id);
    const originalMapping = mapping();
    assert.equal(new URL(originalMapping.external_id, deliveryBase).pathname, new URL(copy[0], deliveryBase).pathname,
      "Apple Calendar copy URLs should be compared by their normalized resource path");
    failNextAppleRequest = { method: "DELETE", path: copy[0], status: 403 };
    assert.equal((await request(`/api/items/${event.id}`, { token: owner.token, method: "PATCH", body: {
      scheduledDate: null, scheduledTime: null,
    } })).status, 200);
    assert.equal(failNextAppleRequest, null);
    assert.deepEqual(mapping(), originalMapping, "Apple authorization failure must retain the complete copy identity");
    assert.equal(appleEvents.has(copy[0]), true);
    let delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    assert.equal(delivery.find((status) => status.provider === "apple")?.reauthorizationRequired, true);
    assert.match(delivery.find((status) => status.provider === "apple")?.lastError ?? "", /Reauthorize Apple Calendar/i);
    await stopServer();
    await startServer();
    delivery = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    assert.equal(delivery.find((status) => status.provider === "apple")?.reauthorizationRequired, true,
      "Apple authorization recovery must remain actionable after restart");

    assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
      username: "person@example.com", password: "renewed-app-specific-password", calendarUrl,
    } })).status, 201);
    assert.deepEqual(mapping(), originalMapping, "reauthorizing the same Apple destination must preserve copy identity and scope");
    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    assert.equal(appleEvents.has(copy[0]), false, "the scheduled retry should delete the copy with refreshed credentials");
    assert.equal(mapping(), undefined);
    assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
      .some((status) => status.provider === "apple"), false);
  } finally {
    failNextAppleRequest = null;
    appleEvents = previousAppleEvents;
    db.close();
  }
});

test("Event mutations survive Calendar delivery failures and retry durably through the worker", async () => {
  const owner = await account();
  const other = await account();
  const priorGoogleEvents = googleEvents;
  const initialClock = new Date(testClock);
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  googleEvents = new Map();
  failNextGoogleRequest = null;
  try {
    const authorization = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    })).status, 303);
    assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
      username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
    } })).status, 201);

    const googleCollection = "/google/calendar/v3/calendars/primary/events";
    failNextGoogleRequest = { method: "POST", path: googleCollection, status: 503 };
    const createdResponse = await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "Locally saved during Google outage", scheduledDate: "2027-02-11",
    } });
    assert.equal(createdResponse.status, 201, "Calendar delivery must not turn a committed Event create into an HTTP failure");
    const created = (await createdResponse.json()).item;
    assert.equal(failNextGoogleRequest, null, "the injected Google create failure must be exercised");
    assert.equal((await (await request(`/api/items/${created.id}`, { token: owner.token })).json()).item.title,
      "Locally saved during Google outage");
    const failedCreateStatus = (await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery;
    const failedCreate = failedCreateStatus.find((entry) => entry.provider === "google");
    assert.equal(failedCreate?.state, "failed", "the account must see durable Google delivery failure status");
    assert.ok(failedCreate.attempts >= 1);
    assert.ok(Number.isFinite(Date.parse(failedCreate.nextAttemptAt)));
    assert.ok(Number.isFinite(Date.parse(failedCreate.lastAttemptAt)));
    assert.match(failedCreate.lastError, /Calendar sync failed/i);
    assert.equal(failedCreate.connected, true);
    assert.deepEqual((await (await request("/api/calendars", { token: other.token })).json()).syncDelivery, [],
      "another account must not see this delivery status");

    await stopServer();
    await startServer();
    assert.equal((await (await request("/api/items", { token: owner.token })).json()).items.some((item) => item.id === created.id), true,
      "the local Event must survive an API restart");
    assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
      .some((entry) => entry.provider === "google" && entry.state === "failed"), true,
    "the retry status must survive an API restart");

    await advanceTestClock(60_000);
    assert.equal((await runReminderWorker()).status, 200, "the existing authenticated worker should process calendar retries");
    const copied = [...googleEvents.values()].find((event) => event.extendedProperties?.private?.filetasksItemId === created.id);
    assert.ok(copied, "the worker should recreate the missing Google Calendar copy");
    assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
      .some((entry) => entry.provider === "google" && entry.state !== "synced"), false,
    "successful retry should clear pending delivery status");

    const copyId = copied.id;
    const appleCopyUrl = db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='apple'")
      .get(owner.user.id, created.id)?.external_id;
    assert.ok(appleCopyUrl, "the successful create should also retain an Apple copy mapping");
    const appleCopyPath = new URL(appleCopyUrl).pathname;
    failNextAppleRequest = { method: "PUT", path: appleCopyPath, status: 503 };
    const updatedResponse = await request(`/api/items/${created.id}`, { token: owner.token, method: "PATCH", body: { title: "Edited while Google is down" } });
    assert.equal(updatedResponse.status, 200, "Calendar delivery must not turn a committed Event update into an HTTP failure");
    assert.equal((await (await request(`/api/items/${created.id}`, { token: owner.token })).json()).item.title, "Edited while Google is down");
    assert.equal(failNextAppleRequest, null, "the injected Apple update failure must be exercised");
    assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
      .some((entry) => entry.provider === "apple" && entry.state === "failed"), true);
    assert.equal(googleEvents.get(copyId).summary, "Locally saved during Google outage",
      "the failed Apple delivery should not mutate an untouched Google copy");
    assert.match(appleEvents.get(appleCopyPath), /SUMMARY:Locally saved during Google outage/,
      "the failed Apple write must not change remote details");

    await advanceTestClock(60_000);
    assert.equal((await runReminderWorker()).status, 200);
    assert.equal(googleEvents.get(copyId).summary, "Edited while Google is down");
    assert.match(appleEvents.get(appleCopyPath), /SUMMARY:Edited while Google is down/);
    assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
      .some((entry) => entry.provider === "apple"), false, "the worker should clear failed Apple delivery status");

    failNextGoogleRequest = { method: "DELETE", path: `${googleCollection}/${copyId}`, status: 503 };
    const deletedResponse = await request(`/api/items/${created.id}`, { token: owner.token, method: "DELETE" });
    assert.equal(deletedResponse.status, 204, "Calendar delivery must not turn a committed Event deletion into an HTTP failure");
    assert.equal(failNextGoogleRequest, null, "the injected Google delete failure must be exercised");
    assert.equal((await request(`/api/items/${created.id}`, { token: owner.token })).status, 404,
      "the Event must be deleted locally even while its Calendar copy remains");
    assert.equal(googleEvents.has(copyId), true, "failed remote deletion must retain the provider copy for retry");
    assert.equal(db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='google'")
      .get(owner.user.id, created.id)?.external_id, copyId, "failed remote deletion must retain the mapping for retry");
    assert.equal((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery
      .some((entry) => entry.provider === "google" && entry.state === "failed"), true,
    "the failed deletion must remain visible after the Event row is gone");

    await stopServer();
    await startServer();
    await advanceTestClock(60_000);
    assert.equal((await runReminderWorker()).status, 200, "the worker should retry the deletion after restart");
    assert.equal(googleEvents.has(copyId), false, "the worker should remove the retained Google copy");
    assert.equal(db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='google'")
      .get(owner.user.id, created.id), undefined, "successful retry should remove the stale mapping");
    assert.deepEqual((await (await request("/api/calendars", { token: owner.token })).json()).syncDelivery, [],
      "successful deletion retry should clear delivery status");
  } finally {
    failNextGoogleRequest = null;
    failNextAppleRequest = null;
    googleEvents = priorGoogleEvents;
    await setTestClock(initialClock);
    db.close();
  }
});

test("Google reconnect collision preserves old mapping and unrelated events", async () => {
  const owner = await account();
  const connect = async () => {
    const auth = await beginGoogleAuthorization(owner);
    return request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, { cookie: auth.cookie, redirect: "manual" });
  };
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    googleCalendarId = "identity-a";
    assert.equal((await connect()).status, 303);
    const created = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "event", title: "Original connection event", scheduledDate: "2027-01-14" } });
    assert.equal(created.status, 201);
    const event = (await created.json()).item;
    const [id, copy] = [...googleEvents.entries()][0];
    const mappingBefore = db.prepare("SELECT * FROM calendar_copies WHERE user_id=? AND item_id=?").all(owner.user.id, event.id);
    const scopeBefore = db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='google'").get(owner.user.id).connection_scope_id;
    assert.equal(mappingBefore.length, 1);
    const unrelated = { ...copy, summary: "Unrelated B event", description: "Unrelated event" };
    googleEvents = new Map([[id, structuredClone(unrelated)]]);
    googleCalendarId = "identity-b";
    assert.equal((await connect()).status, 303);
    const scopeAfter = db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='google'").get(owner.user.id).connection_scope_id;
    assert.notEqual(scopeAfter, scopeBefore, "a different resolved Google calendar must rotate the scope");
    const sync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.deepEqual(googleEvents.get(id), unrelated);
    const edited = await request(`/api/items/${event.id}`, { token: owner.token, method: "PATCH", body: { title: "Edited original", scope: "series" } });
    assert.deepEqual(googleEvents.get(id), unrelated);
    const deleted = await request(`/api/items/${event.id}`, { token: owner.token, method: "DELETE" });
    assert.deepEqual(googleEvents.get(id), unrelated);
    const newEvent = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "event", title: "New connection event", scheduledDate: "2027-01-15" } });
    assert.equal(sync.status, 200);
    assert.equal(edited.status, 200);
    assert.equal(deleted.status, 204);
    assert.equal(newEvent.status, 201);
    assert.deepEqual(db.prepare("SELECT * FROM calendar_copies WHERE user_id=? AND item_id=?").all(owner.user.id, event.id), mappingBefore);
    assert.ok([...googleEvents.values()].some((value) => value.summary === "New connection event"));
  } finally {
    db.close();
    googleCalendarId = "primary";
    googleEvents.clear();
  }
});

test("Google reconnect to the same concrete calendar preserves copy timing and mapping", async () => {
  const owner = await account();
  const connect = async (code) => {
    const auth = await beginGoogleAuthorization(owner);
    return request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=${code}`, { cookie: auth.cookie, redirect: "manual" });
  };
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    googleCalendarId = "same-calendar-id";
    const source = { id: "same-calendar-source", summary: "Same calendar timing", start: { dateTime: "2027-03-28T01:30:00+00:00", timeZone: "Europe/London" }, end: { dateTime: "2027-03-28T03:00:00+01:00", timeZone: "Europe/London" } };
    googleEvents.set(source.id, structuredClone(source));
    assert.equal((await connect("fake-code")).status, 303);
    const initialSync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    const initialSyncBody = await initialSync.text();
    assert.equal(initialSync.status, 200, `${initialSyncBody}\n${logs.slice(-6000)}`);
    const item = (await (await request("/api/items", { token: owner.token })).json()).items.find((entry) => entry.title === source.summary);
    assert.ok(item);
    const before = db.prepare(`SELECT c.external_id,c.connection_scope_id,m.timing_json,conn.credential_generation_id,conn.access_token,conn.refresh_token
      FROM calendar_copies c JOIN calendar_import_metadata m ON m.user_id=c.user_id AND m.item_id=c.item_id
      JOIN calendar_connections conn ON conn.user_id=c.user_id AND conn.provider=c.provider
      WHERE c.user_id=? AND c.item_id=? AND c.provider='google'`).get(owner.user.id,item.id);
    assert.ok(before);
    assert.equal(before.external_id, source.id);
    assert.equal((await connect("reconnect-code")).status, 303);
    const after = db.prepare(`SELECT c.external_id,c.connection_scope_id,m.timing_json,conn.credential_generation_id,conn.access_token,conn.refresh_token
      FROM calendar_copies c JOIN calendar_import_metadata m ON m.user_id=c.user_id AND m.item_id=c.item_id
      JOIN calendar_connections conn ON conn.user_id=c.user_id AND conn.provider=c.provider
      WHERE c.user_id=? AND c.item_id=? AND c.provider='google'`).get(owner.user.id,item.id);
    assert.equal(after.external_id, before.external_id);
    assert.equal(after.connection_scope_id, before.connection_scope_id);
    assert.equal(after.timing_json, before.timing_json);
    assert.notEqual(after.credential_generation_id, before.credential_generation_id);
    assert.notEqual(after.access_token, before.access_token);
    assert.notEqual(after.refresh_token, before.refresh_token);
    db.prepare("UPDATE calendar_connections SET expires_at=0 WHERE user_id=? AND provider='google'").run(owner.user.id);
    const refreshResponse = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(refreshResponse.status, 200, await refreshResponse.text());
    const afterRefresh = db.prepare("SELECT credential_generation_id,access_token FROM calendar_connections WHERE user_id=? AND provider='google'").get(owner.user.id);
    assert.equal(afterRefresh.credential_generation_id, after.credential_generation_id, "token refresh preserves the credential generation");
    assert.notEqual(afterRefresh.access_token, after.access_token, "token refresh replaces the cached access token");
  } finally {
    db.close();
    googleCalendarId = "primary";
    googleEvents.clear();
  }
});

test("Google sync started before same-calendar reconnect cannot commit", async () => {
  const owner = await account();
  const connect = async (code) => {
    const auth = await beginGoogleAuthorization(owner);
    return request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=${code}`, { cookie: auth.cookie, redirect: "manual" });
  };
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  let release;
  let arrive;
  const ready = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { arrive = resolve; });
  try {
    googleCalendarId = "race-calendar-id";
    const created = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "event", title: "Wait for sync", scheduledDate: "2027-04-14" } });
    assert.equal(created.status, 201);
    const item = (await created.json()).item;
    assert.equal((await connect("fake-code")).status, 303);
    googleInventoryBarrier = { arrivals: 0, ready, release, arrived: arrive };
    const inFlight = request("/api/calendars/sync", { token: owner.token, method: "POST" });
    await arrived;
    assert.equal((await connect("reconnect-code")).status, 303);
    release();
    const response = await inFlight;
    assert.equal(response.status, 409);
    assert.equal(db.prepare("SELECT 1 FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=?").get(owner.user.id,item.id), undefined);
    assert.equal(googleEvents.size, 0, "the stale run must stop before creating a provider copy");
  } finally {
    release?.();
    googleInventoryBarrier = null;
    db.close();
    googleCalendarId = "primary";
    googleEvents.clear();
  }
});

test("Apple Calendar reconnect keeps Calendar copy identity scoped to its connection", async () => {
  const owner = await account();
  const connect = (name) => request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: `${name}@example.com`, password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/${name}/`,
  } });
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    assert.equal((await connect("identity-a")).status, 201);
    const created = await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "Original connection event", scheduledDate: "2027-01-14",
    } });
    assert.equal(created.status, 201);
    const event = (await created.json()).item;
    const pathA = [...appleEvents.keys()].find((path) => path.startsWith("/apple/identity-a/"));
    assert.ok(pathA);
    const pathB = pathA.replace("/identity-a/", "/identity-b/");
    const unrelated = appleEvents.get(pathA).replace("SUMMARY:Original connection event", "SUMMARY:Unrelated B event").replace(/^URL:.*\r?\n/m, "");
    appleEvents.set(pathB, unrelated);
    const mappingBefore = db.prepare("SELECT * FROM calendar_copies WHERE user_id=? AND item_id=?").all(owner.user.id, event.id);
    const connectionBefore = db.prepare("SELECT connection_scope_id,credential_generation_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id);
    assert.equal(mappingBefore.length, 1);
    assert.equal((await connect("identity-b")).status, 201);
    const connectionAfter = db.prepare("SELECT connection_scope_id,credential_generation_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id);
    assert.notEqual(connectionAfter.connection_scope_id, connectionBefore.connection_scope_id);
    assert.notEqual(connectionAfter.credential_generation_id, connectionBefore.credential_generation_id);
    const sync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    const afterSync = appleEvents.get(pathB);
    const edited = await request(`/api/items/${event.id}`, { token: owner.token, method: "PATCH", body: { title: "Edited original", scope: "series" } });
    const afterEdit = appleEvents.get(pathB);
    const deleted = await request(`/api/items/${event.id}`, { token: owner.token, method: "DELETE" });
    const afterDelete = appleEvents.get(pathB);
    const newEvent = await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: "New connection event", scheduledDate: "2027-01-15",
    } });
    const mappingAfter = db.prepare("SELECT * FROM calendar_copies WHERE user_id=? AND item_id=?").all(owner.user.id, event.id);
    assert.equal(sync.status, 200);
    assert.equal(edited.status, 200);
    assert.equal(deleted.status, 204);
    assert.equal(newEvent.status, 201);
    assert.equal(afterSync, unrelated, "sync must preserve the unrelated B event");
    assert.equal(afterEdit, unrelated, "editing the old Event must preserve the unrelated B event");
    assert.equal(afterDelete, unrelated, "deleting the old Event must preserve the unrelated B event");
    assert.deepEqual(mappingAfter, mappingBefore, "the old connection mapping must survive");
    assert.ok([...appleEvents.entries()].some(([path, value]) => path.startsWith("/apple/identity-b/") && value.includes("SUMMARY:New connection event")));
  } finally {
    db.close();
    for (const path of appleEvents.keys()) if (path.startsWith("/apple/identity-a/") || path.startsWith("/apple/identity-b/")) appleEvents.delete(path);
  }
});

test("Apple retry work is rebound to a new collection and cannot claim the prior scope", async () => {
  const owner=await account();
  const connect=(name)=>request("/api/calendars",{token:owner.token,method:"POST",body:{
    username:`${name}@example.com`,password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/${name}/`,
  }});
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  try {
    assert.equal((await connect("retry-a")).status,201);
    const created=await request("/api/items",{token:owner.token,method:"POST",body:{
      kind:"event",title:"Retry only on active collection",scheduledDate:"2027-04-14",
    }});
    assert.equal(created.status,201);
    const event=(await created.json()).item;
    const pathA=[...appleEvents.keys()].find((path)=>path.startsWith("/apple/retry-a/"));
    assert.ok(pathA);
    const originalA=appleEvents.get(pathA);
    const oldState=db.prepare("SELECT generation,connection_scope_id FROM calendar_sync_state WHERE user_id=? AND provider='apple'")
      .get(owner.user.id);
    assert.ok(oldState);
    db.prepare("UPDATE calendar_sync_state SET state='failed',attempts=1,next_attempt_at=0 WHERE user_id=? AND provider='apple'")
      .run(owner.user.id);
    const staleSnapshot={generation:oldState.generation,connectionScopeId:oldState.connection_scope_id,nextAttemptAt:0};

    const unrelatedPath=pathA.replace("/retry-a/","/retry-b/");
    const unrelated="BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:unrelated-retry-b\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;VALUE=DATE:20270415\r\nDTEND;VALUE=DATE:20270416\r\nSUMMARY:Unrelated collection B event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    appleEvents.set(unrelatedPath,unrelated);
    assert.equal((await connect("retry-b")).status,201);
    const newConnection=db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id);
    const rebound=db.prepare("SELECT generation,connection_scope_id,state FROM calendar_sync_state WHERE user_id=? AND provider='apple'").get(owner.user.id);
    assert.notEqual(newConnection.connection_scope_id,oldState.connection_scope_id);
    assert.ok(rebound.generation>staleSnapshot.generation);
    assert.equal(rebound.connection_scope_id,newConnection.connection_scope_id);
    assert.equal(rebound.state,"pending");
    const staleClaim=db.prepare(`UPDATE calendar_sync_state SET generation=generation+1,state='pending'
      WHERE user_id=? AND provider='apple' AND generation=? AND connection_scope_id IS ? AND next_attempt_at=?
        AND EXISTS(SELECT 1 FROM calendar_connections c WHERE c.user_id=calendar_sync_state.user_id AND c.provider=calendar_sync_state.provider AND c.connection_scope_id IS calendar_sync_state.connection_scope_id)`)
      .run(owner.user.id,staleSnapshot.generation,staleSnapshot.connectionScopeId,staleSnapshot.nextAttemptAt);
    assert.equal(staleClaim.changes,0,"a previously captured retry cannot claim after the destination changes");

    providerRequests=[];
    const worker=await runReminderWorker();
    assert.equal(worker.status,200);
    assert.ok(providerRequests.some(({path})=>path.startsWith("/apple/retry-b/")),"fresh work should use the selected collection");
    assert.equal(providerRequests.some(({path})=>path.startsWith("/apple/retry-a/")),false,"the retry must not use the previous collection");
    assert.equal(appleEvents.get(pathA),originalA,"the previous copy remains untouched");
    assert.equal(appleEvents.get(unrelatedPath),unrelated,"unrelated Events in the selected collection remain untouched");
    assert.equal(event.title,"Retry only on active collection");
  } finally {
    db.close();
    for(const path of appleEvents.keys()) if(path.startsWith("/apple/retry-a/")||path.startsWith("/apple/retry-b/")) appleEvents.delete(path);
  }
});

test("a claimed Calendar retry stops when its destination changes before execution", async () => {
  const accounts=[await account(),await account()].sort((left,right)=>left.user.id.localeCompare(right.user.id));
  const [blocker,target]=accounts;
  const connect=(owner,path)=>request("/api/calendars",{token:owner.token,method:"POST",body:{
    username:`${owner.user.id}@example.com`,password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/${path}/`,
  }});
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  let release; let arrived;
  const ready=new Promise(resolve=>{release=resolve;});
  const firstRequest=new Promise(resolve=>{arrived=resolve;});
  let worker;
  try {
    assert.equal((await connect(blocker,"claimed-blocker")).status,201);
    assert.equal((await connect(target,"claimed-a")).status,201);
    for (const owner of [blocker,target]) {
      const created=await request("/api/items",{token:owner.token,method:"POST",body:{
        kind:"event",title:"Claimed work",scheduledDate:"2027-04-14",
      }});
      assert.equal(created.status,201);
      db.prepare("UPDATE calendar_sync_state SET state='failed',next_attempt_at=0 WHERE user_id=? AND provider='apple'")
        .run(owner.user.id);
    }
    const targetCopy=[...appleEvents.keys()].find(path=>path.startsWith("/apple/claimed-a/"));
    assert.ok(targetCopy);
    const targetSnapshot=appleEvents.get(targetCopy);
    const unrelatedProviderPath=targetCopy.replace("/claimed-a/","/claimed-b/");
    const unrelated="BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:unrelated-claimed-b\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;VALUE=DATE:20270415\r\nDTEND;VALUE=DATE:20270416\r\nSUMMARY:Unrelated collection B event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    appleEvents.set(unrelatedProviderPath,unrelated);
    db.prepare("UPDATE calendar_sync_state SET next_attempt_at=? WHERE state IN ('pending','failed') AND user_id NOT IN (?,?)")
      .run(Number.MAX_SAFE_INTEGER,blocker.user.id,target.user.id);
    db.prepare("UPDATE calendar_creation_cleanup SET next_attempt_at=? WHERE user_id NOT IN (?,?)")
      .run(Number.MAX_SAFE_INTEGER,blocker.user.id,target.user.id);
    appleInventoryBarrier={arrivals:0,ready,release,arrived};
    const requestsBeforeWorker=providerRequests.length;
    worker=runReminderWorker();
    await firstRequest;
    const reconnect=await connect(target,"claimed-b");
    assert.equal(reconnect.status,201);
    const requestsBeforeWorkerResumes=providerRequests.length;
    release();
    assert.equal((await worker).status,200);
    assert.equal(providerRequests.slice(requestsBeforeWorkerResumes).some(({path})=>path.startsWith("/apple/claimed-a/")||path.startsWith("/apple/claimed-b/")),false,
      "the old claimed generation cannot send requests to either collection after the switch");
    assert.equal(appleEvents.get(targetCopy),targetSnapshot,"the former collection remains unchanged");
    assert.equal(appleEvents.get(unrelatedProviderPath),unrelated,"the replacement collection's unrelated resource remains unchanged");
    const current=db.prepare("SELECT connection_scope_id,state FROM calendar_sync_state WHERE user_id=? AND provider='apple'").get(target.user.id);
    const active=db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(target.user.id);
    assert.equal(current.connection_scope_id,active.connection_scope_id);
    assert.equal(current.state,"pending","the new connection's replacement work remains due");
  } finally {
    release?.();
    appleInventoryBarrier=null;
    if(worker) await worker.catch(()=>{});
    db.close();
    for(const path of appleEvents.keys()) if(path.startsWith("/apple/claimed-blocker/")||path.startsWith("/apple/claimed-a/")||path.startsWith("/apple/claimed-b/")) appleEvents.delete(path);
  }
});

test("Apple scope follows both the account and collection", async () => {
  const owner=await account();
  const connect=(username)=>request("/api/calendars",{token:owner.token,method:"POST",body:{
    username,password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/shared-collection/`,
  }});
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  try {
    assert.equal((await connect("same-account@example.com")).status,201);
    const original=db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id).connection_scope_id;
    assert.equal((await connect(" SAME-ACCOUNT@example.com ")).status,201);
    const sameAccount=db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id).connection_scope_id;
    assert.equal(sameAccount,original,"same account and collection keep their copy identity");
    assert.equal((await connect("another-account@example.com")).status,201);
    const otherAccount=db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id).connection_scope_id;
    assert.notEqual(otherAccount,sameAccount,"a different Apple ID on the same URL gets a new connection scope");
  } finally { db.close(); }
});

test("a legacy Calendar retry stays visible while scoped cleanup resumes after migration", async () => {
  const migrationPath=join(directory,"calendar-sync-migration.sqlite");
  const collectionPath="/apple/migration-legacy/";
  let replica;
  let migrationDb;
  const replicaRequest=async(path,{method="GET",token,body,headers:providedHeaders={}}={})=>{
    const headers=new Headers(providedHeaders);
    headers.set("Connection","close");
    headers.set("Origin",base);
    if(token) headers.set("Authorization",`Bearer ${token}`);
    if(body!==undefined) headers.set("Content-Type","application/json");
    return fetch(`http://localhost:3117${path}`,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  };
  try {
    replica=await startCalendarApiReplica(3117,{FILETASKS_DATABASE_PATH:migrationPath});
    const registration=await replicaRequest("/api/auth/register",{method:"POST",body:{
      email:`migration-${crypto.randomUUID()}@example.com`,password:"correct-horse-battery",
    }});
    assert.equal(registration.status,201);
    const owner=await registration.json();
    assert.equal((await replicaRequest("/api/calendars",{token:owner.token,method:"POST",body:{
      username:"migration@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}${collectionPath}`,
    }})).status,201);
    migrationDb=new DatabaseSync(migrationPath);
    const connection=migrationDb.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id);
    migrationDb.prepare(`INSERT INTO calendar_creation_cleanup(user_id,provider,connection_scope_id,item_id,external_id,uncertain,pending_attempts,next_attempt_at)
      VALUES(?,'apple',?,'deleted-before-upgrade','missing-before-upgrade',0,0,0)`).run(owner.user.id,connection.connection_scope_id);
    migrationDb.prepare(`UPDATE calendar_sync_state SET state='failed',attempts=2,next_attempt_at=0,last_error='Unresolved delivery before upgrade'
      WHERE user_id=? AND provider='apple'`).run(owner.user.id);
    await stopCalendarApiReplica(replica);
    replica=null;
    migrationDb.exec("ALTER TABLE calendar_sync_state DROP COLUMN connection_scope_id");
    migrationDb.close();
    migrationDb=null;
    replica=await startCalendarApiReplica(3117,{FILETASKS_DATABASE_PATH:migrationPath});

    const migrated=(await (await replicaRequest("/api/calendars",{token:owner.token})).json()).syncDelivery.find((entry)=>entry.provider==="apple");
    assert.equal(migrated?.state,"failed","the migration must keep unresolved delivery visible");
    assert.match(migrated?.lastError??"",/Unresolved delivery before upgrade/);
    const migratedDb=new DatabaseSync(migrationPath);
    try {
      const state=migratedDb.prepare("SELECT connection_scope_id,state FROM calendar_sync_state WHERE user_id=? AND provider='apple'").get(owner.user.id);
      assert.equal(state.connection_scope_id,null,"an unknown prior retry scope must not be assigned to the active credentials");
      assert.equal(state.state,"failed");
    } finally { migratedDb.close(); }

    assert.equal((await replicaRequest("/api/internal/reminders/deliver",{method:"POST",headers:{Authorization:"Bearer test-worker-secret"}})).status,200);
    const finalDb=new DatabaseSync(migrationPath);
    try {
      assert.equal(finalDb.prepare("SELECT 1 FROM calendar_creation_cleanup WHERE user_id=? AND item_id='deleted-before-upgrade'").get(owner.user.id),undefined,
        "the cleanup tombstone's own scope allows safe retry after migration");
      const state=finalDb.prepare("SELECT state,connection_scope_id FROM calendar_sync_state WHERE user_id=? AND provider='apple'").get(owner.user.id);
      assert.equal(state.state,"synced");
      assert.ok(state.connection_scope_id);
    } finally { finalDb.close(); }
  } finally {
    try { migrationDb?.close(); } catch {}
    if(replica) await stopCalendarApiReplica(replica);
    appleEvents.delete(`${collectionPath}missing-before-upgrade.ics`);
  }
});

test("imported provider timing survives sync, edits, and unsupported representations", async () => {
  const priorGoogleEvents=googleEvents;
  googleEvents=new Map();
  const owner = await account();
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, { cookie: authorization.cookie, redirect: "manual" })).status, 303);
  const samples = [
    { id:"timed-short",summary:"Short",start:{dateTime:"2027-03-14T01:55:00-05:00",timeZone:"America/New_York"},end:{dateTime:"2027-03-14T03:05:00-04:00",timeZone:"America/New_York"},location:"Room A" },
    { id:"timed-long",summary:"Long",start:{dateTime:"2027-01-14T22:00:00+05:30"},end:{dateTime:"2027-01-16T02:00:00+05:30"} },
    { id:"all-days",summary:"Days",start:{date:"2027-01-14"},end:{date:"2027-01-18"} },
    { id:"unsupported",summary:"Unsupported",start:{dateTime:"2027-01-14T12:00:00"},end:{dateTime:"2027-01-14T13:00:00"} },
  ];
  try {
    for (const sample of samples) googleEvents.set(sample.id, structuredClone(sample));
    const sync = await request("/api/calendars/sync", { token:owner.token,method:"POST" });
    assert.equal(sync.status,200);
    assert.ok((await sync.json()).syncLimitations.some((entry) => entry.title === "Unsupported"));
    for (const sample of samples) {
      assert.deepEqual(googleEvents.get(sample.id).start,sample.start);
      assert.deepEqual(googleEvents.get(sample.id).end,sample.end);
    }
    assert.equal(googleEvents.get("timed-short").location,"Room A");
    const items = (await (await request("/api/items",{token:owner.token})).json()).items;
    const short = items.find((item) => item.title === "Short");
    assert.equal(short.scheduledTime,"01:55");
    assert.equal(short.calendarSync[0].scheduleEdited,false);
    assert.equal((await request(`/api/items/${short.id}`,{token:owner.token,method:"PATCH",body:{scheduledDate:"2027-03-15",scheduledTime:"09:00"}})).status,200);
    assert.equal(googleEvents.get("timed-short").start.dateTime,"2027-03-15T09:00:00-04:00");
    assert.equal(googleEvents.get("timed-short").end.dateTime,"2027-03-15T09:10:00-04:00");
    assert.equal((await (await request(`/api/items/${short.id}`,{token:owner.token})).json()).item.calendarSync[0].scheduleEdited,true);
    assert.equal((await request(`/api/items/${short.id}`,{token:owner.token,method:"PATCH",body:{scheduledDate:null,scheduledTime:null}})).status,200);
    assert.equal(googleEvents.has("timed-short"),false,"clearing the imported Event date removes its obsolete Google copy");
  } finally { googleEvents=priorGoogleEvents; }

  const priorAppleEvents=appleEvents;
  appleEvents=new Map();
  const appleOwner = await account();
  assert.equal((await request("/api/calendars",{token:appleOwner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}})).status,201);
  const fixtures = [
    ["short", "DTSTART;TZID=America/New_York:20270314T015500\r\nDTEND;TZID=America/New_York:20270314T030500"],
    ["long", "DTSTART:20270114T220000Z\r\nDTEND:20270116T020000Z"],
    ["days", "DTSTART;VALUE=DATE:20270114\r\nDTEND;VALUE=DATE:20270118"],
    ["floating", "DTSTART:20270114T120000\r\nDTEND:20270114T130000"],
  ];
  try {
    for (const [name,timing] of fixtures) appleEvents.set(`/apple/calendar/${name}.ics`, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:${name}\r\nDTSTAMP:20261013T120000Z\r\n${timing}\r\nSUMMARY:${name}\r\nLOCATION:Room B\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
    const originals = new Map(appleEvents);
    const sync = await request("/api/calendars/sync",{token:appleOwner.token,method:"POST"});
    assert.equal(sync.status,200);
    assert.ok((await sync.json()).syncLimitations.some((entry) => entry.title === "floating"));
    for (const [name,timing] of fixtures) {
      const value = appleEvents.get(`/apple/calendar/${name}.ics`);
      assert.ok(value.includes(timing));
      assert.ok(value.includes("LOCATION:Room B"));
    }
    assert.equal(appleEvents.get("/apple/calendar/floating.ics"),originals.get("/apple/calendar/floating.ics"));
    const items = (await (await request("/api/items",{token:appleOwner.token})).json()).items;
    const short = items.find((item) => item.title === "short");
    assert.equal((await request(`/api/items/${short.id}`,{token:appleOwner.token,method:"PATCH",body:{scheduledDate:"2027-03-15",scheduledTime:"09:00"}})).status,200);
    assert.ok(appleEvents.get("/apple/calendar/short.ics").includes("DTEND;TZID=America/New_York:20270315T091000"));
    assert.equal((await request("/api/calendars/sync",{token:appleOwner.token,method:"POST"})).status,200);
    assert.equal(appleEvents.size,4);
  } finally { appleEvents=priorAppleEvents; }
});

test("calendar import identity failures roll back Events and recurrence series at the public sync boundary", async () => {
  const owner = await account();
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
    cookie: authorization.cookie, redirect: "manual",
  })).status, 303);
  assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } })).status, 201);

  const googleId = "external-google-series";
  googleEvents.set(googleId, { id: googleId, summary: "Google import transaction", start: { date: "2027-01-14" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=3"] });
  const applePath = "/apple/calendar/external-apple-series.ics";

  const directDatabase = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    for (const provider of ["google", "apple"]) {
      if (provider === "apple") {
        const appleResource = await fetch(`${deliveryBase}${applePath}`, {
          method: "PUT", headers: { "Content-Type": "text/calendar; charset=utf-8" },
          body: appleCalendarFixture({ uid: "external-apple-series", recurrence: "RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=3" }),
        });
        assert.equal(appleResource.status, 201);
      }
      directDatabase.exec(`CREATE TRIGGER fail_calendar_copy_identity BEFORE INSERT ON calendar_copies
        WHEN NEW.provider='${provider}' BEGIN SELECT RAISE(ABORT, 'injected calendar identity failure'); END`);
      const failedSync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
      assert.equal(failedSync.status, 500, `${provider} identity write should fail through the sync API: ${await failedSync.clone().text()}`);
      const itemsAfterFailure = await request("/api/items", { token: owner.token });
      assert.equal(itemsAfterFailure.status, 200);
      assert.deepEqual((await itemsAfterFailure.json()).items, [], `${provider} failure must roll back the imported Event and its Occurrences`);
      const importCount = directDatabase.prepare("SELECT COUNT(*) AS count FROM calendar_imports WHERE user_id=? AND provider=?").get(owner.user.id,provider).count;
      const copyCount = directDatabase.prepare("SELECT COUNT(*) AS count FROM calendar_copies WHERE user_id=? AND provider=?").get(owner.user.id,provider).count;
      assert.equal(importCount, 0, `${provider} import identity should roll back`);
      assert.equal(copyCount, 0, `${provider} Calendar copy identity should roll back`);
      directDatabase.exec("DROP TRIGGER fail_calendar_copy_identity");
      if (provider === "google") googleEvents.clear();
    }

    const recovered = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(recovered.status, 200);
    const recoveredItems = (await (await request("/api/items", { token: owner.token })).json()).items;
    assert.equal(recoveredItems.length, 3);
    assert.equal(new Set(recoveredItems.map(({ seriesId }) => seriesId)).size, 1);
    assert.equal(appleEvents.size, 1);
    const repeated = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(repeated.status, 200);
    assert.equal((await (await request("/api/items", { token: owner.token })).json()).items.length, 3);
    assert.equal(appleEvents.size, 1);
  } finally {
    directDatabase.exec("DROP TRIGGER IF EXISTS fail_calendar_copy_identity");
    directDatabase.close();
    googleEvents.clear();
    appleEvents.delete(applePath);
  }
});

test("scoped recurring Event deletion syncs Google and Apple recurrence exclusions", async () => {
  const owner = await account();
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
    cookie: authorization.cookie, redirect: "manual",
  })).status, 303);
  assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } })).status, 201);

  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Recurring provider review", scheduledDate: "2027-01-14", scheduledTime: "14:30",
    recurrence: { interval: 1, unit: "weeks", weekdays: [4], end: { type: "date", date: "2027-01-31" } },
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  const occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter((item) => item.seriesId === root.id).sort((left, right) => left.scheduledDate.localeCompare(right.scheduledDate));
  assert.equal(occurrences.length, 3);
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  const googleId = [...googleEvents.keys()][0];
  const applePath = [...appleEvents.keys()][0];
  assert.ok(googleEvents.get(googleId).recurrence.some((line) => line.includes("UNTIL=20270131T235959Z")));
  assert.ok(appleEvents.get(applePath).includes("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TH;UNTIL=20270131T235959\r\n"));

  assert.equal((await request(`/api/items/${occurrences[1].id}?scope=occurrence`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(googleEvents.has(googleId), true);
  assert.equal(googleEvents.get(googleId).recurrence.includes(`EXDATE;TZID=UTC:${occurrences[1].scheduledDate.replaceAll("-", "")}T143000`), true);
  assert.equal(appleEvents.get(applePath).includes(`EXDATE:${occurrences[1].scheduledDate.replaceAll("-", "")}T143000`), true);

  assert.equal((await request(`/api/items/${root.id}?scope=occurrence`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(googleEvents.has(googleId), true);
  assert.equal(googleEvents.get(googleId).recurrence.includes(`EXDATE;TZID=UTC:${root.scheduledDate.replaceAll("-", "")}T143000`), true);
  assert.equal(appleEvents.get(applePath).includes(`EXDATE:${root.scheduledDate.replaceAll("-", "")}T143000`), true);

  assert.equal((await request(`/api/items/${occurrences[2].id}?scope=series`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(googleEvents.size, 0);
  assert.equal(appleEvents.size, 0);
});

test("Apple Calendar keeps all-day recurrence exceptions in one valid Calendar resource", async () => {
  const owner = await account();
  assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } })).status, 201);
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "All-day recurring event", scheduledDate: "2027-01-14",
    recurrence: { interval: 1, unit: "weeks", weekdays: [4], end: { type: "date", date: "2027-02-01" } },
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  const occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter((item) => item.seriesId === root.id).sort((left, right) => left.occurrenceDate.localeCompare(right.occurrenceDate));
  assert.equal(occurrences.length, 3);
  const selected = occurrences[1];
  const movedDate = "2027-01-23";
  const moved = await request(`/api/items/${selected.id}`, { token: owner.token, method: "PATCH", body: {
    scheduledDate: movedDate, title: "Moved all-day event", scope: "occurrence",
  } });
  assert.equal(moved.status, 200);
  const calendarData = [...appleEvents.values()][0];
  const components = calendarData.split("BEGIN:VEVENT\r\n").slice(1)
    .map((component) => component.slice(0, component.indexOf("END:VEVENT")));
  assert.equal(components.length, 2, calendarData);
  const uids = components.map((component) => component.match(/^UID:(.+)$/m)?.[1]);
  assert.equal(new Set(uids).size, 1);
  for (const component of components) assert.match(component, /^DTSTAMP:\d{8}T\d{6}Z$/m);
  const exception = components.find((component) => component.includes("RECURRENCE-ID;VALUE=DATE:"));
  assert.ok(exception);
  assert.ok(exception.includes(`RECURRENCE-ID;VALUE=DATE:${selected.occurrenceDate.replaceAll("-", "")}`));
  assert.ok(exception.includes(`DTSTART;VALUE=DATE:${movedDate.replaceAll("-", "")}`));
  assert.ok(exception.includes(`URL:${base}/?event=${root.id}`));
  assert.ok(calendarData.includes("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TH;UNTIL=20270201"));
  assert.equal(appleEvents.size, 1);

  const repeated = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
  assert.equal(repeated.status, 200);
  assert.equal((await (await request("/api/items", { token: owner.token })).json()).items.length, 3);
  assert.equal(appleEvents.size, 1);
  assert.equal((await request(`/api/items/${root.id}?scope=series`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal(appleEvents.size, 0);
});

test("Apple Calendar blocks recurrence changes that differ from the mapped FileTasks Event", async () => {
  const owner = await account();
  assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } })).status, 201);
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Mapped recurrence safeguard", scheduledDate: "2027-01-14",
    recurrence: { interval: 1, unit: "weeks", weekdays: [4], end: { type: "date", date: "2027-02-01" } },
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  const [path, original] = [...appleEvents.entries()][0];
  const external = original.replace("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TH;UNTIL=20270201", "RRULE:FREQ=DAILY;INTERVAL=2");
  assert.notEqual(external, original);
  try {
    appleEvents.set(path, external);
    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    assert.equal(appleEvents.get(path), external, "an externally changed recurrence must be preserved");
    const calendar = await (await request("/api/calendars", { token: owner.token })).json();
    assert.ok(calendar.syncLimitations.some((entry) => entry.itemId === root.id && entry.provider === "apple"),
      "a differing recurrence must remain visibly limited");
  } finally { appleEvents.clear(); }
});

test("Apple direct verification accepts an omitted FileTasks recurrence representation", async () => {
  const owner = await account();
  assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } })).status, 201);
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Omitted FileTasks recurrence", scheduledDate: "2027-01-14",
    recurrence: { interval: 1, unit: "weeks", weekdays: [4], end: { type: "date", date: "2027-02-01" } },
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  const [path] = [...appleEvents.entries()][0];
  try {
    omittedAppleReports.add(path);
    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    const update = await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: { title: "Updated omitted recurrence", scope: "series" } });
    assert.equal(update.status, 200, await update.text());
    assert.match(appleEvents.get(path), /^SUMMARY:Updated omitted recurrence\r?$/m);
    const updated = (await (await request(`/api/items/${root.id}`, { token: owner.token })).json()).item;
    assert.ok(!updated.calendarSync.some(status => status.provider === "apple" && status.state === "limited"));
    assert.ok(providerRequests.some(entry => entry.method === "GET" && entry.path === path));
  } finally { omittedAppleReports.delete(path); appleEvents.clear(); }
});

test("recurring Google exceptions use immutable original starts after moves and retain FileTasks backlinks", async () => {
  const owner = await account();
  const providerRequestsStart = providerRequests.length;
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
    cookie: authorization.cookie, redirect: "manual",
  })).status, 303);
  assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } })).status, 201);

  serverTimeZone = "Europe/London";
  await stopServer();
  await startServer();

  const today = testClock.toISOString().slice(0, 10);
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Long-lead recurring Event", scheduledDate: today, scheduledTime: "09:00",
    recurrence: { interval: 1, unit: "months", end: { type: "never" } },
    reminders: [{ delivery: "notification", amount: 700, unit: "days", time: "08:00" }],
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  const allItems = (await (await request("/api/items", { token: owner.token })).json()).items;
  const occurrence = allItems.filter((item) => item.seriesId === root.id && item.occurrenceDate)
    .find((item) => Date.parse(`${item.occurrenceDate}T00:00:00Z`) - testClock.getTime() > 370 * 86_400_000
      && Number(item.occurrenceDate.slice(5, 7)) >= 6 && Number(item.occurrenceDate.slice(5, 7)) <= 8);
  assert.ok(occurrence, "expected a materialized summer Occurrence beyond 370 days");
  const initialSync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
  assert.equal(initialSync.status, 200, "initial Google and Apple synchronization should succeed before restart");
  assert.equal(googleInstanceRequests.length, 0, JSON.stringify(googleInstanceRequests));
  assert.equal(googleEvents.size, 1, "initial synchronization should create one recurring Google copy");
  const googleCopyId = [...googleEvents.keys()][0];
  const itemsBeforeRestart = (await (await request("/api/items", { token: owner.token })).json()).items;
  const providerObservationsBeforeRestart = providerRequests.slice(providerRequestsStart);
  const googleCopiesBeforeRestart = [...googleEvents.entries()];
  const appleCopiesBeforeRestart = [...appleEvents.entries()];

  await stopServer();
  await startServer();

  const restoredSession = await request("/api/auth/session", { token: owner.token });
  assert.equal(restoredSession.status, 200, "the same account should still authenticate after the synchronized restart");
  assert.deepEqual((await restoredSession.json()).user, owner.user, "the saved account should survive the restart");
  const restoredCalendars = await request("/api/calendars", { token: owner.token });
  assert.equal(restoredCalendars.status, 200, "connected calendars should remain available after restart");
  assert.deepEqual((await restoredCalendars.json()).calendars.map(({ provider, account_label }) => ({ provider, account_label })), [
    { provider: "apple", account_label: "person@example.com" },
    { provider: "google", account_label: "Fake Google Calendar" },
  ], "both connected calendar accounts should persist across the restart");
  const restoredItems = await request("/api/items", { token: owner.token });
  assert.equal(restoredItems.status, 200, "saved recurring items should remain available after restart");
  assert.deepEqual((await restoredItems.json()).items, itemsBeforeRestart, "the root Event and its Occurrences should be unchanged by restart");
  assert.deepEqual(providerRequests.slice(providerRequestsStart), providerObservationsBeforeRestart,
    "restarting and reading saved state should not issue provider requests");
  assert.deepEqual([...googleEvents.entries()], googleCopiesBeforeRestart, "the fake Google copy should survive unchanged across restart");
  assert.deepEqual([...appleEvents.entries()], appleCopiesBeforeRestart, "the fake Apple copy should survive unchanged across restart");

  const originalDate = occurrence.occurrenceDate;
  const movedDate = new Date(`${originalDate}T00:00:00Z`);
  movedDate.setUTCDate(movedDate.getUTCDate() + 10);
  const movedDateString = movedDate.toISOString().slice(0, 10);
  const instance = {
    id: "google-long-lead-instance",
    originalStartTime: { dateTime: `${originalDate}T09:00:00+01:00` },
    start: { dateTime: `${originalDate}T09:00:00+01:00` },
  };
  googleInstances.set(instance.id, instance);
  const edited = await request(`/api/items/${occurrence.id}`, { token: owner.token, method: "PATCH", body: {
    scheduledDate: movedDateString, scheduledTime: "11:15", scope: "occurrence",
  } });
  assert.equal(edited.status, 200);
  const persistedItems = (await (await request("/api/items", { token: owner.token })).json()).items;
  const persistedRoot = persistedItems.find((item) => item.id === root.id);
  const changedOccurrences = persistedItems.filter((item) => item.seriesId === root.id && item.id !== root.id && item.occurrenceDate)
    .filter((item) => item.scheduledDate !== item.occurrenceDate || item.scheduledTime !== persistedRoot.scheduledTime
      || item.title !== persistedRoot.title || item.details !== persistedRoot.details);
  assert.deepEqual(changedOccurrences.map((item) => item.id), [occurrence.id]);
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.equal(googleEvents.size, 1, "updates after restart should keep the original Google copy");
  assert.equal(googleEvents.has(googleCopyId), true, "updates after restart should use the same Google copy id");

  const originalStartRequest = googleInstanceRequests.find(({ originalStart }) => originalStart === `${originalDate}T09:00:00+01:00`);
  assert.ok(originalStartRequest);
  assert.equal(originalStartRequest.timeMin, null);
  assert.equal(originalStartRequest.timeMax, null);
  assert.deepEqual(googleExceptions.get(instance.id).start, {
    dateTime: `${movedDateString}T11:15:00`, timeZone: "Europe/London",
  });
  const backlink = `${base}/?event=${encodeURIComponent(root.id)}`;
  assert.ok(googleExceptions.get(instance.id).description.includes(backlink));

  const movedAgain = new Date(`${originalDate}T00:00:00Z`);
  movedAgain.setUTCDate(movedAgain.getUTCDate() + 20);
  const movedAgainString = movedAgain.toISOString().slice(0, 10);
  const movedAgainResponse = await request(`/api/items/${occurrence.id}`, { token: owner.token, method: "PATCH", body: {
    scheduledDate: movedAgainString, title: "Restored from FileTasks", scope: "occurrence",
  } });
  assert.equal(movedAgainResponse.status, 200);
  const movedAgainItem = (await movedAgainResponse.json()).item;
  assert.equal(movedAgainItem.scheduledDate, movedAgainString);
  assert.equal(movedAgainItem.occurrenceDate, originalDate);
  googleInstances.set(instance.id, { ...googleInstances.get(instance.id), summary: "Edited outside FileTasks", start: { dateTime: "2039-01-01T09:00:00+00:00" } });
  assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
  assert.ok(googleInstanceRequests.filter(({ originalStart }) => originalStart === `${originalDate}T09:00:00+01:00`).length >= 2);
  const instancePatchRequests = providerRequests.filter(({ path }) => path.endsWith(`/events/${instance.id}`));
  assert.ok(instancePatchRequests.length >= 3, "FileTasks should update the same Google instance after moving and restoring it");
  assert.equal(googleEvents.size, 1, "moving the exception should not create another recurring Google copy");
  assert.equal(googleEvents.has(googleCopyId), true, "moving the exception should continue using the same Google copy id");
  assert.deepEqual(googleExceptions.get(instance.id).start, {
    dateTime: `${movedAgainString}T11:15:00`, timeZone: "Europe/London",
  });
  assert.equal(googleExceptions.get(instance.id).summary, "Restored from FileTasks");

  const appleCopy = [...appleEvents.values()][0];
  const appleComponents = appleCopy.split("BEGIN:VEVENT\r\n").slice(1)
    .map((component) => component.slice(0, component.indexOf("END:VEVENT")));
  assert.equal(new Set(appleComponents.map((component) => component.match(/^UID:(.+)$/m)?.[1])).size, 1);
  for (const component of appleComponents) assert.match(component, /^DTSTAMP:\d{8}T\d{6}Z$/m);
  const exceptionComponent = appleComponents.find((part) => part.includes(`RECURRENCE-ID:${originalDate.replaceAll("-", "")}T090000`));
  assert.ok(exceptionComponent);
  assert.ok(appleCopy.includes(`DTSTART:${movedAgainString.replaceAll("-", "")}T111500`));
  assert.ok(exceptionComponent.includes(`URL:${backlink}`));

  const itemsBeforeFailureRestart = (await (await request("/api/items", { token: owner.token })).json()).items;
  const providerObservationCountBeforeFailureRestart = providerRequests.length;
  await stopServer();
  await startServer();
  const itemsAfterFailureRestart = await request("/api/items", { token: owner.token });
  assert.equal(itemsAfterFailureRestart.status, 200, "saved items should remain available before the controlled provider failure");
  assert.deepEqual((await itemsAfterFailureRestart.json()).items, itemsBeforeFailureRestart,
    "the edited exception should persist through the restart before the failed sync");
  assert.equal(providerRequests.length, providerObservationCountBeforeFailureRestart,
    "the restart should not change provider observations before the controlled failure");
  assert.equal(googleEvents.has(googleCopyId), true, "the same Google copy should remain available after the second restart");

  const failedOperationPath = `/google/calendar/v3/calendars/primary/events/${instance.id}`;
  const priorPatchAttempts = providerRequests.filter(({ path, method }) => path === failedOperationPath && method === "PATCH").length;
  failNextGoogleRequest = { method: "PATCH", path: failedOperationPath, status: 503 };
  const failedSync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
  assert.equal(failedSync.status, 502, "a failed Google provider operation should be reported by the API");
  assert.deepEqual(await failedSync.json(), { error: "A recurring Event Occurrence could not be synchronized to Google Calendar." },
    "the API should preserve the provider failure message");
  const failedOperationAttempts = providerRequests.filter(({ path, method }) => path === failedOperationPath && method === "PATCH").length - priorPatchAttempts;
  assert.equal(failedOperationAttempts, 1, "the failed Google provider operation should be attempted exactly once without retries");
  assert.equal(failNextGoogleRequest, null, "the controlled fake failure should be consumed by one request");
  assert.equal((await request(`/api/items/${root.id}?scope=series`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal(googleEvents.size, 0);
  assert.equal(appleEvents.size, 0);
});

test("a stale Google sync cannot overwrite a newer edited recurring Occurrence", async () => {
  const owner=await account();
  const seriesStart=new Date(testClock.getTime()+86_400_000).toISOString().slice(0,10);
  const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:"Weekly series",scheduledDate:seriesStart,
    recurrence:{interval:1,unit:"weeks",weekdays:[new Date(`${seriesStart}T00:00:00Z`).getUTCDay()],end:{type:"count",count:5}}}});
  const createdResult=await created.json();
  assert.equal(created.status,201,JSON.stringify(createdResult));
  const root=createdResult.item;
  const listed=await (await request("/api/items",{token:owner.token})).json();
  const occurrence=listed.items.find(item=>item.seriesId===root.id&&item.id!==root.id);
  assert.ok(occurrence,JSON.stringify({root,items:listed.items}));
  const auth=await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
  assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
  const instance={id:`instance-${occurrence.id}`,originalStartTime:{date:`${occurrence.occurrenceDate}`},start:{date:occurrence.occurrenceDate}};
  googleInstances.set(instance.id,instance);
  const edited=await request(`/api/items/${occurrence.id}`,{token:owner.token,method:"PATCH",body:{title:"Earlier occurrence title",scope:"occurrence"}});
  assert.equal(edited.status,200);
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  const replica=await startCalendarApiReplica(3113);
  const requestReplica=(path,options={})=>fetch(`http://localhost:${replica.port}${path}`,{
    method:options.method??"GET",headers:{Authorization:`Bearer ${owner.token}`,...(options.body?{"Content-Type":"application/json"}:{})},
    ...(options.body?{body:JSON.stringify(options.body)}:{}),
  });
  let release; let started; let staleSync; let stopped=false;
  const held=new Promise(resolve=>{started=resolve;});
  const releasePromise=new Promise(resolve=>{release=resolve;});
  holdNextCalendarUpdate={provider:"google",eventId:instance.id,started,releasePromise};
  try {
    staleSync=requestReplica("/api/calendars/sync",{method:"POST"}).then(response=>({response}),error=>({error}));
    await held;
    db.prepare("UPDATE items SET title=?,updated_at=? WHERE user_id=? AND id=?").run("Latest occurrence title",new Date().toISOString(),owner.user.id,occurrence.id);
    db.prepare("UPDATE calendar_export_locks SET owner_token='occurrence-takeover',fence=fence+1,lease_until=0 WHERE user_id=? AND provider='google'").run(owner.user.id);
    const takeover=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(takeover.status,200,await takeover.text());
    release(); holdNextCalendarUpdate=null;
    await staleSync;
    await stopCalendarApiReplica(replica); stopped=true;
    assert.equal(googleExceptions.get(instance.id).summary,"Latest occurrence title");
    const occurrencePatches=providerRequests.filter(entry=>entry.path.endsWith(`/events/${instance.id}`)&&entry.method==="PATCH");
    assert.ok(occurrencePatches.length>=3,"both generations should conditionally patch the same Occurrence");
    assert.ok(occurrencePatches.every(entry=>Boolean(entry.headers["if-match"])),"every Google Occurrence PATCH uses If-Match");
    const rootCopy=[...googleEvents.values()].find(event=>event.extendedProperties?.private?.filetasksItemId===root.id);
    assert.ok(rootCopy,"the root Calendar copy remains mapped to the recurring Event");
    assert.equal(googleExceptions.get(instance.id).extendedProperties.private.filetasksSyncGeneration,
      rootCopy.extendedProperties.private.filetasksSyncGeneration,
      "the Occurrence records the generation of its newer root Calendar copy");
  } finally {
    release?.(); holdNextCalendarUpdate=null;
    await staleSync?.catch(()=>{});
    if(!stopped) await stopCalendarApiReplica(replica);
    db.close();
  }
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
  assert.deepEqual(occurrences.map(({ scheduledDate }) => scheduledDate), ["2026-11-02", "2026-11-07", "2026-11-09", "2026-11-11"]);
  assert.equal(occurrences.every(({ reminders }) => reminders[0]?.amount === 2), true);
  const seriesEdit = await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: { title: "Water all the plants", scope: "series" } });
  assert.equal(seriesEdit.status, 200);
  const afterSeriesEdit = (await (await request("/api/items", { token: owner.token })).json()).items;
  assert.equal(afterSeriesEdit.filter(({ seriesId, title }) => seriesId === root.id && title === "Water all the plants").length, 4);
  assert.deepEqual(afterSeriesEdit.filter(({ seriesId }) => seriesId === root.id).map(({ scheduledDate }) => scheduledDate).sort(),
    ["2026-11-02", "2026-11-07", "2026-11-09", "2026-11-11"]);
  assert.equal(afterSeriesEdit.find(({ id }) => id === occurrenceId)?.completed, true);
});

test("following split uses original identity after a move and preserves a deleted Occurrence in COUNT", async () => {
  const owner = await account();
  const recurrence = { interval: 1, unit: "days", end: { type: "count", count: 5 } };
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Counted series", scheduledDate: "2026-11-01", recurrence,
    reminders: [{ delivery: "notification", amount: 1, unit: "hours", time: "09:00" }],
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  let series = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === root.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.equal(series.length, 5);

  const deleted = series[1];
  assert.equal((await request(`/api/items/${deleted.id}?scope=occurrence`, { token: owner.token, method: "DELETE" })).status, 204);
  const selected = series[3];
  const movedDate = "2026-12-15";
  assert.equal((await request(`/api/items/${selected.id}`, { token: owner.token, method: "PATCH", body: {
    scheduledDate: "2026-11-25", scope: "occurrence",
  } })).status, 200);
  const split = await request(`/api/items/${selected.id}`, { token: owner.token, method: "PATCH", body: {
    scheduledDate: movedDate, recurrence, scope: "following",
  } });
  assert.equal(split.status, 200, await split.clone().text());

  series = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => [root.id, selected.id].includes(seriesId)).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  const prior = series.filter(({ seriesId }) => seriesId === root.id);
  const future = series.filter(({ seriesId }) => seriesId === selected.id);
  assert.deepEqual(prior.map(({ occurrenceDate }) => occurrenceDate), ["2026-11-01", "2026-11-03"]);
  assert.deepEqual(future.map(({ scheduledDate }) => scheduledDate), [movedDate, "2026-12-16"]);
  assert.deepEqual(future.map(({ occurrenceDate }) => occurrenceDate), [movedDate, "2026-12-16"]);
  assert.equal(future.length, 2, "the deleted earlier Occurrence still consumes its original COUNT slot");
  assert.equal(future.every(({ recurrence }) => recurrence?.end?.type === "count" && recurrence.end.count === 2), true,
    JSON.stringify(future.map(({ recurrence }) => recurrence)));
  assert.equal(future.every(({ reminders }) => reminders[0]?.time === "09:00"), true);
});

test("following split retains later local schedule exceptions and inherited File identity", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Quarterly filing", scheduledDate: "2026-11-01",
    recurrence: { interval: 1, unit: "days", end: { type: "count", count: 5 } },
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  let occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === root.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  const file = (await (await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "Filing notes", url: "https://example.com/filing-notes",
  } })).json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: {
    itemId: root.id, scope: "following",
  } })).status, 201);
  const movedException = occurrences[4];
  assert.equal((await request(`/api/items/${movedException.id}`, { token: owner.token, method: "PATCH", body: {
    scheduledDate: "2026-12-20", scope: "occurrence",
  } })).status, 200);
  occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === root.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  const selected = occurrences[2];
  assert.equal((await request(`/api/items/${selected.id}`, { token: owner.token, method: "PATCH", body: {
    title: "Updated filing", scope: "following",
  } })).status, 200);
  const items = (await (await request("/api/items", { token: owner.token })).json()).items;
  const retainedException = items.find(({ id }) => id === movedException.id);
  assert.equal(retainedException.scheduledDate, "2026-12-20");
  assert.deepEqual(retainedException.files.map(({ id }) => id), [file.id]);
  assert.equal(items.filter(({ seriesId, title }) => seriesId === selected.id && title === "Updated filing").length, 3);
});

test("editing the first Occurrence locally preserves its recurrence definition and series identity", async () => {
  const owner = await account();
  const previousClock = new Date(testClock);
  try {
    const created = await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "task", title: "Original series title", details: "Original series details", scheduledDate: "2026-11-01", scheduledTime: "08:00",
      recurrence: { interval: 1, unit: "days", end: { type: "never" } },
      reminders: [{ delivery: "notification", amount: 1, unit: "days", time: "09:00" }],
    } });
    assert.equal(created.status, 201, await created.clone().text());
    const root = (await created.json()).item;
    const file = (await (await request("/api/files", { token: owner.token, method: "POST", body: { name: "Series notes", url: "https://example.com/series-notes" } })).json()).file;
    assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: root.id, scope: "series" } })).status, 201);
    assert.equal((await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: { completed: true } })).status, 200);
    let series = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
    const laterBefore = series.find(({ id }) => id !== root.id);
    assert.ok(laterBefore);

    const localEdit = await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: {
      title: "First Occurrence only", details: "Local details", scheduledDate: "2026-10-20", scheduledTime: "12:30",
      recurrence: null, reminders: [{ delivery: "notification", amount: 2, unit: "hours", time: "10:30" }], scope: "occurrence",
    } });
    assert.equal(localEdit.status, 200, await localEdit.clone().text());
    const editedRoot = (await localEdit.json()).item;
    assert.equal(editedRoot.id, root.id);
    assert.equal(editedRoot.seriesId, root.id);
    assert.equal(editedRoot.occurrenceDate, "2026-11-01", "moving the first Occurrence must retain its original recurrence identity");
    assert.equal(editedRoot.scheduledDate, "2026-10-20");
    assert.equal(editedRoot.recurrence, null, "the first Occurrence can keep a local recurrence choice");
    assert.equal(editedRoot.completed, true);
    assert.deepEqual(editedRoot.files.map(({ id }) => id), [file.id]);

    series = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
    const unchangedLater = series.find(({ id }) => id === laterBefore.id);
    assert.ok(unchangedLater, "the later Occurrence keeps its stable id");
    assert.equal(unchangedLater.title, "Original series title");
    assert.equal(unchangedLater.scheduledTime, "08:00");
    assert.deepEqual(unchangedLater.reminders, [{ delivery: "notification", amount: 1, unit: "days", time: "09:00" }]);
    assert.deepEqual(unchangedLater.files.map(({ id }) => id), [file.id]);
    assert.ok(series.some(({ id, occurrenceDate }) => id === root.id && occurrenceDate === "2026-11-01"),
      "the moved first Occurrence keeps its original recurrence identity");

    await setTestClock(previousClock.getTime() + 372 * 86_400_000);
    series = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
    const generated = series.find(({ occurrenceDate }) => occurrenceDate === "2028-01-01");
    assert.ok(generated, "advancing the controlled clock should materialize a date beyond the original rolling horizon");
    assert.notEqual(generated.id, root.id);
    assert.equal(generated.title, "Original series title");
    assert.equal(generated.scheduledDate, "2028-01-01");
    assert.equal(generated.scheduledTime, "08:00");
    assert.deepEqual(generated.reminders, [{ delivery: "notification", amount: 1, unit: "days", time: "09:00" }]);
    assert.deepEqual(generated.files.map(({ id }) => id), [file.id]);
  } finally { await setTestClock(previousClock); }
});

test("a whole-series edit after a local first-Occurrence recurrence override keeps the saved series rule", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Series title", scheduledDate: "2026-11-01",
    recurrence: { interval: 1, unit: "days", end: { type: "count", count: 4 } },
  } });
  assert.equal(created.status, 201);
  const root = (await created.json()).item;
  assert.equal((await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: {
    title: "First Occurrence override", recurrence: null, scope: "occurrence",
  } })).status, 200);
  assert.equal((await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: {
    title: "Renamed series", recurrence: null, scope: "series",
  } })).status, 200);
  const rows = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === root.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.equal(rows.length, 4);
  assert.ok(rows.every(({ title }) => title === "Renamed series"));
  assert.deepEqual(rows.map(({ occurrenceDate }) => occurrenceDate), ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
  assert.equal(rows[0].recurrence, null, "the local first-Occurrence override stays local");
  assert.ok(rows.slice(1).every(({ recurrence }) => recurrence?.end?.type === "count" && recurrence.end.count === 4),
    "the saved series recurrence remains available for generated Occurrences");
});

test("a root Occurrence edit with recurrence enabled does not replace the series generation template", async () => {
  const owner = await account();
  const previousClock = new Date(testClock);
  try {
    const created = await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "task", title: "Template title", details: "Template details", scheduledDate: "2026-11-10", scheduledTime: "08:15",
      recurrence: { interval: 1, unit: "days", end: { type: "never" } },
      reminders: [{ delivery: "notification", amount: 1, unit: "days", time: "09:00" }],
    } });
    assert.equal(created.status, 201);
    const root = (await created.json()).item;
    const initialRows = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
    const existingIds = new Set(initialRows.map(({ id }) => id));

    const edit = await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: {
      title: "Local first Occurrence", details: "Local details", scheduledDate: "2026-10-20", scheduledTime: "12:30",
      recurrence: { interval: 2, unit: "days", end: { type: "never" } },
      reminders: [{ delivery: "notification", amount: 3, unit: "hours", time: "10:30" }], scope: "occurrence",
    } });
    assert.equal(edit.status, 200, await edit.clone().text());
    const editedRoot = (await edit.json()).item;
    assert.equal(editedRoot.title, "Local first Occurrence");
    assert.equal(editedRoot.recurrence.interval, 2);
    assert.equal(editedRoot.occurrenceDate, "2026-11-10");

    await setTestClock(previousClock.getTime() + 372 * 86_400_000);
    const afterAdvance = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
    const newlyGenerated = afterAdvance.find(({ id }) => !existingIds.has(id));
    assert.ok(newlyGenerated, "the series definition should materialize future Occurrences after advancing the clock");
    assert.equal(newlyGenerated.title, "Template title");
    assert.equal(newlyGenerated.details, "Template details");
    assert.equal(newlyGenerated.scheduledTime, "08:15");
    assert.equal(newlyGenerated.recurrence.interval, 1);
    assert.deepEqual(newlyGenerated.reminders, [{ delivery: "notification", amount: 1, unit: "days", time: "09:00" }]);
  } finally { await setTestClock(previousClock); }
});

test("legacy recurring roots are backfilled without changing public item data", async () => {
  const owner = await account();
  const previousClock = new Date(testClock);
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Legacy recurring task", details: "Keep existing details", scheduledDate: "2026-11-01", scheduledTime: "08:15",
    recurrence: { interval: 1, unit: "days", end: { type: "never" } },
    reminders: [{ delivery: "notification", amount: 2, unit: "days", time: "09:30" }],
  } });
    assert.equal(created.status, 201, await created.clone().text());
  const root = (await created.json()).item;
  const before = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === root.id).map(({ id, title, details, scheduledDate, scheduledTime, occurrenceDate, recurrence, reminders }) =>
      ({ id, title, details, scheduledDate, scheduledTime, occurrenceDate, recurrence, reminders }));
  assert.ok(before.length > 1);

  try {
    const db = new DatabaseSync(join(directory, "workspace.sqlite"));
    try {
      const row = db.prepare("SELECT user_id FROM items WHERE id=?").get(root.id);
      assert.ok(row);
      db.prepare("DELETE FROM item_series_definitions WHERE user_id=? AND series_root_id=?").run(row.user_id, root.id);
    } finally { db.close(); }

    await stopServer();
    await startServer();
    const after = (await (await request("/api/items", { token: owner.token })).json()).items
      .filter(({ seriesId }) => seriesId === root.id).map(({ id, title, details, scheduledDate, scheduledTime, occurrenceDate, recurrence, reminders }) =>
        ({ id, title, details, scheduledDate, scheduledTime, occurrenceDate, recurrence, reminders }));
    assert.deepEqual(after, before, "migration backfill must preserve existing Occurrences and their public values");

    const firstOverride = await request(`/api/items/${root.id}`, { token: owner.token, method: "PATCH", body: {
      title: "Local legacy root override", scheduledDate: "2026-10-20", recurrence: null, scope: "occurrence",
    } });
    assert.equal(firstOverride.status, 200);

    await setTestClock(previousClock.getTime() + 372 * 86_400_000);
    const afterAdvance = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === root.id);
    const previousIds = new Set(before.map(({ id }) => id));
    const newlyGenerated = afterAdvance.find(({ id }) => !previousIds.has(id));
    assert.ok(newlyGenerated, "the backfilled legacy series should materialize a new Occurrence after clock advancement");
    assert.notEqual(newlyGenerated.id, root.id);
    assert.equal(newlyGenerated.title, "Legacy recurring task", "migration must retain the saved series definition instead of replacing it with a root override");
    assert.equal(newlyGenerated.scheduledTime, "08:15");
    assert.deepEqual(newlyGenerated.reminders, [{ delivery: "notification", amount: 2, unit: "days", time: "09:30" }]);
  } finally { await setTestClock(previousClock); }
});

test("turning an existing item into a recurrence creates its generation definition", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "task", title: "Existing task", details: "Keep this definition", scheduledDate: "2027-02-01", scheduledTime: "09:00",
  } });
  assert.equal(created.status, 201);
  const item = (await created.json()).item;
  const updated = await request(`/api/items/${item.id}`, { token: owner.token, method: "PATCH", body: {
    recurrence: { interval: 1, unit: "days", end: { type: "count", count: 3 } },
  } });
  assert.equal(updated.status, 200, await updated.clone().text());
  let items = (await (await request("/api/items", { token: owner.token })).json()).items;
  let series = items.filter(({ seriesId }) => seriesId === item.id);
  assert.equal(series.length, 3);
  assert.deepEqual(series.map(({ scheduledDate }) => scheduledDate), ["2027-02-01", "2027-02-02", "2027-02-03"]);
  const occurrenceIds = series.map(({ id }) => id).sort();

  const previousClock = new Date(testClock);
  try {
    await setTestClock(previousClock.getTime() + 372 * 86_400_000);
    items = (await (await request("/api/items", { token: owner.token })).json()).items;
    series = items.filter(({ seriesId }) => seriesId === item.id);
    assert.equal(series.length, 3, "the persisted count ending remains in effect after subsequent reads");
    assert.deepEqual(series.map(({ id }) => id).sort(), occurrenceIds, "existing Occurrence identities remain stable");
  } finally { await setTestClock(previousClock); }
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

test("removing a following Attachment from a later Occurrence preserves earlier Occurrences", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Five day series", scheduledDate: "2027-01-01",
    recurrence: { interval: 1, unit: "days", end: { type: "count", count: 5 } },
  } });
  assert.equal(created.status, 201);
  const series = (await created.json()).item;
  const file = (await (await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "Series notes", url: "https://example.com/series-notes",
  } })).json()).file;
  const occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.equal(occurrences.length, 5);
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: {
    itemId: occurrences[1].id, scope: "following",
  } })).status, 201);
  let current = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.deepEqual(current.map(({ files }) => files.length), [0, 1, 1, 1, 1]);

  assert.equal((await request(`/api/files/${file.id}/attachments/${occurrences[2].id}?scope=following`, {
    token: owner.token, method: "DELETE",
  })).status, 204);
  current = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.deepEqual(current.map(({ files }) => files.length), [0, 1, 0, 0, 0]);
  assert.equal((await (await request("/api/files", { token: owner.token })).json()).files.some(({ id }) => id === file.id), true);

  assert.equal((await request(`/api/files/${file.id}/attachments/${occurrences[1].id}?scope=series`, {
    token: owner.token, method: "DELETE",
  })).status, 204);
  assert.deepEqual((await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).map(({ files }) => files.length), [0, 0, 0, 0, 0]);
});

test("reattaching an excluded first Occurrence preserves its series Attachment", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Quarterly review", scheduledDate: "2026-11-01",
    recurrence: { interval: 1, unit: "months", end: { type: "count", count: 3 } },
  } });
  const series = (await created.json()).item;
  const file = (await (await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "Review notes", url: "https://example.com/review-notes",
  } })).json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: series.id, scope: "series" } })).status, 201);
  const before = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === series.id);
  assert.equal((await request(`/api/files/${file.id}/attachments/${series.id}?scope=occurrence`, { token: owner.token, method: "DELETE" })).status, 204);
  assert.equal((await request(`/api/items/${series.id}`, { token: owner.token })).status, 200);
  assert.deepEqual((await (await request(`/api/items/${series.id}`, { token: owner.token })).json()).item.files, []);

  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: series.id, scope: "occurrence" } })).status, 201);
  const after = (await (await request("/api/items", { token: owner.token })).json()).items.filter(({ seriesId }) => seriesId === series.id);
  assert.deepEqual(after.map(({ files }) => files.length), [1, 1, 1]);
  assert.deepEqual((await (await request("/api/files", { token: owner.token })).json()).files[0].attachments.map(({ scope }) => scope), ["series"]);
  assert.equal(before.length, 3);
});

test("local restoration survives earlier following exclusions and following removal clears local restorations", async () => {
  const owner = await account();
  const created = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: "Attachment range", scheduledDate: "2026-11-01",
    recurrence: { interval: 1, unit: "days", end: { type: "count", count: 5 } },
  } });
  const series = (await created.json()).item;
  const file = (await (await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "Range notes", url: "https://example.com/range-notes",
  } })).json()).file;
  const occurrences = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));

  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: {
    itemId: occurrences[0].id, scope: "following",
  } })).status, 201);
  assert.equal((await request(`/api/files/${file.id}/attachments/${occurrences[1].id}?scope=following`, {
    token: owner.token, method: "DELETE",
  })).status, 204);
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: {
    itemId: occurrences[2].id, scope: "following",
  } })).status, 201);
  let current = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.deepEqual(current.map(({ files }) => files.length), [1, 0, 1, 1, 1]);

  assert.equal((await request(`/api/files/${file.id}/attachments/${occurrences[3].id}?scope=following`, {
    token: owner.token, method: "DELETE",
  })).status, 204);
  assert.equal((await request(`/api/files/${file.id}/attachments`, {
    token: owner.token, method: "POST", body: { itemId: occurrences[3].id, scope: "occurrence" },
  })).status, 201);
  assert.equal((await request(`/api/files/${file.id}/attachments/${occurrences[2].id}?scope=following`, {
    token: owner.token, method: "DELETE",
  })).status, 204);
  current = (await (await request("/api/items", { token: owner.token })).json()).items
    .filter(({ seriesId }) => seriesId === series.id).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.deepEqual(current.map(({ files }) => files.length), [1, 0, 0, 0, 0]);
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
  assert.deepEqual(await response.json(), { synced: [], message: "Connect a calendar first.", syncDelivery: [] });
  assert.equal((await request("/api/calendars", { method: "POST", body: { username: "a@example.com", password: "secret" } })).status, 401);
});

test("the Apple provider fake validates iCalendar PUTs and reports stored calendar resources", async () => {
  const invalidResources = [
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//EN\r\nEND:VCALENDAR\r\n",
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//EN\r\nBEGIN:VEVENT\r\nUID:missing-start@example.test\r\nDTSTAMP:20261013T120000Z\r\nSUMMARY:Missing start\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    appleCalendarFixture({ uid: "bad-stamp@example.test", timestamp: "20261013T120000 Z" }),
    appleCalendarFixture({ uid: "root@example.test", recurrence: "RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=2", exceptionUid: "different@example.test" }),
    appleCalendarFixture({ uid: "floating-start@example.test", recurrence: "RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20270114T235959Z" }),
  ];
  for (const [index, calendarData] of invalidResources.entries()) {
    const response = await fetch(`${deliveryBase}/apple/calendar/rejected-${index}.ics`, {
      method: "PUT", headers: { "Content-Type": "text/calendar; charset=utf-8" }, body: calendarData,
    });
    assert.equal(response.status, 400);
    assert.equal(appleEvents.has(`/apple/calendar/rejected-${index}.ics`), false);
  }
  const noCalendarContentType = await fetch(`${deliveryBase}/apple/calendar/rejected-content-type.ics`, {
    method: "PUT", headers: { "Content-Type": "text/plain" }, body: appleCalendarFixture({ uid: "wrong-type@example.test" }),
  });
  assert.equal(noCalendarContentType.status, 415);

  const resourcePath = "/apple/calendar/report-round-trip.ics";
  const saved = await fetch(`${deliveryBase}${resourcePath}`, {
    method: "PUT", headers: { "Content-Type": "text/calendar; charset=utf-8" },
    body: appleCalendarFixture({ uid: "report-round-trip@example.test" }),
  });
  assert.equal(saved.status, 201);
  const report = await fetch(`${deliveryBase}/apple/calendar/`, {
    method: "REPORT", headers: { "Content-Type": "application/xml; charset=utf-8" },
    body: "<?xml version=\"1.0\"?><c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><c:calendar-data/></d:prop></c:calendar-query>",
  });
  const reportXml = await report.text();
  assert.equal(report.status, 207);
  assert.ok(reportXml.includes(`<d:href>${resourcePath}</d:href>`));
  assert.ok(reportXml.includes("UID:report-round-trip@example.test"));
  await fetch(`${deliveryBase}${resourcePath}`, { method: "DELETE" });
  assert.equal(appleEvents.has(resourcePath), false);
});

test("the browser editor keeps a first Occurrence edit local to the series root", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(base);
    await page.getByRole("group", { name: "Account action" }).getByRole("button", { name: "Create account", exact: true }).click();
    const email = `browser-first-occurrence-${crypto.randomUUID()}@example.com`;
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.locator("form").getByRole("button", { name: "Create account", exact: true }).click();

    await page.getByRole("button", { name: "New Task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Browser recurring root");
    await page.getByLabel(/^Date\b/).fill("2026-11-04");
    await page.getByLabel("Repeat", { exact: true }).check();
    await page.getByRole("button", { name: "+ Add Reminder", exact: true }).click();
    await page.getByLabel("Reminder 1 offset", { exact: true }).fill("1");
    await page.getByRole("button", { name: "Save Task", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser recurring root", exact: true })).toBeVisible();

    const login = await request("/api/auth/login", { method: "POST", body: { email, password: "correct-horse-battery" } });
    const owner = await login.json();
    const items = () => request("/api/items", { token: owner.token }).then((response) => response.json()).then(({ items }) => items);
    const recurringRoot = (await items()).find(({ title, seriesId }) => title === "Browser recurring root" && seriesId);
    assert.ok(recurringRoot);
    const originalFollowing = (await items()).find(({ seriesId, id }) => seriesId === recurringRoot.id && id !== recurringRoot.id);
    assert.ok(originalFollowing);

    await page.getByRole("button", { name: "Edit Browser recurring root", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Browser local first Occurrence");
    await page.getByLabel(/^Date\b/).fill("2026-11-05");
    await page.getByLabel("Repeat", { exact: true }).uncheck();
    await page.getByLabel("Reminder 1 offset", { exact: true }).fill("3");
    await page.getByLabel("Apply changes to", { exact: true }).selectOption("occurrence");
    await page.getByRole("button", { name: "Save Task", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser local first Occurrence", exact: true })).toBeVisible();

    const editedRoot = (await request(`/api/items/${recurringRoot.id}`, { token: owner.token }).then((response) => response.json())).item;
    assert.equal(editedRoot.title, "Browser local first Occurrence");
    assert.equal(editedRoot.scheduledDate, "2026-11-05");
    assert.equal(editedRoot.recurrence, null);
    assert.equal(editedRoot.reminders[0].amount, 3);
    const followingAfterLocalEdit = (await request(`/api/items/${originalFollowing.id}`, { token: owner.token }).then((response) => response.json())).item;
    assert.equal(followingAfterLocalEdit.title, "Browser recurring root");
    assert.equal(followingAfterLocalEdit.scheduledDate, originalFollowing.scheduledDate);
    assert.equal(followingAfterLocalEdit.recurrence.unit, "weeks");
    assert.equal(followingAfterLocalEdit.reminders[0].amount, 1);
  } finally { await context.close(); await browser.close(); }
});

test("a person can manage Tasks and Events through the browser and see another client's changes", async () => {
  const previousAppleEvents=appleEvents;
  const previousAppleEventVersions=appleEventVersions;
  appleEvents=new Map();
  appleEventVersions=new Map();
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
    const birthdayResponse = await request("/api/items", { token: native.token, method: "POST", body: { kind: "event", title: "Birthday dinner", scheduledDate: "2026-11-12" } });
    assert.equal(birthdayResponse.status, 201);
    const birthday = (await birthdayResponse.json()).item;
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
    await expect(page.getByText("Deleting this File removes its 2 Attachments from all associated Tasks and Events.", { exact: true })).toBeVisible();
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
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reminder settings", exact: true })).toBeVisible();
    await page.getByLabel("Apple ID", { exact: true }).fill("browser-calendar@example.com");
    await page.getByLabel("App-specific password", { exact: true }).fill("fake-app-password");
    await page.getByLabel(/CalDAV calendar URL/).fill(`${deliveryBase}/apple/calendar/`);
    await page.getByRole("button", { name: "Connect Apple Calendar", exact: true }).click();
    await expect(page.getByText("Apple Calendar · browser-calendar@example.com", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sync Calendar", exact: true }).click();
    await expect(page.getByText("Synced apple Calendar.", { exact: true })).toBeVisible();
    assert.ok([...appleEvents.values()].some((calendarData) => calendarData.includes(`URL:${base}/?event=${birthday.id}`)));
    const postSyncItems = (await (await request("/api/items", { token: native.token })).json()).items;
    assert.ok(postSyncItems.find(({ id }) => id === birthday.id)?.files.some(({ name }) => name === "Application form"));
    const postSyncFiles = (await (await request("/api/files", { token: native.token })).json()).files;
    assert.ok(postSyncFiles.find(({ name }) => name === "Application form").attachments.some(({ itemId }) => itemId === birthday.id));
    const oldCollectionCopy = [...appleEvents.entries()].find(([path, calendarData]) => path.startsWith("/apple/calendar/")
      && calendarData.includes(`URL:${base}/?event=${birthday.id}`));
    assert.ok(oldCollectionCopy, "the first collection should contain the synced Event");
    const unrelatedCollectionCopy = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:unrelated-b\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;VALUE=DATE:20271114\r\nDTEND;VALUE=DATE:20271115\r\nSUMMARY:Unrelated collection B event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    appleEvents.set("/apple/calendar-b/unrelated-b.ics", unrelatedCollectionCopy);
    const appleRequestsBeforeSwitch = providerRequests.length;
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Apple Calendar · browser-calendar@example.com", { exact: true })).toHaveCount(0);
    await page.getByLabel("Apple ID", { exact: true }).fill("browser-calendar-b@example.com");
    await page.getByLabel("App-specific password", { exact: true }).fill("fake-app-password-b");
    await page.getByLabel(/CalDAV calendar URL/).fill(`${deliveryBase}/apple/calendar-b/`);
    await page.getByRole("button", { name: "Connect Apple Calendar", exact: true }).click();
    await expect(page.getByText("Apple Calendar · browser-calendar-b@example.com", { exact: true })).toBeVisible();
    const newCollectionEventResponse = await request("/api/items", { token: native.token, method: "POST", body: {
      kind: "event", title: "New collection B event", scheduledDate: "2027-12-05",
    } });
    assert.equal(newCollectionEventResponse.status, 201);
    await page.getByRole("button", { name: "Sync Calendar", exact: true }).click();
    await expect(page.getByText("Synced apple Calendar.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Calendar sync limitations")).toContainText("earlier or unknown connection");
    assert.equal(appleEvents.get(oldCollectionCopy[0]), oldCollectionCopy[1], "reconnect must preserve the previous collection's copy");
    assert.equal(appleEvents.get("/apple/calendar-b/unrelated-b.ics"), unrelatedCollectionCopy, "sync must preserve an unrelated Event in the selected collection");
    assert.ok([...appleEvents.entries()].some(([path, calendarData]) => path.startsWith("/apple/calendar-b/")
      && calendarData.includes("SUMMARY:New collection B event")), "new work should export to the selected collection");
    assert.ok(providerRequests.slice(appleRequestsBeforeSwitch).filter(({ path }) => path.startsWith("/apple/"))
      .every(({ path }) => path.startsWith("/apple/calendar-b/")), "provider calls after reconnect must use only the selected collection");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Agenda", exact: true }).click();
    await page.getByRole("button", { name: "New Event", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Remember this moment");
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Remember this moment", exact: true })).toBeVisible();
    assert.equal((await request("/api/calendars/sync", { token: native.token, method: "POST" })).status, 200);
    assert.equal([...appleEvents.values()].some((calendarData) => calendarData.includes("SUMMARY:Remember this moment")), false);
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
  } finally {
    await browser.close();
    appleEvents=previousAppleEvents;
    appleEventVersions=previousAppleEventVersions;
  }
});

test("browser Event saves and deletions remain local when Google delivery fails", async () => {
  const owner = await account();
  const previousGoogleEvents = googleEvents;
  googleEvents = new Map();
  let browser;
  try {
    const authorization = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    })).status, 303);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(base);
    await page.getByLabel("Email", { exact: true }).fill(owner.user.email);
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();

    failNextGoogleRequest = {
      method: "POST", path: "/google/calendar/v3/calendars/primary/events", status: 503,
    };
    await page.getByRole("button", { name: "New Event", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Browser committed Event");
    await page.getByLabel(/^Date\b/).fill("2027-02-12");
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser committed Event", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Calendar sync pending." }))
      .toContainText(/Calendar sync pending\. Your Event is saved in FileTasks and will be retried\. The last attempt failed; another retry is scheduled\./i);
    assert.equal(failNextGoogleRequest, null, "the browser save should exercise the injected provider failure");
    const saved = (await (await request("/api/items", { token: owner.token })).json()).items
      .find((item) => item.title === "Browser committed Event");
    assert.ok(saved, "another client should observe the Event saved through the browser");

    await page.getByRole("button", { name: "New Event", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Browser unscheduled Event");
    await page.getByLabel(/^Date\b/).fill("2027-02-13");
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser unscheduled Event", exact: true })).toBeVisible();
    const unscheduled = (await (await request("/api/items", { token: owner.token })).json()).items
      .find((item) => item.title === "Browser unscheduled Event");
    assert.ok(unscheduled);
    const unscheduledCopy = [...googleEvents.entries()].find(([, event]) => event.extendedProperties?.private?.filetasksItemId === unscheduled.id);
    assert.ok(unscheduledCopy, "the dated Event should have a Google copy before its date is cleared");
    failNextGoogleRequest = {
      method: "DELETE", path: `/google/calendar/v3/calendars/primary/events/${unscheduledCopy[0]}`, status: 503,
    };
    await page.getByRole("button", { name: "Edit Browser unscheduled Event", exact: true }).click();
    await page.getByLabel(/^Date\b/).fill("");
    await page.getByRole("button", { name: "Save Event", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser unscheduled Event", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Calendar sync pending." }))
      .toContainText(/Calendar sync pending\. Your Event is saved in FileTasks and will be retried\. The last attempt failed; another retry is scheduled\./i);
    assert.equal(failNextGoogleRequest, null, "clearing the date should exercise the injected provider failure");
    assert.equal(googleEvents.has(unscheduledCopy[0]), true, "the failed cleanup must retain the provider copy for retry");
    const locallyUndated = (await (await request(`/api/items/${unscheduled.id}`, { token: owner.token })).json()).item;
    assert.equal(locallyUndated.scheduledDate, null);
    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    assert.equal(googleEvents.has(unscheduledCopy[0]), false, "a later sync should remove the obsolete dated copy");

    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    const copy = [...googleEvents.entries()].find(([, event]) => event.extendedProperties?.private?.filetasksItemId === saved.id);
    assert.ok(copy, "the manual sync should create the copy so deletion failure can be exercised");
    failNextGoogleRequest = {
      method: "DELETE", path: `/google/calendar/v3/calendars/primary/events/${copy[0]}`, status: 503,
    };
    await page.getByRole("button", { name: "Delete Browser committed Event", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser committed Event", exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Calendar removal pending." }))
      .toContainText(/Calendar removal pending\. Your Event was deleted from FileTasks and will be retried\. The last attempt failed; another retry is scheduled\./i);
    assert.equal(failNextGoogleRequest, null, "the browser deletion should exercise the injected provider failure");
    assert.equal((await request(`/api/items/${saved.id}`, { token: owner.token })).status, 404,
      "another client should observe the completed local deletion");
    assert.equal(googleEvents.has(copy[0]), true, "the failed external removal must remain recoverable");
  } finally {
    failNextGoogleRequest = null;
    googleEvents = previousGoogleEvents;
    if (browser) await browser.close();
  }
});

test("server startup ignores a stale HTTP 401 on the fixed app origin", async () => {
  await stopServer();
  let staleListenerRequests = 0;
  const staleListener = createServer((_request, response) => {
    staleListenerRequests++;
    response.writeHead(401).end();
  });
  try {
    await new Promise((resolve, reject) => {
      staleListener.once("error", reject);
      staleListener.listen(testPort, resolve);
    });
    await assert.rejects(startServer(), /exited before becoming ready/);
    assert.equal(staleListenerRequests, 0,
      "readiness must wait for this Next child to emit Ready before probing the fixed origin");
  } finally {
    if (staleListener.listening) {
      await new Promise((resolve, reject) => staleListener.close((error) => error ? reject(error) : resolve()));
    }
    await stopServer();
    await startServer();
  }
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

test("Android UI acceptance: recurring agenda and connected calendar workflows work natively", {
  skip: process.env.FILETASKS_RUN_ANDROID_UI_ACCEPTANCE !== "1",
}, async () => {
  await setTestClock("2026-10-13T12:00:00.000Z");
  const shared = process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1";
  const email = shared ? "ios-ui-shared@example.com" : "android-ui-shared@example.com";
  const password = "correct-horse-battery";
  const owner = await account(email);
  if (shared) {
    await setEmulatorRunning((args) => runCommand("adb", args), process.env.FILETASKS_ANDROID_EMULATOR_SERIAL, true);
    sharedUIOwner = owner;
    const mappings = await runCommand("adb", ["reverse", "--list"]);
    assert.equal(mappings.split(/\r?\n/).some((line) => /\btcp:3107\b/.test(line)), false,
      "The Android emulator port 3107 must be available for the shared UI workflow.");
    await runCommand("adb", ["reverse", "tcp:3107", "tcp:3107"]);
  }
  const calendarEmail = `android-calendar-ui-${crypto.randomUUID()}@example.com`;
  await account(calendarEmail);
  const appleCollectionPath = `/apple/android-ui-${crypto.randomUUID()}/`;
  const appleCalendarUrl = `${deliveryBase}${appleCollectionPath}`;
  const undatedEventTitle = "Android UI date clearing Event";
  const deleteEventTitle = "Android UI delete Event";
  let undatedEvent;
  let undatedFile;
  let googleCopyId;
  let appleCopyPath;
  let eventToDelete;
  let deleteGoogleCopyId;
  let deleteAppleCopyPath;
  try {
    const authorization = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
      cookie: authorization.cookie, redirect: "manual",
    })).status, 303);
    const appleConnection = await request("/api/calendars", { token: owner.token, method: "POST", body: {
      username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
    } });
    assert.equal(appleConnection.status, 201);
    const eventResponse = await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: undatedEventTitle, details: "Keep its File", scheduledDate: "2026-10-16",
    } });
    assert.equal(eventResponse.status, 201);
    undatedEvent = (await eventResponse.json()).item;
    const fileResponse = await request("/api/files", { token: owner.token, method: "POST", body: {
      name: "Android Event notes", url: "https://example.com/android-event-notes.pdf",
    } });
    assert.equal(fileResponse.status, 201);
    undatedFile = (await fileResponse.json()).file;
    assert.equal((await request(`/api/files/${undatedFile.id}/attachments`, { token: owner.token, method: "POST", body: {
      itemId: undatedEvent.id,
    } })).status, 201);
    googleCopyId = [...googleEvents.entries()].find(([, event]) => event.extendedProperties?.private?.filetasksItemId === undatedEvent.id)?.[0];
    appleCopyPath = [...appleEvents.entries()].find(([, calendarData]) => calendarData.includes(`URL:${base}/?event=${undatedEvent.id}`))?.[0];
    assert.ok(googleCopyId && appleCopyPath, "the dated Event should have both provider copies before the Android UI clears its date");
    const deleteEventResponse = await request("/api/items", { token: owner.token, method: "POST", body: {
      kind: "event", title: deleteEventTitle, scheduledDate: "2026-10-17",
    } });
    assert.equal(deleteEventResponse.status, 201);
    eventToDelete = (await deleteEventResponse.json()).item;
    deleteGoogleCopyId = [...googleEvents.entries()].find(([, event]) => event.extendedProperties?.private?.filetasksItemId === eventToDelete.id)?.[0];
    deleteAppleCopyPath = [...appleEvents.entries()].find(([, calendarData]) => calendarData.includes(`URL:${base}/?event=${eventToDelete.id}`))?.[0];
    assert.ok(deleteGoogleCopyId && deleteAppleCopyPath, "the second dated Event should have provider copies before native deletion");
    failNextGoogleRequest = { method: "POST", path: "/google/calendar/v3/calendars/primary/events", status: 503 };
    await runCommand("./gradlew", [
      ":app:connectedDebugAndroidTest",
      "-Pandroid.testInstrumentationRunnerArguments.class=com.filetasks.android.RecurringAgendaUiTest",
      `-Pandroid.testInstrumentationRunnerArguments.apiUrl=${base}`,
      `-Pandroid.testInstrumentationRunnerArguments.email=${email}`,
      `-Pandroid.testInstrumentationRunnerArguments.password=${password}`,
    ], process.env, join(repoRoot, "apps/android"), { detached: true });
    const fakePort = new URL(deliveryBase).port;
    await runCommand("adb", ["reverse", `tcp:${fakePort}`, `tcp:${fakePort}`]);
    try {
      await runCommand("./gradlew", [
        ":app:connectedDebugAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.class=com.filetasks.android.CalendarSettingsUiTest",
        `-Pandroid.testInstrumentationRunnerArguments.apiUrl=${base}`,
        `-Pandroid.testInstrumentationRunnerArguments.calendarEmail=${calendarEmail}`,
        `-Pandroid.testInstrumentationRunnerArguments.password=${password}`,
        `-Pandroid.testInstrumentationRunnerArguments.providerFakeUrl=${deliveryBase}`,
        `-Pandroid.testInstrumentationRunnerArguments.appleCalendarUrl=${appleCalendarUrl}`,
      ], process.env, join(repoRoot, "apps/android"), { detached: true });
    } finally {
      await runCommand("adb", ["reverse", "--remove", `tcp:${fakePort}`]).catch(() => {});
    }
  } catch (error) {
    const resultsPath = join(repoRoot, "apps/android/app/build/outputs/androidTest-results/connected");
    let reports;
    try {
      const files = (await readdir(resultsPath, { recursive: true })).filter((file) => file.endsWith(".xml"));
      reports = (await Promise.all(files.map((file) => readFile(join(resultsPath, file), "utf8")))).join("\n");
    } catch (reportError) {
      reports = `Could not read instrumentation reports: ${reportError.message}`;
    }
    throw new Error(`${error.message}\nInstrumentation results:\n${reports}\nRecent test server output:\n${logs.slice(-10000)}`, { cause: error });
  } finally {
    failNextGoogleRequest = null;
    if (shared) await runCommand("adb", ["reverse", "--remove", "tcp:3107"], process.env, repoRoot, { cleanup: true });
  }

  const response = await request("/api/items", { token: owner.token });
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.equal(items.filter(({ title }) => title === "Android UI Whole Task").length, 3);
  assert.equal(items.filter(({ title }) => title === "Android UI Following").length, 2);
  assert.equal(items.filter(({ title }) => title === "Android UI Event").length, 1);
  const clearedEvent = (await (await request(`/api/items/${undatedEvent.id}`, { token: owner.token })).json()).item;
  assert.equal(clearedEvent.scheduledDate, null, "the Android UI should clear the Event's date");
  assert.deepEqual(clearedEvent.files.map(({ id }) => id), [undatedFile.id], "the File relationship should remain after the Android UI edit");
  assert.equal(googleEvents.has(googleCopyId), false, "the Android UI date clear should remove the Google copy");
  assert.equal(appleEvents.has(appleCopyPath), false, "the Android UI date clear should remove the Apple copy");
  assert.equal((await request(`/api/items/${eventToDelete.id}`, { token: owner.token })).status, 404,
    "the Android UI should delete the separate dated Event locally");
  assert.equal(googleEvents.has(deleteGoogleCopyId), false, "the Android UI deletion should remove the Google copy");
  assert.equal(appleEvents.has(deleteAppleCopyPath), false, "the Android UI deletion should remove the Apple copy");

  uiAcceptanceBrowser = await launchUIAcceptanceBrowser();
  try {
    uiAcceptanceContext = await createUIAcceptanceContext(uiAcceptanceBrowser);
    try {
      const page = await createUIAcceptancePage(uiAcceptanceContext);
      await page.goto(base);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
      for (const title of ["Android UI Whole Task", "Android UI Following", "Android UI Event"]) {
        await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
      }
    } finally {
      await closeUIAcceptanceContext();
    }
  } finally {
    await closeUIAcceptanceBrowser();
  }
});

test("iOS, Android and web run against one shared account, API and provider fakes", {
  skip: process.env.FILETASKS_RUN_NATIVE_ACCEPTANCE !== "1",
}, async () => {
  await setTestClock("2026-10-13T12:00:00.000Z");
  const shared = process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1";
  const email = shared ? "ios-ui-shared@example.com" : `shared-native-${crypto.randomUUID()}@example.com`;
  const password = "correct-horse-battery";
  const namespace = crypto.randomUUID();
  const sharedOwner = shared ? sharedUIOwner : await account(email);
  assert.ok(sharedOwner, "The Android UI phase must create the account before the shared native workflow.");
  const providerIndex = providerRequests.length;
  const workerDeliveriesBefore = providerRequests.filter(({ path, body }) => path === "/push" && body.operation === "deliver").length;
  const nativeEnv = {
    ...process.env,
    FILETASKS_TEST_API_URL: base,
    FILETASKS_TEST_EMAIL: email,
    FILETASKS_TEST_PASSWORD: password,
    FILETASKS_TEST_NAMESPACE: namespace,
    FILETASKS_TEST_WORKER_SECRET: "test-worker-secret",
  };

  const iosAuthorization = await beginGoogleAuthorization(sharedOwner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(iosAuthorization.state)}&code=fake-code`, {
    cookie: iosAuthorization.cookie, redirect: "manual",
  })).status, 303);
  failNextGoogleRequest = { method: "POST", path: "/google/calendar/v3/calendars/primary/events", status: 503 };

  try {
    await runCommand("swift", ["test", "--package-path", "apps/ios"], nativeEnv);
    assert.equal(failNextGoogleRequest, null, "the iOS UI's first saved Event should exercise Google failure");
  } finally {
    failNextGoogleRequest = null;
  }

  const fakePort = new URL(deliveryBase).port;
  const reversedPorts = ["3107", fakePort];
  const installedReverses = [];
  try {
    for (const port of reversedPorts) {
      await runCommand("adb", ["reverse", `tcp:${port}`, `tcp:${port}`]);
      installedReverses.push(port);
    }
    await runCommand("./gradlew", [
      ":app:connectedDebugAndroidTest",
      "-Pandroid.testInstrumentationRunnerArguments.class=com.filetasks.android.ApiClientAcceptanceTest",
      `-Pandroid.testInstrumentationRunnerArguments.apiUrl=${base}`,
      `-Pandroid.testInstrumentationRunnerArguments.email=${email}`,
      `-Pandroid.testInstrumentationRunnerArguments.password=${password}`,
      `-Pandroid.testInstrumentationRunnerArguments.namespace=${namespace}`,
      "-Pandroid.testInstrumentationRunnerArguments.workerSecret=test-worker-secret",
    ], process.env, join(repoRoot, "apps/android"));
  } finally {
    for (const port of installedReverses) await runCommand("adb", ["reverse", "--remove", `tcp:${port}`], process.env, repoRoot, { cleanup: true });
  }

  const nativeRequests = providerRequests.slice(providerIndex).filter(({ path }) => path === "/push");
  assert.ok(nativeRequests.filter(({ body }) => body.operation === "register").length >= 2,
    "both native clients should register with the shared push provider");
  assert.ok(nativeRequests.filter(({ body }) => body.operation === "revoke").length >= 2,
    "both native clients should revoke their shared push registrations");
  const nativeDeliveries = nativeRequests.filter(({ body }) => body.operation === "deliver").length;
  assert.equal(nativeDeliveries, providerRequests.filter(({ path, body }) => path === "/push" && body.operation === "deliver").length - workerDeliveriesBefore);
  assert.ok(nativeDeliveries >= 2, "both native clients should cause observable push delivery requests at the shared fake");
  assert.equal(providerRequests.slice(providerIndex).some(({ path, body }) => path === "/email" && body.operation === "deliver"), false);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(base);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Events", exact: true }).click();
    await expect(page.getByRole("heading", { name: `Cross-platform Event ${namespace}`, exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    for (const name of [`iOS upload ${namespace}.txt`, `Android upload ${namespace}.txt`]) {
      const card = page.locator(".file-card").filter({ hasText: name });
      await expect(card).toBeVisible();
      const downloadsBefore = storageRequests.filter(({ method }) => method === "GET").length;
      await card.getByRole("button", { name: "Open", exact: true }).click();
      await expect.poll(() => storageRequests.filter(({ method }) => method === "GET").length).toBe(downloadsBefore + 1);
    }
  } finally {
    await context.close();
    await browser.close();
  }
  assert.equal(sharedOwner.user.email, email);
});

test("runner interruption stops only its owned process-group descendants", {
  skip: process.platform === "win32",
}, async () => {
  const childSource = `
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `;
  const ownerSource = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });
    process.on("SIGTERM", () => {});
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const spawnGroup = (source) => spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const waitForReady = (child) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The process-group fixture did not start.")), 5_000);
    child.stdout.once("data", (data) => {
      clearTimeout(timeout);
      assert.match(data.toString(), /ready/);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const owned = spawnGroup(ownerSource);
  const unrelated = spawnGroup('console.log("ready"); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);');
  const ownedClosed = new Promise((resolve) => owned.once("close", resolve));
  const unrelatedClosed = new Promise((resolve) => unrelated.once("close", resolve));
  try {
    await Promise.all([waitForReady(owned), waitForReady(unrelated)]);
    const shutdownStartedAt = Date.now();
    const trackedGroupsPath = join(directory, "owned-process-groups.json");
    await writeFile(trackedGroupsPath, JSON.stringify([owned.pid]));
    await stopTrackedProcessGroups(trackedGroupsPath, { graceMs: 150, killWaitMs: 2_000 });
    assert.ok(Date.now() - shutdownStartedAt >= 100, "The hung owned group should require SIGKILL escalation.");
    await ownedClosed;
    assert.equal(unrelated.exitCode, null, "Interrupting the runner must leave unrelated process groups alone.");
  } finally {
    await Promise.all([
      terminateProcessGroup(owned.pid, "SIGTERM", { graceMs: 250, killWaitMs: 1_000 }).catch(() => {}),
      terminateProcessGroup(unrelated.pid, "SIGTERM", { graceMs: 250, killWaitMs: 1_000 }).catch(() => {}),
    ]);
    await Promise.all([ownedClosed, unrelatedClosed]);
  }
});

test("interruption closes setup admission and waits for an in-flight setup to self-clean", async () => {
  const gate = createSetupGate();
  let releaseSetup;
  let cleanupFinished = false;
  let lateResourcePublished = false;
  let lateResourceDisposed = false;
  const token = gate.begin("pending browser startup");
  const setup = (async () => {
    let localResource;
    try {
      await new Promise((resolve) => { releaseSetup = resolve; });
      localResource = { close() { lateResourceDisposed = true; } };
      token.assertOpen();
    } catch (error) {
      localResource?.close();
      throw error;
    } finally {
      token.finish();
    }
    lateResourcePublished = true;
  })();

  gate.closeAdmission("SIGTERM");
  assert.throws(() => gate.begin("late xcodebuild spawn"), /setup admission closed by SIGTERM/);
  const cleanup = gate.waitForPending(1_000).then(() => { cleanupFinished = true; });
  await delay(20);
  assert.equal(cleanupFinished, false, "Cleanup must wait for setup that started before interruption.");

  releaseSetup();
  await assert.rejects(setup, /setup admission closed by SIGTERM/);
  await cleanup;
  assert.equal(lateResourcePublished, false, "A resource must not be published after interruption.");
  assert.equal(lateResourceDisposed, true, "Late setup must clean up its resource before releasing the barrier.");
  assert.equal(cleanupFinished, true);
});

test("iOS UI acceptance: registration, cross-type Reminder preservation, calendar sync and browser read", {
  skip: process.env.FILETASKS_RUN_IOS_UI_ACCEPTANCE !== "1",
}, async () => {
  await setTestClock("2026-10-13T12:00:00.000Z");
  const email = "ios-ui-shared@example.com";
  const password = "correct-horse-battery";
  const taskReminder = { delivery: "notification", amount: 2, unit: "days", time: "09:15" };
  const eventReminder = { delivery: "notification", amount: 3, unit: "weeks", time: "11:40" };
  const reverseTaskTitle = "UI Runner Event To Task";
  const noRemindersTitle = "UI Runner No Reminders";
  const owner = process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1" ? sharedUIOwner : await account(email);
  assert.ok(owner, "The Android UI phase must create the shared account before the iOS UI phase.");
  const undatedEventTitle = "iOS UI date clearing Event";
  const deleteEventTitle = "iOS UI delete Event";

  const settingsResponse = await request("/api/settings/reminders", {
    token: owner.token,
    method: "PATCH",
    body: {
      taskReminders: [taskReminder],
      eventReminders: [eventReminder],
      pushEnabled: false,
      emailEnabled: false,
    },
  });
  assert.equal(settingsResponse.status, 200, "The shared account should receive separate Task and Event defaults.");
  const savedSettings = (await settingsResponse.json()).settings;
  assert.deepEqual(savedSettings.taskReminders, [taskReminder]);
  assert.deepEqual(savedSettings.eventReminders, [eventReminder]);

  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, {
    cookie: authorization.cookie, redirect: "manual",
  })).status, 303);
  googleEvents.set("native-imported-google-event", {
    id: "native-imported-google-event",
    summary: "Native imported Google Event",
    description: "Shared fake provider import",
    start: { date: "2026-10-20" },
    end: { date: "2026-10-21" },
  });
  const calendarEventTitle = "Native calendar sync authority";
  const missingCopyTitle = "Native calendar missing copy";
  const firstEventResponse = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: calendarEventTitle, details: "FileTasks-owned details", scheduledDate: "2026-10-14", scheduledTime: "10:30",
  } });
  assert.equal(firstEventResponse.status, 201);
  const firstEvent = (await firstEventResponse.json()).item;
  const importedItems = (await (await request("/api/items", { token: owner.token })).json()).items;
  const importedEvent = importedItems.find(({ title }) => title === "Native imported Google Event");
  assert.ok(importedEvent, "the shared Google fake should import an Event into FileTasks");
  const secondEventResponse = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: missingCopyTitle, details: "Restore the deleted provider copy", scheduledDate: "2026-10-15", scheduledTime: "11:00",
  } });
  assert.equal(secondEventResponse.status, 201);
  const secondEvent = (await secondEventResponse.json()).item;
  const contextFileResponse = await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "Native calendar sync notes", url: "https://example.com/calendar-notes.pdf",
  } });
  assert.equal(contextFileResponse.status, 201);
  const contextFile = (await contextFileResponse.json()).file;
  assert.equal((await request(`/api/files/${contextFile.id}/attachments`, {
    token: owner.token, method: "POST", body: { itemId: importedEvent.id },
  })).status, 201);

  const editedCopy = [...googleEvents.entries()].find(([, event]) => event.summary === calendarEventTitle);
  const deletedCopy = [...googleEvents.entries()].find(([, event]) => event.summary === missingCopyTitle);
  assert.ok(editedCopy, "the shared Google fake should contain the first FileTasks Calendar copy");
  assert.ok(deletedCopy, "the shared Google fake should contain the second FileTasks Calendar copy");
  googleEvents.set(editedCopy[0], { ...editedCopy[1], summary: "Provider changed this title", description: "Provider changed these details" });
  googleEvents.delete(deletedCopy[0]);

  const appleConnection = await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } });
  assert.equal(appleConnection.status, 201);
  const eventResponse = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: undatedEventTitle, details: "Keep its File", scheduledDate: "2026-10-16",
  } });
  assert.equal(eventResponse.status, 201);
  const undatedEvent = (await eventResponse.json()).item;
  const fileResponse = await request("/api/files", { token: owner.token, method: "POST", body: {
    name: "iOS Event notes", url: "https://example.com/ios-event-notes.pdf",
  } });
  assert.equal(fileResponse.status, 201);
  const undatedFile = (await fileResponse.json()).file;
  assert.equal((await request(`/api/files/${undatedFile.id}/attachments`, { token: owner.token, method: "POST", body: {
    itemId: undatedEvent.id,
  } })).status, 201);
  const googleCopyId = [...googleEvents.entries()].find(([, event]) => event.extendedProperties?.private?.filetasksItemId === undatedEvent.id)?.[0];
  const appleCopyPath = [...appleEvents.entries()].find(([, calendarData]) => calendarData.includes(`URL:${base}/?event=${undatedEvent.id}`))?.[0];
  assert.ok(googleCopyId && appleCopyPath, "the dated Event should have both provider copies before the iOS UI clears its date");
  const deleteEventResponse = await request("/api/items", { token: owner.token, method: "POST", body: {
    kind: "event", title: deleteEventTitle, scheduledDate: "2026-10-17",
  } });
  assert.equal(deleteEventResponse.status, 201);
  const eventToDelete = (await deleteEventResponse.json()).item;
  const deleteGoogleCopyId = [...googleEvents.entries()].find(([, event]) => event.extendedProperties?.private?.filetasksItemId === eventToDelete.id)?.[0];
  const deleteAppleCopyPath = [...appleEvents.entries()].find(([, calendarData]) => calendarData.includes(`URL:${base}/?event=${eventToDelete.id}`))?.[0];
  assert.ok(deleteGoogleCopyId && deleteAppleCopyPath, "the second dated Event should have provider copies before native deletion");
  failNextGoogleRequest = {
    method: "POST", path: "/google/calendar/v3/calendars/primary/events", status: 503,
    summary: "UI Runner Event Default",
  };
  failNextAppleRequest = { method: "PROPFIND", path: "/apple/calendar/", status: 503 };

  const simulatorId = process.env.FILETASKS_IOS_UI_SIMULATOR_ID;
  assert.ok(simulatorId, "The focused runner must create and pass a disposable iOS Simulator id.");
  if (process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1") {
    await setEmulatorRunning((args) => runCommand("adb", args), process.env.FILETASKS_ANDROID_EMULATOR_SERIAL, false);
    await runCommand("xcrun", ["simctl", "boot", simulatorId]);
    await runCommand("xcrun", ["simctl", "bootstatus", simulatorId, "-b"]);
  }
  try {
    await runCommand("xcodebuild", [
      "-project", "apps/ios/FileTasks.xcodeproj",
      "-scheme", "FileTasks",
      "-destination", `platform=iOS Simulator,id=${simulatorId}`,
      "-derivedDataPath", join(directory, "ios-ui-derived-data"),
      "-resultBundlePath", join(directory, "ios-ui-tests.xcresult"),
      "-parallel-testing-enabled", "NO",
      // Simulator ad hoc signing supplies the app's Keychain entitlements.
      "test",
    ], {
      ...process.env,
      TEST_RUNNER_FILETASKS_IOS_UI_APPLE_URL: `${deliveryBase}/apple/calendar/`,
      TEST_RUNNER_FILETASKS_IOS_UI_PROVIDER_STATE_URL: `${deliveryBase}/test/google-events`,
    }, repoRoot, { detached: true });
    assert.equal(failNextAppleRequest, null, "the native Apple Calendar UI should surface and then recover from the provider failure");
  } catch (error) {
    throw new Error(`${error.message}\nRecent test server output:\n${logs.slice(-10000)}`, { cause: error });
  } finally {
    failNextGoogleRequest = null;
    failNextAppleRequest = null;
  }

  const restoredCopies = [...googleEvents.values()];
  const authoritativeCopy = restoredCopies.find(({ summary }) => summary === calendarEventTitle);
  const recreatedCopy = restoredCopies.find(({ summary }) => summary === missingCopyTitle);
  assert.ok(authoritativeCopy, "native Sync Calendar should restore the FileTasks title after a provider edit");
  assert.ok(recreatedCopy, "native Sync Calendar should recreate an externally deleted Calendar copy");
  assert.equal(authoritativeCopy.description.includes(`?event=${firstEvent.id}`), true, "the restored copy should retain its FileTasks backlink");
  assert.equal(recreatedCopy.description.includes(`?event=${secondEvent.id}`), true, "the recreated copy should include its FileTasks backlink");
  assert.equal(restoredCopies.filter(({ summary }) => summary === calendarEventTitle).length, 1, "the provider fake should contain one copy for each FileTasks Event");
  assert.equal(restoredCopies.filter(({ summary }) => summary === missingCopyTitle).length, 1, "restoring a missing copy should not duplicate it");
  const calendarItems = (await (await request("/api/items", { token: owner.token })).json()).items;
  assert.equal(calendarItems.filter(({ title }) => title === calendarEventTitle).length, 1);
  assert.equal(calendarItems.filter(({ title }) => title === missingCopyTitle).length, 1);
  assert.equal(calendarItems.filter(({ title }) => title === "Native imported Google Event").length, 1,
    "the native refresh should retain the provider-imported Event without duplicating it");

  const registeredAccount = await request("/api/auth/login", {
    method: "POST",
    body: { email: "ios-ui-registration@example.com", password },
  });
  assert.equal(registeredAccount.status, 200, "The UI must register its second account through the app.");

  const sharedItemsResponse = await request("/api/items", { token: owner.token });
  assert.equal(sharedItemsResponse.status, 200);
  const { items } = await sharedItemsResponse.json();
  const defaultEvent = items.find(({ title }) => title === "UI Runner Event Default");
  const customizedEvent = items.find(({ title }) => title === "UI Runner Customized Event");
  const reverseTask = items.find(({ title }) => title === reverseTaskTitle);
  const noRemindersEvent = items.find(({ title }) => title === noRemindersTitle);
  assert.ok(defaultEvent, "The UI-created Event should be persisted in the shared account.");
  assert.ok(customizedEvent, "The customized UI-created Event should be persisted in the shared account.");
  assert.ok(reverseTask, "The Event-to-Task UI flow should persist a Task in the shared account.");
  assert.ok(noRemindersEvent, "The remove-all UI flow should persist an Event in the shared account.");
  assert.equal(defaultEvent.kind, "event");
  assert.deepEqual(defaultEvent.reminders, [eventReminder]);
  assert.equal(customizedEvent.kind, "event");
  assert.deepEqual(customizedEvent.reminders, [{ ...taskReminder, amount: 4 }]);
  assert.equal(reverseTask.kind, "task");
  assert.deepEqual(reverseTask.reminders, [taskReminder]);
  assert.equal(noRemindersEvent.kind, "event");
  assert.deepEqual(noRemindersEvent.reminders, []);
  const clearedEvent = (await (await request(`/api/items/${undatedEvent.id}`, { token: owner.token })).json()).item;
  assert.equal(clearedEvent.scheduledDate, null, "the iOS UI should clear the Event's date");
  assert.deepEqual(clearedEvent.files.map(({ id }) => id), [undatedFile.id], "the File relationship should remain after the iOS UI edit");
  assert.equal(googleEvents.has(googleCopyId), false, "the iOS UI date clear should remove the Google copy");
  assert.equal(appleEvents.has(appleCopyPath), false, "the iOS UI date clear should remove the Apple copy");
  assert.equal((await request(`/api/items/${eventToDelete.id}`, { token: owner.token })).status, 404,
    "the iOS UI should delete the separate dated Event locally");
  assert.equal(googleEvents.has(deleteGoogleCopyId), false, "the iOS UI deletion should remove the Google copy");
  assert.equal(appleEvents.has(deleteAppleCopyPath), false, "the iOS UI deletion should remove the Apple copy");

  const recurringTaskRows = items.filter(({ title }) => title === "UI Runner Whole Series Task");
  assert.equal(recurringTaskRows.length, 2, "The iOS scoped saves should leave both affected Task Occurrences in the shared API.");
  assert.ok(recurringTaskRows.every(({ recurrence }) => recurrence?.end?.type === "count" && recurrence.end.count === 2),
    "The refreshed Task rows should retain the server-generated two-Occurrence Recurrence rule.");
  assert.equal(items.filter(({ title }) => title === "UI Runner Recurring Task").length, 1,
    "The unrelated earlier Task Occurrence should retain its original value.");
  assert.equal(items.filter(({ title }) => title === "UI Runner Following Task").length, 0,
    "The following series edit should update both affected loaded rows.");
  assert.equal(items.filter(({ title }) => title === "UI Runner Recurring Event").length, 3,
    "The iOS-created Event should be visible with its server-generated Occurrences.");

  uiAcceptanceBrowser = await launchUIAcceptanceBrowser();
  try {
    uiAcceptanceContext = await createUIAcceptanceContext(uiAcceptanceBrowser);
    try {
      const page = await createUIAcceptancePage(uiAcceptanceContext);
      await page.goto(base);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Events", exact: true }).click();
      if (process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1") {
        await expect(page.getByRole("heading", { name: "Android UI Following", exact: true }).first()).toBeVisible();
      }
      await expect(page.getByRole("heading", { name: "UI Runner Event Default", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "UI Runner Customized Event", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: noRemindersTitle, exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Tasks", exact: true }).click();
      if (process.env.FILETASKS_RUN_SHARED_ACCEPTANCE === "1") {
        await expect(page.getByRole("heading", { name: "Android UI Whole Task", exact: true }).first()).toBeVisible();
      }
      await expect(page.getByRole("heading", { name: reverseTaskTitle, exact: true }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "UI Runner Recurring Task", exact: true })).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "UI Runner Whole Series Task", exact: true })).toHaveCount(2);
      await page.getByRole("button", { name: "Events", exact: true }).click();
      await expect(page.getByRole("heading", { name: "UI Runner Recurring Event", exact: true })).toHaveCount(3);
    } finally {
      await closeUIAcceptanceContext();
    }
  } finally {
    await closeUIAcceptanceBrowser();
  }
});

test("imported series normalization and splits retain export safeguards", async () => {
  const owner = await account();
  const authorization = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(authorization.state)}&code=fake-code`, { cookie:authorization.cookie, redirect:"manual" })).status,303);
  const source = { id:"split-provenance", summary:"Split provenance", start:{dateTime:"2027-01-13T09:00:00-05:00",timeZone:"America/New_York"}, end:{dateTime:"2027-01-13T11:30:00-05:00",timeZone:"America/New_York"}, recurrence:["RRULE:FREQ=WEEKLY;BYDAY=WE,MO;COUNT=5"] };
  try {
    googleEvents.set(source.id,structuredClone(source));
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    const items = (await (await request("/api/items",{token:owner.token})).json()).items;
    const root = items.find((item) => item.title === source.summary && item.recurrence);
    assert.equal(root.calendarSync[0].state,"limited");
    assert.equal(root.calendarSync[0].recurrenceEdited,false);
    const later = items.find((item) => item.seriesId === root.id && item.id !== root.id);
    const providerEventsBeforeSplit = structuredClone([...googleEvents.entries()]);
    const patch = await request(`/api/items/${later.id}`,{token:owner.token,method:"PATCH",body:{title:"Split later",scope:"following"}});
    assert.equal(patch.status,200);
    assert.equal((await patch.json()).item.calendarSync[0].limitationCode,"imported-series-split");
    const loaded = (await (await request(`/api/items/${later.id}`,{token:owner.token})).json()).item;
    assert.equal(loaded.calendarSync[0].state,"limited");
    assert.ok((await (await request("/api/calendars",{token:owner.token})).json()).syncLimitations.some((entry) => entry.itemId === later.id));
    assert.deepEqual([...googleEvents.entries()],providerEventsBeforeSplit,
      "splitting an imported series must leave every Google provider copy unchanged");
    assert.deepEqual(googleEvents.get(source.id).start,source.start);
    assert.deepEqual(googleEvents.get(source.id).end,source.end);
  } finally { googleEvents.clear(); }
});

test("generated split Occurrences remain blocked after detaching across providers", async () => {
  googleEvents.clear(); appleEvents.clear();
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"});
  await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}});
  const source = {id:"generated-split",summary:"Generated split",start:{date:"2027-01-01"},end:{date:"2027-01-03"},recurrence:["RRULE:FREQ=DAILY;COUNT=3"]};
  try {
    googleEvents.set(source.id,structuredClone(source));
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    const preservedCopy = structuredClone(googleEvents.get(source.id));
    let items = (await (await request("/api/items",{token:owner.token})).json()).items;
    const root = items.find((item) => item.title === source.summary && item.id === item.seriesId);
    const later = items.find((item) => item.seriesId === root.id && item.id !== root.id);
    const recurrence = {...root.recurrence,end:{type:"count",count:7}};
    assert.equal((await request(`/api/items/${later.id}`,{token:owner.token,method:"PATCH",body:{scope:"following",recurrence}})).status,200);
    items = (await (await request("/api/items",{token:owner.token})).json()).items.filter((item) => item.seriesId === later.id);
    assert.ok(items.length > 2);
    assert.ok(items.every((item) => item.calendarSync.some((status) => status.limitationCode === "imported-series-split")));
    assert.equal((await request(`/api/items/${later.id}`,{token:owner.token,method:"PATCH",body:{scope:"following",recurrence:null}})).status,200);
    items = (await (await request("/api/items",{token:owner.token})).json()).items.filter((item) => item.title === source.summary);
    assert.ok(items.every((item) => item.calendarSync.some((status) => status.state === "limited")));
    const start = providerRequests.length;
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    const unexpectedRequests = providerRequests.slice(start).filter(({path,method}) => (path.includes("/events") || path.startsWith("/apple/")) && ["POST","PUT","PATCH"].includes(method));
    assert.equal(unexpectedRequests.length, 0, `Unexpected provider mutations: ${JSON.stringify(unexpectedRequests.map(({method, path, body, text}) => ({method, path, body: text || body})))}`);
    assert.deepEqual(googleEvents.get(source.id),preservedCopy);
  } finally { googleEvents.clear(); appleEvents.clear(); }
});

test("generated Occurrences from an Apple split stay blocked after detaching", async () => {
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"});
  await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/generated-split.ics";
  const source = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//EN\r\nBEGIN:VEVENT\r\nUID:generated-apple-split\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;VALUE=DATE:20270101\r\nDTEND;VALUE=DATE:20270103\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Apple generated split\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  try {
    appleEvents.set(path,source);
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    const preservedCopy = appleEvents.get(path);
    let items = (await (await request("/api/items",{token:owner.token})).json()).items;
    const root = items.find((item) => item.title === "Apple generated split" && item.id === item.seriesId);
    const later = items.find((item) => item.seriesId === root.id && item.id !== root.id);
    assert.equal((await request(`/api/items/${later.id}`,{token:owner.token,method:"PATCH",body:{scope:"following",recurrence:{...root.recurrence,end:{type:"count",count:7}}}})).status,200);
    items = (await (await request("/api/items",{token:owner.token})).json()).items.filter((item) => item.seriesId === later.id);
    assert.ok(items.length > 2);
    assert.ok(items.every((item) => item.calendarSync.some((status) => status.limitationCode === "imported-series-split")));
    assert.equal((await request(`/api/items/${later.id}`,{token:owner.token,method:"PATCH",body:{scope:"following",recurrence:null}})).status,200);
    items = (await (await request("/api/items",{token:owner.token})).json()).items.filter((item) => item.title === "Apple generated split");
    assert.ok(items.every((item) => item.calendarSync.some((status) => status.state === "limited")));
    const start = providerRequests.length;
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    assert.equal(providerRequests.slice(start).some(({path,method}) => (path.includes("/events") || path.startsWith("/apple/")) && ["POST","PUT","PATCH"].includes(method)),false);
    assert.equal(appleEvents.get(path),preservedCopy);
  } finally { googleEvents.clear(); appleEvents.clear(); }
});

test("overlapping Google recovery creates one mapped replacement", async () => {
  const priorGoogleEvents=googleEvents;
  googleEvents=new Map();
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
  const source = {id: "overlap-recovery-source", summary: "Overlap recovery", start: {date: "2027-01-01"}, end: {date: "2027-01-02"}};
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    googleEvents.set(source.id, structuredClone(source));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === source.summary);
    assert.ok(item);
    googleEvents.delete(source.id);
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    googleInventoryBarrier = {arrivals: 0, ready, release};
    const start = providerRequests.length;
    const timeout = setTimeout(release, 5000);
    const responses = await Promise.all([1, 2].map(() => request("/api/calendars/sync", {token: owner.token, method: "POST"})));
    clearTimeout(timeout);
    assert.ok(googleInventoryBarrier.arrivals >= 2, "both syncs must request inventory");
    googleInventoryBarrier = null;
    assert.ok(responses.every(response => response.status === 200),JSON.stringify(await Promise.all(responses.map(response=>response.clone().text()))));
    const outcomes = await Promise.all(responses.map(response => response.json()));
    const attempts = providerRequests.slice(start);
    assert.ok(attempts.filter(({method, path}) => method === "GET" && path.endsWith("/events")).length >= 2);
    assert.ok(outcomes.every(outcome => outcome.syncLimitations.every(limitation => limitation.itemId === item.id && limitation.message.includes("inventory is incomplete"))), JSON.stringify(outcomes));
    assert.ok(attempts.some(({method, path}) => method === "POST" && path.endsWith("/events")), JSON.stringify(attempts));
    // A concurrent sync can pause while the other inventory is pending. Retry after both settle.
    if (outcomes.some(outcome => outcome.syncLimitations.length)) {
      const retry = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
      assert.equal(retry.status, 200);
      assert.deepEqual((await retry.json()).syncLimitations, []);
    }
    const mappings = db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='google'").all(owner.user.id, item.id);
    assert.equal(mappings.length, 1);
    assert.equal(googleEvents.size, 1, "no replacement may be left orphaned");
    assert.ok(googleEvents.has(mappings[0].external_id), "the sole remote Event must be mapped");
    assert.notEqual(mappings[0].external_id, source.id);
  } finally { googleInventoryBarrier?.release(); googleInventoryBarrier = null; googleEvents=priorGoogleEvents; db.close(); }
});

test("concurrent save and Sync Calendar requests keep one Google and Apple copy", async () => {
  const owner = await account();
  const created = await request("/api/items", {token: owner.token, method: "POST", body: {
    kind: "event", title: "Concurrent provider save", scheduledDate: "2027-02-12",
  }});
  assert.equal(created.status, 201);
  const item = (await created.json()).item;
  const fileResponse = await request("/api/files", {token: owner.token, method: "POST", body: {
    name: "Concurrent save notes", url: "https://example.com/concurrent-save-notes",
  }});
  assert.equal(fileResponse.status, 201);
  const file = (await fileResponse.json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`, {token: owner.token, method: "POST", body: {itemId: item.id}})).status, 201);
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"})).status, 303);
  assert.equal((await request("/api/calendars", {token: owner.token, method: "POST", body: {
    username: "concurrent@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/concurrent/`,
  }})).status, 201);

  let releaseGoogle;
  let arriveGoogle;
  let releaseApple;
  let arriveApple;
  const googleReady = new Promise((resolve) => { releaseGoogle = resolve; });
  const googleArrived = new Promise((resolve) => { arriveGoogle = resolve; });
  const appleReady = new Promise((resolve) => { releaseApple = resolve; });
  const appleArrived = new Promise((resolve) => { arriveApple = resolve; });
  googleInventoryBarrier = {arrivals: 0, ready: googleReady, release: releaseGoogle,
    arrived: () => { if (googleInventoryBarrier.arrivals >= 2) arriveGoogle(); }};
  appleInventoryBarrier = {arrivals: 0, ready: appleReady, release: releaseApple,
    arrived: () => { if (appleInventoryBarrier.arrivals >= 2) arriveApple(); }};
  let timeout;
  let requests=[];
  try {
    requests = [
      request(`/api/items/${item.id}`, {token: owner.token, method: "PATCH", body: {title: "Concurrent provider save updated"}}),
      request("/api/calendars/sync", {token: owner.token, method: "POST"}),
    ];
    timeout = setTimeout(() => { releaseGoogle(); releaseApple(); arriveGoogle(); arriveApple(); }, 5000);
    await Promise.all([googleArrived, appleArrived]);
    assert.ok(googleInventoryBarrier.arrivals >= 2, "both overlapping requests must reach the shared Google fake");
    assert.ok(appleInventoryBarrier.arrivals >= 2, "both overlapping requests must reach the shared Apple fake");
    releaseGoogle();
    releaseApple();
    const responses = await Promise.all(requests);
    clearTimeout(timeout);
    timeout = undefined;
    assert.ok(responses.every((response) => response.status === 200), (await Promise.all(responses.map((response) => response.clone().text()))).join("\n"));
    const db = new DatabaseSync(join(directory, "workspace.sqlite"));
    try {
      for (const provider of ["google", "apple"]) {
        assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_copies WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id).count, 1);
      }
      assert.equal([...googleEvents.values()].filter((entry) => entry.description?.includes(item.id)).length, 1, "concurrent sync must keep one Google resource for this Event");
      assert.equal([...appleEvents.values()].filter((entry) => entry.includes(`?event=${item.id}`)).length, 1, "concurrent sync must keep one Apple resource for this Event");
      const saved = (await (await request("/api/items", {token: owner.token})).json()).items.find((entry) => entry.id === item.id);
      assert.equal(saved.title, "Concurrent provider save updated");
      assert.deepEqual(saved.files.map(({id}) => id), [file.id], "the intended Event keeps its File association");
      assert.ok([...googleEvents.values()].find((entry) => entry.description?.includes(item.id)), "the Google Calendar copy keeps its Event backlink");
      assert.ok([...appleEvents.values()].find((entry) => entry.includes(`?event=${item.id}`)), "the Apple Calendar copy keeps its Event backlink");
    } finally { db.close(); }
  } finally {
    clearTimeout(timeout);
    releaseGoogle();
    releaseApple();
    await Promise.allSettled(requests);
    googleInventoryBarrier = null;
    appleInventoryBarrier = null;
  }
});

test("calendar export coordination spans API processes and does not block another account", async () => {
  const owner=await account();
  const other=await account();
  const createEvent=async(token,title,date)=>{
    const response=await request("/api/items",{token,method:"POST",body:{kind:"event",title,scheduledDate:date}});
    assert.equal(response.status,201);
    return (await response.json()).item;
  };
  const item=await createEvent(owner.token,"Before distributed export","2027-02-18");
  const otherItem=await createEvent(other.token,"Independent destination","2027-02-19");
  const connect=async(user)=>{
    const auth=await beginGoogleAuthorization(user);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
  };
  await connect(owner); await connect(other);
  const replica=await startCalendarApiReplica(3112);
  const requestReplica=(path,{token,method="GET",body}={})=>fetch(`http://localhost:${replica.port}${path}`,{
    method,headers:{...(token?{Authorization:`Bearer ${token}`}:{"Authorization":"Bearer test-worker-secret"}),...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  let release;
  let started;
  const held=new Promise((resolve)=>{started=resolve;});
  const released=new Promise((resolve)=>{release=resolve;});
  let firstSync;
  let concurrentSync;
  let edited;
  holdNextCalendarCreation={provider:"google",created:started,releasePromise:released,release};
  try {
    firstSync=request("/api/calendars/sync",{token:owner.token,method:"POST"});
    await held;
    assert.equal([...googleEvents.values()].filter((event)=>event.description?.includes(item.id)).length,1,"the first process has created its reserved Google resource");

    const independent=await requestReplica("/api/calendars/sync",{token:other.token,method:"POST"});
    assert.equal(independent.status,200,await independent.text());
    assert.equal([...googleEvents.values()].filter((event)=>event.description?.includes(otherItem.id)).length,1,
      "an unrelated account can export while another destination is held");

    concurrentSync=requestReplica("/api/calendars/sync",{token:owner.token,method:"POST"});
    edited=requestReplica(`/api/items/${item.id}`,{token:owner.token,method:"PATCH",body:{title:"After distributed export"}});
    const sharedDb=new DatabaseSync(join(directory,"workspace.sqlite"));
    try {
      const deadline=Date.now()+5000;
      while(Date.now()<deadline&&sharedDb.prepare("SELECT title FROM items WHERE user_id=? AND id=?").get(owner.user.id,item.id)?.title!=="After distributed export") await delay(10);
      assert.equal(sharedDb.prepare("SELECT title FROM items WHERE user_id=? AND id=?").get(owner.user.id,item.id)?.title,"After distributed export",
        "the Event edit should commit before releasing the older provider write");
    } finally { sharedDb.close(); }
    release();
    const first=await firstSync;
    assert.equal(first.status,200,await first.text());
    const [syncResponse,editResponse]=await Promise.all([concurrentSync,edited]);
    assert.equal(syncResponse.status,200,await syncResponse.text());
    assert.equal(editResponse.status,200,await editResponse.text());
    const db=new DatabaseSync(join(directory,"workspace.sqlite"));
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=?").get(owner.user.id,item.id).count,1);
      const copy=[...googleEvents.values()].find((event)=>event.description?.includes(item.id));
      assert.ok(copy,"the provider contains the FileTasks copy");
      assert.equal(copy.summary,"After distributed export","the later process must reconcile the newest Event payload");
      assert.equal([...googleEvents.values()].filter((event)=>event.description?.includes(item.id)).length,1,"the two processes retain one provider identity");
      assert.deepEqual((await (await request("/api/calendars",{token:owner.token})).json()).syncDelivery,[],"a stale generation must not leave delivery falsely pending or falsely clear a later edit");
    } finally { db.close(); }
  } finally {
    release?.(); holdNextCalendarCreation=null;
    await firstSync?.catch(()=>{}); await concurrentSync?.catch(()=>{}); await edited?.catch(()=>{});
    await stopCalendarApiReplica(replica);
  }
});

test("a blocked Google calendar does not serialize a different account", async () => {
  const first = await account();
  const second = await account();
  const connect = async (owner) => {
    const auth = await beginGoogleAuthorization(owner);
    assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"})).status, 303);
  };
  const firstEventResponse = await request("/api/items", {token: first.token, method: "POST", body: {
    kind: "event", title: "Blocked account copy", scheduledDate: "2027-02-14",
  }});
  const secondEventResponse = await request("/api/items", {token: second.token, method: "POST", body: {
    kind: "event", title: "Independent account copy", scheduledDate: "2027-02-15",
  }});
  const firstEvent = (await firstEventResponse.json()).item;
  const secondEvent = (await secondEventResponse.json()).item;
  await connect(first);
  await connect(second);

  let signalCreated;
  let release;
  const providerCreated = new Promise((resolve) => { signalCreated = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  let firstSync;
  let secondSync;
  holdNextCalendarCreation = {provider: "google", created: signalCreated, releasePromise, release};
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    firstSync = request("/api/calendars/sync", {token: first.token, method: "POST"});
    await providerCreated;
    secondSync = request("/api/calendars/sync", {token: second.token, method: "POST"});
    let timer;
    const result = await Promise.race([
      secondSync.then((response) => ({response})),
      new Promise((resolve) => { timer = setTimeout(() => resolve({timedOut: true}), 3000); }),
    ]);
    clearTimeout(timer);
    assert.ok(result.response, "another account should sync while the first provider create is held at the shared fake");
    assert.equal(result.response.status, 200, await result.response.text());
    assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=?").get(second.user.id,secondEvent.id).count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=?").get(first.user.id,firstEvent.id).count, 0,
      "the held first account should not commit before its provider response");
    release();
    const firstResponse = await firstSync;
    assert.equal(firstResponse.status, 200);
    assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=?").get(first.user.id,firstEvent.id).count, 1);
  } finally {
    release();
    await firstSync?.catch(() => {});
    await secondSync?.catch(() => {});
    holdNextCalendarCreation = null;
    db.close();
  }
});

test("Google and Apple provider creations recover their reserved copy after a server restart", async () => {
  const owner = await account();
  const created = await request("/api/items", {token: owner.token, method: "POST", body: {
    kind: "event", title: "Interrupted provider creation", scheduledDate: "2027-02-13",
  }});
  assert.equal(created.status, 201);
  const item = (await created.json()).item;
  const fileResponse = await request("/api/files", {token: owner.token, method: "POST", body: {
    name: "Recovery notes", url: "https://example.com/recovery-notes",
  }});
  const file = (await fileResponse.json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`, {token: owner.token, method: "POST", body: {itemId: item.id}})).status, 201);
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"})).status, 303);
  assert.equal((await request("/api/calendars", {token: owner.token, method: "POST", body: {
    username: "recovery@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/recovery/`,
  }})).status, 201);
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  let activeGate;
  try {
    for (const provider of ["google", "apple"]) {
      removeProviderCopyForTest(db,owner.user.id,provider,item.id);
      let signalCreated;
      let release;
      const providerCreated = new Promise((resolve) => { signalCreated = resolve; });
      const releasePromise = new Promise((resolve) => { release = resolve; });
      activeGate = {provider, created: signalCreated, releasePromise, release};
      holdNextCalendarCreation = activeGate;
      const interrupted = request("/api/calendars/sync", {token: owner.token, method: "POST"})
        .then((response) => ({response}), (error) => ({error}));
      await providerCreated;
      assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_copies WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id).count, 0,
        `${provider} creation must be observable before its local identity is committed`);
      const createdResource = provider === "google"
        ? [...googleEvents.values()].find((entry) => entry.description?.includes(item.id))?.id
        : [...appleEvents.entries()].find(([,entry]) => entry.includes(`?event=${item.id}`))?.[0];
      assert.ok(createdResource, `${provider} provider should have committed the copy before local completion`);
      if (provider === "google") assert.equal([...googleEvents.values()].filter((entry) => entry.description?.includes(item.id)).length, 1, "Google provider has committed the reserved Event");
      else assert.equal([...appleEvents.values()].filter((entry) => entry.includes(`?event=${item.id}`)).length, 1, "Apple provider has committed the reserved Event");

      await stopServer();
      release();
      activeGate = undefined;
      await interrupted;
      await startServer();
      if (provider === "google") {
        const edited = await request(`/api/items/${item.id}`, {token:owner.token,method:"PATCH",body:{title:"Edited before reserved ID retry"}});
        assert.equal(edited.status,200,await edited.text());
        assert.equal(googleEvents.get(createdResource)?.summary,"Edited before reserved ID retry",
          "verified reserved-ID recovery must repair the provider copy with the current Event payload before succeeding");
      }
      const retry = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
      assert.equal(retry.status, 200, await retry.text());
      assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_copies WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id).count, 1,
        `${provider} retry must recover the reserved Calendar copy`);
      const mapping = db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id);
      assert.equal(provider === "google" ? mapping.external_id : new URL(mapping.external_id).pathname, createdResource,
        `${provider} retry must track the same provider resource that existed before interruption`);
      const resourceCount = provider === "google"
        ? [...googleEvents.values()].filter((entry) => entry.description?.includes(item.id)).length
        : [...appleEvents.values()].filter((entry) => entry.includes(`?event=${item.id}`)).length;
      assert.equal(resourceCount, 1, `${provider} retry must not create a second resource`);
    }

    const saved = (await (await request("/api/items", {token: owner.token})).json()).items.find((entry) => entry.id === item.id);
    assert.deepEqual(saved.files.map(({id}) => id), [file.id], "recovery preserves the Event's File association");
    assert.ok([...googleEvents.values()].find((entry) => entry.description?.includes(item.id)), "recovered Google copy keeps its Event backlink");
    assert.ok([...appleEvents.values()].find((entry) => entry.includes(`?event=${item.id}`)), "recovered Apple copy keeps its Event backlink");
    assert.deepEqual((await (await request("/api/calendars", {token: owner.token})).json()).syncDelivery, [], "visible sync status resolves after retry");
  } finally {
    activeGate?.release();
    holdNextCalendarCreation = null;
    db.close();
  }
});

test("deleting an Event after interrupted provider creation reconciles its reservation after restart", async () => {
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  let gate;
  try {
    for(const provider of ["google","apple"]){
      const owner=await account();
      const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:`Deleted interrupted ${provider} Event`,scheduledDate:"2027-02-20"}});
      assert.equal(created.status,201);
      const item=(await created.json()).item;
      if(provider==="google"){
        const auth=await beginGoogleAuthorization(owner);
        assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
      }else{
        assert.equal((await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"cleanup@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/cleanup-${item.id}/`}})).status,201);
      }
      removeProviderCopyForTest(db,owner.user.id,provider,item.id);
      let signalCreated;
      let release;
      const providerCreated=new Promise((resolve)=>{signalCreated=resolve;});
      const releasePromise=new Promise((resolve)=>{release=resolve;});
      gate={provider,created:signalCreated,releasePromise,release};
      holdNextCalendarCreation=gate;
      const interrupted=request("/api/calendars/sync",{token:owner.token,method:"POST"}).then((response)=>({response}),error=>({error}));
      await providerCreated;
      const copy=provider==="google"
        ? [...googleEvents.values()].find((event)=>event.description?.includes(item.id))
        : [...appleEvents.entries()].find(([,ics])=>ics.includes(`?event=${item.id}`));
      assert.ok(copy,`${provider} provider committed the copy before local completion`);
      await stopServer();
      db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(owner.user.id,item.id);
      assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_creation_cleanup WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id).count,1,
        `${provider} reservation identity must survive Event deletion`);
      release(); gate=undefined; holdNextCalendarCreation=null;
      await interrupted;
      await startServer();
      if(provider==="google") failNextGoogleRequest={method:"DELETE",path:`/google/calendar/v3/calendars/primary/events/${copy.id}`,status:403};
      else failNextAppleRequest={method:"DELETE",path:copy[0],status:403};
      const retried=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
      assert.ok([200,502].includes(retried.status),await retried.text());
      const deniedStatus=(await (await request("/api/calendars",{token:owner.token})).json()).syncDelivery
        .find((entry)=>entry.provider===provider);
      assert.equal(deniedStatus?.reauthorizationRequired,true,`${provider} cleanup-ledger 403 remains actionable`);
      assert.ok(db.prepare("SELECT 1 FROM calendar_creation_cleanup WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id),
        `${provider} cleanup intent remains after denied deletion`);
      if(provider==="google") assert.ok(googleEvents.has(copy.id));
      else assert.ok(appleEvents.has(copy[0]));
      failNextGoogleRequest=null;
      failNextAppleRequest=null;
      const cleanupRetry=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
      assert.equal(cleanupRetry.status,200,await cleanupRetry.text());
      const cleanup=db.prepare("SELECT uncertain,pending_attempts FROM calendar_creation_cleanup WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id);
      assert.ok(cleanup && (cleanup.uncertain || cleanup.pending_attempts),
        `${provider} retains cleanup intent while the interrupted attempt remains uncertain`);
      assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_imports WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id).count,0,
        `${provider} stale provider resource must not be imported after deletion`);
      if(provider==="google") assert.equal([...googleEvents.values()].some((event)=>event.description?.includes(item.id)),false);
      else assert.equal([...appleEvents.values()].some((ics)=>ics.includes(`?event=${item.id}`)),false);
    }
  } finally {
    gate?.release(); holdNextCalendarCreation=null;
    try { if(!server&&!interruptedSignal) await startServer(); }
    finally { db.close(); }
  }
});

test("deleting while a reserved creation is held before provider commit retains and reconciles both identities", async () => {
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  let gate;
  try {
    for (const provider of ["google","apple"]) {
      const owner=await account();
      const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:`Delete before ${provider} commit`,scheduledDate:"2027-03-02"}});
      assert.equal(created.status,201);
      const item=(await created.json()).item;
      if (provider === "google") {
        const auth=await beginGoogleAuthorization(owner);
        assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
      } else {
        assert.equal((await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"before-commit@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/before-commit-${item.id}/`}})).status,201);
      }
      removeProviderCopyForTest(db,owner.user.id,provider,item.id);
      let started;
      let release;
      const held=new Promise((resolve)=>{started=resolve;});
      const releasePromise=new Promise((resolve)=>{release=resolve;});
      gate={provider,beforeCommit:true,created:started,releasePromise,release};
      holdNextCalendarCreation=gate;
      const exporting=request("/api/calendars/sync",{token:owner.token,method:"POST"}).then(response=>({response}),error=>({error}));
      await held;
      const reservation=db.prepare("SELECT * FROM calendar_creation_cleanup WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id);
      assert.equal(reservation,undefined,"the reserved identity is still attached to the live Event before delete");
      assert.equal(provider === "google"
        ? [...googleEvents.values()].some(event=>event.description?.includes(item.id))
        : [...appleEvents.values()].some(ics=>ics.includes(`?event=${item.id}`)),false,"the provider side effect has not happened yet");

      const deleting=request(`/api/items/${item.id}`,{token:owner.token,method:"DELETE"});
      const deadline=Date.now()+5000;
      while(Date.now()<deadline&&db.prepare("SELECT 1 FROM items WHERE user_id=? AND id=?").get(owner.user.id,item.id)) await delay(10);
      assert.equal(db.prepare("SELECT 1 FROM items WHERE user_id=? AND id=?").get(owner.user.id,item.id),undefined,"delete commits locally while export is held");
      assert.equal(db.prepare("SELECT uncertain FROM calendar_creation_cleanup WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id)?.uncertain,1,
        "the cleanup tombstone records that the provider request may still commit");

      release();
      gate=undefined; holdNextCalendarCreation=null;
      await Promise.all([exporting,deleting]);
      const retry=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
      assert.equal(retry.status,200,await retry.text());
      const cleanup=db.prepare("SELECT uncertain,pending_attempts FROM calendar_creation_cleanup WHERE user_id=? AND provider=? AND item_id=?").get(owner.user.id,provider,item.id);
      assert.equal(cleanup,undefined,`${provider} cleanup resolves after the completed attempt is reconciled`);
      assert.equal(provider === "google"
        ? [...googleEvents.values()].some(event=>event.description?.includes(item.id))
        : [...appleEvents.values()].some(ics=>ics.includes(`?event=${item.id}`)),false,"only the reserved resource is reconciled");
    }
  } finally {
    gate?.release(); holdNextCalendarCreation=null;
    db.close();
  }
});

test("Apple cleanup retains an unresolved create through takeover, delete, and its late commit", async () => {
  const owner=await account();
  const eventDate=new Date(testClock.getTime()+86_400_000).toISOString().slice(0,10);
  const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:"Apple held creation",scheduledDate:eventDate}});
  const item=(await created.json()).item;
  assert.equal((await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"held-create@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/held-create-${item.id}/`}})).status,201);
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  removeProviderCopyForTest(db,owner.user.id,"apple",item.id);
  let release; let started;
  const held=new Promise(resolve=>{started=resolve;});
  const releasePromise=new Promise(resolve=>{release=resolve;});
  let exporting;
  try {
    holdNextCalendarCreation={provider:"apple",beforeCommit:true,created:started,releasePromise,release};
    exporting=request("/api/calendars/sync",{token:owner.token,method:"POST"}).then(response=>({response}),error=>({error}));
    await held;
    assert.equal(db.prepare("SELECT active_attempts FROM apple_creation_reservations WHERE user_id=? AND item_id=?").get(owner.user.id,item.id).active_attempts,1);

    db.prepare("UPDATE calendar_sync_state SET generation=generation+1,state='pending',attempts=0,next_attempt_at=0,last_attempt_at=NULL,last_error=NULL WHERE user_id=? AND provider='apple'").run(owner.user.id);
    db.prepare("UPDATE calendar_export_locks SET owner_token='apple-takeover',fence=fence+1,lease_until=0 WHERE user_id=? AND provider='apple'").run(owner.user.id);
    const takeover=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(takeover.status,200,await takeover.text());
    const mapping=db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id);
    assert.ok(mapping,"the takeover maps the resource created while the first PUT remains unresolved");
    const hasCopy=()=>[...appleEvents.values()].some(ics=>ics.includes(`?event=${item.id}`));
    assert.equal(hasCopy(),true);
    assert.equal(db.prepare("SELECT active_attempts FROM apple_creation_reservations WHERE user_id=? AND item_id=?").get(owner.user.id,item.id).active_attempts,1,
      "the takeover completion must not clear the older in-flight attempt");

    const deleted=await request(`/api/items/${item.id}`,{token:owner.token,method:"DELETE"});
    assert.equal(deleted.status,204);
    const tombstone=db.prepare("SELECT uncertain,pending_attempts FROM calendar_creation_cleanup WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id);
    assert.deepEqual({...tombstone},{uncertain:1,pending_attempts:1},"deletion retains the unresolved provider request identity");
    assert.equal(hasCopy(),false,"delete removes the mapped copy but keeps the tombstone while the older PUT is unresolved");

    release(); holdNextCalendarCreation=null;
    await exporting;
    assert.equal(hasCopy(),false,"ownership recovery reconciles the late provider commit immediately");
    assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_creation_cleanup WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id).count,0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM calendar_imports WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id).count,0,
      "the deleted Apple Event is not reimported");
    assert.equal(db.prepare("SELECT count(*) AS count FROM items WHERE user_id=? AND id=?").get(owner.user.id,item.id).count,0);
  } finally {
    release?.(); holdNextCalendarCreation=null;
    await exporting?.catch(()=>{});
    db.close();
  }
});

async function seedMappedAppleCopy(owner,item,calendarName) {
  const calendarUrl=`${deliveryBase}/apple/${calendarName}/`;
  const connected=await request("/api/calendars",{token:owner.token,method:"POST",body:{username:`${calendarName}@example.com`,password:"app-specific-password",calendarUrl}});
  assert.equal(connected.status,201,await connected.text());
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  try {
    const connection=db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='apple'").get(owner.user.id);
    assert.ok(connection?.connection_scope_id);
    const resourceUid=`mapped-${item.id}@filetasks`;
    const externalId=`${calendarUrl}${encodeURIComponent(resourceUid)}.ics`;
    const path=new URL(externalId).pathname;
    const ics=appleCalendarFixture({uid:resourceUid,date:item.scheduledDate.replaceAll("-","")})
      .replace("SUMMARY:Imported calendar event",`URL:${base}/?event=${item.id}\r\nSUMMARY:${item.title}`);
    db.prepare(`INSERT INTO apple_creation_reservations(user_id,item_id,provider,connection_scope_id,resource_uid,attempted,active_attempts)
      VALUES(?,?,'apple',?,?,1,0)`).run(owner.user.id,item.id,connection.connection_scope_id,resourceUid);
    db.prepare(`INSERT INTO calendar_copies(user_id,provider,item_id,external_id,resource_uid,connection_scope_id)
      VALUES(?,'apple',?,?,?,?)`).run(owner.user.id,item.id,externalId,resourceUid,connection.connection_scope_id);
    appleEvents.set(path,ics);
    appleEventVersions.set(path,1);
    return {path,externalId,resourceUid,connectionScopeId:connection.connection_scope_id,ics};
  } finally { db.close(); }
}

test("a mapped Apple deletion is settled after a crash between provider deletion and local cleanup", async () => {
  const owner=await account();
  const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:"Mapped deletion recovery",scheduledDate:"2027-03-04"}});
  assert.equal(created.status,201);
  const item=(await created.json()).item;
  const copy=await seedMappedAppleCopy(owner,item,`mapped-delete-${item.id}`);

  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  let gate;
  let crashedWorker;
  let recoveryWorker;
  let interrupted;
  try {
    const mapping=db.prepare("SELECT external_id,resource_uid,connection_scope_id FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id);
    assert.equal(mapping.external_id,copy.externalId);
    assert.equal(mapping.resource_uid,copy.resourceUid);
    assert.equal(mapping.connection_scope_id,copy.connectionScopeId);
    const path=copy.path;

    // Keep the real deletion tombstone and mapping, as if the process stopped
    // after Apple accepted DELETE but before the local cleanup transaction.
    db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(owner.user.id,item.id);
    assert.equal(db.prepare("SELECT external_id FROM calendar_creation_cleanup WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id).external_id,mapping.resource_uid);

    let started;
    let release;
    const startedPromise=new Promise(resolve=>{started=resolve;});
    const releasePromise=new Promise(resolve=>{release=resolve;});
    gate={path,started,releasePromise,release};
    holdNextAppleDelete=gate;
    crashedWorker=await startCalendarApiReplica(3120);
    interrupted=fetch(`http://localhost:${crashedWorker.port}/api/calendars/sync`,{method:"POST",headers:{Authorization:`Bearer ${owner.token}`}})
      .then(response=>({response}),error=>({error}));
    await startedPromise;
    assert.equal(appleEvents.has(path),false,"Apple has accepted the deletion while the cleanup request is still waiting for its response");
    assert.ok(db.prepare("SELECT 1 FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=? AND resource_uid=?").get(owner.user.id,item.id,mapping.resource_uid),
      "the local mapping remains until the provider response is committed");
    assert.ok(db.prepare("SELECT 1 FROM calendar_creation_cleanup WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id),
      "the durable cleanup tombstone remains through the crash window");

    await stopCalendarApiReplica(crashedWorker);
    crashedWorker=undefined;
    gate.release();
    holdNextAppleDelete=null;
    await interrupted;
    interrupted=undefined;

    recoveryWorker=await startCalendarApiReplica(3121);
    const retry=await fetch(`http://localhost:${recoveryWorker.port}/api/calendars/sync`,{method:"POST",headers:{Authorization:`Bearer ${owner.token}`}});
    assert.equal(retry.status,200,await retry.text());
    assert.equal(db.prepare("SELECT 1 FROM calendar_creation_cleanup WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id),undefined,
      "restart verifies the provider's 404 and settles the cleanup tombstone");
    assert.equal(db.prepare("SELECT 1 FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id),undefined,
      "restart removes only the mapped copy whose Apple identity was verified absent");
    assert.equal(appleEvents.has(path),false);
  } finally {
    gate?.release();
    holdNextAppleDelete=null;
    if(interrupted) await interrupted;
    if(crashedWorker) await stopCalendarApiReplica(crashedWorker);
    if(recoveryWorker) await stopCalendarApiReplica(recoveryWorker);
    db.close();
  }
});

test("streamed Apple cleanup rejects a replaced resource and a stale connection", async () => {
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  let replica;
  let gate;
  let syncing;
  try {
    for (const scenario of ["replacement","reconnect"]) {
      const owner=await account();
      const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:`Streamed cleanup ${scenario}`,scheduledDate:"2027-03-05"}});
      assert.equal(created.status,201);
      const item=(await created.json()).item;
      const calendarName=`streamed-${scenario}-${item.id}`;
      const copy=await seedMappedAppleCopy(owner,item,calendarName);
      const connect=(name)=>request("/api/calendars",{token:owner.token,method:"POST",body:{username:`${name}@example.com`,password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/${name}/`}});
      const mapping=db.prepare("SELECT external_id,resource_uid FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id);
      assert.equal(mapping.external_id,copy.externalId);
      assert.equal(mapping.resource_uid,copy.resourceUid);
      const path=copy.path;
      const original=copy.ics;
      db.prepare("DELETE FROM items WHERE user_id=? AND id=?").run(owner.user.id,item.id);

      let started;
      let release;
      const startedPromise=new Promise(resolve=>{started=resolve;});
      const releasePromise=new Promise(resolve=>{release=resolve;});
      gate={path,started,releasePromise,release};
      holdNextAppleBody=gate;
      replica=await startCalendarApiReplica(scenario==="replacement" ? 3122 : 3123);
      const deleteStart=providerRequests.filter(entry=>entry.path===path&&entry.method==="DELETE").length;
      syncing=fetch(`http://localhost:${replica.port}/api/calendars/sync`,{method:"POST",headers:{Authorization:`Bearer ${owner.token}`}})
        .then(response=>({response}),error=>({error}));
      await startedPromise;

      if (scenario==="replacement") {
        const replacement=original.replace(`?event=${item.id}`,"?event=replacement-owned");
        assert.notEqual(replacement,original);
        appleEvents.set(path,replacement);
        appleEventVersions.set(path,(appleEventVersions.get(path)??1)+1);
        gate.release();
        gate=undefined;
        holdNextAppleBody=null;
        const result=await syncing;
        syncing=undefined;
        assert.ok(result.response,"the provider replacement should complete as a failed safe cleanup request");
        assert.equal(result.response.status,502,await result.response.text());
        const deletes=providerRequests.filter(entry=>entry.path===path&&entry.method==="DELETE").slice(deleteStart);
        assert.equal(deletes.length,1,"the verifier must attempt one conditional delete for the version it read");
        assert.equal(deletes[0].headers["if-match"],`"apple-${(appleEventVersions.get(path)??1)-1}"`,
          "Apple DELETE must carry the ETag from the streamed response");
        assert.equal(appleEvents.get(path),replacement,"the replacement that changed during the body read must survive the stale ETag");
        assert.ok(db.prepare("SELECT 1 FROM calendar_creation_cleanup WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id),
          "a rejected conditional delete keeps cleanup pending for a later verification");
        assert.ok(db.prepare("SELECT 1 FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=? AND resource_uid=?").get(owner.user.id,item.id,mapping.resource_uid),
          "the failed delete retains the exact local mapping");
      } else {
        const replacementName=`streamed-reconnected-${item.id}`;
        assert.equal((await connect(replacementName)).status,201,"reconnect changes the active Apple connection while the old response body is streaming");
        gate.release();
        gate=undefined;
        holdNextAppleBody=null;
        const result=await syncing;
        syncing=undefined;
        assert.ok(result.response,"the stale sync should return its ownership error");
        assert.equal(result.response.status,409,await result.response.text());
        assert.equal(providerRequests.filter(entry=>entry.path===path&&entry.method==="DELETE").length,deleteStart,
          "the old connection must be revalidated after the streamed body and before deletion");
        assert.equal(appleEvents.get(path),original,"reconnect cannot delete the old resource with stale credentials");
        assert.ok(db.prepare("SELECT 1 FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=? AND resource_uid=?").get(owner.user.id,item.id,mapping.resource_uid),
          "the old connection mapping remains intact when the stale cleanup is rejected");
      }
      await stopCalendarApiReplica(replica);
      replica=undefined;
    }
  } finally {
    gate?.release();
    holdNextAppleBody=null;
    if(syncing) await syncing;
    if(replica) await stopCalendarApiReplica(replica);
    db.close();
  }
});

test("mapped Google and Apple updates stay fenced through takeover and late worker crash", async () => {
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  try {
    for (const provider of ["google","apple"]) {
      const owner=await account();
      const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:"Before takeover",scheduledDate:"2027-03-03"}});
      const item=(await created.json()).item;
      if (provider === "google") {
        const auth=await beginGoogleAuthorization(owner);
        assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
      } else {
        assert.equal((await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"takeover@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/takeover-${item.id}/`}})).status,201);
      }
      assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
      if (provider === "google") {
        const [externalId,event]=[...googleEvents.entries()].find(([,entry])=>entry.description?.includes(item.id));
        googleEvents.set(externalId,{...event,summary:"Provider-side edit"});
      } else {
        const [path,ics]=[...appleEvents.entries()].find(([,entry])=>entry.includes(`?event=${item.id}`));
        appleEvents.set(path,ics.replace("SUMMARY:Before takeover","SUMMARY:Provider-side edit"));
      }
      const replica=await startCalendarApiReplica(3124);
      const requestReplica=(path,options={})=>fetch(`http://localhost:${replica.port}${path}`,{
        method:options.method??"GET",headers:{Authorization:`Bearer ${owner.token}`,...(options.body?{"Content-Type":"application/json"}:{})},
        ...(options.body?{body:JSON.stringify(options.body)}:{}),
      });
      let release;
      let started;
      let staleSync;
      let replicaStopped=false;
      const held=new Promise(resolve=>{started=resolve;});
      const releasePromise=new Promise(resolve=>{release=resolve;});
      holdNextCalendarUpdate={provider,started,releasePromise};
      try {
        staleSync=requestReplica("/api/calendars/sync",{method:"POST"}).then(response=>({response}),error=>({error}));
        await held;
        const latestTitle="After provider takeover";
        db.prepare("UPDATE items SET title=?,updated_at=? WHERE user_id=? AND id=?").run(latestTitle,new Date().toISOString(),owner.user.id,item.id);
        db.prepare(`UPDATE calendar_sync_state SET generation=generation+1,state='pending',attempts=0,next_attempt_at=0,last_attempt_at=NULL,last_error=NULL
          WHERE user_id=? AND provider=?`).run(owner.user.id,provider);
        db.prepare("UPDATE calendar_export_locks SET owner_token='test-takeover',fence=fence+1,lease_until=0 WHERE user_id=? AND provider=?").run(owner.user.id,provider);
        const latest=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
        assert.equal(latest.status,200,await latest.text());
        if (provider === "google") {
          const providerEvent=[...googleEvents.values()].find(event=>event.description?.includes(item.id));
          assert.equal(providerEvent.summary,latestTitle,"the newer generation commits its authoritative payload");
          assert.ok(Number(providerEvent.extendedProperties.private.filetasksSyncGeneration)>0,"the provider copy records the committed generation as a string");
        } else {
          const providerEvent=[...appleEvents.values()].find(ics=>ics.includes(`?event=${item.id}`));
          assert.ok(providerEvent.includes(`SUMMARY:${latestTitle}`),"the newer Apple generation commits its authoritative payload");
          assert.ok(providerEvent.includes("X-FILETASKS-SYNC-GENERATION:"),"the Apple resource records the committed generation");
        }

        await stopCalendarApiReplica(replica);
        replicaStopped=true;
        release(); holdNextCalendarUpdate=null;
        await staleSync;
        const state=db.prepare("SELECT state,attempts FROM calendar_sync_state WHERE user_id=? AND provider=?").get(owner.user.id,provider);
        assert.deepEqual({...state},{state:"synced",attempts:0},"the crashed stale generation cannot leave the newer sync marked failed");
        if (provider === "google") {
          assert.equal([...googleEvents.values()].find(event=>event.description?.includes(item.id)).summary,latestTitle,
            "Google rejects the stale write with its old ETag after the newer commit");
        } else {
          assert.ok([...appleEvents.values()].find(ics=>ics.includes(`?event=${item.id}`)).includes(`SUMMARY:${latestTitle}`),
            "Apple rejects the stale write with its old ETag after the newer commit");
        }
      } finally {
        release?.(); holdNextCalendarUpdate=null;
        await staleSync?.catch(()=>{});
        if (!replicaStopped) await stopCalendarApiReplica(replica);
      }
    }
  } finally {
    db.close();
  }
});

test("Calendar retry deadlines increase and the worker runs only when delivery is due", async () => {
  const owner=await account();
  const auth=await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  try {
    deferOtherCalendarRetriesForTest(db,owner.user.id);
    const inventoryPath="/google/calendar/v3/calendars/primary/events";
    failNextGoogleRequest={path:inventoryPath,method:"GET"};
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    const first=db.prepare("SELECT attempts,next_attempt_at FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id);
    assert.equal(first.attempts,1);
    assert.equal(first.next_attempt_at,testClock.getTime()+30_000,"the first failure schedules the base delay");
    const workerHeaders={Authorization:"Bearer test-worker-secret"};
    const early=await request("/api/internal/reminders/deliver",{method:"POST",headers:workerHeaders});
    const earlyResult=await early.json();
    assert.equal(early.status,200,JSON.stringify(earlyResult));
    assert.equal(earlyResult.calendarSync.attempted,0,"the worker ignores a retry before its deadline");
    assert.equal(db.prepare("SELECT attempts FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id).attempts,1);

    await advanceTestClock(first.next_attempt_at-testClock.getTime());
    failNextGoogleRequest={path:inventoryPath,method:"GET"};
    const retried=await request("/api/internal/reminders/deliver",{method:"POST",headers:workerHeaders});
    const retriedResult=await retried.json();
    assert.equal(retried.status,200,JSON.stringify(retriedResult));
    const second=db.prepare("SELECT attempts,next_attempt_at FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id);
    assert.equal(second.attempts,2,"the due worker preserves the prior failure count");
    assert.equal(second.next_attempt_at,testClock.getTime()+60_000,"the second failure doubles the retry delay");
    assert.ok(second.next_attempt_at>first.next_attempt_at,"each failure moves the retry deadline forward");
    const beforeSecondDeadline=await request("/api/internal/reminders/deliver",{method:"POST",headers:workerHeaders});
    const beforeSecondDeadlineResult=await beforeSecondDeadline.json();
    assert.equal(beforeSecondDeadline.status,200,JSON.stringify(beforeSecondDeadlineResult));
    assert.equal(beforeSecondDeadlineResult.calendarSync.attempted,0,"the worker waits through the longer second delay");

    await advanceTestClock(second.next_attempt_at-testClock.getTime());
    const success=await request("/api/internal/reminders/deliver",{method:"POST",headers:workerHeaders});
    const successResult=await success.json();
    assert.equal(success.status,200,JSON.stringify(successResult));
    assert.equal(db.prepare("SELECT attempts FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id).attempts,0,
      "successful delivery resets the retry count");
  } finally { failNextGoogleRequest=null; db.close(); }
});

test("two calendar workers atomically claim one due generation", async () => {
  const owner=await account();
  const auth=await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  const replica=await startCalendarApiReplica(3114);
  try {
    deferOtherCalendarRetriesForTest(db,owner.user.id);
    const inventoryPath="/google/calendar/v3/calendars/primary/events";
    failNextGoogleRequest={path:inventoryPath,method:"GET"};
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    const due=db.prepare("SELECT next_attempt_at FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id);
    await advanceTestClock(due.next_attempt_at-testClock.getTime());
    const before=providerRequests.filter(entry=>entry.path===inventoryPath&&entry.method==="GET").length;
    const headers={Authorization:"Bearer test-worker-secret"};
    const [first,second]=await Promise.all([
      request("/api/internal/reminders/deliver",{method:"POST",headers}),
      fetch(`http://localhost:${replica.port}/api/internal/reminders/deliver`,{method:"POST",headers}),
    ]);
    assert.equal(first.status,200);
    assert.equal(second.status,200);
    const results=await Promise.all([first.json(),second.json()]);
    assert.equal(results.reduce((sum,result)=>sum+result.calendarSync.attempted,0),1,
      "only the worker that atomically claims the due generation runs it");
    assert.equal(providerRequests.filter(entry=>entry.path===inventoryPath&&entry.method==="GET").length-before,1,
      "the second worker cannot bypass the retry backoff using its stale due snapshot");
  } finally { failNextGoogleRequest=null; await stopCalendarApiReplica(replica); db.close(); }
});

test("a crashed Calendar create is recovered as an individual uncertain attempt and a late commit is cleaned", async () => {
  const owner=await account();
  const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:"Crash recovery copy",scheduledDate:"2027-03-14"}});
  const item=(await created.json()).item;
  assert.equal((await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"crash-recovery@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/crash-recovery-${item.id}/`}})).status,201);
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  let release; let started;
  const held=new Promise(resolve=>{started=resolve;});
  const releasePromise=new Promise(resolve=>{release=resolve;});
  let crashedWorker; let recoveryWorker;
  try {
    removeProviderCopyForTest(db,owner.user.id,"apple",item.id);
    holdNextCalendarCreation={provider:"apple",beforeCommit:true,created:started,releasePromise,release};
    crashedWorker=await startCalendarApiReplica(3115);
    const exporting=fetch(`http://localhost:${crashedWorker.port}/api/calendars/sync`,{method:"POST",headers:{Authorization:`Bearer ${owner.token}`}}).catch(error=>({error}));
    await held;
    const active=db.prepare("SELECT attempt_id,status FROM calendar_creation_attempts WHERE user_id=? AND item_id=? AND provider='apple'").get(owner.user.id,item.id);
    assert.equal(active.status,"active");
    await stopCalendarApiReplica(crashedWorker); crashedWorker=undefined;
    recoveryWorker=await startCalendarApiReplica(3116);
    const initialized=await fetch(`http://localhost:${recoveryWorker.port}/api/items`,{headers:{Authorization:`Bearer ${owner.token}`}});
    assert.equal(initialized.status,200,await initialized.text());
    assert.equal(db.prepare("SELECT status FROM calendar_creation_attempts WHERE attempt_id=?").get(active.attempt_id).status,"uncertain",
      "restart gives this provider request a durable identity instead of inheriting a stuck active count");
    assert.equal(db.prepare("SELECT active_attempts FROM apple_creation_reservations WHERE user_id=? AND item_id=?").get(owner.user.id,item.id).active_attempts,0);

    assert.equal((await request(`/api/items/${item.id}`,{token:owner.token,method:"DELETE"})).status,204);
    const workerSync=async()=>fetch(`http://localhost:${recoveryWorker.port}/api/calendars/sync`,{method:"POST",headers:{Authorization:`Bearer ${owner.token}`}});
    const beforeCommit=await workerSync();
    assert.equal(beforeCommit.status,200,await beforeCommit.text());
    assert.equal(db.prepare("SELECT state FROM calendar_sync_state WHERE user_id=? AND provider='apple'").get(owner.user.id).state,"synced",
      "a provider identity verified absent resolves visible delivery status while retaining uncertain cleanup intent");
    assert.ok(db.prepare("SELECT 1 FROM calendar_creation_cleanup WHERE user_id=? AND provider='apple' AND item_id=?").get(owner.user.id,item.id));

    release(); holdNextCalendarCreation=null;
    await exporting;
    assert.ok([...appleEvents.values()].some(ics=>ics.includes(`?event=${item.id}`)),"the provider may commit after the worker process exited");
    const afterCommit=await workerSync();
    assert.equal(afterCommit.status,200,await afterCommit.text());
    assert.equal([...appleEvents.values()].some(ics=>ics.includes(`?event=${item.id}`)),false,
      "the durable tombstone finds and removes the late provider commit");
    assert.equal(db.prepare("SELECT state FROM calendar_sync_state WHERE user_id=? AND provider='apple'").get(owner.user.id).state,"synced");
  } finally {
    release?.(); holdNextCalendarCreation=null;
    if(crashedWorker) await stopCalendarApiReplica(crashedWorker);
    if(recoveryWorker) await stopCalendarApiReplica(recoveryWorker);
    db.close();
  }
});

test("a timed out Calendar create releases its lease, keeps its attempt uncertain, and permits another account", async () => {
  const owner=await account();
  const independent=await account();
  const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"event",title:"Timed request",scheduledDate:"2027-04-02"}});
  const item=(await created.json()).item;
  const otherEvent=await request("/api/items",{token:independent.token,method:"POST",body:{kind:"event",title:"Independent request",scheduledDate:"2027-04-03"}});
  const otherItem=(await otherEvent.json()).item;
  const connect=async(user,path)=>request("/api/calendars",{token:user.token,method:"POST",body:{username:`${user.user.id}@example.com`,password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/${path}/`}});
  assert.equal((await connect(owner,`timeout-${item.id}`)).status,201);
  assert.equal((await connect(independent,`independent-${otherItem.id}`)).status,201);
  const db=new DatabaseSync(join(directory,"workspace.sqlite"));
  let release; let started;
  const held=new Promise(resolve=>{started=resolve;});
  const releasePromise=new Promise(resolve=>{release=resolve;});
  let replica;
  try {
    replica=await startCalendarApiReplica(3117,{FILETASKS_CALENDAR_OPERATION_TIMEOUT_MS:"250",FILETASKS_CALENDAR_LOCK_WAIT_TIMEOUT_MS:"250"});
    holdNextCalendarCreation={provider:"apple",beforeCommit:true,created:started,releasePromise,release};
    const startedAt=Date.now();
    const exporting=fetch(`http://localhost:${replica.port}/api/calendars/sync`,{method:"POST",headers:{Authorization:`Bearer ${owner.token}`}});
    await held;
    const response=await Promise.race([exporting,delay(4000).then(()=>{throw new Error("provider timeout did not bound the stalled request");})]);
    assert.ok(Date.now()-startedAt<4000,"the stalled provider request is aborted at its operation deadline");
    assert.notEqual(response.status,200,"the uncertain create is retried after reconciliation rather than treated as delivered");
    const attempt=db.prepare("SELECT status FROM calendar_creation_attempts WHERE user_id=? AND item_id=? AND provider='apple' ORDER BY started_at DESC LIMIT 1").get(owner.user.id,item.id);
    assert.equal(attempt.status,"uncertain");
    assert.equal(db.prepare("SELECT active_attempts FROM apple_creation_reservations WHERE user_id=? AND item_id=?").get(owner.user.id,item.id).active_attempts,0,
      "aborting the HTTP request cannot leave an active lease count behind");
    const unrelated=await request("/api/calendars/sync",{token:independent.token,method:"POST"});
    assert.equal(unrelated.status,200,await unrelated.text(),"one stalled destination cannot block another account");
    release(); holdNextCalendarCreation=null;
    const retried=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(retried.status,200,await retried.text());
    assert.equal([...appleEvents.values()].filter(ics=>ics.includes(`?event=${item.id}`)).length,1,
      "the late commit and retry converge on the reserved Apple resource");
    db.prepare("UPDATE calendar_export_locks SET owner_token='test-held-lease',lease_until=? WHERE user_id=? AND provider='apple'")
      .run(Date.now()+60_000,owner.user.id);
    const lockWaitStarted=Date.now();
    const blocked=fetch(`http://localhost:${replica.port}/api/calendars/sync`,{method:"POST",headers:{Authorization:`Bearer ${owner.token}`}});
    const otherAccount=await request("/api/calendars/sync",{token:independent.token,method:"POST"});
    assert.equal(otherAccount.status,200,await otherAccount.text(),"export lock acquisition is scoped to one connected account");
    const lockResult=await blocked;
    assert.equal(lockResult.status,503);
    assert.ok(Date.now()-lockWaitStarted<2000,"export lock acquisition ends at its configured deadline");
  } finally { release?.(); holdNextCalendarCreation=null; if(replica) await stopCalendarApiReplica(replica); db.close(); }
});

test("Google recovery reconciles a persisted replacement after a lost response", async () => {
  const priorGoogleEvents=googleEvents;
  googleEvents=new Map();
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
  const source = {id: "lost-response-source", summary: "Lost response recovery", start: {date: "2027-01-01"}, end: {date: "2027-01-02"}};
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    googleEvents.set(source.id, structuredClone(source));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === source.summary);
    assert.ok(item);
    googleEvents.delete(source.id);
    loseNextGooglePostResponse = true;
    await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(loseNextGooglePostResponse, false, "the fake persisted the POST before returning invalid JSON");
    assert.equal(googleEvents.size, 1);
    const [replacementId, replacement] = [...googleEvents.entries()][0];
    assert.notEqual(replacementId, source.id);
    assert.equal(replacement.extendedProperties.private.filetasksItemId, item.id);
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const mappings = db.prepare("SELECT external_id FROM calendar_copies WHERE user_id=? AND item_id=? AND provider='google'").all(owner.user.id, item.id);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].external_id, replacementId);
    assert.equal(googleEvents.size, 1);
    assert.ok(googleEvents.has(replacementId));
  } finally { loseNextGooglePostResponse = false; googleEvents=priorGoogleEvents; db.close(); }
});

test("Google recovered single Event receives subsequent local title edits", async () => {
  const priorGoogleEvents=googleEvents;
  googleEvents=new Map();
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"});
  const source = {id:"recover-single-edit",summary:"Original title",start:{date:"2027-01-01"},end:{date:"2027-01-02"}};
  try {
    googleEvents.set(source.id,structuredClone(source));
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    const item = (await (await request("/api/items",{token:owner.token})).json()).items.find((entry) => entry.title === source.summary);
    assert.ok(item);
    googleEvents.delete(source.id);
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    assert.equal(googleEvents.size,1);
    const [replacementId] = googleEvents.keys();
    assert.notEqual(replacementId,source.id);
    googleEvents.delete(replacementId);
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    assert.equal(googleEvents.size,1, "a second deletion should produce exactly one replacement");
    const [secondReplacementId] = googleEvents.keys();
    assert.notEqual(secondReplacementId,replacementId);
    assert.equal((await request(`/api/items/${item.id}`,{token:owner.token,method:"PATCH",body:{title:"Updated title"}})).status,200);
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    assert.equal(googleEvents.size,1);
    assert.equal(googleEvents.get(secondReplacementId)?.summary,"Updated title");
    const updated = (await (await request(`/api/items/${item.id}`,{token:owner.token})).json()).item;
    assert.ok(updated.calendarSync.every(({state}) => state !== "pending" && state !== "limited"));
    assert.ok(!(await (await request("/api/calendars",{token:owner.token})).json()).syncLimitations.some((entry) => entry.itemId === item.id));
  } finally { googleEvents=priorGoogleEvents; }
});

test("Google recovery preserves conference and attachment options and remains idempotent", async () => {
  const priorGoogleEvents=googleEvents;
  googleEvents=new Map();
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"});
  const source = {id:"recover-extras",summary:"Recover extras",start:{date:"2027-01-01"},end:{date:"2027-01-02"},conferenceData:{conferenceId:"abc"},attachments:[{fileUrl:"https://example.com/file",title:"File"}]};
  try {
    googleEvents.set(source.id,structuredClone(source));
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    googleEvents.delete(source.id);
    const start = providerRequests.length;
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    const post = providerRequests.slice(start).find(({path,method}) => path.endsWith("/events") && method === "POST");
    assert.equal(new URLSearchParams(post.query).get("conferenceDataVersion"),"1");
    assert.equal(new URLSearchParams(post.query).get("supportsAttachments"),"true");
    assert.deepEqual(post.body.conferenceData,source.conferenceData); assert.deepEqual(post.body.attachments,source.attachments);
    const [copyId,copy] = [...googleEvents.entries()][0];
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    assert.equal(googleEvents.size,1); assert.deepEqual(googleEvents.get(copyId),copy);
  } finally { googleEvents=priorGoogleEvents; }
});

test("unsupported schedule edits remain visible and Apple alarm descriptions survive edits", async () => {
  const owner = await account();
  assert.equal((await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}})).status,201);
  const path = "/apple/calendar/alarm-safeguard.ics";
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:alarm-safeguard\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;TZID=America/New_York:20270314T015500\r\nDTEND;TZID=America/New_York:20270314T030500\r\nSUMMARY:Alarm safeguard\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Alarm text\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nDESCRIPTION:Event text\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  try {
    appleEvents.set(path,ics);
    assert.equal((await request("/api/calendars/sync",{token:owner.token,method:"POST"})).status,200);
    const item = (await (await request("/api/items",{token:owner.token})).json()).items.find((entry) => entry.title === "Alarm safeguard");
    assert.equal(item.details,"Event text");
    assert.equal((await request(`/api/items/${item.id}`,{token:owner.token,method:"PATCH",body:{details:"Changed event"}})).status,200);
    assert.match(appleEvents.get(path),/DESCRIPTION:Alarm text\r\nTRIGGER/);
    assert.match(appleEvents.get(path),/END:VALARM\r\nDESCRIPTION:Changed event/);
    for (const body of [{scheduledDate:"2027-03-14",scheduledTime:"02:30"},{scheduledDate:"2027-03-14",scheduledTime:null}]) {
      const before = appleEvents.get(path);
      const patch = await request(`/api/items/${item.id}`,{token:owner.token,method:"PATCH",body});
      assert.equal(patch.status,200);
      assert.equal((await patch.json()).item.calendarSync[0].limitationCode,"schedule-unsupported");
      assert.equal((await (await request(`/api/items/${item.id}`,{token:owner.token})).json()).item.calendarSync[0].state,"limited");
      assert.ok((await (await request("/api/calendars",{token:owner.token})).json()).syncLimitations.some((entry) => entry.itemId === item.id));
      assert.equal(appleEvents.get(path),before);
    }
  } finally { appleEvents.clear(); }
});

test("legacy imports and detached Occurrences remain blocked without provider discovery", async () => {
  const priorGoogleEvents=googleEvents;
  googleEvents=new Map();
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"});
  const source = {id:"legacy-split",summary:"Legacy split",start:{date:"2027-01-01"},end:{date:"2027-01-03"},recurrence:["RRULE:FREQ=DAILY;COUNT=5"]};
  try {
    googleEvents.set(source.id,structuredClone(source));
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    let items = (await (await request("/api/items",{token:owner.token})).json()).items;
    const root = items.find((item) => item.title === source.summary && item.id === item.seriesId);
    const db = new DatabaseSync(join(directory,"workspace.sqlite"));
    db.prepare("DELETE FROM calendar_import_metadata WHERE item_id=?").run(root.id); db.close();
    googleEvents.delete(source.id);
    assert.equal((await (await request(`/api/items/${root.id}`,{token:owner.token})).json()).item.calendarSync[0].limitationCode,"legacy-import");
    const third = items.filter((item) => item.seriesId === root.id).sort((a,b) => a.occurrenceDate.localeCompare(b.occurrenceDate))[2];
    assert.equal((await request(`/api/items/${third.id}`,{token:owner.token,method:"PATCH",body:{scope:"following",recurrence:null}})).status,200);
    items = (await (await request("/api/items",{token:owner.token})).json()).items.filter((item) => item.title === source.summary);
    assert.ok(items.every((item) => item.calendarSync.some((status) => status.state === "limited")));
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(googleEvents.size,0);
  } finally { googleEvents=priorGoogleEvents; }
});

test("imported Occurrence edits and deletions are visible after restart", async () => {
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"});
  const source = {id:"occurrence-status",summary:"Occurrence status",start:{date:"2027-02-01"},end:{date:"2027-02-02"},recurrence:["RRULE:FREQ=DAILY;COUNT=4"]};
  try {
    googleEvents.set(source.id,structuredClone(source)); await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    const beforeEdit = structuredClone(googleEvents.get(source.id));
    const items = (await (await request("/api/items",{token:owner.token})).json()).items;
    const root = items.find((item) => item.title === source.summary && item.id === item.seriesId);
    const occurrences = items.filter((item) => item.seriesId === root.id && item.id !== root.id);
    const patch = await request(`/api/items/${occurrences[0].id}`,{token:owner.token,method:"PATCH",body:{scope:"occurrence",title:"Changed occurrence"}});
    assert.equal((await patch.json()).item.calendarSync[0].limitationCode,"unsupported-recurrence");
    assert.equal((await request(`/api/items/${occurrences[1].id}?scope=occurrence`,{token:owner.token,method:"DELETE"})).status,204);
    await stopServer(); await startServer();
    const restored = (await (await request("/api/items",{token:owner.token})).json()).items;
    assert.equal(restored.find((item) => item.id === occurrences[0].id)?.title,"Changed occurrence");
    assert.equal(restored.some((item) => item.id === occurrences[1].id),false);
    assert.equal((await (await request(`/api/items/${root.id}`,{token:owner.token})).json()).item.calendarSync[0].limitationCode,"unsupported-recurrence");
    assert.ok((await (await request("/api/calendars",{token:owner.token})).json()).syncLimitations.some((entry) => entry.itemId === root.id));
    assert.deepEqual(googleEvents.get(source.id),beforeEdit);
  } finally { googleEvents.clear(); }
});

test("Apple duplicate direct timing and recurrence properties pause export", async () => {
  const owner = await account();
  await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}});
  try {
    for (const [id,duplicate] of [["rrule","RRULE:FREQ=DAILY;COUNT=2\r\nRRULE:FREQ=WEEKLY;COUNT=2"],["start","DTSTART;VALUE=DATE:20270101"],["end","DTEND;VALUE=DATE:20270103"]]) {
      const path = `/apple/calendar/duplicate-${id}.ics`;
      const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:duplicate-${id}\r\nDTSTART;VALUE=DATE:20270101\r\nDTEND;VALUE=DATE:20270102\r\n${duplicate}\r\nSUMMARY:Duplicate ${id}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
      appleEvents.set(path,ics);
    }
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    const items = (await (await request("/api/items",{token:owner.token})).json()).items;
    for (const id of ["rrule","start","end"]) {
      const item = items.find((entry) => entry.title === `Duplicate ${id}`);
      assert.equal(item.calendarSync[0].limitationCode,"malformed-event");
      const path = `/apple/calendar/duplicate-${id}.ics`; const before = appleEvents.get(path);
      await request(`/api/items/${item.id}`,{token:owner.token,method:"PATCH",body:{details:"Changed"}});
      assert.equal(appleEvents.get(path),before);
    }
  } finally { appleEvents.clear(); }
});

test("clearing an imported root recurrence with following scope preserves the Calendar copy", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie:auth.cookie,redirect:"manual"});
  const source = {id:"root-following-clear",summary:"Root following clear",start:{dateTime:"2027-01-13T09:00:00-05:00",timeZone:"America/New_York"},end:{dateTime:"2027-01-13T11:00:00-05:00",timeZone:"America/New_York"},recurrence:["RRULE:FREQ=DAILY;COUNT=4"]};
  try {
    googleEvents.set(source.id,structuredClone(source));
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    const providerBeforeEdit = structuredClone(googleEvents.get(source.id));
    const before = (await (await request("/api/items",{token:owner.token})).json()).items;
    const root = before.find((item) => item.title === source.summary && item.recurrence);
    assert.ok(before.filter((item) => item.seriesId === root.id).length > 1);
    const patch = await request(`/api/items/${root.id}`,{token:owner.token,method:"PATCH",body:{scope:"following",recurrence:null}});
    assert.equal(patch.status,200);
    assert.equal((await patch.json()).item.calendarSync[0].limitationCode,"unsupported-recurrence");
    const items = (await (await request("/api/items",{token:owner.token})).json()).items.filter((item) => item.title === source.summary);
    assert.equal(items.length,1);
    assert.equal((await (await request(`/api/items/${root.id}`,{token:owner.token})).json()).item.calendarSync[0].state,"limited");
    assert.ok((await (await request("/api/calendars",{token:owner.token})).json()).syncLimitations.some((entry) => entry.itemId === root.id));
    const sync = await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.ok((await sync.json()).syncLimitations.some((entry) => entry.itemId === root.id));
    assert.equal(googleEvents.size,1);
    assert.deepEqual(googleEvents.get(source.id),providerBeforeEdit);
  } finally { googleEvents.clear(); }
});

test("Apple schedule edits that end in the repeated DST hour pause export", async () => {
  const priorAppleEvents=appleEvents;
  appleEvents=new Map();
  const owner = await account();
  await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/fallback.ics";
  const original = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Test//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:fallback\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;TZID=America/New_York:20271106T003000\r\nDTEND;TZID=America/New_York:20271106T023000\r\nSUMMARY:Fallback edit\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  try {
    appleEvents.set(path,original);
    await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    const item = (await (await request("/api/items",{token:owner.token})).json()).items.find((entry) => entry.title === "Fallback edit");
    const patch = await request(`/api/items/${item.id}`,{token:owner.token,method:"PATCH",body:{scheduledDate:"2027-11-07"}});
    assert.equal(patch.status,200);
    const status = (await patch.json()).item.calendarSync[0];
    assert.equal(status.limitationCode,"schedule-unsupported");
    assert.match(status.limitation,/ambiguous local time/);
    assert.equal((await (await request(`/api/items/${item.id}`,{token:owner.token})).json()).item.calendarSync[0].state,"limited");
    assert.ok((await (await request("/api/calendars",{token:owner.token})).json()).syncLimitations.some((entry) => entry.itemId === item.id));
    const sync = await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.ok((await sync.json()).syncLimitations.some((entry) => entry.itemId === item.id));
    assert.equal(appleEvents.size,1);
    assert.equal(appleEvents.get(path),original);
  } finally { appleEvents=priorAppleEvents; }
});

test("Apple ambiguous fallback start remains visibly blocked", async () => {
  const owner = await account();
  await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/ambiguous-start.ics";
  const original = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ambiguous-start\r\nDTSTART;TZID=America/New_York:20271107T013000\r\nDTEND;TZID=America/New_York:20271107T023000\r\nSUMMARY:Ambiguous start\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  try {
    appleEvents.set(path,original);
    const sync = await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(sync.status,200);
    const item = (await (await request("/api/items",{token:owner.token})).json()).items.find((entry) => entry.title === "Ambiguous start");
    assert.ok(item);
    assert.equal(item.calendarSync[0].state,"limited");
    assert.ok((await sync.json()).syncLimitations.some((entry) => entry.itemId === item.id));
    await request(`/api/items/${item.id}`,{token:owner.token,method:"PATCH",body:{details:"Changed"}});
    assert.equal(appleEvents.get(path),original);
  } finally { appleEvents.clear(); }
});

test("Google first-Monday, yearly leap-day, and EXDATE recurrence imports round-trip through Apple", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, { cookie: auth.cookie, redirect: "manual" })).status, 303);
  assert.equal((await request("/api/calendars", { token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  } })).status, 201);
  googleEvents.set("first-monday-google", { id:"first-monday-google",summary:"First Monday",start:{date:"2027-01-04"},end:{date:"2027-01-05"},
    recurrence:["RRULE:FREQ=MONTHLY;BYDAY=1MO;UNTIL=20270301","EXDATE;VALUE=DATE:20270201"] });
  googleEvents.set("leap-day-google", { id:"leap-day-google",summary:"Leap day",start:{date:"2024-02-29"},end:{date:"2024-03-01"},
    recurrence:["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=2"] });
  const previousClock = new Date(testClock);
  try {
    await setTestClock("2027-03-01T12:00:00.000Z");
    const firstSync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(firstSync.status, 200, await firstSync.clone().text());
    let items = (await (await request("/api/items", { token: owner.token })).json()).items;
    const monday = items.find((item) => item.title === "First Monday" && item.seriesId === item.id);
    const leap = items.find((item) => item.title === "Leap day" && item.seriesId === item.id);
    assert.ok(monday && leap);
    assert.deepEqual(items.filter((item) => item.seriesId === monday.id).map((item) => item.scheduledDate).sort(), ["2027-01-04","2027-03-01"]);
    assert.deepEqual(items.filter((item) => item.seriesId === leap.id).map((item) => item.scheduledDate).sort(), ["2024-02-29","2028-02-29"],
      "invalid intervening February 29 candidates must be skipped without consuming COUNT");
    assert.deepEqual(monday.recurrence.ordinalWeekday,{ordinal:1,weekday:1});
    assert.equal(monday.calendarSync.find((status) => status.provider === "google")?.state,"supported");

    const file = (await (await request("/api/files", { token: owner.token, method: "POST", body:{name:"Series file",url:"https://example.com/series"} })).json()).file;
    assert.equal((await request(`/api/files/${file.id}/attachments`,{token:owner.token,method:"POST",body:{itemId:monday.id,scope:"series"}})).status,201);
    const beforeIds = items.filter((item) => item.seriesId === monday.id).map(({id,scheduledDate}) => [id,scheduledDate]);
    const projectionEdit = await request(`/api/items/${monday.id}`,{token:owner.token,method:"PATCH",body:{title:"First Monday edited",details:"Keep source rule",scope:"series",
      recurrence:{interval:1,unit:"months",end:{type:"date",date:"2027-03-01"}}}});
    assert.equal(projectionEdit.status,200,await projectionEdit.clone().text());
    const edited = (await projectionEdit.json()).item;
    assert.deepEqual(edited.recurrence.ordinalWeekday,{ordinal:1,weekday:1},"the native simple projection must retain stored rich BYDAY data");
    assert.equal(edited.calendarSync.find((status) => status.provider === "google")?.recurrenceEdited,false);
    items = (await (await request("/api/items",{token:owner.token})).json()).items;
    assert.deepEqual(items.filter((item) => item.seriesId === monday.id).map(({id,scheduledDate}) => [id,scheduledDate]),beforeIds);
    assert.ok(items.filter((item) => item.seriesId === monday.id).every((item) => item.files.some(({id}) => id === file.id)));

    const repeated = await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(repeated.status,200,await repeated.clone().text());
    const repeatedBody=await repeated.json();
    assert.equal(googleEvents.get("first-monday-google").recurrence[1],"EXDATE;VALUE=DATE:20270201");
    const appleCopies = [...appleEvents.values()];
    assert.ok(appleCopies.some((ics) => ics.includes("RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=1MO;UNTIL=20270301")
      && ics.includes("EXDATE;VALUE=DATE:20270201") && ics.includes("SUMMARY:First Monday edited")),appleCopies.join("\n---\n"));
    assert.ok(appleCopies.some((ics) => ics.includes("RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=29;COUNT=2")));
    assert.deepEqual(repeatedBody.syncLimitations,[]);
    const changedRule=await request(`/api/items/${leap.id}`,{token:owner.token,method:"PATCH",body:{scope:"series",
      recurrence:{interval:1,unit:"years",end:{type:"count",count:3}}}});
    assert.equal(changedRule.status,200,await changedRule.clone().text());
    assert.equal((await changedRule.json()).item.calendarSync.find((status)=>status.provider==="google")?.recurrenceEdited,true);
    const retainedRule=[...googleEvents.get("first-monday-google").recurrence];
    googleEvents.set("first-monday-cancelled-exception",{id:"first-monday-cancelled-exception",recurringEventId:"first-monday-google",
      originalStartTime:{date:"2027-03-01"},status:"cancelled"});
    const destructiveSync=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(destructiveSync.status,200,await destructiveSync.clone().text());
    assert.deepEqual(googleEvents.get("first-monday-google").recurrence,retainedRule,"a detached provider exception must keep the source recurrence untouched");
    const limitedRoot=(await (await request(`/api/items/${monday.id}`,{token:owner.token})).json()).item;
    assert.equal(limitedRoot.calendarSync.find((status)=>status.provider==="google")?.state,"limited");
    assert.ok((await destructiveSync.json()).syncLimitations.some((entry)=>entry.itemId===monday.id));
  } finally { await setTestClock(previousClock); googleEvents.clear(); appleEvents.clear(); }
});

test("monthly fifth weekdays skip nonexistent months and explicit rich recurrence edits apply", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, { cookie: auth.cookie, redirect: "manual" })).status, 303);
  googleEvents.set("fifth-monday-google", { id:"fifth-monday-google",summary:"Fifth Monday",start:{date:"2024-01-29"},end:{date:"2024-01-30"},
    recurrence:["RRULE:FREQ=MONTHLY;BYDAY=5MO;COUNT=2"] });
  try {
    const sync = await request("/api/calendars/sync", {token:owner.token,method:"POST"});
    assert.equal(sync.status,200,await sync.clone().text());
    let items=(await (await request("/api/items",{token:owner.token})).json()).items;
    const root=items.find((item)=>item.seriesId===item.id && item.scheduledDate==="2024-01-29");
    assert.ok(root);
    assert.deepEqual(items.filter((item)=>item.seriesId===root.id).map((item)=>item.scheduledDate).sort(),["2024-01-29","2024-04-29"],
      "a missing fifth Monday in February must be skipped without consuming COUNT");

    const edit=await request(`/api/items/${root.id}`,{token:owner.token,method:"PATCH",body:{scope:"series",scheduledDate:"2027-01-11",
      recurrence:{interval:1,unit:"months",ordinalWeekday:{ordinal:2,weekday:1},end:{type:"count",count:2}}}});
    assert.equal(edit.status,200,await edit.clone().text());
    const updated=(await edit.json()).item;
    assert.deepEqual(updated.recurrence.ordinalWeekday,{ordinal:2,weekday:1},"explicit rich fields must be honored");
    items=(await (await request("/api/items",{token:owner.token})).json()).items;
    assert.deepEqual(items.filter((item)=>item.seriesId===root.id).map((item)=>item.scheduledDate).sort(),["2027-01-11","2027-02-08"]);
    assert.equal(googleEvents.get("fifth-monday-google").recurrence[0],"RRULE:FREQ=MONTHLY;BYDAY=5MO;COUNT=2",
      "the edited recurrence is limited and must not overwrite the original provider rule");
  } finally { googleEvents.clear(); }
});

test("Apple first-Monday and leap-day rules with EXDATE import and retain Google copies", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"})).status,303);
  assert.equal((await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}})).status,201);
  const mondayPath="/apple/calendar/first-monday-apple.ics";
  const leapPath="/apple/calendar/leap-day-apple.ics";
  appleEvents.set(mondayPath,appleCalendarFixture({uid:"first-monday-apple",date:"20270104",recurrence:"FREQ=MONTHLY;BYDAY=1MO;COUNT=3",exdate:"EXDATE;VALUE=DATE:20270201",exceptionUid:null}));
  appleEvents.set(leapPath,appleCalendarFixture({uid:"leap-day-apple",date:"20240229",recurrence:"FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=2",exceptionUid:null}));
  const previousClock = new Date(testClock);
  try {
    await setTestClock("2027-03-01T12:00:00.000Z");
    const sync = await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(sync.status,200,await sync.text());
    const items = (await (await request("/api/items",{token:owner.token})).json()).items;
    const monday=items.find((item)=>item.title==="Imported calendar event" && item.seriesId===item.id && item.scheduledDate==="2027-01-04" && item.recurrence?.ordinalWeekday);
    const leap=items.find((item)=>item.seriesId===item.id && item.scheduledDate==="2024-02-29" && item.recurrence?.monthDay===29);
    assert.ok(monday && leap);
    assert.deepEqual(monday.recurrence.ordinalWeekday,{ordinal:1,weekday:1});
    assert.equal(monday.calendarSync.find((status)=>status.provider==="apple")?.state,"supported");
    assert.equal(items.some((item)=>item.seriesId===monday.id && item.scheduledDate==="2027-02-01"),false,"EXDATE must hide matching occurrence");
    assert.deepEqual(items.filter((item)=>item.seriesId===leap.id).map((item)=>item.scheduledDate).sort(),["2024-02-29","2028-02-29"]);
    const beforeIds=items.filter((item)=>item.seriesId===monday.id).map(({id,scheduledDate})=>[id,scheduledDate]);
    const edit=await request(`/api/items/${monday.id}`,{token:owner.token,method:"PATCH",body:{details:"Edited through FileTasks",scope:"series"}});
    assert.equal(edit.status,200,await edit.text());
    const repeated=await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(repeated.status,200,await repeated.text());
    const refreshed=(await (await request("/api/items",{token:owner.token})).json()).items;
    assert.deepEqual(refreshed.filter((item)=>item.seriesId===monday.id).map(({id,scheduledDate})=>[id,scheduledDate]),beforeIds);
    assert.equal(appleEvents.get(mondayPath).includes("RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=3"),true);
    assert.equal(appleEvents.get(mondayPath).includes("EXDATE;VALUE=DATE:20270201"),true);
    assert.ok([...googleEvents.values()].some((event)=>event.recurrence?.some((line)=>line.includes("BYDAY=1MO"))
      && event.recurrence?.some((line)=>line.includes("EXDATE;VALUE=DATE:20270201"))));
    assert.ok([...googleEvents.values()].some((event)=>event.recurrence?.some((line)=>line.includes("BYMONTH=2;BYMONTHDAY=29"))));
  } finally { await setTestClock(previousClock); googleEvents.clear(); appleEvents.clear(); }
});

test("details-only series edits preserve Occurrence and Attachment identities", async () => {
  const owner=await account();
  const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"task",title:"Identity task",details:"Before",scheduledDate:"2026-11-02",
    recurrence:{interval:1,unit:"weeks",weekdays:[1],end:{type:"count",count:4}}}});
  const root=(await created.json()).item;
  let items=(await (await request("/api/items",{token:owner.token})).json()).items.filter((item)=>item.seriesId===root.id).sort((a,b)=>a.occurrenceDate.localeCompare(b.occurrenceDate));
  const completed=items[2];
  assert.equal((await request(`/api/items/${completed.id}`,{token:owner.token,method:"PATCH",body:{completed:true,scope:"occurrence"}})).status,200);
  assert.equal((await request(`/api/items/${items[1].id}?scope=occurrence`,{token:owner.token,method:"DELETE"})).status,204);
  const file=(await (await request("/api/files",{token:owner.token,method:"POST",body:{name:"Identity file",url:"https://example.com/identity"}})).json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`,{token:owner.token,method:"POST",body:{itemId:root.id,scope:"series"}})).status,201);
  items=(await (await request("/api/items",{token:owner.token})).json()).items.filter((item)=>item.seriesId===root.id).sort((a,b)=>a.occurrenceDate.localeCompare(b.occurrenceDate));
  const before=items.map(({id,occurrenceDate,completed,files})=>({id,occurrenceDate,completed,fileIds:files.map(({id})=>id)}));
  const update=await request(`/api/items/${root.id}`,{token:owner.token,method:"PATCH",body:{title:"Identity task edited",details:"After",scope:"series"}});
  assert.equal(update.status,200,await update.text());
  const afterItems=(await (await request("/api/items",{token:owner.token})).json()).items.filter((item)=>item.seriesId===root.id).sort((a,b)=>a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.deepEqual(afterItems.map(({id,occurrenceDate,completed,files})=>({id,occurrenceDate,completed,fileIds:files.map(({id})=>id)})),before);
});

test("a full edit from a later Occurrence preserves the authoritative series dates", async () => {
  const owner=await account();
  const recurrence={interval:1,unit:"days",end:{type:"count",count:5}};
  const reminders=[{delivery:"notification",amount:1,unit:"days",time:"09:00"}];
  const created=await request("/api/items",{token:owner.token,method:"POST",body:{kind:"task",title:"Five day series",details:"Before",
    scheduledDate:"2026-11-02",scheduledTime:"10:00",recurrence,reminders}});
  assert.equal(created.status,201,await created.clone().text());
  const root=(await created.json()).item;
  const before=(await (await request("/api/items",{token:owner.token})).json()).items
    .filter((item)=>item.seriesId===root.id).sort((a,b)=>a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.equal(before.length,5);
  const third=before[2];
  const customized=before[3];
  const customReminder=[{delivery:"notification",amount:3,unit:"days",time:"07:15"}];
  const localReminder=await request(`/api/items/${customized.id}`,{token:owner.token,method:"PATCH",body:{reminders:customReminder,scope:"occurrence"}});
  assert.equal(localReminder.status,200,await localReminder.text());

  // Real editors send the full selected Occurrence state even when only details
  // or Reminders changed. That schedule is not a request to reanchor the series.
  const fullEdit=await request(`/api/items/${third.id}`,{token:owner.token,method:"PATCH",body:{kind:"task",title:"Renamed series",
    details:"After",scheduledDate:third.scheduledDate,scheduledTime:third.scheduledTime,recurrence:third.recurrence,
    reminders:[{delivery:"notification",amount:2,unit:"days",time:"08:30"}],scope:"series"}});
  assert.equal(fullEdit.status,200,await fullEdit.text());
  const after=(await (await request("/api/items",{token:owner.token})).json()).items
    .filter((item)=>item.seriesId===root.id).sort((a,b)=>a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.deepEqual(after.map(({id,occurrenceDate,scheduledDate})=>({id,occurrenceDate,scheduledDate})),
    before.map(({id,occurrenceDate,scheduledDate})=>({id,occurrenceDate,scheduledDate})));
  assert.ok(after.every((item)=>item.title==="Renamed series" && item.details==="After"));
  assert.ok(after.filter((item)=>item.id!==customized.id).every((item)=>JSON.stringify(item.reminders)===JSON.stringify([{delivery:"notification",amount:2,unit:"days",time:"08:30"}])));
  assert.deepEqual(after.find((item)=>item.id===customized.id).reminders,customReminder,"a customized Occurrence Reminder survives a series edit");

  const partial=await request(`/api/items/${third.id}`,{token:owner.token,method:"PATCH",body:{details:"Partial update",scope:"series"}});
  assert.equal(partial.status,200,await partial.text());
  const partiallyUpdated=(await (await request("/api/items",{token:owner.token})).json()).items.filter((item)=>item.seriesId===root.id);
  assert.deepEqual(partiallyUpdated.map(({id,occurrenceDate,scheduledDate})=>({id,occurrenceDate,scheduledDate})),
    before.map(({id,occurrenceDate,scheduledDate})=>({id,occurrenceDate,scheduledDate})));
  assert.deepEqual(partiallyUpdated.find((item)=>item.id===customized.id).reminders,customReminder);

  // A genuinely changed schedule remains an intentional reanchor.
  const reanchor=await request(`/api/items/${third.id}`,{token:owner.token,method:"PATCH",body:{scheduledDate:"2026-12-01",scope:"series"}});
  assert.equal(reanchor.status,200,await reanchor.text());
  const reanchored=(await (await request("/api/items",{token:owner.token})).json()).items
    .filter((item)=>item.seriesId===root.id).sort((a,b)=>a.occurrenceDate.localeCompare(b.occurrenceDate));
  assert.deepEqual(reanchored.map((item)=>item.scheduledDate),["2026-12-01","2026-12-02","2026-12-03","2026-12-04","2026-12-05"]);
});

test("oversized imported text and unsupported recurrence preserve provider originals", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`,{cookie:auth.cookie,redirect:"manual"});
  await request("/api/calendars",{token:owner.token,method:"POST",body:{username:"person@example.com",password:"app-specific-password",calendarUrl:`${deliveryBase}/apple/calendar/`}});
  const cases = [
    ["long-title", "T".repeat(1000), "description", null],
    ["long-description", "Long description", "D".repeat(20000), null],
    ["weekly-no-byday", "Weekly without BYDAY", "description", "FREQ=WEEKLY;COUNT=3"],
    ["count-range", "Out of range count", "description", "FREQ=DAILY;COUNT=999999999"],
  ];
  try {
    for (const [id,title,description,rule] of cases) {
      googleEvents.set(id,{id,summary:title,description,start:{date:"2027-01-14"},end:{date:"2027-01-15"},...(rule ? {recurrence:[`RRULE:${rule}`]} : {})});
      appleEvents.set(`/apple/calendar/${id}.ics`,`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FileTasks Tests//EN\r\nBEGIN:VEVENT\r\nUID:${id}\r\nDTSTAMP:20270101T000000Z\r\nDTSTART;VALUE=DATE:20270114\r\nDTEND;VALUE=DATE:20270115\r\nSUMMARY:${title}\r\nDESCRIPTION:${description}\r\n${rule ? `RRULE:${rule}\r\n` : ""}END:VEVENT\r\nEND:VCALENDAR\r\n`);
    }
    const googleBefore = structuredClone(googleEvents);
    const appleBefore = new Map(appleEvents);
    const sync = await request("/api/calendars/sync",{token:owner.token,method:"POST"});
    assert.equal(sync.status,200);
    for (const id of ["long-title", "long-description", "count-range"]) {
      assert.deepEqual(googleEvents.get(id), googleBefore.get(id));
      assert.equal(appleEvents.get(`/apple/calendar/${id}.ics`), appleBefore.get(`/apple/calendar/${id}.ics`));
    }
    const items = (await (await request("/api/items",{token:owner.token})).json()).items;
    for (const [id, title] of cases.filter(([id]) => id !== "weekly-no-byday")) {
      for (const provider of ["google", "apple"]) {
        const item = items.find((entry) => entry.title === (id === "long-title" ? title.slice(0, 200) : title) && entry.calendarSync.some((status) => status.provider === provider));
        assert.ok(item, `${provider} ${id} imported`);
        assert.equal(item.calendarSync.find((status) => status.provider === provider).state, "limited");
      }
    }
    for (const provider of ["google", "apple"]) {
      const series = items.filter((item) => item.title === "Weekly without BYDAY" && item.calendarSync.some((status) => status.provider === provider));
      assert.deepEqual(series.map((item) => item.scheduledDate).sort(), ["2027-01-14", "2027-01-21", "2027-01-28"]);
      assert.ok(series.every((item) => item.calendarSync.some((status) => status.provider === provider && status.state === "limited" && status.limitationCode === "unsupported-recurrence")));
      assert.ok(series.every((item) => JSON.stringify(item.recurrence) === JSON.stringify({interval:1,unit:"weeks",weekdays:[4],end:{type:"count",count:3}})));
    }
    assert.deepEqual(googleEvents.get("weekly-no-byday").start, googleBefore.get("weekly-no-byday").start);
    assert.deepEqual(googleEvents.get("weekly-no-byday").end, googleBefore.get("weekly-no-byday").end);
    assert.deepEqual(googleEvents.get("weekly-no-byday").recurrence, googleBefore.get("weekly-no-byday").recurrence);
    const weeklyApple = appleEvents.get("/apple/calendar/weekly-no-byday.ics");
    assert.match(weeklyApple, /DTSTART;VALUE=DATE:20270114/);
    assert.match(weeklyApple, /DTEND;VALUE=DATE:20270115/);
    assert.match(weeklyApple, /RRULE:FREQ=WEEKLY;COUNT=3/);
  } finally { googleEvents.clear(); appleEvents.clear(); }
});


test("Google exception inventory follows empty pages and blocks lossy writes", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
  const master = {id: "inventory-master", summary: "Inventory master", start: {date: "2027-01-01"}, end: {date: "2027-01-02"}, recurrence: ["RRULE:FREQ=DAILY;COUNT=3"]};
  const moved = {id: "inventory-moved", recurringEventId: master.id, originalStartTime: {date: "2027-01-02"}, start: {date: "2040-01-01"}, end: {date: "2040-01-02"}, summary: "Moved exception"};
  const cancelled = {id: "inventory-cancelled", recurringEventId: master.id, originalStartTime: {date: "2027-01-03"}, status: "cancelled"};
  try {
    googleEvents.set(master.id, structuredClone(master));
    googleEventPages = {first: {items: [master], nextPageToken: "empty"}, empty: {items: [], nextPageToken: "later"}, later: {items: [moved, cancelled]}};
    const sync = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(sync.status, 200);
    const items = (await (await request("/api/items", {token: owner.token})).json()).items;
    const root = items.find(item => item.title === master.summary && item.recurrence);
    assert.ok(root);
    assert.ok(root.calendarSync[0].limitationCode, "exceptions must limit the imported series");
    assert.equal(items.some(item => item.title === moved.summary), false, "exception must not become a standalone Event");
    assert.deepEqual(googleEvents.get(master.id), master);
    assert.equal(providerRequests.some(r => r.method === "GET" && r.query.includes("pageToken=later")), true);
    await stopServer(); await startServer();
    assert.ok((await (await request(`/api/items/${root.id}`, {token: owner.token})).json()).item.calendarSync[0].limitationCode);
    googleEvents.delete(master.id);
    await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(googleEvents.size, 0, "limited series must not be recovered as a lossy copy");
  } finally { googleEventPages = null; googleEvents.clear(); }
});

test("Apple external unsupported recurrence preserves an existing imported resource", async () => {
  const owner = await account();
  await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/external-change.ics";
  try {
    appleEvents.set(path, appleCalendarFixture({uid: "external-change"}));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const items = (await (await request("/api/items", {token: owner.token})).json()).items;
    const item = items.find(entry => entry.calendarSync.some(status => status.provider === "apple"));
    assert.ok(item);
    const original = appleCalendarFixture({uid: "external-change", recurrence: "FREQ=WEEKLY;COUNT=3"});
    appleEvents.set(path, original);
    const sync = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(sync.status, 200);
    assert.equal(appleEvents.get(path), original);
    const updated = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item;
    assert.equal(updated.calendarSync.find(status => status.provider === "apple").state, "limited");
  } finally { appleEvents.clear(); }
});


test("Apple sync safely recreates a deleted imported Event and propagates later edits", async () => {
  const owner = await account();
  await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/deleted-import.ics";
  try {
    appleEvents.set(path, appleCalendarFixture({uid: "deleted-import"}));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === "Imported calendar event");
    assert.ok(item);
    appleEvents.delete(path);
    providerRequests = [];
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const recreated = appleEvents.get(path);
    assert.ok(recreated, "deleted resource should be recreated");
    assert.match(recreated, /^UID:deleted-import\r?$/m);
    assert.match(recreated, new RegExp(`^URL:${base}/\\?event=${item.id}$`, "m"));
    assert.match(recreated, /^DTSTART;VALUE=DATE:20270114\r?$/m);
    assert.match(recreated, /^DTEND;VALUE=DATE:20270115\r?$/m);
    assert.equal(providerRequests.find(entry => entry.method === "PUT" && entry.path === path)?.headers["if-none-match"], "*");
    const updated = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item;
    assert.notEqual(updated.calendarSync.find(status => status.provider === "apple").state, "limited");
    assert.equal((await request(`/api/items/${item.id}`, {token: owner.token, method: "PATCH", body: {title: "Edited after recovery"}})).status, 200);
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    assert.match(appleEvents.get(path), /^SUMMARY:Edited after recovery\r?$/m);
  } finally { appleEvents.clear(); }
});

test("Apple REPORT omission validates the existing resource before exporting", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
  await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/omitted-resource.ics";
  try {
    appleEvents.set(path, appleCalendarFixture({uid: "omitted-resource"}));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === "Imported calendar event");
    assert.ok(item);
    const original = appleCalendarFixture({uid: "omitted-resource", date: "20400114", recurrence: "FREQ=WEEKLY;COUNT=3"});
    appleEvents.set(path, original);
    omittedAppleReports.add(path);
    const googleBefore = structuredClone([...googleEvents.entries()]);
    providerRequests = [];
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    assert.ok(providerRequests.some(entry => entry.method === "GET" && entry.path === path));
    assert.equal(appleEvents.get(path), original);
    assert.deepEqual([...googleEvents.entries()], googleBefore);
    const updated = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item;
    assert.equal(updated.calendarSync.find(status => status.provider === "apple").state, "limited");
  } finally { omittedAppleReports.clear(); appleEvents.clear(); googleEvents.clear(); }
});

test("Apple REPORT href with a different UID blocks overwrite", async () => {
  const owner = await account();
  await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/uid-mismatch.ics";
  try {
    appleEvents.set(path, appleCalendarFixture({uid: "original-uid"}));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === "Imported calendar event");
    assert.ok(item);
    const replacement = appleCalendarFixture({uid: "different-uid"});
    appleEvents.set(path, replacement);
    providerRequests = [];
    await request(`/api/items/${item.id}`, {token: owner.token, method: "PATCH", body: {title: "Local edit"}});
    await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(appleEvents.get(path), replacement);
    assert.equal(providerRequests.some(entry => entry.method === "PUT" && entry.path === path), false);
  } finally { appleEvents.clear(); }
});

test("undated Event cleanup retains an Apple copy when an omitted resource fails identity verification", async () => {
  const owner = await account();
  await request("/api/calendars", {token: owner.token, method: "POST", body: {
    username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`,
  }});
  const event = (await (await request("/api/items", {token: owner.token, method: "POST", body: {
    kind: "event", title: "Keep unverified Apple identity", scheduledDate: "2027-02-14",
  }})).json()).item;
  const copy = [...appleEvents.entries()].find(([, ics]) => ics.includes(`URL:${base}/?event=${event.id}`));
  assert.ok(copy, "the dated local Event should have an Apple copy");
  const path = copy[0];
  const original = copy[1];
  const originalUid = original.match(/^UID:([^\r\n]+)/m)?.[1];
  assert.ok(originalUid);
  const changedIdentity = original.replace(/^UID:[^\r\n]+/m, "UID:unexpected-provider-event");
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    appleEvents.set(path, changedIdentity);
    omittedAppleReports.add(path);
    providerRequests = [];
    const cleared = await request(`/api/items/${event.id}`, {token: owner.token, method: "PATCH", body: {
      scheduledDate: null, scheduledTime: null,
    }});
    assert.equal(cleared.status, 200);
    assert.ok(providerRequests.some((entry) => entry.method === "GET" && entry.path === path),
      "the omitted Apple resource should be fetched and checked");
    assert.equal(providerRequests.some((entry) => entry.method === "DELETE" && entry.path === path), false,
      "a resource whose UID differs from the tracked copy must not be deleted");
    assert.equal(appleEvents.get(path), changedIdentity);
    const mapping = db.prepare("SELECT external_id,resource_uid FROM calendar_copies WHERE user_id=? AND provider='apple' AND item_id=?")
      .get(owner.user.id, event.id);
    assert.ok(mapping, "the unverified Calendar copy identity must be retained");
    assert.equal(mapping.resource_uid, originalUid);
    const retained = (await (await request(`/api/items/${event.id}`, {token: owner.token})).json()).item;
    assert.equal(retained.scheduledDate, null);
    assert.ok(retained.calendarSync.some((status) => status.provider === "apple"
      && status.state === "limited" && status.limitationCode === "unverifiable-event"),
    "the undated Event should retain the identity-verification limitation");
    assert.ok((await (await request("/api/calendars", {token: owner.token})).json()).syncDelivery
      .some((status) => status.provider === "apple" && status.state === "failed"),
    "cleanup must not report a provider sync as complete while identity is unknown");
  } finally {
    omittedAppleReports.delete(path);
    appleEvents.clear();
    db.close();
  }
});

test("Apple connected first does not export before Google recurrence validation", async () => {
  const owner = await account();
  await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
  const source = {id: "google-external-recurrence", summary: "Google external recurrence", start: {date: "2027-01-14"}, end: {date: "2027-01-15"}};
  try {
    googleEvents.set(source.id, structuredClone(source));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === source.summary);
    assert.ok(item);
    googleEvents.set(source.id, {...googleEvents.get(source.id), recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"]});
    const googleBefore = structuredClone(googleEvents.get(source.id));
    const appleBefore = structuredClone([...appleEvents.entries()]);
    providerRequests = [];
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    assert.deepEqual(googleEvents.get(source.id), googleBefore);
    assert.deepEqual([...appleEvents.entries()], appleBefore);
    assert.equal(providerRequests.some(entry => entry.method === "PUT" && entry.path.startsWith("/apple/")), false);
    const updated = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item;
    assert.equal(updated.calendarSync.find(status => status.provider === "google").state, "limited");
  } finally { appleEvents.clear(); googleEvents.clear(); }
});

test("imported provider titles preserve whitespace until deliberately edited", async () => {
  for (const provider of ["apple", "google"]) {
    const priorGoogleEvents=googleEvents;
    const priorAppleEvents=appleEvents;
    googleEvents=new Map();
    appleEvents=new Map();
    const owner = await account();
    if (provider === "apple") await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
    else {
      const auth = await beginGoogleAuthorization(owner);
      await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
    }
    const title = "  Whitespace title  ";
    const path = "/apple/calendar/whitespace.ics";
    const original = appleCalendarFixture({uid: "whitespace"}).replace("DTSTART;VALUE=DATE:20270114", "DTSTART;VALUE=DATE:20270114\r\nDTEND;VALUE=DATE:20270115").replace("SUMMARY:Imported calendar event", `SUMMARY:${title}`);
    try {
      if (provider === "apple") appleEvents.set(path, original);
      else googleEvents.set("whitespace", {id: "whitespace", summary: title, start: {date: "2027-01-14"}, end: {date: "2027-01-15"}});
      assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
      if (provider === "apple") assert.equal(appleEvents.get(path), original);
      else assert.equal(googleEvents.get("whitespace").summary, title);
      const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title.trim() === "Whitespace title");
      assert.ok(item);
      assert.equal((await request(`/api/items/${item.id}`, {token: owner.token, method: "PATCH", body: {title: "Edited title"}})).status, 200);
      if (provider === "apple") assert.match(appleEvents.get(path), /SUMMARY:Edited title/);
      else assert.equal(googleEvents.get("whitespace").summary, "Edited title");
    } finally { appleEvents=priorAppleEvents; googleEvents=priorGoogleEvents; }
  }
});

test("legacy Google copies migrate only with a verified provider marker", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, { cookie: auth.cookie, redirect: "manual" })).status, 303);
  const create = async (title) => {
    const response = await request("/api/items", { token: owner.token, method: "POST", body: { kind: "event", title, scheduledDate: "2027-01-14" } });
    assert.equal(response.status, 201);
    return (await response.json()).item;
  };
  const verified = await create("Legacy verified");
  const blocked = await create("Legacy blocked");
  const fileResponse = await request("/api/files", { token: owner.token, method: "POST", body: { name: "Legacy context", url: "https://example.com/context" } });
  assert.equal(fileResponse.status, 201);
  const file = (await fileResponse.json()).file;
  assert.equal((await request(`/api/files/${file.id}/attachments`, { token: owner.token, method: "POST", body: { itemId: verified.id } })).status, 201);
  const findCopy = (item) => [...googleEvents.entries()].find(([, copy]) => copy.extendedProperties.private.filetasksItemId === item.id);
  const [verifiedId] = findCopy(verified);
  const [blockedId, blockedCopy] = findCopy(blocked);
  const mismatched = structuredClone(blockedCopy);
  mismatched.extendedProperties.private.filetasksItemId = "another-item";
  googleEvents.set(blockedId, mismatched);
  googleEvents.set(verifiedId, { ...googleEvents.get(verifiedId), summary: "External change" });
  await stopServer();
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    db.prepare("UPDATE calendar_connections SET connection_scope_id=NULL, legacy_identity_eligible=0 WHERE user_id=? AND provider='google'").run(owner.user.id);
    db.prepare("UPDATE calendar_copies SET connection_scope_id=NULL WHERE user_id=? AND provider='google'").run(owner.user.id);
    await startServer();
    const sync = await request("/api/calendars/sync", { token: owner.token, method: "POST" });
    assert.equal(sync.status, 200);
    const result = await sync.json();
    assert.ok(!result.syncLimitations.some((entry) => entry.itemId === verified.id), "verified legacy copy must not retain a limitation on first sync");
    const scope = db.prepare("SELECT connection_scope_id FROM calendar_connections WHERE user_id=? AND provider='google'").get(owner.user.id).connection_scope_id;
    assert.ok(scope);
    const mappings = () => db.prepare("SELECT item_id,external_id,connection_scope_id FROM calendar_copies WHERE user_id=? AND provider='google' ORDER BY item_id").all(owner.user.id);
    const rows = mappings();
    assert.equal(rows.find((row) => row.item_id === verified.id).connection_scope_id, scope);
    assert.equal(rows.find((row) => row.item_id === blocked.id).connection_scope_id, null);
    assert.equal((await request(`/api/items/${verified.id}`, { token: owner.token, method: "PATCH", body: { title: "Updated legacy verified" } })).status, 200);
    assert.equal(googleEvents.get(verifiedId).summary, "Updated legacy verified");
    assert.deepEqual(googleEvents.get(blockedId), mismatched);
    assert.ok(result.syncLimitations.some((entry) => entry.itemId === blocked.id));
    const items = (await (await request("/api/items", { token: owner.token })).json()).items;
    assert.ok(items.find((item) => item.id === blocked.id).calendarSync.length);
    assert.deepEqual(items.find((item) => item.id === verified.id).files, [{ id: file.id, name: "Legacy context", sourceType: "link" }]);
    await stopServer();
    await startServer();
    assert.equal((await request("/api/calendars/sync", { token: owner.token, method: "POST" })).status, 200);
    assert.deepEqual(mappings(), rows);
    assert.deepEqual(googleEvents.get(blockedId), mismatched);
    const files = (await (await request("/api/files", { token: owner.token })).json()).files;
    assert.ok(files.find((entry) => entry.id === file.id).attachments.some((attachment) => attachment.itemId === verified.id));
  } finally {
    db.close();
    googleEvents.clear();
  }
});

test("Apple embedded VTIMEZONE conflicting with IANA rules blocks Calendar copies", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
  await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
  const path = "/apple/calendar/conflicting-timezone.ics";
  const original = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:conflicting-timezone\r\nDTSTAMP:20261013T120000Z\r\nDTSTART;TZID=America/New_York:20270114T100000\r\nDTEND;TZID=America/New_York:20270114T110000\r\nSUMMARY:Conflicting timezone\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  try {
    appleEvents.set(path, original);
    const sync = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(sync.status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === "Conflicting timezone");
    assert.ok(item);
    assert.ok((await sync.json()).syncLimitations.some(entry => entry.itemId === item.id));
    const status = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item.calendarSync.find(entry => entry.provider === "apple");
    assert.equal(status.state, "limited");
    assert.ok(status.limitationCode);
    assert.equal(appleEvents.get(path), original);
    assert.equal(googleEvents.size, 0);
  } finally { appleEvents.clear(); googleEvents.clear(); }
});

for (const order of ["apple-first", "google-first"]) {
  test(`Apple-origin copies recover together in one sync (${order})`, async () => {
    const owner = await account();
    const connectApple = () => request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
    const connectGoogle = async () => {
      const auth = await beginGoogleAuthorization(owner);
      return request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
    };
    const path = "/apple/calendar/both-deleted.ics";
    try {
      appleEvents.set(path, appleCalendarFixture({uid: "both-deleted"}));
      if (order === "apple-first") { await connectApple(); await connectGoogle(); }
      else { await connectGoogle(); await connectApple(); }
      assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
      const items = (await (await request("/api/items", {token: owner.token})).json()).items;
      const item = items.find(entry => entry.title === "Imported calendar event");
      assert.ok(item);
      assert.equal(googleEvents.size, 1, `Google resources after initial sync: ${[...googleEvents.keys()].join(", ")}`);
      appleEvents.clear(); googleEvents.clear();
      assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
      assert.equal(appleEvents.size, 1, `Apple resources after recovery: ${[...appleEvents.keys()].join(", ")}`);
      assert.equal(googleEvents.size, 1);
      assert.equal((await request(`/api/items/${item.id}`, {token: owner.token, method: "PATCH", body: {title: "Recovered event edited"}})).status, 200);
      assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
      assert.match([...appleEvents.values()][0], /SUMMARY:Recovered event edited/);
      assert.equal([...googleEvents.values()][0].summary, "Recovered event edited");
      assert.equal(appleEvents.size, 1);
      assert.equal(googleEvents.size, 1);
      assert.equal((await (await request("/api/items", {token: owner.token})).json()).items.filter(entry => entry.title === "Recovered event edited").length, 1);
    } finally { appleEvents.clear(); googleEvents.clear(); }
  });
}

test("dual verified NULL-scope Calendar copies update on first sync without stale status", async () => {
  const owner = await account();
  const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"})).status, 303);
  assert.equal((await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}})).status, 201);
  const created = await request("/api/items", {token: owner.token, method: "POST", body: {kind: "event", title: "Authoritative title", scheduledDate: "2027-01-14"}});
  const item = (await created.json()).item;
  const [googleId] = googleEvents.keys(); const [applePath] = appleEvents.keys();
  googleEvents.set(googleId, {...googleEvents.get(googleId), summary: "External title"});
  appleEvents.set(applePath, appleEvents.get(applePath).replace("SUMMARY:Authoritative title", "SUMMARY:External title"));
  await stopServer();
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    db.prepare("UPDATE calendar_connections SET connection_scope_id=NULL, legacy_identity_eligible=0 WHERE user_id=?").run(owner.user.id);
    db.prepare("UPDATE calendar_copies SET connection_scope_id=NULL WHERE user_id=?").run(owner.user.id);
    await startServer();
    const sync = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(sync.status, 200);
    const result = await sync.json();
    assert.equal(googleEvents.get(googleId).summary, "Authoritative title", JSON.stringify({
      sync:result,
      connection:db.prepare("SELECT connection_scope_id,legacy_identity_eligible FROM calendar_connections WHERE user_id=? AND provider='google'").get(owner.user.id),
      copy:db.prepare("SELECT external_id,connection_scope_id FROM calendar_copies WHERE user_id=? AND provider='google' AND item_id=?").get(owner.user.id,item.id),
      state:db.prepare("SELECT generation,connection_scope_id,state,last_error FROM calendar_sync_state WHERE user_id=? AND provider='google'").get(owner.user.id),
    }));
    assert.match(appleEvents.get(applePath), /SUMMARY:Authoritative title/);
    assert.ok(!result.syncLimitations.some(entry => entry.itemId === item.id));
    const updated = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item;
    assert.ok(updated.calendarSync.every(({state}) => state !== "pending" && state !== "limited"));
  } finally { db.close(); googleEvents.clear(); appleEvents.clear(); }
});

test("Google tentative status survives the actual PUT body", async () => {
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
  const source = {id: "tentative-status", status: "tentative", summary: "Tentative event", start: {date: "2027-01-01"}, end: {date: "2027-01-02"}};
  try {
    googleEvents.set(source.id, structuredClone(source));
    assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
    const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === source.summary);
    assert.ok(item);
    const start = providerRequests.length;
    assert.equal((await request(`/api/items/${item.id}`, {token: owner.token, method: "PATCH", body: {title: "Edited tentative event"}})).status, 200);
    const put = providerRequests.slice(start).find(entry => entry.method === "PUT" && entry.path.endsWith(`/events/${source.id}`));
    assert.ok(put, "expected a Google PUT for the edited event");
    assert.equal(put.body.status, "tentative");
  } finally { googleEvents.clear(); }
});

test("Google attendee displayName line breaks cannot inject Apple properties", async () => {
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"})).status, 303);
  assert.equal((await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}})).status, 201);
  const source = {id: "attendee-injection", summary: "Attendee injection", start: {date: "2027-01-14"}, end: {date: "2027-01-15"}, attendees: [{email: "guest@example.com", displayName: "Guest\r\nX-INJECTED:yes\nLOCATION:Injected\rSUMMARY:Injected"}]};
  try {
    googleEvents.set(source.id, structuredClone(source));
    const sync = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(sync.status, 200);
    assert.ok((await sync.json()).synced.includes("apple"));
    assert.equal(appleEvents.size, 1);
    const ics = [...appleEvents.values()][0];
    assert.match(ics, /ATTENDEE/);
    assert.doesNotMatch(ics, /(?:^|[\r\n])(?:X-INJECTED|LOCATION|SUMMARY):Injected/);
    assert.doesNotMatch(ics, /(?:^|[\r\n])X-INJECTED:/);
  } finally { googleEvents.clear(); appleEvents.clear(); }
});

test("Google fractional timestamps remain limited and preserve provider timing", async () => {
  const owner = await account(); const auth = await beginGoogleAuthorization(owner);
  assert.equal((await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"})).status, 303);
  assert.equal((await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}})).status, 201);
  const samples = [
    {id: "fraction-start", summary: "Fraction start", start: {dateTime: "2027-01-14T12:00:00.123Z"}, end: {dateTime: "2027-01-14T13:00:00Z"}},
    {id: "fraction-end", summary: "Fraction end", start: {dateTime: "2027-01-14T14:00:00Z"}, end: {dateTime: "2027-01-14T15:00:00.456Z"}},
  ];
  try {
    for (const source of samples) googleEvents.set(source.id, structuredClone(source));
    const sync = await request("/api/calendars/sync", {token: owner.token, method: "POST"});
    assert.equal(sync.status, 200);
    const result = await sync.json();
    const items = (await (await request("/api/items", {token: owner.token})).json()).items;
    for (const source of samples) {
      const item = items.find(entry => entry.title === source.summary);
      assert.ok(item);
      assert.ok(result.syncLimitations.some(entry => entry.itemId === item.id));
      assert.equal(item.calendarSync[0].limitationCode, "unsupported-timing");
      assert.deepEqual(googleEvents.get(source.id), source);
      const start = providerRequests.length;
      assert.equal((await request(`/api/items/${item.id}`, {token: owner.token, method: "PATCH", body: {scheduledDate: "2027-01-15", scheduledTime: "10:00"}})).status, 200);
      assert.deepEqual(googleEvents.get(source.id), source);
      assert.ok(!providerRequests.slice(start).some(entry => entry.method === "PUT" && entry.path.endsWith(`/events/${source.id}`)));
    }
    assert.equal(appleEvents.size, 0);
  } finally { googleEvents.clear(); appleEvents.clear(); }
});

for (const omitted of [false, true]) {
  test(`Google-origin Apple copy preserves externally added unsupported recurrence (${omitted ? "REPORT omitted" : "REPORT included"})`, async () => {
    const owner = await account();
    const auth = await beginGoogleAuthorization(owner);
    await request(`/api/calendars/google/callback?state=${encodeURIComponent(auth.state)}&code=fake-code`, {cookie: auth.cookie, redirect: "manual"});
    await request("/api/calendars", {token: owner.token, method: "POST", body: {username: "person@example.com", password: "app-specific-password", calendarUrl: `${deliveryBase}/apple/calendar/`}});
    const source = {id: "google-single-destination", summary: "Google single destination", start: {date: "2027-01-14"}, end: {date: "2027-01-15"}};
    try {
      googleEvents.set(source.id, structuredClone(source));
      assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
      const item = (await (await request("/api/items", {token: owner.token})).json()).items.find(entry => entry.title === source.summary);
      assert.ok(item);
      const [path, valid] = [...appleEvents.entries()][0];
      assert.ok(valid);
      const changed = valid.replace("END:VEVENT", "RRULE:FREQ=MONTHLY;BYDAY=1MO\r\nEND:VEVENT");
      assert.notEqual(changed, valid);
      appleEvents.set(path, changed);
      if (omitted) omittedAppleReports.add(path);
      const googleBefore = structuredClone([...googleEvents.entries()]);
      for (let attempt = 0; attempt < 2; attempt++) {
        providerRequests = [];
        assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
        if (omitted) assert.ok(providerRequests.some(entry => entry.method === "GET" && entry.path === path));
        assert.equal(appleEvents.get(path), changed);
        assert.deepEqual([...googleEvents.entries()], googleBefore);
        assert.equal(providerRequests.some(entry => ["PUT", "PATCH", "DELETE"].includes(entry.method) && (entry.path === path || entry.path.includes(source.id))), false);
        const updated = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item;
        assert.ok(updated.calendarSync.some(status => status.state === "limited" && status.limitationCode && status.limitation));
      }
      appleEvents.set(path, valid);
      omittedAppleReports.delete(path);
      assert.equal((await request("/api/calendars/sync", {token: owner.token, method: "POST"})).status, 200);
      const restored = (await (await request(`/api/items/${item.id}`, {token: owner.token})).json()).item;
      assert.ok(restored.calendarSync.every(status => status.state !== "limited"));
    } finally { omittedAppleReports.clear(); appleEvents.clear(); googleEvents.clear(); }
  });
}
