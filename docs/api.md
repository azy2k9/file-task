# Workspace API

All paths are relative to the FileTasks server origin. Send JSON request bodies with `Content-Type: application/json`. Responses containing account data use `Cache-Control: no-store`. Errors are `{ "error": "Human-readable message" }` with HTTP 400 (validation), 401 (sign-in required), 403 (origin), 404 (item unavailable), 409 (account exists), 413 (body too large), 415 (content type), or 429 (login attempt limit).

## Accounts and sessions

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | `{email,password}` | 201 `{token,user:{id,email}}` |
| POST | `/api/auth/login` | `{email,password}` | 200 `{token,user:{id,email}}` |
| GET | `/api/auth/session` | — | 200 `{user:{id,email}}` |
| POST | `/api/auth/logout` | — | 204 |

Email addresses are trimmed and lowercased. Passwords are 12–1024 characters. Tokens expire after 30 days. Sign-out revokes only the current token, so another signed-in device remains available.

Web authentication sets a `filetasks_session` HttpOnly cookie. Native clients store the returned token securely and send `Authorization: Bearer <token>`; disable native cookie handling. Bearer authentication takes precedence over a cookie. Cookie-authenticated mutations require `Origin` matching `FILETASKS_ORIGIN`, or the request origin in local development. Native bearer requests do not need an Origin header. Cross-origin browser requests are not supported.

## Tasks and Events

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/items` | — | 200 `{items:[WorkspaceItem]}` |
| GET | `/api/items/{id}` | — | 200 `{item:WorkspaceItem}` |
| POST | `/api/items` | Item input | 201 `{item:WorkspaceItem}` |
| PATCH | `/api/items/{id}` | Changed input fields or `{completed:boolean}` | 200 `{item:WorkspaceItem}` |
| DELETE | `/api/items/{id}` | — | 204 |

Item input: `kind` (`task` or `event`), `title` (1–200 characters after trimming), optional `details` (up to 10,000 characters, default empty), optional `scheduledDate` (`YYYY-MM-DD` or null), and optional `scheduledTime` (`HH:mm` in 24-hour time or null). A time requires a date. The kind cannot change after creation. Only Tasks accept `completed`.

Item input can also include `reminders`, an array of `{delivery,amount,unit,time}` where `delivery` is `notification` or `email`, `unit` is `minutes`, `hours`, `days`, `weeks`, or `months`, and `time` is `HH:mm`. New items inherit their Task or Event Reminder default if this field is omitted. Recurring items accept `recurrence: {interval,unit,weekdays?,end}` where `unit` is `days`, `weeks`, `months`, or `years`; weekly `weekdays` use Sunday `0` through Saturday `6`; `end` is `{type:"never"}`, `{type:"date",date:"YYYY-MM-DD"}`, or `{type:"count",count}`. Patching a recurring item accepts `scope` of `occurrence`, `following`, or `series`. The API materializes scheduled Occurrences through the next 370 days and preserves separate Task completion state and Attachments per Occurrence.

PATCH preserves omitted fields. Send explicit nulls to remove date/time; send both nulls when removing a dated item's schedule. Changing completion alone must send only `{completed}` to preserve edits from other clients. Dates use the Gregorian calendar and have no timezone conversion. Concurrent field edits use the last saved value.

```json
{
  "id": "opaque-id",
  "kind": "task",
  "title": "Renew car insurance",
  "details": "Compare the renewal quote",
  "scheduledDate": "2026-11-03",
  "scheduledTime": "16:00",
  "completed": false,
  "files": [],
  "recurrence": null,
  "reminders": [],
  "seriesId": null,
  "isOccurrence": false,
  "createdAt": "2026-10-12T12:00:00.000Z",
  "updatedAt": "2026-10-12T12:00:00.000Z"
}
```

Events have `completed: null`; Tasks have a boolean. Lists contain only the authenticated account's items, ordered by date and time, with undated items last. Requests for another person's item return 404. Clients refresh through GET to observe changes saved by other clients.

## Files and Attachments

File metadata and Attachments are private to the authenticated account. A File may be either an uploaded document or an external HTTP(S) link. A File can be attached to multiple Tasks and Events; deleting an item removes its Attachments but leaves the File in the Files section.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/files` | — | 200 `{files:[WorkspaceFile]}` |
| POST | `/api/files` | `{name,url}` | 201 `{file:WorkspaceFile}` for an external link |
| POST | `/api/files/uploads` | `{name,contentType,sizeBytes}` | 201 `{uploadId,uploadUrl,expiresInSeconds}` |
| POST | `/api/files/{id}/complete` | — | 200 `{file:WorkspaceFile}` after the object is verified in R2 |
| GET | `/api/files/{id}/open` | — | 200 `{url,name,contentType,sourceType}` |
| POST | `/api/files/{id}/attachments` | `{itemId}` | 201 `{success:true}` |
| DELETE | `/api/files/{id}/attachments/{itemId}` | — | 204 |
| DELETE | `/api/files/{id}` | — | 204; deletes the File and every Attachment |

