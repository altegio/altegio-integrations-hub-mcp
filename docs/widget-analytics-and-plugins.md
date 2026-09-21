# Booking-widget analytics, injections, and the dormant plugin subsystem

Reference for three adjacent mechanisms that are easy to confuse when adding an analytics or tag-management application to the Integrations Hub:

1. **native analytics applications** — a Marketplace card whose entire implementation lives inside Biz.ERP (Google Analytics, Yandex Metrika);
2. **booking-form injections** — a support-operated field for bespoke per-form code;
3. **the plugin subsystem** — a second Marketplace application type (`type='plugin'`) with its own build, review, and delivery pipeline, imported from upstream but not wired up.

Only the first is a working path for a new application today. The third is where this should eventually live.

Verified against Biz.ERP `fa3ee092384` (master) and `altegio/client.booking` `a581528b60f` (master) on 2026-09-21. Production counts come from the analytics replica on the same date and will drift.

## Two booking widgets

| Repository                                    | Role                                           | Booking forms                                |
| --------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| `altegio/client.widget` (GitLab project 26)   | legacy AngularJS SPA, last activity 2025-04-23 | 606,785 (`booking_form.ab_test_enabled = 0`) |
| `altegio/client.booking` (GitLab project 137) | current Angular widget, actively developed     | 862,984 (`ab_test_enabled = 1`)              |

`ab_test_enabled` on the booking form selects which widget serves it. Everything below describes `client.booking` unless stated otherwise; the legacy widget has its own `src/init/setClientInjection.ts` and is not kept in sync.

Widget configuration is assembled by `BookingFormAdaptService::adaptForm()` and served through the legacy unauthenticated `PageBookformController`. `BookingFormAdaptCachedService` caches it for 10 minutes under tags `booking_form_adapt_salon_id_%d` and `booking_form_adapt_booking_form_id_%d`; `purgeCacheBySalonIds()` and `purgeCacheByBookingFormIds()` invalidate them. Anything added to the adapt payload that depends on Marketplace installation state must purge by salon tag on install and uninstall.

## Native analytics applications

Google Analytics is the reference implementation. It is a Marketplace card, not a partner integration: application id 102, slug `google_analytics`, partner 65 (`Altegio`, main account), category 13 (`analytics`), `monetization_type = free`, `is_iframe = 1`, moderated since 2024-01-01, 1562 active and 14 pending installations. It requests **zero** system-user permissions — there are no rows in `marketplace_system_user_permissions` for it — because nothing calls the public API on its behalf.

Hosting is entirely inside Biz.ERP. `callback_url` is empty and `registration_redirect_url` is `https://app.alteg.io/appstore/**SALON_ID**/frames/default/google_analytics`, which resolves to `MarketplaceFramesController::action_default()` — gated by the `APPS_WITH_DEFAULT_FRAME` whitelist — rendering `templates/marketplace/frames/google_analytics.php`, which mounts the Vue component `<marketplace-integrations-google-analytics>` from the `marketplaceIntegrations` entrypoint.

Its API is first-party, not the partner API:

```text
GET|POST|PUT|DELETE /api/v1/company/{salonId}/marketplace/ga/
```

registered in `src/Application/Http/Routing/Routes/api/api.php` under a group carrying the comment `// google_analytics adblock workaround` — the path is shortened to `ga` so that blockers do not drop it. Handled by `MarketplaceGoogleAnalyticsController` → `MarketplaceGoogleAnalyticsService`.

The application owns no storage. It writes `booking_form.google_analytics_id` (`varchar(64)`); a "stream" in the UI is a booking form plus its counter id. Related columns on the same table are `metrika_counter_id`, `facebook_pixel_id`, `vkontakte_pixel_id`, `app_metrika_id`.

Lifecycle is derived from data rather than driven by the user:

- creating the first counter auto-installs the application through `BasicInstaller` (`MarketplaceApplicationInstallerFactory::BASIC_INSTALLER_APPS`);
- deleting the last counter moves the location link back to `pending`;
- the application is excluded from `UninstallExpiredApplicationsCommand`;
- install and uninstall both require `hasSalonOnlineRecordAccess`, special-cased for this slug and for `yandex_metrika` in `MarketplaceApplicationContainerBuilder`.

Availability is gated by the brand feature `BrandFeatureSlugsDict::BOOKING_FORM_GOOGLE_ANALYTICS` through `BookingFormAnalyticsAvailabilityService`; the same service gates the Facebook Pixel, Yandex Metrica, and Yandex AppMetrica fields. The card is seeded by `SyncMarketplaceApplicationsCommand`.

