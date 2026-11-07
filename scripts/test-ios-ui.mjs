import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { setEmulatorRunning } from "./emulator-control.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const testName = "iOS UI acceptance: registration, cross-type Reminder preservation, calendar sync and browser read";
let activeChild;
let interruptedSignal;
let interruptionPromise;
let interruptionFailure;
let cleanupInProgress = false;

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function probeProcessGroup(pid) {
  if (process.platform === "win32") throw new Error("POSIX process groups are not available on Windows.");
  try {
    process.kill(-pid, 0);
    return "present";
  } catch (error) {
    if (error.code === "ESRCH") return "gone";
    // On macOS a group probe can fail if any member is not signalable.
    // This does not establish that the group has exited.
    if (error.code === "EPERM") return "permission-denied";
    throw error;
  }
}

export function processGroupExists(pid) {
  return probeProcessGroup(pid) !== "gone";
}

export async function waitForProcessGroupExit(pid, timeoutMs = 2_000) {
  if (process.platform === "win32") return true;
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

export async function terminateProcessGroup(pid, signal = "SIGTERM", { graceMs = 2_000, killWaitMs = 5_000 } = {}) {
  if (process.platform === "win32") throw new Error("POSIX process groups are not available on Windows.");
  const initialState = probeProcessGroup(pid);
  if (initialState === "gone") return;
  if (initialState === "permission-denied") {
    throw new Error(`Cannot safely signal process group ${pid}: permission denied.`);
  }

  signalProcessGroup(pid, signal);
  if (await waitForProcessGroupExit(pid, graceMs)) return;

  const state = probeProcessGroup(pid);
  if (state === "gone") return;
  if (state === "permission-denied") {
    throw new Error(`Cannot verify process group ${pid} exited after ${signal}: permission denied.`);
  }
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, killWaitMs))) {
    throw new Error(`Owned process group ${pid} did not exit after ${signal} and SIGKILL.`);
  }
}

function installInterruptionHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (interruptedSignal) {
        if (!cleanupInProgress && activeChild?.pid && process.platform !== "win32") {
          void terminateProcessGroup(activeChild.pid, "SIGKILL", { graceMs: 0 }).catch((error) => { interruptionFailure = error; });
        }
        return;
      }

      interruptedSignal = signal;
      if (cleanupInProgress) return;

      const child = activeChild;
      interruptionPromise = child?.pid && process.platform !== "win32"
        // The coordinator gets 60 seconds to stop Xcode, the temporary server,
        // provider fake, and browser before the runner escalates its process group.
        ? terminateProcessGroup(child.pid, signal, { graceMs: 60_000, killWaitMs: 5_000 })
        : Promise.resolve();
      interruptionPromise.catch((error) => { interruptionFailure = error; });
    });
  }
}