Attachment creation also accepts `scope: "occurrence"` (default), `scope: "following"`, or `scope: "series"` for a recurring item. A series Attachment appears on each materialized Occurrence; a following Attachment applies from the selected Occurrence onward. Delete with the matching `?scope=...` value to remove it from that scope.

`WorkspaceFile` contains `id`, `name`, `sourceType` (`upload` or `link`), `contentType`, `sizeBytes`, `externalUrl`, `createdAt`, and `attachments` (`itemId`, `itemKind`, `itemTitle`). Task and Event responses include their attached Files as `{id,name,sourceType}` summaries.

Uploaded bytes move directly between the client and Cloudflare R2. The client first requests an upload URL, PUTs the file with the returned URL and matching `Content-Type`, then calls the completion endpoint. Upload and download URLs expire after five minutes. Uploads are limited to 50 MB. Configure the R2 bucket's CORS policy to allow the web origin to send PUT requests with the `Content-Type` header and read the response. Keep R2 credentials on the server using `FILETASKS_R2_ACCOUNT_ID`, `FILETASKS_R2_ACCESS_KEY_ID`, `FILETASKS_R2_SECRET_ACCESS_KEY`, and `FILETASKS_R2_BUCKET`; `FILETASKS_R2_ENDPOINT` is optional. The API refuses cross-account Attachments and returns 404 for Files that are not owned by the signed-in account.

## Reminder and calendar settings

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/settings/reminders` | — | 200 `{settings}` |
| PATCH | `/api/settings/reminders` | `{taskReminders,eventReminders,pushEnabled,emailEnabled,applyToExisting}` | 200 `{settings}` |
| GET | `/api/notifications` | — | 200 `{notifications}` for due in-app Reminders |
| PATCH | `/api/notifications/{id}` | — | 200 `{success:true}` marks a Notification read |
| GET | `/api/calendars` | — | 200 `{calendars}` |
| GET | `/api/calendars/google/connect` | — | Redirects to Google OAuth |
| GET | `/api/calendars/google/callback` | OAuth callback | Redirects back to the app |
| POST | `/api/calendars` | `{username,password,calendarUrl?}` | 201 Apple CalDAV connection |
| POST | `/api/calendars/sync` | — | 200 `{synced,eventCount}` |
| DELETE | `/api/calendars/{google|apple}` | — | 204 |

Calendar credentials are encrypted at rest. Set `FILETASKS_CALENDAR_ENCRYPTION_KEY` to a private 32-byte base64 or hex key. Google requires OAuth client ID, secret, and callback URL settings. Apple Calendar uses an Apple ID app-specific password; CalDAV discovery runs from iCloud unless a calendar collection URL is supplied. Sync imports Events once, then FileTasks is authoritative: external edits are replaced by FileTasks values and missing Calendar copies are recreated. Configure `FILETASKS_PUBLIC_URL` or `FILETASKS_ORIGIN` for backlinks, and `FILETASKS_TIME_ZONE` for Google timed Event copies.
