import assert from "node:assert/strict";
import { test } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../../scripts/test-ios-ui.mjs";

const group = 123456;
const failure = (code) => Object.assign(new Error(code), { code });

test("cleanup waits through a transient permission error until the group disappears", async (t) => {
  const calls = [];
  let probes = 0;
  t.mock.method(process, "kill", (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 0 && ++probes === 2) throw failure("EPERM");
    if (signal === 0 && probes === 3) throw failure("ESRCH");
    return true;
  });

  await terminateProcessGroup(group, "SIGTERM", { graceMs: 500 });
  assert.deepEqual(calls, [[-group, 0], [-group, "SIGTERM"], [-group, 0], [-group, 0]]);
});

test("permission errors do not establish group exit or permit escalation", async (t) => {
  const calls = [];
  let probes = 0;
  t.mock.method(process, "kill", (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 0 && ++probes > 1) throw failure("EPERM");
    return true;
  });

  await assert.rejects(terminateProcessGroup(group, "SIGTERM", { graceMs: 0 }), /permission denied/);
  assert.equal(processGroupExists(group), true);
  assert.equal(calls.some(([, signal]) => signal === "SIGKILL"), false);
});

test("a denied termination signal remains an error", async (t) => {
  t.mock.method(process, "kill", (_pid, signal) => {
    if (signal !== 0) throw failure("EPERM");
    return true;
  });
  await assert.rejects(terminateProcessGroup(group), { code: "EPERM" });
});
