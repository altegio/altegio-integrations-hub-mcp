# Build and release

## Validation and merge

1. Run `npx --yes npm@12.2.2 ci --ignore-scripts` and `npx --yes npm@12.2.2 run check` on the pinned Node.js 26 runtime and Node.js 24.22.2.
2. Check the full dependency audit, CodeQL and container job. Build with `--build-arg VCS_REF="$(git rev-parse HEAD)"` when the build system supports revision metadata. The default label is `unknown`; do not interpret it as deployed revision evidence.
3. Obtain an independent review of the exact PR head. Rerun affected checks and obtain review of subsequent changes before merge. Use the repository's normal merge-commit path and do not bypass required reviews.
4. Verify the merged-main checks. A pull-request check run is not evidence for a different merged revision.

The CI workflow installs the locked dependencies without lifecycle scripts, tests both supported runtimes, audits all dependencies, verifies the installed tarball, builds a pinned non-root container, scans it, and exercises HTTP protocol and graceful shutdown. CodeQL analyzes JavaScript/TypeScript without deployment credentials. Tests and generated catalog checks do not replace private source-contract review.

## Maintained hosted deployment

The existing platform deployment watches this repository's `main` branch. Merging deployable changes triggers its normal polling/build/recreate path on both maintained backend contours. Use that path; do not restart unrelated services or change the shared platform as part of a repository update.

After a merge, maintainers must verify:

- checkout revision and actual running image/build identity on each contour; when no OCI revision was injected, compare the installed application and lockfile hashes with the merged build and record the image ID;
- health, initialization, tool/resource listing, a read-only authenticated call where credentials are available, session deletion and expected unauthenticated refusal;
- a bounded post-deploy traffic/log window, with the total requests, status classes, latency and limitations. Count proxy-generated errors as well as backend logs. No traffic is not evidence of business correctness.

Access paths, infrastructure addresses, credentials and operational evidence belong in the private platform runbook. This server retains the 2025-era stateful Streamable HTTP and stdio protocol flow after its SDK v2 migration. Enabling the 2026 protocol requires a separate compatibility decision and client/platform canaries.

## Durable financial state

Mount `INTEGRATIONS_HUB_MCP_STATE_DIR` on persistent storage. Payment keys are global within that store and tied to the normalized request fingerprint. Existing completed payment records remain readable. Refunds use a deterministic key derived from the developer account, application and payment IDs. Caller ownership is checked before any replay.

A durable `pending` record means the outcome is unknown, including a crash or timeout after sending the request. Check the actual payment/refund with authorized upstream evidence before touching that record. Do not retry with a new key. Once the outcome is established, an operator can preserve the original evidence and reconcile the record under the normal production-data approval process. This MCP intentionally offers no automatic clear/retry command. Losing the state volume or rolling back to code without reservation support can re-enable duplicate writes.

Reservations use exclusive file creation across processes. Completed records use a private temporary file, fsync and atomic rename. Deploy a single service instance per state volume; separate volumes cannot coordinate idempotency.

## Source distribution and publication

`npm pack` creates an allowlisted tarball containing built code, declarations, the five MCP resource documents, README and MIT license. `npm run test:package` installs it in a temporary consumer and verifies the public exports and stdio interface. The package remains `private: true`; do not advertise a published npm install until an explicit publishing decision is made.

Use semantic versioning and update [CHANGELOG.md](CHANGELOG.md) when preparing an approved release. Publishing npm packages/images, creating public releases, changing repository visibility, enabling private vulnerability reporting, changing protections or adding CODEOWNERS requires a separate maintainer decision. Proposed settings: enable private reporting and require the two CI runtime checks, container check, CodeQL and an independent exact-head review. Confirm the actual authorized maintainer/team before adding CODEOWNERS.
