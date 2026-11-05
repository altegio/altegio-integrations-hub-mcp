# Changelog

## Unreleased

- Move to Node.js 26 LTS (also tested on Node.js 24), npm 12, TypeScript 6, ESLint 10 and Vitest 5.
- Migrate to the split MCP SDK v2 packages while retaining the existing protocol flow.
- Revalidate ownership before replaying payments and durably reserve payment/refund operations before sending writes.
- Isolate HTTP identities from local stdio configuration, validate Host/Origin, propagate cancellation and hide HTTP parser diagnostics.
- Add package exports, isolated tarball checks, a generated tool inventory, container verification and contributor/release guidance.

## 0.1.0

Initial developer-owner and partner MCP server. This version identifies the source package; it does not imply an npm publication.
