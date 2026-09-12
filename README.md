# Altegio Marketplace MCP

Public-zone MCP server for robotized creation, configuration, rollout, operation, and analysis of Altegio Marketplace applications. It wraps three deliberately separated surfaces:

- documented public/partner APIs;
- the authenticated Developer Cabinet API used by Biz.ERP itself;
- optional internal backoffice APIs, disabled by default.

Production endpoint after the platform MR is deployed: `https://mcp.alteg.io/public/marketplace/mcp`.

## What it covers

The server exposes 40 tools:

- Developer accounts: `marketplace_list_developer_accounts`, `marketplace_create_developer_account`, `marketplace_update_developer_account`, `marketplace_delete_developer_account`.
- Applications/card: `marketplace_list_applications`, `marketplace_get_application`, `marketplace_get_catalog_metadata`, `marketplace_list_available_rights`, `marketplace_create_application`, `marketplace_update_application`.
- Moderation: `marketplace_save_moderation_instructions`, `marketplace_submit_for_moderation`.
- Frames/chat: `marketplace_list_entity_frames`, `marketplace_replace_entity_frames`, `marketplace_notify_chat_message`, `marketplace_install_sidebar_frame`, `marketplace_toggle_sidebar_highlight`.
- Installation: `marketplace_grant_location_access`, `marketplace_activate_installation`, `marketplace_get_installation_status`, `marketplace_list_installations`, `marketplace_uninstall`.
- Billing/notifications: `marketplace_list_tariffs`, `marketplace_get_payment_link`, `marketplace_record_payment`, `marketplace_refund_payment`, `marketplace_set_discount`, `marketplace_update_notification_channel`, `marketplace_set_sms_sender_names`.
- Analytics: `marketplace_get_statistics`, `marketplace_get_conversion_statistics`, `marketplace_list_reviews`.
- Lifecycle: `marketplace_validate_lifecycle_callback`.
- Internal, disabled-by-default backoffice: `marketplace_backoffice_get_application`, `marketplace_backoffice_set_publication`, `marketplace_backoffice_set_commercials`, `marketplace_backoffice_delete_application`, `marketplace_backoffice_list_offers`, `marketplace_backoffice_upsert_offer`, `marketplace_backoffice_delete_offer`.

MCP resources:

- `altegio://marketplace/internals` — the complete source-referenced Biz.ERP implementation guide;
- `altegio://marketplace/safe-e2e` — draft → configure → install → activate → verify → update → uninstall;
- `altegio://marketplace/tool-boundaries` — public/internal classifications and safety rules.

Prompt: `marketplace_safe_draft_rollout`.

## Safety model

Every mutation requires `mode: plan | apply`. Plan mode sends no write request. Destructive and production-sensitive operations require an exact confirmation phrase. Payment records have a durable local idempotency store; application creation uses slug as a natural idempotency key; activation status-checks before callback.

Partner operations are not authorized merely because a caller reached the public MCP endpoint. The server first checks that the caller's Altegio user can see the requested application in the stated developer account, then uses that account's `partner_system.token`. Transport authentication headers are never accepted as tool arguments. The optional `account.partner_token` on account creation only binds an existing partner system; `payload.partner_token` is accepted only by the callback-validation helper. Both are treated as secrets. Tokens, API keys, passwords, authorization headers, and secret keys are recursively redacted from tool results; secret-bearing settings are forwarded without logging.

Backoffice tools require both:

```env
ALLOW_BACKOFFICE=true
ALTEGIO_ADMIN_USER_TOKEN=...
```

They stay off in the public deployment.

## Configuration

```env
ALTEGIO_PARTNER_TOKEN=bootstrap-partner-token
ALTEGIO_USER_TOKEN=optional-for-local-stdio
ALTEGIO_API_BASE=https://api.alteg.io/api/v1
ALTEGIO_APP_BASE=https://app.alteg.io
PORT=8094
MARKETPLACE_MCP_STATE_DIR=.marketplace-mcp
ALLOW_BACKOFFICE=false
```

The public platform route authenticates through Altegio OAuth/raw token and forwards the current user token as `X-Altegio-User-Token`. `ALTEGIO_USER_TOKEN` is only for a private local stdio process.

## Run locally

Node 22.23.2 is pinned.

```bash
npm ci
cp .env.example .env
npm run dev:http
```

Health: `GET http://localhost:8094/health`. MCP Streamable HTTP: `/mcp`. Stdio: `npm run dev`.

## Verification

```bash
npm run check
docker build -t altegio-marketplace-mcp .
docker run --rm -p 8094:8094 -e ALTEGIO_PARTNER_TOKEN=test altegio-marketplace-mcp
```

Tests cover schemas/safety, request-scoped authentication, upstream error normalization, tool inventory, plan no-op behavior, application idempotency, normalized install payloads, backoffice gates, and Streamable HTTP initialization.

Live mutation tests are intentionally not part of CI because they would create Marketplace state. Use the `marketplace_safe_draft_rollout` prompt against an approved test location.

## Known platform limits

- Normal partner API has no direct freeze/unfreeze command. Expiry freezes; a valid payment may unfreeze.
- Entity frames are stored but blocked for normal new apps by a frontend feature constant and application/location allowlists.
- Waiting-list/task-tracker sidebar frames are additionally brand-gated; general frame installation is allowlisted.
- Chat through activation is usable but one effective chat slot exists per location.
- Schedule webhook configuration is not propagated into the installed webhook DTO.
- Lifecycle callback URLs must target the application's backend, not this OAuth-protected MCP endpoint.

Read [docs/marketplace-internals.md](docs/marketplace-internals.md) before adding or changing operations.
