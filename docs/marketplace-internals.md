# Biz.ERP Marketplace internals

This is the implementation reference for projects integrating with Altegio Integrations Hub. The underlying Biz.ERP module, routes, namespaces, tables, and DTOs retain their legacy Marketplace names. It is intentionally dry: facts, contracts, limits, and source paths. Verified against Biz.ERP `c6a74fd7ea8` on 2026-09-19 and public API docs `1a60136b5`.

This public MCP implements only application-owner and partner workflows. Upstream backoffice facts are retained here solely to explain the authorization boundary; Marketplace administrator actions belong in a separate moderator-only skill or service.

## Architecture and ownership

Marketplace is a Biz.ERP module, not a separate service. Its HTTP surface is split between:

- `/api/v1/marketplace/*` on `https://api.alteg.io`: catalogue, owner-side install grant, Developer Cabinet, reviews, dictionaries, statistics, and internal backoffice;
- `/marketplace/*` on `https://app.alteg.io`: partner callback, installation/status/list/uninstall, chat/sidebar helpers, tariffs, discounts, payment links, payments/refunds, and notification settings;
- application-owned HTTPS URLs: registration/settings page, lifecycle callback, and entity webhook receivers.

Core namespaces are `src/More/Marketplace/Applications`, `Common`, `DevelopersAccount`, `Notifications`, `SidebarFrames`, `Billing`, `Tariffs`, `Analytics`, and `Backoffice`. Routes are registered in `src/Application/Http/Routing/Routes/api/api.php` and `src/Application/Http/Routing/Routes/integrations.php`.

The principal identities are:

- Marketplace partner account (`marketplace_partners`) linked to one partner-system identity/token and one or more maintainers (`marketplace_partner_user_links`);
- Marketplace application (`marketplace_applications`) owned by a partner account;
- application system user, whose user hash is returned as `application_token` and whose permission tree is stored per application;
- application-location link (`marketplace_application_salon_links`; public vocabulary: location) carrying install status and special settings;
- ordinary Biz.ERP user who grants installation access and administers the developer account.

## Data model

| Table                                                                                        | Purpose                                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `marketplace_partners`                                                                       | developer/company metadata and partner-system link                          |
| `marketplace_partner_user_links`                                                             | developer-account membership/maintainer relation                            |
| `marketplace_applications`                                                                   | card, slug, category, price, descriptions, flags, functionality, timestamps |
| `marketplace_application_categories`                                                         | hierarchical catalogue categories                                           |
| `marketplace_application_country_links`                                                      | application availability countries                                          |
| `marketplace_system_user_permissions`                                                        | requested system-user access tree                                           |
| `marketplace_applications_hook_settings`                                                     | enabled Marketplace webhook entity types                                    |
| `marketplace_application_settings`                                                           | callback/registration URL, system user, privacy/multi-location flags        |
| `marketplace_application_promo_materials`                                                    | image/video material                                                        |
| `marketplace_application_questions`                                                          | FAQ                                                                         |
| `marketplace_application_moderations`                                                        | connect/payment instructions and moderation start                           |
| `marketplace_application_frames`                                                             | developer declarations for employee/client/visit frames                     |
| `marketplace_application_salon_links`                                                        | installed/pending/frozen application per location                           |
| `marketplace_application_log`                                                                | append-style state transition history with source                           |
| `marketplace_sidebar_frame_urls`                                                             | effective chat/waiting-list/task-tracker URLs per location                  |
| `marketplace_sidebar_frame_user_links`                                                       | per-user sidebar highlight state                                            |
| `marketplace_application_salon_channel_links`                                                | SMS/WhatsApp availability                                                   |
| `marketplace_application_salon_short_names`                                                  | SMS sender names                                                            |
| `marketplace_tips_urls`                                                                      | installed tips URL                                                          |
| `marketplace_application_tariffs`, `marketplace_application_tariff_options`                  | billing plans/options                                                       |
| `marketplace_payments`, `marketplace_payment_transactions`                                   | payment periods, refunds, processing                                        |
| `marketplace_application_reviews`, `marketplace_application_requests`                        | reviews and review prompts                                                  |
| `marketplace_applications_ranking`, `marketplace_applications_ranking_rates`                 | catalogue ranking inputs                                                    |
| `marketplace_featuring`, `marketplace_quickstart_featuring`                                  | curated placement                                                           |
| `marketplace_partners_tags`, `marketplace_partner_tag_links`, `marketplace_partner_comments` | internal partner classification/review                                      |
| `marketplace_special_offers`                                                                 | internal catalogue offers                                                   |
| `marketplace_blocked_entities`                                                               | rollout/install blocks                                                      |
| `marketplace_backoffice_permissions`                                                         | internal Marketplace administration permission                              |

