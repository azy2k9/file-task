# API domain code

This directory holds the current authentication, database, and workspace logic for FileTasks. The issue #2 HTTP routes still run through the temporary Next.js route handlers in `apps/web/app/api`; this code is not an independently deployable API service yet.

The TypeScript server runtime and deployment target are still under evaluation. Once selected, move the HTTP runtime here and have the web, iOS, and Android clients call that service directly.
