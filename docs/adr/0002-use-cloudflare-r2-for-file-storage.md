# Use Cloudflare R2 for File object storage

**Status:** Accepted  
**Date:** 2026-10-12

## Context

FileTasks has three clients (web, Android, and iOS) that need private document storage. The initial target is personal use by 1–5 people with roughly 1–10 GB of files. Keeping files in a provider-neutral object store lets each client transfer bytes directly without routing file bodies through the application API.

The comparison in [the backend research](../research/backend-options.md) found that R2's published Standard storage allowance is 10 GB-month per month, with free direct egress. R2 exposes an S3-compatible API and documents use of the JavaScript AWS SDK. Those familiar interfaces and implementation examples are the practical basis for the user's “AI-friendly” characterization; this is not a claim that R2 offers a special AI integration. R2 does not provide FileTasks authentication, metadata, or application authorization.

## Decision

Use Cloudflare R2 Standard for private File object bytes. Store opaque, provider-neutral object keys in File metadata. Keep R2 credentials in trusted server-side code, and issue short-lived signed upload/download URLs only after the API verifies access to the relevant File and Attachment.

This decision selects object storage only. It does not select Cloudflare Workers, D1, or any other API runtime, database, or authentication provider.

## Consequences

- The published 10 GB-month allowance and free direct egress fit the expected initial workload, subject to R2's current pricing and request quotas.
- All three clients can use the same API-authorized flow and transfer file bytes directly to R2. Browser uploads/downloads need bucket CORS configured for the web origin; native clients do not use browser CORS.
- Presigned URLs are bearer credentials. Keep expirations short, scope them to one object and operation, and never persist them as File identity or log them.
- R2's S3-compatible API is not identical to every AWS S3 feature. Use only the required operations and verify compatibility before relying on additional S3 behavior.
- Cloudflare's `eu` jurisdiction is available when EU data residency is required, but must be selected when creating the bucket and cannot later be changed. This decision alone does not establish whole-system data residency.
- Verify checkout/billing requirements and current pricing when provisioning. Cloudflare's no-card marketing and product checkout documentation are not fully aligned.
- Keep the storage boundary behind a provider-neutral interface and opaque object keys. Revisit this decision if cost, residency, or technical requirements change materially.

## References

- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 S3-compatible API setup and JavaScript SDK](https://developers.cloudflare.com/r2/get-started/s3/)
- [R2 presigned URL constraints](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [Object-storage comparison and cost assumptions](../research/backend-options/object-storage.md)
