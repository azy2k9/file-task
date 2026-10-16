import { readFileSync } from "node:fs";

export function nowMs() {
  const clockPath = process.env.FILETASKS_TEST_CLOCK_PATH;
  if (clockPath) {
    try {
      const controlledTime = Date.parse(readFileSync(clockPath, "utf8").trim());
      if (Number.isFinite(controlledTime)) return controlledTime;
    } catch {
      // Fall through to the system clock if the optional test clock is unavailable.
    }
  }
  return Date.now();
}

export function now() {
  return new Date(nowMs());
}
