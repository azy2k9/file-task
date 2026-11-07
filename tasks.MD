# FileTasks — outstanding actions

This file separates setup that needs your accounts or infrastructure from repository work I can complete.

## You — external setup (only for features you want to use)

- [ ] **Choose and configure a hosted server** if FileTasks should be available when your development machine is off. Use HTTPS, persistent writable storage for SQLite (`FILETASKS_DATABASE_PATH`), set the public origin, and arrange database backups. The current prototype requires a persistent filesystem.
- [ ] **Enable uploaded Files:** create a private Cloudflare R2 bucket, configure browser CORS for the web origin, and provide the R2 credentials in the server environment. External file links work without this setup.
- [ ] **Enable Google Calendar:** create a Google OAuth client, register the server callback URL, and configure the OAuth credentials on the server.
- [ ] **Enable Apple Calendar:** generate an Apple ID app-specific password when connecting the account. Configure `FILETASKS_CALENDAR_ENCRYPTION_KEY` on the server before connecting either calendar provider.
- [ ] **Enable email or push Reminders:** choose delivery providers and configure their server-side adapters/secrets. Schedule the authenticated reminder worker to run at least once per minute. For iPhone push, also configure APNs and an iOS signing team with Push Notifications enabled; for Android push, configure the Firebase app and `google-services.json`.
- [ ] **Install native clients if desired:** iOS requires a Mac with Xcode and device signing; Android requires Android Studio/SDK and JDK 17. Set each client to the same reachable server origin. Use HTTPS outside local development.

## Assistant — repository work

- [ ] **Finish issue #24 / PR #55:** the code and acceptance-fixture fixes are pushed; the latest Android workflow failed in `RecurringAgendaUiTest` with a Compose `SnapshotStateObserver` cross-thread error. Recheck or rerun the Android job when GitHub finishes the workflow, then fix any reproducible failure and complete the PR.
- [ ] **Review and complete remaining open implementation tickets** after checking each issue against the current code and open PRs: #32, #31, #30, #29, #28, #27, #26, #25, #11, #9, #8, #7, #6, #5, #4, #3, #2, and #1. Some may be parent or umbrella tickets; check their acceptance criteria and avoid duplicate work. Close tickets only after their criteria are met.
- [ ] **Potential product gaps, if they are in scope:** email verification, password recovery, account deletion, and offline editing are not implemented. These need product requirements before coding.

## Status notes

- Local prototype mode works without R2, calendar providers, or external Reminder delivery adapters; those integrations need setup only when you want to use them.
- Native clients share data through the configured FileTasks API. They do not currently edit offline.