Analytics also reads ClickHouse `marketplace_app_tracks`, `marketplace_conversions`, and `marketplace_analytics_tracks`.

## Authentication and tokens

User-authenticated v1 calls use:

```http
Accept: application/vnd.api.v2+json
Authorization: Bearer <PARTNER_TOKEN>, User <USER_TOKEN>
```

Partner integration calls use only `Authorization: Bearer <PARTNER_TOKEN>` and the same Accept header. `ApiPartnerAuthMiddleware` requires the v2 media type for partner IDs above 1743 except specific legacy partners. Source: `src/More/Auth/Services/AuthHeaderService.php`, `src/Application/Http/Middleware/Api/ApiPartnerAuthMiddleware.php`.

The Developer Cabinet application transformer returns:

- `system_user_id`: the technical user selected/created for the app;
- `application_token`: that user's hash, used as the `User` token when calling Business Management API v1;
- the chosen `permissions` tree.

Tokens are credentials. Do not put them in URLs or logs. The legacy chat-frame `hash=sha1(location_id + partner_token)` is stable and appears in a URL; it is not user authorization.

## Developer account and application contracts

Developer account endpoints (first-party UI API, not published as a stable external API):

```text
GET    /api/v1/marketplace/developers/companies
POST   /api/v1/marketplace/developers/companies
PUT    /api/v1/marketplace/developers/companies/{partnerId}
DELETE /api/v1/marketplace/developers/companies/{partnerId}
```

Create fields: `title`, `description`, `name`, `phone`, `email`, `website_url`; optional/default `legal_type`, `partner_token`. Update additionally accepts `country_id`, `company_name`, `reg_number`, `privacy_policy_url` but still reads the complete base fields. Sources: `CreatePartnerDto.php`, `UpdatePartnerDto.php`.

Current Biz.ERP normalizes a bare domain in `website_url` and `privacy_policy_url` by prepending `https://`; it also accepts an explicit URL scheme. The MCP deliberately requires an explicit HTTPS URL so an automated caller cannot accidentally select an insecure or ambiguous destination.

Application endpoints:

```text
GET  /api/v1/marketplace/developers/companies/{partnerId}/applications
POST /api/v1/marketplace/developers/companies/{partnerId}/applications
PUT  /api/v1/marketplace/developers/companies/{partnerId}/applications/{applicationId}
GET  /api/v1/marketplace/developers/companies/{partnerId}/applications/available_rights
PUT  /api/v1/marketplace/developers/companies/{partnerId}/applications/{applicationId}/moderation
POST /api/v1/marketplace/developers/companies/{partnerId}/applications/{applicationId}/moderation/start
```

Create requires title, short description, category ID, country IDs, website URL, price string, nonnegative trial days, channel IDs, a flat permission map, an alphanumeric slug, and monetization type (`free`, `paid`, or `freemium`). Most permission entries are `0|1` flags, but the authoritative application response also contains integer IDs and day-limit fields such as `-1` for unlimited history; full-card updates must round-trip those integer values unchanged. Optional/default technical fields are icon, callback URL, registration redirect URL, personal-data access, multiple locations, iframe, private/nonpublic flag, and nonpublic webhook URL. Update is a full replacement-style payload and adds long description, feature strings, promo materials `{type: image|video, content}`, FAQ `{question, answer}`, and validated functionality slugs. Read the current application first; omission may clear values. Source: `CreateApplicationDto.php`, `UpdateApplicationDto.php`, `MarketplacePermissionsDict.php`.

