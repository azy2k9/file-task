# FileTasks for iOS

This is the native SwiftUI client for FileTasks. It supports iOS 16 and later and uses the shared FileTasks API so a person’s Tasks and Events appear on the web and other clients after refresh.

## Requirements

| Dependency | Needed for |
| --- | --- |
| A Mac running a macOS version supported by the installed Xcode; use Xcode 15 or later | Building the iOS project. Xcode includes Swift and the iOS SDK; the app's deployment target is iOS 16. See [Apple's Xcode system requirements](https://developer.apple.com/xcode/system-requirements/). |
| An iPhone running iOS 16 or later, plus an Apple Account signed in to Xcode | Installing and running the app on a physical phone. Connect by USB (or pair the device with Xcode over Wi-Fi), trust the Mac, and enable Developer Mode on the iPhone if prompted. The current target includes the APNs entitlement, so plan to sign with an Apple Developer Program team that supports Push Notifications. A free Personal Team does not support push capabilities; to use one, the project first needs a no-push signing configuration. Personal Team profiles also expire after 7 days. See [Apple's developer account guide](https://developer.apple.com/help/account/basics/about-your-developer-account/), [Apple's Personal Team overview](https://developer.apple.com/videos/play/wwdc2019/304/), and [Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device/). |
| Node.js 22.13 or later and npm | Running the shared API/web server on the Mac, or building and running it on a host. |
| Network connectivity between the iPhone and server | Saving and refreshing Tasks, Events, and Files. For local development, both devices must be on the same reachable network. |

The native iOS app has no third-party Swift package dependencies, and does not need CocoaPods or Homebrew. Android Studio, Java, and Firebase are not needed for iPhone use. The repository's lockfile-managed Node runtime dependencies include Next.js, React, React DOM, and the AWS SDK packages used by the optional R2 adapter. The database uses Node's built-in `node:sqlite`; no separate database engine or database account is needed. Install the JavaScript dependency tree with `npm ci` at the repository root.

## Run on an iPhone with a local Mac server

This setup is for development on the same local network. It stops working when the Mac's server stops, the Mac sleeps, or the phone leaves that network. Do not use HTTP with a real account or sign-in token outside a development network.

1. In Terminal, go to the repository checkout and install its Node dependencies:

   ```sh
   npm ci
   ```

2. Start the server:

   ```sh
   npm run dev
   ```

   The app creates a SQLite database at `data/filetasks.sqlite` under the repository root. No external database or authentication service is required. Keep this terminal open while using the phone. If macOS asks whether Node may accept incoming connections, allow it on the private network.

3. Make sure the iPhone and Mac are on the same Wi-Fi network, with device-to-device traffic allowed. Find the Mac's local hostname or LAN IP address. A `.local` hostname or an address such as `192.168.1.20` can be used; `localhost` on the phone refers to the phone itself.

4. Open `apps/ios/FileTasks.xcodeproj` in Xcode. Select the **FileTasks** scheme and the connected iPhone as the run destination. In the FileTasks target's **Signing & Capabilities**, enable automatic signing and choose your Apple Developer Program team with Push Notifications enabled. If Xcode reports the bundle identifier `com.filetasks.ios` is unavailable, change it to a unique identifier. Press **Run**. Trust the Mac and follow the iPhone prompts to enable Developer Mode if asked. The project includes the APNs entitlement in its default signing settings, so a Personal Team may fail to sign even if you do not configure a server push provider.

5. On the iPhone, open FileTasks, tap **Server settings**, and enter the Mac's reachable server origin with no path, for example `http://filetasks-mac.local:3000` or `http://192.168.1.20:3000`. Turn on **Allow local development HTTP**, then save.

6. Return to the sign-in screen and create an account. The email address is the account name; FileTasks does not send verification or password reset email. Use a password of at least 12 characters. Email verification, password recovery, and account deletion are not implemented.

## Keep it available away from home

For persistent access, host the Node app on a machine with a persistent writable disk, expose it through an HTTPS reverse proxy and a hostname, then build and run it from the repository root:

```sh
npm ci
npm run build
npm start
```

Set `FILETASKS_ORIGIN` to the exact public HTTPS origin (no trailing slash), and `FILETASKS_DATABASE_PATH` to a path on persistent storage. Keep the process running and configure restart-on-failure. The database is SQLite; this prototype must use persistent disk and a single shared database file, not an ephemeral/serverless filesystem or separate databases per instance. Back it up with SQLite-aware tooling. See the root [deployment notes](../../README.md#current-api-prototype) and [`apps/web/.env.example`](../web/.env.example).

On the iPhone, set Server settings to the hosted `https://...` origin and leave **Allow local development HTTP** off. Do not expose a local development server directly to the public internet.

## Optional providers and app features

The base Task/Event workflow needs no external auth provider or hosted database. Set up only the integrations you want:

- **Uploaded Files:** External file links work without storage setup. To upload file bytes, create a private Cloudflare R2 bucket and server access key, then set the `FILETASKS_R2_*` variables in [`apps/web/.env.example`](../web/.env.example).
- **Google Calendar:** Create Google OAuth client credentials, register `<server-origin>/api/calendars/google/callback`, and configure the client ID, secret, redirect URI, and `FILETASKS_CALENDAR_ENCRYPTION_KEY` on the server.
- **Apple Calendar:** Create an Apple ID app-specific password and configure `FILETASKS_CALENDAR_ENCRYPTION_KEY` on the server before connecting the calendar.
- **Due Reminders:** The server worker must call `POST /api/internal/reminders/deliver` at least once per minute with `Authorization: Bearer <FILETASKS_REMINDER_WORKER_SECRET>`. This worker creates due in-app Notification records and queues external deliveries. Keep the secret only on the server/scheduler.
- **Email Reminders:** Configure an HTTPS email delivery adapter and its server-only token. FileTasks provides the adapter contract, but no email provider implementation. The adapter contract is in [`docs/api.md`](../../docs/api.md).
- **iPhone Push Reminders:** Configure an HTTPS push delivery adapter that speaks the contract in [`docs/api.md`](../../docs/api.md). Enable Push Notifications for the app's identifier, sign the build with the matching APNs entitlement, and give the adapter APNs credentials (key, key ID, and team ID). Then enable Push in Reminder settings and allow notifications on the phone. FileTasks does not include a push-sending adapter or APNs credentials. Apple capability availability depends on your developer account; check [supported iOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios/).

Keep provider secrets out of the repository and the iPhone app. The complete user-side setup checklist is in [issue #10](https://github.com/azy2k9/file-task/issues/10).

## Acceptance tests

Run the complete shared acceptance harness from the repository root on a Mac with Swift/Xcode command-line tools, Android SDK, and a booted Android emulator:

```sh
npm run test:acceptance
```

The harness keeps the API and fake calendar, delivery, and object-storage providers running while browser, Swift, and Android tests use the same account. The native cases upload and download real bytes through the fake object store, exercise scoped Recurrence and Attachment changes, register and revoke Push devices, and trigger a due Reminder through the delivery boundary. A focused Swift run is available with `swift test --package-path apps/ios`; set `FILETASKS_TEST_API_URL` to a running test API when running it separately.

## What it supports

- Account registration, sign-in, session restore, and sign-out.
- Separate Task and Event filters, plus an all-items view grouped by local schedule date with an undated group.
- Create, edit, and delete Tasks and Events. Tasks can be completed and reopened.
- Optional local date and time, including undated and all-day items.
- Pull-to-refresh for changes made from another client.
- Files section with external links, private R2 uploads, Attachments to multiple Tasks and Events, and separate Attachment/File deletion actions.
- Bearer-token authentication with the token stored in the iOS Keychain.

Failed saves leave the editor fields in place so the person can retry. A failed refresh leaves the last loaded items visible and displays the error.

## Limitations

- There is no offline editing or background synchronization. Changes are sent to the server when saved, and cross-client changes appear after refresh.
- The API URL is an origin without a path. Changing it clears the saved sign-in token and returns to the sign-in screen.
- HTTP is intended only for local development. Do not use it with a production account or token.
- Date and time values are wall-clock values in the device’s current calendar and time zone, matching the API contract; the client does not convert them to UTC.
