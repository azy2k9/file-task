# FileTasks Android

This is the native Kotlin and Jetpack Compose Android client for FileTasks. It talks directly to the shared FileTasks API; Tasks and Events therefore stay in sync with the web and iOS clients for the signed-in account.

## Build and run

Install JDK 17 and Android SDK Platform 36, then run:

```sh
./gradlew :app:assembleDebug
```

Install the resulting `app/build/outputs/apk/debug/app-debug.apk` on an emulator or device. The initial API URL is `http://10.0.2.2:3000`, which reaches a development server running on the host from the Android emulator. Open the settings button to change it. HTTPS URLs are supported; HTTP is accepted only for `localhost`, `127.0.0.1`, and `10.0.2.2` development endpoints.

The Gradle wrapper pins Gradle 8.14.6 and checks its binary distribution against the SHA-256 published by Gradle. Android Gradle Plugin 8.13.2 requires Gradle 8.13 or newer and JDK 17. The project uses the Compose compiler Gradle plugin and the Compose BOM to keep Compose artifacts aligned. OkHttp handles HTTP requests, including the API's PATCH updates.

## Account and data behavior

- Sign in or create an account with the shared `/api/auth` endpoints.
- The token is encrypted with AES-GCM using a non-exportable Android Keystore key before it is saved in private app preferences.
- Tasks and Events are fetched from `/api/items`; all create, edit, completion, and delete actions are sent to the shared API.
- An item with no date is shown in the Undated section. A time can be saved only when a date is present.
- Files section with external links, private R2 uploads, Attachments to multiple Tasks and Events, and separate Attachment/File deletion actions.
- Changing the API URL clears the saved token and signs the client out, so a token is never silently sent to a different server.
