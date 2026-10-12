# FileTasks

A personal workspace for actionable **Tasks** and memorable **Events**. The web client uses Next.js; the mobile clients are native SwiftUI (iOS) and Kotlin/Jetpack Compose (Android). All clients share one account and server API.

This implements [issue #2](https://github.com/azy2k9/file-task/issues/2). Recurrence rules, Reminders, Files, and connected calendars belong to later issues.

## Run the web client and API

Install Node.js 22.13 or newer, then:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000` and create an account with an email address and a password of at least 12 characters. Create a Task or Event, optionally add details and a date/time, and use the agenda or type filters. Tasks support completion and reopening; Events have no completion state. Open an item to view or edit its full details. Deletion asks for confirmation.

## Native clients

- [iOS setup](clients/ios/README.md): open the Xcode project on macOS.
- [Android setup](clients/android/README.md): open the Gradle project in Android Studio.

Configure the same FileTasks server origin in each client and sign in with the same account. The Android emulator reaches a local host server through `http://10.0.2.2:3000`; the iOS simulator can use `http://localhost:3000`. Physical devices need a reachable server address. HTTP is a development option; use HTTPS for a hosted server. Refresh the agenda to see changes from another client; the web also refreshes when focused and every 30 seconds while visible. Network access is required to save and refresh.

## Host a shared server

```sh
npm run build
npm start
```

Run a single Node server behind an HTTPS reverse proxy. Set `FILETASKS_ORIGIN` to its exact public origin (for example `https://filetasks.example.com`, without a trailing slash) and `FILETASKS_DATABASE_PATH` to a persistent writable SQLite path. Forward requests to port 3000. Back up the database with a SQLite-aware backup while running, or stop the server before copying the database and any journal files. This deployment requires persistent disk; an ephemeral/serverless filesystem will not preserve accounts or support shared instances.

Account data is scoped on the server. Passwords use salted scrypt hashes; random session tokens are stored as hashes and expire after 30 days. Browser sessions use HttpOnly, SameSite cookies, secured on HTTPS; native clients use bearer tokens. Cookie mutations require the configured same origin. Sign-out revokes the current session. Login attempts are limited per email. Email verification, password recovery, and account deletion are not implemented in this first workspace.

Dates and times are local wall-clock values, not instants: an item dated `2026-11-03` at `16:00` displays that same date/time on every client. An absent time means all day; an absent date means undated. A time requires a date.

## Verify

```sh
npm run typecheck
npx playwright install --with-deps chromium
npm test
npm run build
```

Acceptance tests exercise the public HTTP application boundary and browser workflows using a temporary database and isolated accounts. They run a test server on port 3107. Stop another Next.js development server in this checkout before testing, because Next.js locks its development output directory. Run one workflow with `node --test --test-name-pattern='workflow name' tests/workspace.test.mjs`.

CI checks the web application and compiles both native projects with their platform SDKs. Native builds require their respective toolchains; a web build does not validate SwiftUI or Android code.

See [the API contract](docs/api.md) for the shared client interface.