Media upload is embedded in the application write rather than exposed as a separate Marketplace upload tool. A non-null `icon` is treated as a base64 image data URL and uploaded into the `marketplace` image folder; omit the field to preserve the current icon instead of sending the hosted icon URL returned by reads. The icon path writes the decoded bytes verbatim: `ImageFileService::createFromBase64()` strips the `data:image/...;base64,` prefix, calls `base64_decode()` in non-strict mode, and `file_put_contents()`s the result without decoding it as an image. A non-data-URL string is therefore stored as a corrupt file under a fresh `.png` name, replacing both the card icon and the application system user's avatar. Round-tripping a read's `icon` URL produced exactly that on two live applications on 2026-09-19, so this server rejects any `icon` that is not a base64 image data URL. For an image promo material, `content` containing `base64` is uploaded and replaced with the stored relative URL. Existing Marketplace-hosted image paths/URLs are normalized and preserved. Video promo `content` is stored as a reference; the endpoint does not upload video bytes. The server does not generate media and deliberately does not wrap the unrelated generic multipart `/api/v1/image/upload` route. Sources: `DevelopersAccountApplicationService.php`, `ImageFromBinaryCreator.php`, `PromoMaterialDto.php`.

Moderation instructions accept `connect_instruction` and `payment_instruction` (empty or 3–1000 characters). `moderation/start` records the owner's submission; it does not itself publish. A separate Marketplace administrator workflow makes the publication decision and is not exposed by this MCP.

Public dictionaries:

```text
GET /api/v1/marketplace/applications/categories
GET /api/v1/marketplace/applications/channels
GET /api/v1/marketplace/applications/functionalities
GET /api/v1/countries
```

These routes belong to the public catalogue surface, but the current production gateway rejects unauthenticated requests; the MCP sends the caller's normal Developer Cabinet authorization. Categories `analytics` and `ai_bots` exist. Category selection affects discovery only; it does not grant permissions or UI placement. Existing application slugs may contain underscores even though the create validator's human-facing message describes Latin letters and numbers; preserve such slugs during full-card updates.

## Installation state machine

Canonical states in code are `pending`, `active`, `freezed`, and the logical/history state `uninstalled`.

```text
uninstalled --owner grant--> pending --partner callback--> active
uninstalled --eligible private/fast grant----------------> active
active --license/billing expiry--------------------------> freezed
freezed --eligible successful payment--------------------> active
pending|active|freezed --uninstall-----------------------> uninstalled
```

Step 1 is `POST /api/v1/company/{locationId}/marketplace/applications/{applicationId}/grant_access` using partner + owner user token. The owner needs the manage-user-rights permission. A normal application creates a pending link. `is_nonpublic` and hardcoded fast-install slugs install immediately.

Step 2 is `POST https://app.alteg.io/marketplace/partner/callback` using partner token. Current code accepts pending confirmation for 12 hours (`MarketplaceApplicationSalonLink::PENDING_TTL`). A separate configured application list uses `PENDING_WEEK_TTL` of seven days during stale-pending cleanup. Never assume the previous one-hour guide value. Sources: `MarketplaceApplicationSalonLink.php`, `MarketplaceApplicationSalonLinksService::isLinkAvailableToBeActivated`, `MarketplaceApplicationSalonLinksStorage::getExpiredPendingSalonLinks`.

The callback validates partner ownership/access strategy, pending freshness, stores partner settings, chooses an installer by application slug/category, links/configures the system user, creates webhooks/chat settings, marks active, logs the transition, and emits `ApplicationInstalledEvent`. Repeating a callback after active is rejected by Biz.ERP; callers should status-check first.

There is no partner freeze/unfreeze endpoint. Freeze is driven by internal expiry/payment behavior. `POST /marketplace/partner/payment` records a successful payment and the payment flow can invoke `processUnfreeze`. Uninstall is idempotent internally if the last state is already uninstalled.

Status and inventory:

```text
GET  https://app.alteg.io/marketplace/salon/{locationId}/application/{applicationId}
GET  https://app.alteg.io/marketplace/application/{applicationId}/salons?page=1&count=100
POST https://app.alteg.io/marketplace/salon/{locationId}/application/{applicationId}/uninstall
```

The public wire format retains `salon`; integrations should expose `location` externally and translate at the boundary.

