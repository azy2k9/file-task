# FileTasks for iOS

This is the native SwiftUI client for FileTasks. It supports iOS 16 and later and uses the shared FileTasks API so a person’s Tasks and Events appear on the web and other clients after refresh.

## Build and run

1. Open `FileTasks.xcodeproj` in Xcode 15 or later on macOS.
2. Choose the `FileTasks` scheme and an iOS 16 or later simulator or device.
3. Build and run. On a physical device, select a development team in the target’s Signing & Capabilities settings.
4. On the sign-in screen, open **Server settings**, enter the backend origin (for example, `https://api.example.com`), and save it.
5. Create an account or sign in.

For local development, enter the development server URL and turn on **Allow local development HTTP**. The app defaults to HTTPS and rejects HTTP unless that option is enabled. On a device, use a local hostname reachable from the device, such as a `.local` host; `localhost` on the phone points to the phone itself.

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
