import assert from "node:assert/strict";
import { test } from "node:test";
import { setEmulatorRunning } from "../../../scripts/emulator-control.mjs";

test("shared acceptance pauses and restores only its selected emulator", async () => {
  let state = "running";
  const actions = [];
  const execute = async (args) => {
    assert.deepEqual(args.slice(0, 4), ["-s", "emulator-5554", "emu", "avd"]);
    const action = args[4];
    actions.push(action);
    if (action === "status") return `virtual device is ${state}\nOK\n`;
    state = action === "start" ? "running" : "stopped";
    return "OK\n";
  };
  await setEmulatorRunning(execute, "emulator-5554", false);
  await setEmulatorRunning(execute, "emulator-5554", false);
  await setEmulatorRunning(execute, "emulator-5554", true);
  await setEmulatorRunning(execute, "emulator-5554", true);
  assert.equal(state, "running");
  assert.deepEqual(actions, ["status", "stop", "status", "status", "start", "status"]);
});

test("emulator control rejects unrecognized state and console errors", async () => {
  await assert.rejects(setEmulatorRunning(async () => "KO: failed\n", "emulator-5554", false), /failed/);
  await assert.rejects(setEmulatorRunning(async () => "unknown\nOK\n", "emulator-5554", false), /determine/);
  await assert.rejects(setEmulatorRunning(async () => "OK\n", "physical-device", false), /serial/);
});
