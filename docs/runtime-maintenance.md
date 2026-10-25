# Runtime maintenance

The container and CI use Node 22.23.4 LTS. Update both Dockerfile stages and
`.nvmrc` together; CI checks their agreement. Preserve uid 1001 and the `/data`
volume ownership when rebuilding. Dependency refreshes do not migrate the
idempotency store format.

Refresh compatible packages with `npm update --ignore-scripts
--registry=https://registry.npmjs.org`, then run `npm run check` and `npm audit`.
Keep the SDK on 1.x until a separately tested migration. The production image
excludes dev dependencies, npm and Yarn. Weekly CI repeats the audit and scans
the image for HIGH/CRITICAL vulnerabilities with published fixes; unfixable
findings remain visible in the report.

CI also checks initialize/tools-list, session cleanup, writable `/data`, uid
1001 and graceful SIGTERM in the actual image. Unit/integration tests cover
session limits, idempotency, request context and the plan/confirmation contract.
The HTTP smoke uses a dummy token and makes no Altegio API calls. It is not a
customer OAuth end-to-end test.

Production runs on both MCP VMs through `altegio-mcp-platform` Compose. Merge
and deployment need the platform's production approval. Retain the prior image
and persistent volume, then verify the customer route with an authorized real
customer identity before considering the OAuth rollout fully certified.
