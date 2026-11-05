# Issue #20: recurrence subset semantics

Research checked 5 November 2026. RFC statements below follow the normative RFC 5545 text; Google Calendar statements follow Google's Calendar API documentation. Mapping recommendations are identified as product policy inferences.

## Issue and repository context

Issue [#20](https://github.com/azy2k9/file-task/issues/20) asks for round-trip support for first-Monday monthly rules, yearly month/day constraints, and exception dates through Google and Apple boundaries. It also requires preserving unsupported recurrence components or blocking destructive writes. The parent issue is #11.

FileTasks currently stores a Recurrence rule as a restricted interval model (days/weeks/months/years), materializes date-keyed Occurrences, and stores exclusions by `(series_root_id, occurrence_date)`. See [`services/api/src/workspace.ts`](../../services/api/src/workspace.ts) and [`services/api/src/database.ts`](../../services/api/src/database.ts). The current month/year materializer anchors on the start day and clamps to the final day of a short month; that is not RFC behavior for invalid dates. Imported provider payload and timing are already retained additively, and the existing decision says unsupported imported representations pause export instead of being simplified: [ADR-0003](../adr/0003-preserve-calendar-import-metadata.md). The glossary calls each dated series instance an **Occurrence**.

## RFC 5545 behavior

### Monthly ordinal BYDAY

With `FREQ=MONTHLY`, `BYDAY=1MO` means the first Monday of each selected month; `-1MO` means the last Monday. An ordinal is scoped to the month for a monthly rule. In yearly rules, an ordinal BYDAY is scoped to the month when `BYMONTH` is present (for example, `FREQ=YEARLY;BYMONTH=2;BYDAY=1MO` is the first Monday each February). Numeric BYDAY is invalid with frequencies other than MONTHLY/YEARLY, and invalid with YEARLY plus BYWEEKNO. [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10)

### Yearly BYMONTH / BYMONTHDAY and short months

`BYMONTH` selects month numbers 1–12. `BYMONTHDAY` selects month days 1–31 or -31 through -1; together with `FREQ=YEARLY`, `BYMONTH=2;BYMONTHDAY=29` selects February 29. If a rule would generate a date that does not exist, RFC 5545 requires that instance to be ignored, not moved to a nearby valid date, and not counted. Thus a February 29 yearly rule has no instance in non-leap years; a monthly day-31 rule skips months without a 31st. COUNT is applied after the BY-part processing, so skipped invalid candidates do not consume the count. [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10)

### DTSTART, COUNT, and UNTIL

`DTSTART` defines the first member of the recurrence set. It SHOULD agree with the RRULE pattern; if it does not, the RFC says the generated set is undefined. COUNT is the total occurrence bound and DTSTART always counts as occurrence one. UNTIL is inclusive. COUNT and UNTIL MUST NOT both appear in one RRULE. For a DATE DTSTART, UNTIL is DATE; for floating local DTSTART, UNTIL is floating local DATE-TIME; for a UTC or TZID-local DTSTART, UNTIL must be UTC. [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10) and [§3.8.5.3](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.8.5.3)

There is an important distinction: DTSTART remains part of the source recurrence identity even if EXDATE excludes that first displayed instance. A consumer must retain the original DTSTART because detached instances can refer back to it. [RFC 5545 §3.8.5.1](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.8.5.1)

### EXDATE identity and value type

EXDATE removes matching start values from the final set; it takes precedence over RRULE/RDATE inclusion, and duplicate included starts are coalesced. EXDATE can itself exclude DTSTART, subject to retaining DTSTART as described above. Its default value type is DATE-TIME; DATE is also allowed and must be explicitly marked `VALUE=DATE`. RFC syntax requires its listed value type to match the EXDATE property's type. Safe interoperable use therefore uses DATE exclusions for DATE DTSTART/all-day series and DATE-TIME exclusions for timed series, with the series' recurrence-zone context preserved for local date-times. [RFC 5545 §3.8.5.1](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.8.5.1)

### Detached exceptions / RECURRENCE-ID

RECURRENCE-ID identifies an instance by that instance's original DTSTART value, not its moved-to start. It must use the same value type as the master DTSTART; a DATE DTSTART uses a calendar date, while a timed DTSTART uses the original date-time and corresponding local-time/zone semantics. Moving a Friday instance to Thursday therefore leaves RECURRENCE-ID at the original Friday start. `RANGE=THISANDFUTURE` applies later instances ordered by their RECURRENCE-ID, not by their changed current start. [RFC 5545 §3.8.4.4](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.8.4.4)

### Timezone and all-day behavior

For recurring DATE-TIME events, recurrence dates and wall-clock times derive from DTSTART; RFC recommends local time with a TZID in most cases so occurrences remain at the same local time across timezone changes. A recurrence candidate at a nonexistent local time during a forward clock change is ignored and does not count. A DATE DTSTART is a calendar date without a time-of-day or timezone. [RFC 5545 §3.3.5](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.5) and [§3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10)

## Google Calendar API behavior

- A recurring master has `start`/`end` for the first instance and a `recurrence[]` array containing RFC-style RRULE, EXRULE, RDATE, and EXDATE lines. DTSTART and DTEND are not placed in that array. Google omits `recurrence` for single events and generated instances. [Events resource: recurrence](https://developers.google.com/workspace/calendar/api/v3/reference/events#resource)
- By default, `events.list()` returns masters and exceptions, but not ordinary generated instances. `events.instances()` retrieves instances; `singleEvents=true` expands instances and omits the underlying master. Instance resources carry `recurringEventId` and `originalStartTime`. [Recurring events guide](https://developers.google.com/workspace/calendar/api/guides/recurringevents#access_instances)
- `originalStartTime` uniquely identifies the occurrence even after it is moved; it is immutable. All-day identity uses `date`; timed identity uses `dateTime` and its recurrence `timeZone`. `start` is the actual/current time and can differ. [Events resource: originalStartTime](https://developers.google.com/workspace/calendar/api/v3/reference/events#resource)
- A cancelled exception means that occurrence should no longer be shown. Google says to retain such exceptions for the lifetime of the parent; only `id`, `recurringEventId`, and `originalStartTime` are guaranteed to be present. Do not interpret it as deletion of the master. [Events resource: status](https://developers.google.com/workspace/calendar/api/v3/reference/events#resource)
- Google documents patch semantics: an array field supplied in a PATCH replaces the existing array and discards prior elements. Rewriting `recurrence[]` must therefore include every retained RRULE/RDATE/EXDATE/EXRULE line, or omit the field if no recurrence change is intended. [Events resource: patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
- For recurring timed events, Google requires `start.timeZone` and uses it as the zone in which recurrence is expanded. The same API models all-day starts with `date`. [Events resource: start](https://developers.google.com/workspace/calendar/api/v3/reference/events#resource)

## Safe mapping guidance for FileTasks

The following recommendations are **product policy inferences** from the standards, Google API behavior, current FileTasks schema, and ADR-0003; they are not requirements imposed by RFC 5545.

1. **Keep the provider recurrence representation losslessly.** A monthly `BYDAY=1MO` or yearly `BYMONTH`/`BYMONTHDAY` rule cannot be expressed by the present `{interval, unit, weekdays?, end}` model. Do not convert these to approximate month/year intervals. Keep the source rule and provider timing in import metadata and pause exports after local edits that cannot be translated exactly, consistent with ADR-0003.
2. **Separate original instance identity from current placement.** For imported detached exceptions, map FileTasks `Occurrence.occurrenceDate` to the original recurrence identity, and `scheduledDate`/`scheduledTime` to the actual moved start. Never overwrite the original key with the moved-to date. For Google, correlate on `(recurringEventId, originalStartTime)`; for iCalendar, correlate on `(UID, RECURRENCE-ID)`.
3. **Current date key is safe only for a date-granular subset.** `(series_root_id, occurrence_date)` is sufficient for all-day recurrence, or a timed recurrence proven to produce at most one occurrence per source-local calendar date with a stable master timezone. It is insufficient for hourly/minutely rules, multiple same-date instances, floating times, timezone changes that alter local date identity, or exact distinction of two starts on one date. Until identity is extended to preserve DATE versus DATE-TIME and time-zone context, block destructive writes for those cases.
4. **Preserve EXDATE's type and source value.** For all-day series, serialize an exclusion as DATE (`EXDATE;VALUE=DATE`) and use the original date. For timed series, serialize DATE-TIME in the recurrence's zone and at the original scheduled wall time; do not derive it from a moved exception's current start. Current FileTasks exclusion rows have only a date, so do not claim lossless timed EXDATE support unless the master time and timezone metadata make that exact conversion provable.
5. **Keep DTSTART even when excluded.** Store the original master start independently from the visible/excluded Occurrence. Excluding the first instance must not reset series identity or shift the rest of the RRULE.
6. **Treat COUNT as generated valid starts, not materialized rows.** DTSTART is count one; invalid calendar dates and nonexistent local times are skipped before counting; EXDATE removes an instance from the final display set but does not change how many RRULE starts the COUNT bound generates. Don't count only non-excluded visible Occurrences to compute the rule's endpoint.
7. **Use source calendar date for timed identities.** Keep the timezone from the original series when converting provider date-time identity into a date key. A UTC date conversion can move a late-night occurrence to a different calendar day. If FileTasks cannot retain that zone or original value precisely, preserve raw provider identity and avoid generating RECURRENCE-ID/EXDATE from a guessed timezone.
8. **Retain cancelled provider exceptions as tombstones.** A cancelled Google instance with a parent and originalStartTime should become an exclusion keyed by that original identity and stay stored for the parent series lifetime, even though Google may omit its other fields.
9. **Treat THISANDFUTURE as more than one detached date.** It affects subsequent identities according to original recurrence order. FileTasks' following-scope operations should not translate to a single exclusion or one-off edit; preserve it in provider metadata or explicitly pause export until the behavior can be represented.

## Edge-case matrix

| Case | RFC/Google consequence | Consequence for date-keyed FileTasks Occurrences |
|---|---|---|
| `FREQ=MONTHLY;BYDAY=1MO` | First Monday in each month | Not representable by current interval model; retain original rule. |
| `FREQ=MONTHLY;BYMONTHDAY=31` | Skip months without day 31; no clamp | Current month materializer clamps (e.g. Jan 31 to Feb 28/29), so it must not be used as an RFC-equivalent expansion. |
| `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29` | Feb 29 only; skip non-leap years | Current yearly materializer would produce Feb 28 in common years; retain/expand with RFC semantics, never approximate. |
| `COUNT=3` plus invalid candidates | DTSTART is first; only valid generated starts count; COUNT/UNTIL are exclusive alternatives | A finite materialized horizon or exclusion count is not a substitute for RRULE COUNT semantics. |
| Excluded DTSTART | No visible first Occurrence, but original DTSTART remains required for recurrence identity | Keep root's original schedule even if first instance is excluded. |
| Moved detached instance | RECURRENCE-ID/originalStartTime stay at original date/time; actual `start` changes | Preserve original Occurrence key and put moved schedule in current schedule fields. |
| All-day | DATE identity, no timezone | Current date identity is a natural fit if imported `date` is preserved exactly. |
| Timed + DST | Zone-bound wall time; nonexistent local time is skipped | Materialize by the recurrence-zone calendar, not UTC dates; date-only identity cannot cover all timed rules. |
| Cancelled Google exception | Tombstone for parent instance; sparse fields are normal | Retain exclusion using parent ID plus originalStartTime even without `start` or summary. |

## Primary sources

- [RFC 5545: iCalendar](https://www.rfc-editor.org/rfc/rfc5545.html)
- [Google Calendar API: Recurring events guide](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
- [Google Calendar API: Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- [Google Calendar API: events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
