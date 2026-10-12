# FileTasks

A personal workspace for actionable **Tasks** and memorable **Events**. The clients are a Next.js web app, a native SwiftUI iOS app, and a Kotlin/Jetpack Compose Android app. All clients share one account and API.

This implements [issue #2](https://github.com/azy2k9/file-task/issues/2). Recurrence rules, Reminders, Files, and connected calendars belong to later issues.

## Run the web app

Install Node.js 22.13 or newer, then:

```sh
npm ci
cp apps/web/.env.example apps/web/.env.local
npm run dev
```

Open `http://localhost:3000` and create an account with an email address and a password of at least 12 characters. Create a Task or Event, optionally add details and a date/time, and use the agenda or type filters. Tasks support completion and reopening; Events have no completion state. Open an item to view or edit its full details. Deletion asks for confirmation.

## Native clients

- [iOS setup](apps/ios/README.md): open the Xcode project on macOS.
- [Android setup](apps/android/README.md): open the Gradle project in Android Studio.

Configure the same FileTasks server origin in each client and sign in with the same account. The Android emulator reaches a local host server through `http://10.0.2.2:3000`; the iOS simulator can use `http://localhost:3000`. Physical devices need a reachable server address. HTTP is a development option; use HTTPS for a hosted server. Refresh the agenda to see changes from another client; the web also refreshes when focused and every 30 seconds while visible. Network access is required to save and refresh.

## Current issue #2 API prototype

The current prototype still routes API requests through Next.js route handlers; their authentication, persistence, and workspace logic lives under `services/api`. The long-term server runtime is being evaluated independently, and the route handlers are a temporary adapter to keep issue #2 usable while that choice is made.

```sh
npm run build
npm start
```

For a shared prototype, run the web app's Node server behind an HTTPS reverse proxy. Set `FILETASKS_ORIGIN` to its exact public origin (for example `https://filetasks.example.com`, without a trailing slash) and `FILETASKS_DATABASE_PATH` to a persistent writable SQLite path. Relative database paths resolve from the repository root, preserving the earlier `data/filetasks.sqlite` default. Back up the database with a SQLite-aware backup while running, or stop the server before copying the database and any journal files. This prototype requires persistent disk; an ephemeral/serverless filesystem will not preserve accounts or support shared instances.

If you already have a root `.env.local`, move it to `apps/web/.env.local` before restarting the web app.

Account data is scoped on the server. Passwords use salted scrypt hashes; random session tokens are stored as hashes and expire after 30 days. Browser sessions use HttpOnly, SameSite cookies, secured on HTTPS; native clients use bearer tokens. Cookie mutations require the configured same origin. Sign-out revokes the current session. Login attempts are limited per email. Email verification, password recovery, and account deletion are not implemented in this first workspace.

Dates and times are local wall-clock values, not instants: an item dated `2026-11-03` at `16:00` displays that same date/time on every client. An absent time means all day; an absent date means undated. A time requires a date.

## Verify

```sh
npm run typecheck
npx playwright install --with-deps chromium
npm test
npm run build
```

Acceptance tests exercise the public HTTP application boundary and browser workflows using a temporary database and isolated accounts. They run a test server on port 3107. Stop another Next.js development server in this checkout before testing, because Next.js locks its development output directory. Run one workflow with `node --test --test-name-pattern='workflow name' apps/web/tests/workspace.test.mjs`.

CI checks the web application and compiles both native projects with their platform SDKs. Native builds require their respective toolchains; a web build does not validate SwiftUI or Android code.

See [the API contract](docs/api.md) for the shared client interface.