## Permissions and system user

`MarketplacePermissionsDict` is the only reliable current permission catalogue. It spans timetable/history/phones/statistics; appointment client, services, goods, payment, consumables and custom fields; general settings, users, staff, positions, schedules, notifications and webhooks; client contacts/history/comments/files/accounts; finance transactions/accounts/cash/POS/receipts/Z reports/salary/online payments; loyalty; online-booking privacy; overview, analytics and reports; inventory and tips.

Request the minimum tree required by concrete Business Management API calls. Application activation assigns it to the technical system user at the installed location. Changes after moderation are constrained by the application edit/re-moderation process; do not silently broaden access during rollout.

## Settings iframe and redirects

`registration_redirect_url` is opened after connect and from Settings. `is_iframe=true` embeds it in the application card; false opens it externally. The URL receives `salon_id` and, when personal-data transfer is enabled, optional encrypted `user_data` and `user_data_sign`.

The Settings iframe has `clipboard-write`, no `sandbox`, fills the tab, and uses a fallback height for cross-origin content. Application to Biz.ERP messages:

```ts
{action: 'show_modal', payload?: {maximized?: boolean, scrollIntoView?: ScrollLogicalPosition}}
{action: 'close_modal'}
{action: 'set_modal_scroll_offset', payload: number}
{action: 'open_app_category_page'}
{action: 'show_toast', payload: {type, options}}
{action: 'open_tab', payload: string}
```

Biz.ERP to application:

```ts
{action: 'close_modal'}
{action: 'send_iframe_offset', payload: {top, left, right, bottom, width, height, x, y, windowHeight}}
```

The generic Settings channel sends with `targetOrigin='*'` and checks `event.source`, not `event.origin`. This is separate from entity frames, whose channel is origin-bound. The embedded application must validate origin and message shape. Sources: `vue-app/src/util/iframeChannelBase/index.ts`, `MarketplaceSettingsTabIframeChannel.ts`, `MarketplaceProductDefaultSettingsTab.vue`.

## Entity frames

Declarations are full replacement:

```text
GET  /api/v1/marketplace/developers/companies/{partnerId}/applications/{applicationId}/frames
POST /api/v1/marketplace/developers/companies/{partnerId}/applications/{applicationId}/frames
```

```json
{ "frames": [{ "title": "Agent", "url": "https://agent.example/frame", "slug": "employee" }] }
```

Allowed slugs are `employee`, `client`, `visit`; title length 3–100; URL must be valid. Per location across all applications: employee 1, client 1, visit 5.

The rollout release removes the historical frontend feature constant and application/test-location allowlists. It does not add backfill: saving declarations does not update already installed applications. New values are copied only during a later installation.

Protocol after gates are enabled:

```ts
// iframe -> Biz.ERP
{type: 'iframe_ready'}
{type: 'iframe_request_entity'}
// Biz.ERP -> iframe
{type: 'yclients_response_entity', payload: {entity_type, entity}}
```

Employee payload: ID and name parts. Client adds phone, birthdate, sex, comer. Visit adds date, employee, client. The entity channel derives `targetOrigin` from the declared frame URL and accepts messages only from the iframe window and that exact origin. A redirect to another origin breaks `postMessage`.

## Chat and sidebar frames

For a normal new application, pass `chat_url` in the activation callback. `NotificationInstaller` creates/updates the chat frame directly rather than using the general frame installer. The effective base URL contains `salon_id` and legacy `hash`; timetable use adds `user_id` and `lang_id`, and appointment context adds client `phone`.

Chat visibility requires `hasChatAccess`: explicit backoffice access or the relevant timetable phone + appointment client permissions. `POST /marketplace/application/new_message` sets unread/highlight state, publishes a socket update, and may add notification-center entries. If the location enables lead saving, a message from an unknown phone may create a lead. Location users control push and lead-saving settings.

Only one effective chat slot exists per location. A later chat integration updates the existing chat row's application ID and URL.

General sidebar API:

```text
POST /marketplace/application/install_frame
POST /marketplace/application/toggle_highlight
```

