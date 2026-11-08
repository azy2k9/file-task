# Files and Reminders across recurring Occurrences

[Issue #6](https://github.com/azy2k9/file-task/issues/6) uses the shared account API across the Next.js web client, native SwiftUI iOS app, and native Kotlin/Compose Android app.

| Requirement | Implementation and coverage |
| --- | --- |
| Series Files appear on every Occurrence; local Files stay local | `services/api/src/workspace.ts` resolves series, following, and Occurrence Attachments. API acceptance tests cover inheritance and local exclusions for Tasks and Events. |
| Multiple series Reminders and individual settings | Series definitions store Reminder arrays; Occurrence edits preserve local settings. Tests cover the three edit scopes, account default changes, and future generation. |
| Offer this Occurrence, this and following Occurrences, and whole series | All three clients expose these scopes for recurring Reminder edits and Attachment additions/removals. iOS removal detects the recurring item even when the Attachment itself is local. |
| Apply following removal to the entire selected range | `services/api/src/files.ts` removes local Attachments and later following anchors in one transaction, while preserving earlier Occurrences and associations with other series. API regressions exercise both local-only and overlapping following Attachments. |
| New uploads remain independent Files | Upload completion creates a File without changing existing Attachments. Same-name upload tests verify that replacement requires explicit removal and addition of Attachments. |

Run focused API acceptance checks from the repository root:

```sh
node --test --test-name-pattern='issue 6:|series Attachment|following Attachment|reattaching an excluded|local restoration|custom recurring Reminders|recurring items create independent' apps/web/tests/workspace.test.mjs
npm run typecheck
npm run build
```

The API harness uses a temporary database, a controlled clock, and fake object storage. It verifies saved settings, effective Files on Occurrences, and independent upload bytes through public routes. Native UI execution additionally requires the Xcode and Android toolchains; use `npm run test:shared-acceptance` on a configured host. A web build does not validate SwiftUI compilation or the native removal dialog.
