# Altegio Marketplace MCP

TypeScript MCP server for Developer Cabinet and Marketplace partner APIs.

## Before changes

1. Read `docs/marketplace-internals.md`.
2. Verify routes and DTOs against `/Users/ypetrou/Developer/biz.erp`.
3. Verify public contracts against `/Users/ypetrou/Developer/biz.erp.api.docs`.
4. Keep internal Developer Cabinet and backoffice routes explicitly labelled; never present them as public API.

## Commands

```bash
npm ci
npm run check
```

## Safety invariants

- Every mutation has `mode: plan | apply`; `plan` performs no write request.
- Destructive or production-sensitive operations require an exact confirmation phrase.
- Backoffice operations require both `ALLOW_BACKOFFICE=true` and `ALTEGIO_ADMIN_USER_TOKEN`.
- A caller must own the partner/application through Developer Cabinet before partner-token operations run.
- Never log or return partner/user tokens. Normalize legacy `salon` names to `location` at the tool boundary.
- Preserve server-side idempotency signals; add a local idempotency key for payment-like operations.
