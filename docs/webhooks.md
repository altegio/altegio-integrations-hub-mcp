# Owner webhook management

Verified against Biz.ERP `src/Application/Http/Controllers/ApiLegacy/Auth/PageApiHooksSettingsController.php`, `src/More/WebHook/Data/WebHookBuilder.php`, `src/More/Hooks/Services/HookSettingsUpdateService.php`, `src/More/Marketplace/Applications/Services/MarketplaceInstallerHelper.php`, and the public Developer Tools OpenAPI at `docs/en/developers/openapi.yaml`.

## Two distinct channels

| Channel                         | Configuration                                                                           | Events                                                                                                                   | Read path                                |
| ------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Location entity notifications   | `webhook_urls` at activation, then location-wide `/api/v1/hooks_settings/{location_id}` | Location, team member, product, service/category, client, appointment, loyalty card, goods operations, finance operation | `integrations_hub_get_location_webhooks` |
| Application lifecycle callbacks | Application `callback_url` in Developer Cabinet                                         | `uninstall`, `freeze`, `payment` (production only)                                                                       | `integrations_hub_get_application`       |

The Developer Cabinet route is a first-party UI API, not a public API. Use `integrations_hub_update_application` to change its `callback_url`; that tool requires the complete card payload and exact confirmation. `nonpublic_webhook_url` is the receiver installed automatically for a private application, and it is also part of that card. `integrations_hub_get_installation_status` can inspect the application's recorded location settings, including activation URLs where returned.

## Location subscriptions

`integrations_hub_get_location_webhooks` reads the documented public `/hooks_settings/{location_id}` contract. The caller must own the stated application through Developer Cabinet and have the location's webhook settings permission. A successful read does not establish that the application owns every URL at that location. The endpoint aggregates the location's destinations.

`integrations_hub_change_location_webhooks` supports adding, replacing, and removing one URL, and changing the shared active/event flags. Run `mode: plan` first. It reads the current settings and returns the complete POST body plus `expected_snapshot`. Apply requires that snapshot and `CHANGE LOCATION <location_id> WEBHOOKS`. The tool reads again, rejects a changed snapshot, sends one POST, and verifies all fields the GET exposes. New URLs require HTTPS; existing legacy HTTP URLs may be preserved or removed. The upstream limit is 10 unique URLs, with at least one required by its validator.

`integrations_hub_activate_installation` also caps `webhook_urls` at 10 unique HTTPS destinations so the resulting location remains manageable through this API.

The legacy POST is **location-wide replacement**. It updates the event flags on every URL, including URLs installed by other applications, and deletes any omitted URL. Its GET reports only the flags of the first URL, so it cannot reveal differing per-URL settings. It also omits `good` (product) and `self_sending`. The mutation requires `product` and `self_sending` explicitly; review those values and the list of all destinations before apply. Changes made between the final read and POST are still possible because upstream has no conditional write. The backend may reject a write when the location's webhook feature is restricted; both GET and POST enforce location settings permissions. The tool does not override either restriction.

For a location with multiple existing URLs, set `overwrite_shared_settings: true` to acknowledge that differing per-URL flags cannot be preserved by this backend API. Otherwise the tool refuses the change. The `self_sending` value is interpreted against the partner identity used for the location settings request, which may differ from the application's partner identity.

The public tool event names are `location`, `team_member`, `product`, `service`, `service_category`, `client`, `appointment`, `loyalty_card`, `goods_sale`, `goods_receipt`, `goods_consumption`, `goods_theft`, `goods_move`, and `finance_operation`. The tool maps these to the legacy wire names. `loyalty_card` is available through location settings, but the Marketplace activation installer does not set it. Neither the location settings request builder nor the Marketplace installer copies `schedule` into the webhook DTO, so schedule is not offered as a supported subscription.

## Delivery contract and diagnosis

Entity notifications are HTTP POST JSON with `company_id` (location), `resource`, `resource_id`, `status` (`create`, `update`, `delete` where applicable), and `data`. The public [Developer Tools OpenAPI](https://developer.alteg.io/en/developers/openapi.yaml) contains event-specific payload schemas. Acknowledge with 2xx promptly, queue processing, backfill entities through the API before consuming incremental events, and deduplicate repeated deliveries. Do not infer exactly-once delivery or a full initial snapshot.

Lifecycle callback JSON contains `salon_id`, `application_id`, `event`, and `partner_token`; payment adds payment and period fields plus `sign`. Validate the token using a constant-time comparison and validate the payment signature. The callback URL must point to the application backend, not this OAuth-protected MCP server.

There is no owner-facing Biz.ERP API for delivery logs, replay, or sending a test event for either channel. Diagnose a missing event by reading current settings, checking that the location and application are active, checking the receiver's own logs and 2xx responses, and confirming the entity was modified after the initial backfill. This MCP does not claim delivery success merely because settings were saved.
