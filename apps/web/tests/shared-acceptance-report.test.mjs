import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSharedAcceptanceReport } from "../../../scripts/test-ios-ui.mjs";

const report = `TAP version 13
ok 1 - Android UI acceptance: recurring agenda updates are visible across clients
ok 2 - iOS, Android and web run against one shared account, API and provider fakes
ok 3 - iOS UI acceptance: registration, cross-type Reminder preservation, calendar sync and browser read
# fail 0
# skipped 0
# todo 0
`;

test("shared acceptance requires each native phase and rejects skipped scenarios", () => {
  assert.doesNotThrow(() => assertSharedAcceptanceReport(report));
  assert.throws(() => assertSharedAcceptanceReport(report.replace("ok 1 - Android", "ok 1 - Other")), /required shared phase/);
  assert.throws(() => assertSharedAcceptanceReport(report.replace("visible across clients", "visible across clients # SKIP")), /required shared phase/);
  assert.throws(() => assertSharedAcceptanceReport(`${report}ok 4 - future scenario # SKIP missing prerequisite\n`), /skipped/);
  assert.throws(() => assertSharedAcceptanceReport(report.replace("# fail 0", "# fail 1")), /skipped/);
});