function run(command, args, { env = process.env, stream = false, allowFailure = false, cleanup = false } = {}) {
  if (interruptedSignal && !cleanup) {
    return Promise.reject(new Error(`The iOS UI runner was interrupted by ${interruptedSignal}.`));
  }

  return new Promise((resolve, reject) => {
    let output = "";
    let spawnError;
    let child;
    try {
      child = spawn(command, args, {
        cwd: repoRoot,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChild = { child, pid: child.pid };
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      if (stream) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      if (stream) process.stderr.write(text);
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", async (code, signal) => {
      let groupError;
      if (child.pid && process.platform !== "win32") {
        try {
          const shutdownGraceMs = interruptedSignal ? 65_000 : 10_000;
          if (!(await waitForProcessGroupExit(child.pid, shutdownGraceMs))) {
            await terminateProcessGroup(child.pid, interruptedSignal ?? "SIGTERM", {
              graceMs: interruptedSignal ? 0 : 2_000,
              killWaitMs: 5_000,
            });
            groupError = new Error(`${command} exited while owned child processes remained; they were terminated.`);
          }
        } catch (error) {
          groupError = error;
        }
      }
      if (activeChild?.child === child) activeChild = undefined;
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (groupError) {
        reject(new Error(`${command} ${args.join(" ")} process cleanup failed: ${groupError.message}\n${output.slice(-6000)}`));
        return;
      }
      const result = { code: code ?? 1, signal, output };
      if (result.code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}\n${output.slice(-6000)}`));
    });
  });
}

async function capture(command, args, options) {
  return (await run(command, args, options)).output.trim();
}

function versionParts(value) {
  return String(value ?? "0").match(/\d+/g)?.map(Number) ?? [0];
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function checkPrerequisites(shared = false) {
  const command = shared ? "npm run test:shared-acceptance" : "npm run test:ios-ui";
  if (process.platform !== "darwin") {
    throw new Error(`${command} requires macOS with Xcode and an iOS Simulator runtime; detected ${process.platform}.`);
  }

  try {
    await capture("xcode-select", ["-p"]);
    const xcodeVersion = await capture("xcodebuild", ["-version"]);
    const runtimeList = JSON.parse(await capture("xcrun", ["simctl", "list", "runtimes", "--json"]));
    const deviceTypeList = JSON.parse(await capture("xcrun", ["simctl", "list", "devicetypes", "--json"]));

    const runtimes = (runtimeList.runtimes ?? [])
      .filter((runtime) => runtime.name?.startsWith("iOS") && runtime.isAvailable !== false)
      .sort((left, right) => compareVersions(right.version, left.version));
    if (runtimes.length === 0) {
      throw new Error("Xcode is installed, but no available iOS Simulator runtime is installed. Add an iOS platform runtime in Xcode Settings > Platforms.");
    }

    const deviceTypes = (deviceTypeList.devicetypes ?? [])
      .filter((deviceType) => deviceType.name?.startsWith("iPhone") && deviceType.identifier)
      .sort((left, right) => compareVersions(right.name, left.name));
    if (deviceTypes.length === 0) {
      throw new Error("Xcode has no iPhone Simulator device types available.");
    }

    return { xcodeVersion, runtimes, deviceTypes };
  } catch (error) {
    throw new Error(`${command} could not verify the Xcode Simulator prerequisites. Install/select a full Xcode installation and an iOS Simulator runtime.\n${error.message}`);
  }
}

async function createDisposableSimulator(name, { runtimes, deviceTypes }) {
  const attempts = [];

  for (const runtime of runtimes) {
    // Let simctl determine compatibility: its numeric minRuntimeVersion is
    // encoded differently from the dotted runtime.version string.
    for (const deviceType of deviceTypes) {
      const result = await run("xcrun", ["simctl", "create", name, deviceType.identifier, runtime.identifier], { allowFailure: true });
      if (result.code === 0) {
        const simulatorId = result.output.trim().match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
        if (simulatorId) return simulatorId;
        throw new Error(`simctl created a simulator but did not return its device id: ${result.output.trim()}`);
      }
      attempts.push(`${deviceType.name} / ${runtime.name}: ${result.output.trim().slice(-1000)}`);
    }
  }

  throw new Error(`Could not create an isolated disposable iPhone Simulator.\n${attempts.slice(0, 3).join("\n")}`);
}

async function runFocusedAcceptance(simulatorId, processGroupStatePath, shared = false, androidSerial) {
  const pattern = `^${testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const testFiles = shared
    ? (await readdir(join(repoRoot, "apps/web/tests"))).filter((name) => name.endsWith(".test.mjs")).sort()
        .map((name) => join("apps/web/tests", name))
    : ["apps/web/tests/workspace.test.mjs"];
  if (testFiles.length === 0) throw new Error("No web acceptance test files were found.");
  const result = await run(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    ...(shared ? [] : [`--test-name-pattern=${pattern}`]),
    ...testFiles,
  ], {
    env: {
      ...process.env,
      FILETASKS_RUN_IOS_UI_ACCEPTANCE: "1",
      ...(shared ? {
        FILETASKS_RUN_SHARED_ACCEPTANCE: "1",
        FILETASKS_RUN_ANDROID_UI_ACCEPTANCE: "1",
        FILETASKS_RUN_NATIVE_ACCEPTANCE: "1",
        FILETASKS_ANDROID_EMULATOR_SERIAL: androidSerial,
      } : {}),
      FILETASKS_IOS_UI_SIMULATOR_ID: simulatorId,
      FILETASKS_IOS_UI_PROCESS_GROUPS_PATH: processGroupStatePath,
    },
    stream: true,
    allowFailure: true,
  });

  if (result.code !== 0) {
    throw new Error(`${shared ? "The full shared acceptance suite" : "The focused iOS UI acceptance"} failed with exit code ${result.code}.`);
  }
  const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const targetLinePattern = new RegExp(`^ok \\d+ - ${escapedName}(?:\\s|$)`);
  const targetLine = result.output.split(/\r?\n/).find((line) => targetLinePattern.test(line));
  if (!targetLine || /# (?:SKIP|TODO)\b/.test(targetLine) || !/^# fail 0$/m.test(result.output)) {
    throw new Error(`The focused iOS UI acceptance did not execute and pass its target test.\n${result.output.slice(-6000)}`);
  }
  if (shared) assertSharedAcceptanceReport(result.output);
}

export function assertSharedAcceptanceReport(output) {
  for (const name of [
    testName,
    "Android UI acceptance: recurring agenda updates are visible across clients",
    "iOS, Android and web run against one shared account, API and provider fakes",
  ]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = output.split(/\r?\n/).find((entry) => new RegExp(`^ok \\d+ - ${escaped}(?:\\s|$)`).test(entry));
    if (!line || /# (?:SKIP|TODO)\b/.test(line)) throw new Error(`The required shared phase did not run: ${name}`);
  }
  if (/^ok \d+ - .*# (?:SKIP|TODO)\b/m.test(output) || !/^# skipped 0$/m.test(output) || !/^# todo 0$/m.test(output) || !/^# fail 0$/m.test(output)) {
    throw new Error("The shared acceptance suite skipped, failed, or marked a test TODO.");
  }
}

export async function stopTrackedProcessGroups(path, { graceMs = 2_000, killWaitMs = 5_000 } = {}) {
  const pids = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid < 2)) {
    throw new Error("The iOS UI harness wrote an invalid owned process-group list.");
  }

  const failures = [];
  for (const pid of pids) {
    try {
      await terminateProcessGroup(pid, "SIGTERM", { graceMs, killWaitMs });
      if (!(await waitForProcessGroupExit(pid, 0))) {
        throw new Error(`Owned iOS UI process group ${pid} is still running.`);
      }
    } catch (error) {
      failures.push(new Error(`Could not stop the iOS UI harness process group ${pid} before Simulator cleanup: ${error.message}`));
    }
  }
  if (failures.length) throw new AggregateError(failures, "Could not stop every tracked iOS UI harness process group.");
}

async function findDisposableSimulator(name) {
  const devices = JSON.parse(await capture("xcrun", ["simctl", "list", "devices", "--json"], { cleanup: true }));
  for (const runtimeDevices of Object.values(devices.devices ?? {})) {
    const match = runtimeDevices.find((device) => device.name === name);
    if (match) return match.udid;
  }
  return undefined;
}

function errorDetails(error) {
  if (error instanceof AggregateError) {
    return `${error.message}\n${[...error.errors].map(errorDetails).join("\n")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  installInterruptionHandlers();
  const shared = process.argv.slice(2).includes("--shared");
  let simulatorId;
  const simulatorName = `FileTasks-UI-${randomUUID().slice(0, 8)}`;
  let simulatorCreationAttempted = false;
  let processGroupStatePath;
  let failure;
  let safeToDeleteSimulator = true;
  let androidSerial;
  try {
    const prerequisites = await checkPrerequisites(shared);
    if (shared) {
      try {
        const state = await capture("adb", ["get-state"]);
        const emulator = await capture("adb", ["shell", "getprop", "ro.kernel.qemu"]);
        const booted = await capture("adb", ["shell", "getprop", "sys.boot_completed"]);
        androidSerial = await capture("adb", ["get-serialno"]);
        await capture("swift", ["--version"]);
        if (state !== "device" || emulator !== "1" || booted !== "1") throw new Error("No fully booted Android emulator was selected.");
      } catch (error) {
        throw new Error(`The shared acceptance suite requires Swift, Android SDK platform-tools, and a booted Android emulator. ${error.message}`);
      }
    }
    if (interruptedSignal) throw new Error(`The iOS UI runner was interrupted by ${interruptedSignal}.`);
    console.log(`Using ${prerequisites.xcodeVersion.replaceAll("\n", " ")}.`);
    simulatorCreationAttempted = true;
    simulatorId = await createDisposableSimulator(simulatorName, prerequisites);
    if (shared) {
      await setEmulatorRunning((args) => capture("adb", args), androidSerial, false);
    } else {
      await run("xcrun", ["simctl", "boot", simulatorId]);
      await run("xcrun", ["simctl", "bootstatus", simulatorId, "-b"]);
    }
    if (interruptedSignal) throw new Error(`The iOS UI runner was interrupted by ${interruptedSignal}.`);
    processGroupStatePath = join(tmpdir(), `filetasks-ios-ui-groups-${randomUUID()}.json`);
    await writeFile(processGroupStatePath, "[]\n", { flag: "wx" });
    await runFocusedAcceptance(simulatorId, processGroupStatePath, shared, androidSerial);
    console.log(shared
      ? "The full web, iOS, and Android acceptance suite passed against the shared temporary backend."
      : "The focused iOS UI acceptance passed against the shared temporary API and browser.");
  } catch (error) {
    failure = error;
  } finally {
    cleanupInProgress = true;
    if (interruptionPromise) {
      try {
        await interruptionPromise;
      } catch (error) {
        safeToDeleteSimulator = false;
        failure = new AggregateError([failure, error].filter(Boolean), "Could not stop the interrupted iOS UI test process group safely.");
      }
    }
    if (interruptionFailure) {
      safeToDeleteSimulator = false;
      failure = new AggregateError([failure, interruptionFailure].filter(Boolean), "Could not stop the interrupted iOS UI test process group safely.");
    }
    if (interruptedSignal && !failure) failure = new Error(`The iOS UI runner was interrupted by ${interruptedSignal}.`);

    if (shared && androidSerial) {
      try {
        await setEmulatorRunning((args) => capture("adb", args, { cleanup: true }), androidSerial, true);
      } catch (error) {
        failure = new AggregateError([failure, error].filter(Boolean), "Could not restore the Android emulator after shared acceptance.");
      }
    }

    if (processGroupStatePath) {
      try {
        await stopTrackedProcessGroups(processGroupStatePath);
      } catch (error) {
        safeToDeleteSimulator = false;
        failure = new AggregateError([failure, error].filter(Boolean), "The iOS UI process groups did not stop safely.");
      }
      try {
        await rm(processGroupStatePath, { force: true });
      } catch (error) {
        failure = new AggregateError([failure, error].filter(Boolean), "Could not remove the iOS UI process-group state file.");
      }
    }

    if (simulatorCreationAttempted && !simulatorId && safeToDeleteSimulator) {
      try {
        simulatorId = await findDisposableSimulator(simulatorName);
      } catch (error) {
        failure = new AggregateError([failure, error].filter(Boolean), "Could not check for a partially created disposable Simulator.");
      }
    }
    if (simulatorId && safeToDeleteSimulator) {
      await run("xcrun", ["simctl", "shutdown", simulatorId], { allowFailure: true, cleanup: true }).catch(() => {});
      const deletion = await run("xcrun", ["simctl", "delete", simulatorId], { allowFailure: true, cleanup: true });
      if (deletion.code !== 0) {
        failure = new AggregateError(
          [failure, new Error(`Could not delete disposable Simulator ${simulatorId}: ${deletion.output.trim()}`)].filter(Boolean),
          "The iOS UI test runner failed during cleanup.",
        );
      }
    } else if (simulatorId) {
      failure = new AggregateError(
        [failure, new Error(`Left disposable Simulator ${simulatorId} in place because its Xcode process group did not exit safely.`)].filter(Boolean),
        "The iOS UI test runner failed during cleanup.",
      );
    }
  }

  if (failure) {
    console.error(errorDetails(failure));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
