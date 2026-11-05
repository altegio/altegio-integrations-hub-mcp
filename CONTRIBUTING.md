# Contributing

This project manages developer-owned Altegio integrations. Marketplace moderation decisions and backoffice administration are outside its scope.

## Development

Use Node.js 26.13.0 (the `.nvmrc` pin) and npm 12.2.2. Node.js 24.22.2 is also tested.

```sh
npx --yes npm@12.2.2 ci --ignore-scripts
npx --yes npm@12.2.2 run check
```

Tests use synthetic data and temporary state. They do not need an Altegio account, credentials, private specifications, or live writes. Keep private diagnostic evidence out of commits and CI artifacts. The package remains `private: true`; the hosted service and source checkout are the supported installation paths.

## Changes and review

Read [the API boundaries](docs/tool-boundaries.md) and [implementation reference](docs/marketplace-internals.md). Internal Developer Cabinet endpoints must stay explicitly labelled. Maintainers with source access verify route/DTO changes against the ERP and public API contracts; do not upload private source or specifications to a pull request. Contributors without access should link the published contract and describe what still needs maintainer verification.

Preserve no-write plan mode, exact confirmations, current caller ownership, secret redaction and durable financial idempotency. Add a synthetic regression that fails before a behavioral fix. Never replay a customer write to reproduce an incident.

Run `npm run catalog` after changing tool names, descriptions or schemas. Commit both generated inventory files. `npm run check` checks formatting, actual lint rules, source/test types, coverage, build, inventory drift and an isolated installed tarball, including stdio, types, resources and a no-write plan.

Open a focused pull request explaining the problem, resulting behavior, checks and limits. An independent review of the exact head is required before merge; self-review and green CI are separate evidence. Address findings and rerun affected checks. Follow [the release path](RELEASING.md); do not use an administrative review bypass.

## Dependencies

Keep the lockfile, runtime pins, Docker base, npm version and CI matrix aligned. Check official engines and peer ranges before major upgrades. TypeScript stays on 6.0.x while `typescript-eslint` requires `<6.1.0`; the compiler's latest tag alone is not a compatibility test.

The scoped `minimatch` override upgrades the development lint chain to the patched 11.x line for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Lint fixture tests and the full type/lint checks exercise its consumers. Remove the override when their supported dependency ranges include the fix. Do not suppress advisories or downgrade to an unsupported linter to obtain a clean audit.
