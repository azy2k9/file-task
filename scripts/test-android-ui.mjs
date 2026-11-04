import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const adb = spawnSync("adb", ["get-state"], { encoding: "utf8" });
if (adb.error || adb.status !== 0 || adb.stdout.trim() !== "device") {
  console.error("Android UI acceptance requires Android SDK platform-tools and one booted emulator (set ANDROID_SERIAL if needed).");
  process.exit(1);
}
const emulator = spawnSync("adb", ["shell", "getprop", "ro.kernel.qemu"], { encoding: "utf8" });
if (emulator.status !== 0 || emulator.stdout.trim() !== "1") {
  console.error("Android UI acceptance requires a booted Android emulator.");
  process.exit(1);
}
const boot = spawnSync("adb", ["shell", "getprop", "sys.boot_completed"], { encoding: "utf8" });
if (boot.status !== 0 || boot.stdout.trim() !== "1") {
  console.error("The Android emulator has not finished booting.");
  process.exit(1);
}
const mappings = spawnSync("adb", ["reverse", "--list"], { encoding: "utf8" });
if (mappings.status !== 0 || mappings.stdout.split("\n").some((line) => /\btcp:3107\b/.test(line))) {
  console.error("Cannot reserve emulator port 3107; check adb reverse mappings and remove any existing mapping first.");
  process.exit(1);
}
const reverse = spawnSync("adb", ["reverse", "tcp:3107", "tcp:3107"], { encoding: "utf8" });
if (reverse.status !== 0) {
  console.error(`Could not forward emulator port 3107: ${reverse.stderr.trim()}`);
  process.exit(1);
}

const child = spawn(process.execPath, [
  "--test", "--test-concurrency=1",
  "--test-name-pattern=Android UI acceptance: recurring agenda updates are visible across clients",
  "apps/web/tests/workspace.test.mjs",
], {
  cwd: root,
  env: { ...process.env, FILETASKS_RUN_ANDROID_UI_ACCEPTANCE: "1" },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("close", (code, signal) => {
  const cleanup = spawnSync("adb", ["reverse", "--remove", "tcp:3107"], { encoding: "utf8" });
  if (cleanup.status !== 0) console.error(`Could not remove emulator port forwarding: ${cleanup.stderr.trim()}`);
  process.exitCode = signal || cleanup.status !== 0 ? 1 : code ?? 1;
});