Yandex Metrika is the sibling implementation and differs in one respect: it has its own `YandexMetrikaInstaller` because it performs an OAuth handshake with Yandex, whereas Google Analytics only stores an identifier.

## Widget tracking and its limits

`MetrikaService.reachGoal()` in `apps/client.booking/src/app/shared-modules/tracking/metrika.service.ts` does four things per goal, and the first three are provider-agnostic:

1. calls `additionalOptions.eventHooks[target]` if the embedding page registered one;
2. `postMessage`s `{action, params}` to the parent frame;
3. dispatches a `window` `CustomEvent` named **`onSendAnalytics`** with `{detail: {target, params}}`;
4. only then, and only when tracking is enabled, forwards to gtag, fbq, and Firebase.

Step 3 happens before the `enabled` check and regardless of which counters are configured, so any injected or plugin-delivered script can subscribe once and receive the full event stream without a widget change.

Provider loading is hardcoded in the same service. `initGoogleScript()` appends `https://www.googletagmanager.com/gtag/js?id=<id>`, defines `window.dataLayer` and `window.gtag`, applies GDPR consent defaults through `GdpConsentBannerService` (EU visitors get `denied` unless previously consented), sets `custom_map` from `google_analytics_client_id_index`, and adds `cookie_flags: 'samesite=none;secure'` when running in an iframe. `initFacebookScript()` calls `ScriptAppenderHelper.appendFacebook()` plus a `<noscript>` pixel.

Two limits matter for any tag-management work:

- **The event vocabulary is fixed by the widget release.** 41 distinct names across 27 call sites, including `widget_loaded`, `service_selected`, `master_selected`, `date_selected`, `time_selected`, `send_contacts`, `phone_approved`, `booked`, `Schedule`, `group_record_created`, `widget_closed`. Nothing in application configuration can add or rename one.
- **Payloads carry no commercial data.** `booked` and `group_record_created` send `{appointments, code, companyId, companyName, isMobile, event_id}`, where `Appointment` is `{services: number[], staff_id, datetime, chargeStatus, custom_fields, id, ...}`. Service identifiers only — no price, currency, or names. Ecommerce or revenue attribution therefore requires enriching the payload in the widget, independent of how the tag is delivered.

DOM insertion primitives available today, all runtime (the widget is client-rendered; there are no `@angular/ssr` or `platform-server` dependencies, and `index.html` is just `<head>` with one script plus `<body><app-root></app-root>`):

- `<head>` append — `ScriptAppenderHelper.appendScript()` and `applyInjection()`;
- end of `<body>` — `ScriptAppenderHelper.appendHtml()` via `insertAdjacentHTML('beforeend')`, used for the Facebook `<noscript>` pixel;
- start of `<body>` — does not exist.

Because the widget is client-rendered, the classic "right after `<body>`" GTM `<noscript>` fragment is inert: a browser with JavaScript disabled never renders the widget at all, so any runtime-injected `<noscript>` can never be reached. Document position carries little meaning here; the meaningful axis is load phase relative to app bootstrap.

## Booking-form injections

`booking_form_injection_settings` holds one `content` (`mediumtext`) row per booking form, plus `is_adapted` (adapted for the new widget) and `is_editable_for_user`. Companion tables `booking_form_injection_tags` and `booking_form_injection_tag_links` classify them.

`BookingFormAdaptService` exports it as `injection.content`, and the widget applies it in `CurrentBookformService.applyInjection()`:

```ts
const documentFragment = document
  .createRange()
  .createContextualFragment(bookForm.injection.content);
document.getElementsByTagName('head')[0].append(documentFragment);
```

This runs from `app-initializer.ts` (Angular `APP_INITIALIZER`), before `loadCurrentBookform()` resolves and before `initTracking()`, so injected code reliably precedes the first `reachGoal`, including `widget_loaded`.

Editing is restricted by `BookingFormInjectionFieldsAvailabilityService`: `isInjectionContentAvailable` is `isSuperUser() || isEditableForUser`, and the legacy `html_code_v2` field (exported as `y_injection`) is superuser-only for the new widget. The default template lives in `BookingFormDefaultJsInjectionsDict` and references `window.altegioApi` — the name comes from `SubProject::$widgetDefaultInjectionObject`, set to `altegioApi` for every sub-project in `SubProjectStorage`.

