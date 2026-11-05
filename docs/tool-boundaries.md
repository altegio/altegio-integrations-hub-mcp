# Integrations Hub tool boundaries

Verified against Biz.ERP `6c25807e7c5` on 2026-09-12.

| Surface                                                          | Authentication                   | Stability                                    | MCP policy                                                                                                |
| ---------------------------------------------------------------- | -------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Public catalogue (`/api/v1/marketplace/applications/*`)          | partner + user token in this MCP | public product API                           | read tools                                                                                                |
| Public B2B install grant                                         | partner + user token             | documented public API                        | caller ownership check, `plan/apply`                                                                      |
| Partner integration API (`https://app.alteg.io/marketplace/*`)   | partner token                    | documented unless noted below                | caller must own the application; destructive actions need confirmation                                    |
| Developer Cabinet (`/api/v1/marketplace/developers/companies/*`) | partner + user token             | first-party UI API, not advertised as public | exposed as clearly named developer operations; never described as a public contract                       |
| Internal sidebar install/highlight                               | partner token                    | chat/waiting_list/task_tracker               | separate from developer frames; read-back unavailable; install/remove needs confirmation                  |
| Location hooks (`/api/v1/hooks_settings/{location_id}`)          | partner + user token             | documented public Developer Tools API        | developer application ownership plus location permission; full replacement with snapshot and confirmation |

Transport authentication tokens are never tool arguments. The optional `account.partner_token` binds an existing partner system when creating a developer account, and `payload.partner_token` is accepted only for lifecycle callback validation; both are treated as secrets. In HTTP mode the platform proxy forwards the authenticated caller's Altegio token in `X-Altegio-User-Token`; stdio mode may use `ALTEGIO_USER_TOKEN`. `ALTEGIO_PARTNER_TOKEN` bootstraps Developer Cabinet calls; partner-lane requests and lifecycle validation use the selected developer account's own `partner_system.token` after an ownership check.

Every mutating tool requires `mode`. `plan` returns the normalized request without sending a write. `apply` performs it. Uninstall, refund, full frame replacement, developer-account deletion, payment recording, and other production-sensitive owner actions also require the exact confirmation phrase returned by the plan/error.

Partner-token operations first list the current caller's applications in the declared developer account and reject requests for an application the caller cannot see. This prevents a generally authenticated public-zone user from borrowing the server's partner token for another developer's application.

The following routes are intentionally not described as public API by this repository:

- Developer Cabinet CRUD, moderation statistics, and frame declarations;
- `/marketplace/application/install_frame` and `/toggle_highlight`, which manage internal `chat/waiting_list/task_tracker` types rather than developer entity frames.

All `/marketplace/developers/backoffice/*` routes are outside this server entirely. They represent a Marketplace administrator role rather than an application owner role and must only be exposed through a separate moderator-only skill or service with its own authorization boundary.

`feedback_submit` calls no Altegio API. It writes one `agent_feedback` line to this server's own log, masked for contact details and secrets, keyed by a hash of the caller's token rather than the token, and is therefore served as read-only and closed-world.

`/marketplace/application/new_message` is a partner integration endpoint. Its payload uses the legacy wire name `salon_id`; the MCP exposes `location_id`.

Financial operations recheck ownership before replaying a stored result. Durable reservations prevent automatic replay after ambiguous failures; see [the reconciliation procedure](../RELEASING.md#durable-financial-state).