Types are `chat`, `waiting_list`, `task_tracker`; do not confuse them with developer `employee/client/visit` frames. Ownership and active installation are checked. The rollout release removes the historical application allowlist and Altegio/YCLIENTS frontend brand gates. Frame-limit exhaustion logs `Frames limit reached` but can return success-like output without a row. The partner API has no effective-frame read endpoint, so the MCP reports the result as unverified rather than claiming creation.

## Webhooks and lifecycle callbacks

Activation `webhook_urls` registers the standard entity set enabled in `MarketplaceApplicationHookSettings`: location, team member, product, service, service category, client, appointment, goods sale/receipt/consumption/theft/move, and finance operation. Wire event naming follows the existing webhook subsystem. Always perform an initial API backfill; webhooks are incremental notification, not a snapshot or exactly-once queue.

The schedule flag exists in Marketplace hook settings, but `MarketplaceInstallerHelper::createWebhookDtoForMarketplaceApplication()` does not copy it into `WebHookDto`. Do not claim schedule webhook support without a Biz.ERP change and contract test.

`callback_url` receives production-only lifecycle events `uninstall`, `freeze`, and `payment`. Common fields are `salon_id`, `application_id`, `event`, `partner_token`; payment adds payment/period data. Validate the partner token with constant-time comparison in the application backend, return 2xx quickly, deduplicate, and process asynchronously. This is distinct from entity `webhook_urls`.

The MCP public endpoint is OAuth-protected and is not a lifecycle receiver. Callback URLs must point to the application's backend.

## Billing

Partner endpoints:

```text
GET  /marketplace/application/{applicationId}/tariffs
GET  /marketplace/application/payment_link?salon_id=&application_id=&discount=
POST /marketplace/application/add_discount
POST /marketplace/partner/payment
POST /marketplace/partner/payment/refund/{paymentId}
```

Discount is 0–100. Payment requires location/application IDs, ISO currency, nonnegative amount, and `Y-m-d H:i:s` payment/period timestamps. A successful payment is not merely accounting: the billing subscriber may unfreeze the installation. Refund is a financial/destructive action. Biz.ERP does not expose a request idempotency field in its DTO, so clients need a durable external idempotency key and stored result.

## Statistics, conversion, reviews, and short links

Developer statistics:

```text
GET /api/v1/marketplace/developers/companies/{partnerId}/applications/main_stats
GET /api/v1/marketplace/developers/companies/{partnerId}/applications/conversion_stats
```

Main series: category views, app views, pendings, activations, new payments, uninstalls. Conversion slugs: `open_pending`, `show_open`, `active_payed`, `pending_active`, `pending_payed`; granularities day/week/month. The spelling `payed` is the wire enum and should be normalized only in presentation.

Public review reads are under `/api/v1/marketplace/applications/{applicationId}/reviews` and `/best`. User-side create/delete routes exist inside a location-scoped Marketplace API, but they represent customer behavior, not developer management.

Developer application output includes generated short links `info` and `review`. Redirect handlers are `/d/{token}`, `/e/{token}`, and `/m/{token}` with differing login/location behavior. There is no general developer endpoint to arbitrarily create these links.

## Caches and invalidation

| Cache                                     |        TTL | Important invalidation behavior                                                |
| ----------------------------------------- | ---------: | ------------------------------------------------------------------------------ |
| category list                             |     1 hour | service runtime cache can also hold slug lookup                                |
| installation map                          |  5 minutes | link service manages map refresh                                               |
| link-by-slug proxy                        |     1 hour | location + slug key                                                            |
| system users / moderated app system users |   24 hours | invalidated on application create/moderate/delete events                       |
| frame container and highlights            |     1 week | invalidated by frame install/remove/highlight and chat changes by location tag |
| best reviews                              |   12 hours | review changes clear related runtime/cache state                               |
| pending review request                    |     1 hour | tagged per location                                                            |
| backoffice permission                     | 10 minutes | user-scoped                                                                    |
| top-up marker                             | 30 minutes | location + application slug                                                    |

Developer frame declaration save does not invalidate or rewrite already materialized location frame rows. A later installation copies current declarations; there is no backfill/sync for existing installations.

## Rollout gates and known limitations

