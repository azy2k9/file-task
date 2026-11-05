# Preserve imported Calendar representations as metadata

Imported Events keep provider- and account-specific source timing and payload in an additive metadata table instead of changing the shared wall-clock Event contract. Sync reuses the exact provider timing while the local schedule is unchanged, translates simple schedule edits only when duration and timezone remain unambiguous, and pauses every connected-provider export for unsupported representations; this preserves existing clients and gives future recurrence work a durable source-data seam.
