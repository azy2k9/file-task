# FileTasks Android

This is the native Kotlin and Jetpack Compose Android client for FileTasks. It talks directly to the shared FileTasks API; Tasks and Events therefore stay in sync with the web and iOS clients for the signed-in account.

## Build and run

Install JDK 17 and Android SDK Platform 36, then run:

```sh
./gradlew :app:assembleDebug
```

Install the resulting `app/build/outputs/apk/debug/app-debug.apk` on an emulator or device. The initial API URL is `http://10.0.2.2:3000`, which reaches a development server running on the host from the Android emulator. Open the settings button to change it. HTTPS URLs are supported; HTTP is accepted only for `localhost`, `127.0.0.1`, and `10.0.2.2` development endpoints.

The Gradle wrapper pins Gradle 8.14.6 and checks its binary distribution against the SHA-256 published by Gradle. Android Gradle Plugin 8.13.2 requires Gradle 8.13 or newer and JDK 17. The project uses the Compose compiler Gradle plugin and the Compose BOM to keep Compose artifacts aligned. OkHttp handles HTTP requests, including the API's PATCH updates.

To use Push delivery, configure a Firebase Android app for `com.filetasks.android` and place its `google-services.json` in `app/`. The client asks for notification permission when Push is enabled, registers its Firebase Installation ID with the shared FileTasks API, and revokes the device registration when requested. Firebase only supplies the Android device identity and transport; the FileTasks server continues to send through its configured push adapter. Push messages should include `title`, `body`, `scheduledAt`, and `itemId` data fields for the native notification.

## Acceptance tests

Run the complete shared acceptance harness from the repository root on a Mac with Swift/Xcode command-line tools, Android SDK, and a booted Android emulator:

```sh
npm run test:acceptance
```

The harness keeps the API and fake calendar, delivery, and object-storage providers running while browser, Swift, and Android tests use the same account. The Android instrumentation case reads and downloads the File uploaded by iOS, uploads and downloads its own File, exercises scoped Recurrence and Attachment changes, registers and revokes a Push device, and triggers a due Reminder through the shared delivery fake. A focused Android run can target a test API with `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.apiUrl=http://10.0.2.2:3107`.

To exercise the real Android screens for recurring agenda creation, scoped saves, connected-calendar management, and provider-copy recovery, start a fresh Android emulator and run from the repository root:

```sh
npm run test:android-ui
```

Install the Android SDK and platform tools, JDK 17, and the Playwright Chromium browser (`npx playwright install chromium`) first. The emulator must be fully booted; set `ANDROID_SERIAL` if more than one device is connected. The runner starts the shared temporary API and provider fakes, uses `adb reverse` for the emulator, drives the app with Compose UI tests, and checks the saved items in the browser. The calendar UI case checks the Google system-browser URL, Apple connection and disconnection, imported Events and Files, provider errors, and native Sync Calendar recovery after an external edit or deletion. Use a disposable emulator with no existing FileTasks session. The command fails when prerequisites are missing or the expected shared data was not created.

## Account and data behavior

- Sign in or create an account with the shared `/api/auth` endpoints.
- The token is encrypted with AES-GCM using a non-exportable Android Keystore key before it is saved in private app preferences.
- Tasks and Events are fetched from `/api/items`; all create, edit, completion, and delete actions are sent to the shared API.
- An item with no date is shown in the Undated section. A time can be saved only when a date is present.
- Files section with external links, private R2 uploads, Attachments to multiple Tasks and Events, and separate Attachment/File deletion actions.
- Changing the API URL clears the saved token and signs the client out, so a token is never silently sent to a different server.

## In-app Notifications

The workspace Notifications section lists due Notification Reminders without requiring push or email delivery. Refresh the inbox to load new Notifications, open the associated Task or Event, or mark a Notification read. Push and email remain optional in Reminder settings; Email is available in reminder rows only when email delivery is enabled.
