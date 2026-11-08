# Personal Tasks and Events acceptance

[Issue #2](https://github.com/azy2k9/file-task/issues/2) is implemented by the shared account API and three clients. This checklist maps its acceptance criteria to the implementation and regression coverage.

| Requirement | Implementation | Acceptance coverage |
| --- | --- | --- |
| Next.js web and native mobile apps | `apps/web/app/page.tsx`, SwiftUI in `apps/ios/FileTasks/Views`, Kotlin/Compose in `apps/android/app/src/main/java/com/filetasks/android/ui` | Web production build; native build and UI jobs in CI |
| Create, view, edit, delete and complete Tasks | Shared `/api/items` routes; each client's agenda, editor and Task completion controls | Web Task lifecycle and browser workflows in `apps/web/tests/workspace.test.mjs`; iOS `createTaskAndExerciseItsLifecycle`; Android personal Task workflow in `RecurringAgendaUiTest.kt` |
| Create, view, edit and delete Events with optional dates and times | The same account API stores distinct `task` and `event` kinds. Events have no completion state. Dates and times may be absent; a time requires a date. | Web Event lifecycle, validation and browser workflows; iOS `createEventAndExerciseItsLifecycle`; Android personal Event workflow |
| Distinguish Tasks and Events in a useful agenda | All three clients label item types, filter by type, group by date and place undated items separately. Only Tasks expose completion controls. | Browser navigation and native agenda UI workflows |
| Saved items available on other clients | Browser cookies and native bearer tokens authenticate to the same account-scoped SQLite data through `/api/items`. Refresh retrieves changes from other clients. | Independent browser/native session lifecycle regression; shared iOS/Android/web acceptance workflow; server restart persistence and account privacy tests |

The independent session regression creates both item types with a browser session, reads and edits them through a separately authenticated bearer session, checks the browser sees those edits, then verifies browser deletion removes them from the other session. This checks cross-client persistence through the public API rather than assuming two clients share local state.

Run the focused web/API verification from the repository root:

```sh
FILETASKS_TEST_PORT=3122 node --test --test-name-pattern='a person can create a Task|Task and Event changes stay shared|a person can edit, complete|Events can be remembered|invalid item changes|accounts are private|a person can manage Tasks|account and saved items remain' apps/web/tests/workspace.test.mjs
npm run typecheck
npm run build
```

The bearer-session test verifies the shared API contract; running the actual native clients additionally requires their toolchains. Use `npm run test:shared-acceptance` on macOS with Xcode, an iOS Simulator runtime and an Android emulator for the complete native and browser workflow, as described in the root README. Native execution cannot be validated on a Linux host without those tools.