Production usage, 2026-09-21: 3821 forms have non-empty content; 50 load a real GTM container (`gtm.js` / `GTM-`); 142 push to `dataLayer`; 357 reference `altegioApi`/`yclientsApi`; 7 already subscribe to `onSendAnalytics`.

**This is a support tool, not an application mechanism.** One free-text field per booking form, edited by hand for bespoke customer work. Writing application-managed content into the same field would collide with support edits in both directions, and it is per-form rather than per-application. It is a reasonable pilot vehicle and a poor product surface.

## The plugin subsystem

A second Marketplace application type, imported from upstream YCLIENTS under the PFA-459 ticket line, present in Biz.ERP and unused.

### Schema

`db/migrations/pt-online-schema-change/20250723112120_pfa_459_marketplace_application.php` adds to `marketplace_applications`:

```sql
ADD COLUMN type ENUM('integration','plugin') NOT NULL DEFAULT 'integration' COMMENT 'Тип приложения' AFTER slug
ADD COLUMN current_plugin_version VARCHAR(20) NULL COMMENT 'Текущая активная версия плагина' AFTER is_nonpublic
```

A plugin is therefore an ordinary Marketplace application — same card, partner, location links, tariffs, and billing — distinguished by `type` and pointed at an active build by `current_plugin_version`.

`db/migrations/20250718112120_pfa_459_plugin_migration.php` adds three satellite tables:

| Table                    | Purpose                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin_builds`          | `slug` + SemVer `version`, unique together                                                                                                                        |
| `plugin_builds_packages` | `package_name`, `application ENUM('erp','widget')`, `areas JSON`, `resources JSON`                                                                                |
| `plugin_reviews`         | `status ENUM('draft','pending','approved','rejected','published')`, `reviewer_id`, `review_comment`, `plugin_version`, `published_at`, `gitlab_merge_request_url` |

One plugin may ship several packages, each with its own embedding areas and resources, so a single application can deliver code into both the ERP and the widget. Moderation is separate from card moderation (`marketplace_application_moderations` + `moderation/start`): `gitlab_merge_request_url` shows the intent was to review plugin **sources** in a GitLab merge request and publish each version independently of the application itself.

### Delivery

```text
GET /api/v1/salon/{salonId}/plugins?application=erp|widget&area[]=...
```

`SalonPluginsController` → `SalonPluginService` → `PluginBuildStorage::getPluginBuildPackages()`. The query joins builds to the application on `ma.slug = pb.slug AND pb.version = ma.current_plugin_version`, and filters `ma.type = 'plugin'` and `marketplace_application_salon_links.status = 'active'` — so resources are served only for applications actually installed on that location. Each row becomes a `PluginInformationDto{slug, areas, url, type}`, where the URL is `{plugin.cdn_url}/{pluginSlug}/{pluginVersion}/{packageName}/{resourceName}`.

```text
GET /api/v1/plugin/webhook
```

`WebhookPluginBuildController` → `WebhookService::registerBuild()`: a token-authenticated CI hook that fetches `contract.json` and `metafile.json` from the CDN path, inserts the build and its packages, and sets `current_plugin_version` on the application.

`ApplicationEnum` declares four hosts — `erp`, `widget`, `adminapp`, `yplaces` — while `plugin_builds_packages.application` currently allows only `erp` and `widget`.

Configuration keys are `plugin.cdn_url` and `plugin.webhook.token`. They appear only in `config/config.php.example` (`https://cdn.altegio.cloud/plugins`); the real `config/config.php` is gitignored, so whether they are set in production cannot be determined from the repository.

### ERP frontend: implemented and mounted

`vue-app/src/yclients/plugins/PluginManager/` with `pluginsStore` (Pinia), `PluginsApiService` (documented in `vue-app/src/yclients/api/modules/plugins/README.md`), and `PluginProcessorService`, which loads `script` and `stylesheet` resources and de-duplicates through `ResourceRegistry`.

Five embedding areas exist, in two generations of the API:

- `erp-visit-modal-client-details`, `erp-visit-modal-client-card-sidebar`, `erp-visit-modal-client-card-info` — typed through the `EPluginAreas` enum and `usePluginManager`;
- `erp-timetable-controls`, `erp-timetable-record-client-name` — raw `AREA_ID` string constants dispatching `CustomEvent('host:${AREA_ID}:ready')`.

### Widget frontend: a development stub only

