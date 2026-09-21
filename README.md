# Altegio Integrations Hub MCP

Public-zone MCP server for robotized creation, configuration, rollout, operation, and analysis of developer-owned Altegio Integrations Hub applications. It wraps two deliberately separated surfaces:

- documented public/partner APIs;
- the authenticated Developer Cabinet API used by Biz.ERP itself.

Marketplace administration is intentionally excluded. Moderation decisions, publication, ranking, commissions, application removal by moderators, and special-offer management belong in a separate moderator-only skill or service.

Production endpoint after the platform MR is deployed: `https://mcp.alteg.io/public/integrations-hub/mcp`.

## What it covers

The server exposes 33 owner-facing tools:

- Developer accounts: `integrations_hub_list_developer_accounts`, `integrations_hub_create_developer_account`, `integrations_hub_update_developer_account`, `integrations_hub_delete_developer_account`.
- Applications/card: `integrations_hub_list_applications`, `integrations_hub_get_application`, `integrations_hub_get_catalog_metadata`, `integrations_hub_list_available_rights`, `integrations_hub_create_application`, `integrations_hub_update_application`.
- Moderation: `integrations_hub_save_moderation_instructions`, `integrations_hub_submit_for_moderation`.
- Frames/chat: `integrations_hub_list_entity_frames`, `integrations_hub_replace_entity_frames`, `integrations_hub_notify_chat_message`, `integrations_hub_install_sidebar_frame`, `integrations_hub_toggle_sidebar_highlight`.
- Installation: `integrations_hub_grant_location_access`, `integrations_hub_activate_installation`, `integrations_hub_get_installation_status`, `integrations_hub_list_installations`, `integrations_hub_uninstall`.
- Billing/notifications: `integrations_hub_list_tariffs`, `integrations_hub_get_payment_link`, `integrations_hub_record_payment`, `integrations_hub_refund_payment`, `integrations_hub_set_discount`, `integrations_hub_update_notification_channel`, `integrations_hub_set_sms_sender_names`.
- Analytics: `integrations_hub_get_statistics`, `integrations_hub_get_conversion_statistics`, `integrations_hub_list_reviews`.
- Lifecycle: `integrations_hub_validate_lifecycle_callback`.

MCP resources:

- `altegio://integrations-hub/internals` — the complete source-referenced Biz.ERP implementation guide;
- `altegio://integrations-hub/safe-e2e` — draft → configure → install → activate → verify → update → uninstall;
- `altegio://integrations-hub/tool-boundaries` — public/internal classifications and safety rules.

Prompt: `integrations_hub_safe_draft_rollout`.

## Safety model

Every mutation requires `mode: plan | apply`. Plan mode sends no write request. Destructive and production-sensitive operations require an exact confirmation phrase. Payment records have a durable local idempotency store; application creation uses slug as a natural idempotency key; activation status-checks before callback.

Partner operations are not authorized merely because a caller reached the public MCP endpoint. The server first checks that the caller's Altegio user can see the requested application in the stated developer account, then uses that account's `partner_system.token`. Transport authentication headers are never accepted as tool arguments. The optional `account.partner_token` on account creation only binds an existing partner system; `payload.partner_token` is accepted only by the callback-validation helper. Both are treated as secrets. Tokens, API keys, passwords, authorization headers, and secret keys are recursively redacted from tool results; secret-bearing settings are forwarded without logging.

## Configuration

```env
ALTEGIO_PARTNER_TOKEN=bootstrap-partner-token
ALTEGIO_USER_TOKEN=optional-for-local-stdio
ALTEGIO_API_BASE=https://api.alteg.io/api/v1
ALTEGIO_APP_BASE=https://app.alteg.io
PORT=8094
INTEGRATIONS_HUB_MCP_STATE_DIR=.integrations-hub-mcp
```

The public platform route authenticates through Altegio OAuth/raw token and forwards the current user token as `X-Altegio-User-Token`. `ALTEGIO_USER_TOKEN` is only for a private local stdio process.

## Media assets

The MCP does not generate logos, covers, screenshots, or videos. Generate or prepare those assets with a separate image/video tool, then include them in the full application update:

- `icon`: pass a `data:image/...;base64,...` data URL to upload a new icon into Marketplace storage. Omit `icon` when the current icon should remain unchanged; the hosted icon URL returned by a read is not a valid icon upload payload.
- `promo_materials` with `type: image`: pass a base64 image data URL to upload a new image, or preserve an existing Marketplace-hosted image URL/path returned by the application read.
- `promo_materials` with `type: video`: pass the video reference or URL. This application endpoint does not upload video bytes.

`integrations_hub_update_application` remains a full replacement. Read the application first and preserve the complete `promo_materials` list, because omitted materials are deleted. The MCP intentionally does not expose the unrelated generic multipart `/image/upload` route or provide general-purpose asset hosting.

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
docker build -t altegio-integrations-hub-mcp .
docker run --rm -p 8094:8094 -e ALTEGIO_PARTNER_TOKEN=test altegio-integrations-hub-mcp
```

Tests cover schemas/safety, request-scoped authentication, upstream error normalization, the owner-only tool inventory, plan no-op behavior, application idempotency, normalized install payloads, and Streamable HTTP initialization.

The current contract/completeness review is [docs/AUDIT-2026-09-19.md](docs/AUDIT-2026-09-19.md). The four dedicated iframe tools publish MCP output schemas; the remaining tool families still expose raw or lightly wrapped upstream output and are tracked as follow-up work in that audit.

Live mutation tests are intentionally not part of CI because they would create Marketplace state. Use the `integrations_hub_safe_draft_rollout` prompt against an approved test location.

## Known platform limits

- Normal partner API has no direct freeze/unfreeze command. Expiry freezes; a valid payment may unfreeze.
- Entity-frame rollout requires the Biz.ERP backend/frontend release that removes the historical application/location and frontend gates. Saving declarations never backfills existing installations.
- Entity frame URLs are origin-bound: redirects to a different origin break `postMessage`. Per-location limits are global across applications: employee 1, client 1, visit 5.
- Developer entity frames (`employee/client/visit`) and internal sidebar frames (`chat/waiting_list/task_tracker`) are separate systems.
- Chat through activation is usable but one effective chat slot exists per location.
- Schedule webhook configuration is not propagated into the installed webhook DTO.
- Lifecycle callback URLs must target the application's backend, not this OAuth-protected MCP endpoint.

Read [docs/marketplace-internals.md](docs/marketplace-internals.md) before adding or changing operations.
