# Maintenance baseline — 2026-11-05

Versions were checked against the npm registry, Node.js distribution index and official GitHub Action tags. This is an upgrade record, not a claim that later releases will remain compatible.

| Component                   | Previous locked version                         | Selected version                                    |
| --------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Node.js                     | 22.23.4                                         | 26.13.0 LTS; compatibility check on 24.22.2         |
| npm                         | Not pinned                                      | 12.2.2                                              |
| MCP SDK                     | `@modelcontextprotocol/sdk` 1.32.2              | server/client 2.4.0, Node adapter 2.1.2             |
| TypeScript                  | 5.9.3                                           | 6.0.3                                               |
| Node types                  | 22.20.5                                         | 24.19.2 (oldest supported runtime)                  |
| dotenv                      | 17.4.2                                          | 18.0.9                                              |
| ESLint / recommended rules  | 9.39.5 / 9.39.5                                 | 10.14.0 / 10.0.1                                    |
| typescript-eslint / globals | 8.72.0 / 16.5.0                                 | 8.72.1 / 17.14.0                                    |
| Test runner                 | Jest 30.5.2, ts-jest 29.4.15, Jest types 30.0.0 | Vitest and V8 coverage 5.1.0                        |
| Express / Express types     | 5.3.0 / 5.0.6                                   | Unchanged; current compatible releases              |
| Zod / Prettier / tsx        | 4.6.7 / 3.9.10 / 4.23.15                        | Unchanged; current compatible releases              |
| checkout / setup-node       | Pinned v7 SHAs                                  | Verified v7.0.1 / v7.1.0; same SHAs                 |
| Trivy                       | 0.76.1                                          | 0.76.2, digest pinned                               |
| Additional checks           | None                                            | CodeQL v4 and Gitleaks 8.30.1, immutable references |

TypeScript 7.0.2 is intentionally held: `typescript-eslint` 8.72.1 supports TypeScript `>=4.8.4 <6.1.0`. Node 26 types would allow APIs missing from the supported Node 24 runtime. The [SDK migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2) separates the package migration from new protocol adoption; this project keeps its stateful legacy handshake.

The original lockfile reported 26 npm advisories. Refreshing compatible dependencies, replacing Jest's transform chain and upgrading the development-only minimatch consumer chain removes those findings. The `minimatch` override resolves to 11.0.4 and addresses [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Its ESLint consumer is exercised by a real temporary-file lint test. The audit still runs without advisory exclusions.

## Behavioral verification

The baseline had 91 passing tests. Two added regressions failed before the fix: replay of a cached payment after ownership was revoked, and replay after an ambiguous write failure. Their passing replacements cover separate server instances, exclusive reservations across processes, old completed state, private file permissions, refund confirmation and current ownership. The older duplicate same-instance payment test was removed.

Protocol checks cover native HTTP Host/Origin refusals, concurrent identities on a retained session, no HTTP fallback to the stdio token, cancellation, capacity and expiry, deletion and bounded shutdown. Package checks install a tarball into an isolated consumer, type-check its exports and exercise both linked executables, all resources, the prompt and a no-write plan.

Coverage floors (75% statements/lines, 70% branches/functions) are below the measured upgraded baseline to allow instrumentation differences between the two runtimes. They are a regression floor, not evidence that untested upstream contracts are correct. Container checks additionally use a read-only root filesystem, non-root user, dropped capabilities and persistent writable state.

The secret scan covers available Git history and the current tracked snapshot. Its only reviewed historical exception is an exact synthetic request-ID UUID in `tests/feedback.test.ts`; the new fixture uses an explicit synthetic label. No production payloads or private specification snapshots were added.

## Remaining decisions

Independent exact-head review, merged-main checks and deployment evidence are release gates, recorded with the PR and private operational evidence. No repository settings, access, secrets, visibility, npm publications or public image releases are changed here. The concrete settings proposal is in [RELEASING.md](../RELEASING.md).

Private source access remains necessary for authoritative Developer Cabinet contract review. Public CI uses synthetic fixtures and does not claim to check private source drift. Signed proxy-header verification is not implemented by this server; its current trusted-proxy deployment boundary is described in [SECURITY.md](../SECURITY.md).