`apps/client.booking/src/app/core/services/widget-plugins.service.ts` is guarded by `if (environment.isMockedMode)` while `isMockedMode: false` in the single environment file, hardcodes `pluginLocations = ['/assets/plugins/widget-masters-promo']`, reads a local `manifest.json` of `{name, type}` entries, and never calls `/api/v1/salon/{id}/plugins`. `initPlugins()` runs in `APP_INITIALIZER` _before_ `loadCurrentBookform()`, so sourcing the plugin list from the adapt config would require reordering or a separate early fetch.

The bundled example `widget-masters-promo` reveals the intended widget-side SDK: packages `@yclients-plugins/utils` and `@test_entry_user/widget-api`, a `contract.json` exposing `packages[<name>].area`, host events `host:${area}:ready` and `host:${area}:shutdown`, and UI mounting through `window.widgetApi.addSlotInfo({containerType, componentType, ...})`. `EWApiSlotContainerType` defines eleven slots: `staff_info_comments`, `record_type_prepend`, `record_type_last`, `menu_prepend`, `menu_last`, `master_select_prepend`, `services_select_prepend`, `activity_select_prepend`, `service_tag`, `master_tag`.

### Why it is dormant

- the literal `'plugin'` appears exactly once in the codebase — the SQL filter in `PluginBuildStorage`;
- `MarketplaceApplication::setType()` is never called, so nothing can turn an application into a plugin;
- `type` is accepted by neither `CreateApplicationDto` nor `UpdateApplicationDto`, so the Developer Cabinet cannot create one;
- `type` is not emitted by any Marketplace transformer, so the catalogue frontend cannot see it;
- the `PluginReview` model is referenced by no service or controller — the table exists, the review flow does not;
- `src/More/Plugin/Resources/Translations/{ru,en}.php` are empty arrays;
- production holds 2460 applications, all `integration`; `plugin_builds`, `plugin_builds_packages`, and `plugin_reviews` are empty; no application has `current_plugin_version` set.

What is missing is the layer that **assigns** the type (Developer Cabinet or backoffice), the layer that **moderates** it (UI over `plugin_reviews`), and the widget client.

## Upstream synchronisation status

Code arrives from YCLIENTS as squashed import commits, not as a live mirror.

Biz.ERP, staged through a `yc-merge` → `new-features` → `master` chain:

| Drop                      | Merged     | Files | Plugin content                                                                                                                                 |
| ------------------------- | ---------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `New features 23.04.2025` | 2025-05-14 | 2022  | —                                                                                                                                              |
| `New features 16.06.2025` | 2025-07-15 | 3048  | —                                                                                                                                              |
| `New features 14.08.2025` | 2025-09-08 | 2757  | both migrations, `SalonPluginsController`, `SalonPluginService`, models incl. `PluginReview`, all of `PluginManager`                           |
| `New features 2025-10-15` | 2025-12-01 | 3475  | webhook + build registration, `ApplicationEnum`, `PluginPackageUrl`, service provider, storage, `pluginsStore`, API module, two more ERP areas |
| `New features 23 03 2026` | 2026-04-27 | 168   | none                                                                                                                                           |

`client.booking`: `YC-MERGE 16.10.2024-03.12.2024`, `YC-MERGE 13.12.2024-17.01.2025`, `New features 20.03.2025`, and `New features 21.08.2025` (merged 2025-10-07, +104,862/−10,831, brought the development-only plugin loader). Nothing since.

Two conclusions:

- **Nothing was filtered out locally.** The plugin feature arrived in layers, each drop complete. `origin/new-features` differs from `master` on plugin files only by translation-key renaming from the local i18n migration, so no plugin code is sitting unmerged.
- **The channel then narrowed.** The last backend drop is 168 files against a 2000–3500 baseline, and the widget has received nothing for roughly eleven months. Work done upstream after 2025-10-15 — plausibly including the missing assignment and review layers — has not been pulled.

There is no upstream mirror available locally: the `yc-merge` branch is deleted (only 2024 backups such as `yc-merge-2` and `yc-merge-backup-15-05-2024` remain), `master-yc*` branches are frozen at 2024, and no plugin SDK repository exists in `gitlab.altegio.dev` across its 53 groups. Instance-wide code search is unavailable (Advanced Search is not enabled), so absence is established from project listings, not file contents. The `widget-masters-promo` bundle ships a source map carrying all ten original sources with full content, including `packages/utils` and the `@test_entry_user/widget-api` ESM build — enough to reconstruct the widget-side contract if upstream does not deliver it.

## Consequences for new analytics applications