- Entity frames require the backend/frontend rollout release; declarations saved before it remain inert until a new installation.
- Waiting list/task tracker require the frontend rollout release that removes the historical brand gate; they remain internal sidebar types.
- Chat: usable through activation callback, but one shared slot per location.
- Arbitrary iframe types or main-menu items: no configuration extension point found.
- Schedule webhook: setting is not propagated into actual webhook DTO.
- Marketplace callback lifecycle is production-only.
- Iframes have no sandbox. Entity-frame postMessage is strict-origin; the separate Settings channel does not validate origin on the host side.
- Public v3 is future-facing; this implementation uses v1/v2 wire contracts.
- Internal Developer Cabinet APIs may change with the first-party frontend. Keep them behind adapters and contract tests; do not add backoffice routes to this public server.
- `is_push_enabled` defaults differ between DB (0) and model (1); explicitly saving the setting removes ambiguity.

## Source index

Routes and authentication:

- `src/Application/Http/Routing/Routes/integrations.php`
- `src/Application/Http/Routing/Routes/api/api.php`
- `src/More/Auth/Services/AuthHeaderService.php`
- `src/Application/Http/Middleware/Api/ApiPartnerAuthMiddleware.php`

Developer/application contracts:

- `src/Application/Http/Controllers/Api/Marketplace/DevelopersAccountCompanyController.php`
- `src/Application/Http/Controllers/Api/Marketplace/DevelopersAccountApplicationController.php`
- `src/More/Marketplace/DevelopersAccount/Validation/{CreatePartnerDto,UpdatePartnerDto,CreateApplicationDto,UpdateApplicationDto}.php`
- `src/More/Marketplace/DevelopersAccount/Transformers/{MarketplacePartnerTransformer,MarketplaceApplicationDeveloperTransformer}.php`

Install, lifecycle, auth and billing:

- `src/More/Marketplace/Applications/Services/Abstracts/MarketplaceInstaller.php`
- `src/More/Marketplace/Applications/Services/MarketplaceApplicationInstallerFactory.php`
- `src/More/Marketplace/Notifications/Services/NotificationInstaller.php`
- `src/More/Marketplace/Applications/Services/MarketplaceInstallerHelper.php`
- `src/More/Marketplace/Common/Services/MarketplaceApplicationSalonLinksService.php`
- `src/More/Marketplace/Common/Data/MarketplaceApplicationSalonLink.php`
- `src/Application/Http/Controllers/Api/Marketplace/{NotificationWizardController,MarketplaceIntegrationController,MarketplacePaymentsController}.php`

Frames and web UI:

- `src/More/Marketplace/SidebarFrames/Services/{MarketplaceFramesService,MarketplaceChatsService,MarketplaceFramesDataProvider}.php`
- `src/More/Marketplace/DevelopersAccount/Enum/ApplicationFrameSlug.php`
- `src/More/Marketplace/SidebarFrames/Enum/SidebarFrameSlug.php`
- `vue-app/src/util/frameSettings.ts`
- `vue-app/src/util/iframeChannelBase/index.ts`
- `vue-app/src/util/marketplace/MarketplaceSettingsTabIframeChannel.ts`
- `vue-app/src/util/integration/EntityExtendedIntegrationChannelBase.ts`
- `vue-app/src/util/partnerChat/PartnerChatSettingsContainer.ts`

Analytics and caches:

- `src/More/Marketplace/Analytics/Services/{MainMarketplaceStatisticsService,MarketplaceConversionsService}.php`
- `src/More/Marketplace/Analytics/Storages/{MarketplaceApplicationStatisticsStorage,MarketplaceConversionsStorage}.php`
- `src/More/Marketplace/SidebarFrames/Services/MarketplaceFramesCachedDataProvider.php`
- `src/More/Marketplace/SystemUsers/Services/SystemUsersCacheDataProvider.php`
- `src/More/Marketplace/Applications/Services/MarketplaceApplicationReviewService.php`

Published developer references:

- `biz.erp.api.docs/docs/en/developers/openapi.yaml`
- `biz.erp.api.docs/docs/en/developers/marketplace-quickstart.md`
- `biz.erp.api.docs/docs/en/paths/marketplace/*.yml`