- A new counter- or tag-based application is fastest to ship by cloning the Google Analytics path: a column on `booking_form`, a service/controller/DTO/transformer set, a default frame plus Vue module, an adapt export, a brand feature flag, and the seed entry — plus a loader branch in the widget's `MetrikaService`.
- `initGoogleScript()` unconditionally assigns `window.gtag` and `window.dataLayer`. A second Google-family loader must not repeat that pattern, or two configured counters will fight and events will be double-counted when a GA4 tag also sits inside a GTM container. Consent handling currently lives inside that method and has to be hoisted before any provider branch.
- Partner-hosted code cannot reach the widget. The only script-injection surface is `booking_form_injection_settings.content`, which is superuser-gated support tooling. Anything else needs a Biz.ERP change.
- Existing GTM artefacts in production: application id 826, slug `tag_manager`, partner 980 (`GTM`, legal name `Google LLC`, created 2025-06-16, maintainer user 12791883), category 13, `is_nonpublic = 1`, `moderated_at` null, `is_iframe = 0`, `nonpublic_webhook_url` pointing at a `webhook.site` sink, `system_user_id` 12791946, 149 requested system-user permissions, one active installation. An abandoned prototype rather than a shipped integration.

## Source index

Biz.ERP — native analytics applications:

- `src/Application/Http/Controllers/Api/Marketplace/Applications/MarketplaceGoogleAnalyticsController.php`
- `src/More/Marketplace/Applications/Services/MarketplaceGoogleAnalyticsService.php`
- `src/More/Marketplace/Applications/Validation/GoogleAnalyticsCreateDto.php`
- `src/More/Marketplace/Applications/Transformers/GoogleAnalyticsFlowTransformer.php`
- `src/More/Marketplace/Applications/Data/Containers/GoogleAnalyticsFlowContainer.php`
- `src/More/Marketplace/Applications/Services/Installers/YandexMetrikaInstaller.php`
- `src/Application/Http/Controllers/Web/Yclients/Salon/Marketplace/MarketplaceFramesController.php`
- `templates/marketplace/frames/{google_analytics,yandex_metrika}.php`
- `vue-app/src/entrypoints/marketplaceIntegrations/modules/GoogleAnalytics/`
- `vue-app/src/yclients/api/modules/marketplaceApi/marketplaceGoogleAnalyticsIntegrationApi.ts`
- `src/More/Command/Dev/Marketplace/SyncMarketplaceApplicationsCommand.php`

Biz.ERP — booking form, adapt payload, injections:

- `src/CBookingForm.php`
- `src/More/BookingForm/Service/BookingFormAdaptService.php`
- `src/More/BookingForm/Service/BookingFormAdaptCachedService.php`
- `src/More/BookingForm/Service/BookingFormAnalyticsAvailability/BookingFormAnalyticsAvailabilityService.php`
- `src/More/BookingForm/Service/BookingFormInjectionSettings/BookingFormInjectionSettingsService.php`
- `src/More/BookingForm/Service/BookingFormInjectionFieldsAvailabilityService.php`
- `src/More/BookingForm/Data/BookingFormDefaultJsInjectionsDict.php`
- `templates/online/booking_form/analytics.php`

Biz.ERP — plugin subsystem:

- `src/More/Plugin/` (Data, Models, Request, Service, Storage, Transformers, ServiceProvider)
- `src/Application/Http/Controllers/Api/Plugin/{SalonPluginsController,WebhookPluginBuildController}.php`
- `db/migrations/20250718112120_pfa_459_plugin_migration.php`
- `db/migrations/pt-online-schema-change/20250723112120_pfa_459_marketplace_application.php`
- `vue-app/src/yclients/plugins/PluginManager/`
- `vue-app/src/yclients/api/modules/plugins/README.md`
- `vue-app/src/store/pinia/pluginsStore.ts`
- `vue-app/src/yclients/services/PluginProcessorService.ts`

`altegio/client.booking`:

- `apps/client.booking/src/app/shared-modules/tracking/metrika.service.ts`
- `apps/client.booking/src/app/shared-modules/tracking/script-appender.ts`
- `apps/client.booking/src/app/shared-modules/widget-api/widget-api.ts`
- `apps/client.booking/src/app/core/services/current-bookform.service.ts`
- `apps/client.booking/src/app/core/services/widget-plugins.service.ts`
- `apps/client.booking/src/app-initializer.ts`
- `apps/types/widget-api/src/lib/constants/w-api-slot-container-type.constants.ts`
- `apps/client.booking/src/assets/plugins/widget-masters-promo/`
