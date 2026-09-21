# Embedded UI surfaces

What an application actually gets _inside_ the Altegio interface, and what each surface
proves about the person looking at it. Field notes from shipping one — application 2391
(`altegio_analytics_agent`, partner 2630) — against production on 2026-09-21: every claim
below marked **verified** was executed against `app.alteg.io` / `api.alteg.io` and, where
the partner API cannot answer, read back from the salon database.

Complements [marketplace-internals.md](marketplace-internals.md) (contracts) and
[widget-analytics-and-plugins.md](widget-analytics-and-plugins.md) (code delivered into
the booking widget). This file is about surfaces rendered inside the ERP.

## The three surfaces, ranked by what they cost to take

| Surface                                   | Where                                                    | What it takes                                                        | State 2026-09-21                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Settings tab in the application card      | Marketplace → card → Settings                            | `is_iframe=true` + `registration_redirect_url`                       | Available to any application                                                                                                |
| Journal sidebar panel                     | Right-hand panel of the journal, and from a booking card | `chat_url` at activation, or `install_frame` for an existing install | Available; **one chat slot per location**                                                                                   |
| Entity tabs (`employee`/`client`/`visit`) | Employee card, booking window                            | Frame declarations, copied into a location at _install_ time         | Declarations API answers in production (`200`, `data: []` for a fresh application); frontend rollout not visually confirmed |

The chat slot is the expensive one: `createOrUpdateChatSettings` rewrites the location's
single chat row, so a messaging integration installed later silently replaces the panel,
and installing one replaces theirs. Treat it as a shared resource, not as your surface.

## Signing a person in without OAuth

Both embedded surfaces hand the application enough to establish identity server-side.
They are not equivalent, and the difference decides what you may show.

### Settings tab — the person is signed

`MarketplaceApplicationUniqueFieldsTransformer` exposes
`unique_fields.registration_redirect_url`, which `MarketplaceRedirectUrlBuilder::build`
**rebuilds per viewing user on every card open**. Reading the stored application config
returns the bare URL; the card serves the built one:

```text
<registration_redirect_url>?salon_id=<id>&user_data=<base64 json>&user_data_sign=<hex>
# the multi-location grant flow sends salon_ids=<csv> instead of salon_id
```

**`user_data` is base64 of JSON, not ciphertext**, despite the field name and despite
`UserDataEncryptor` also having a real AES-256-CBC `encrypt()` that this path does not
call. `encryptWithSign()` returns `base64(json)` plus
`hash_hmac('sha256', <json bytes>, <partner token>)` — so the signature, not the encoding,
is the security property. Verify it with a constant-time compare over the _decoded_ bytes.

Payload is `UserTransformer` plus the location name:
`{id, name, phone, email, is_approved, avatar, salon_name}`. It contains **no Altegio API
token**, and it is only sent when `is_personal_data_access_needed` is on.

Two consequences worth designing around:

- There is no nonce and no expiry in the payload, and it travels in a URL. Treat it as
  one-time login material: exchange it immediately for your own session, bind it to the
  location it arrived with, and keep it out of logs.
- `salon_id`/`salon_ids` sit next to the signature but are **not covered by it**. Check
  the person against the location before trusting the pair (see below).

### Journal panel — the _location_ is signed, the person is not

`MarketplaceFramesDataProvider` builds the panel URL with the location and a legacy hash;
the frontend (`PartnerChatSettingsContainer`) appends the rest client-side:

```text
<chat_url>?salon_id=<id>&hash=sha1(salon_id + partner_token)[&entity_type=<slug>]
          &user_id=<current user>&lang_id=<lang>      # appended by the browser
          &phone=<client phone>                       # only when opened from a booking
```

`hash` is a shared secret and proves the frame was rendered by Altegio for that location.
`user_id` is **not signed** — anyone who can open the panel can edit it. Verify it:
`GET /api/v1/company_users/{locationId}` with the system-user token returns the location's
users with an `access` map (271 flags on a current location, including
`edit_users_access` — the same right Altegio itself requires to connect an application).
Pick the flag that matches what your surface exposes and fail closed; cache the answer
briefly rather than calling per iframe load.

Visibility is gated independently by `MarketplaceChatsService::canUserSeeChat`: a
backoffice chat permission, _or_ timetable-phones access **and** record-form-client
access. A restricted receptionist may never see the panel at all.

### Sessions inside an iframe

A cross-site iframe does not receive a `SameSite=Lax` cookie, and third-party cookies are
blocked outright in some browsers, so a cookie session cannot carry an embedded surface.
What works: verify the hand-off while rendering the frame and embed a short-lived bearer
token in that document, then authorize API calls with it.

Framing headers are the application's job. `X-Frame-Options` cannot express an allowlist
(`ALLOW-FROM` is dead), so serve the framed routes with
`Content-Security-Policy: frame-ancestors https://app.alteg.io …` and omit
`X-Frame-Options` on those routes only. The Altegio side sets no `sandbox` attribute, and
the Settings channel posts with `targetOrigin: '*'` while checking only `event.source` —
so the embedded page must validate `event.origin` itself.

## Installing the journal panel on an application that is already installed

`chat_url` in the activation callback only reaches installs that are still `pending`.
**Verified:** re-confirming an active install returns `403 {"meta":{"message":"The user
has already installed this application."}}`, so a confirm-with-`chat_url` against a live
location is a no-op for the panel.

For an existing install, use the partner sidebar route directly:

```http
POST https://app.alteg.io/marketplace/application/install_frame
Authorization: Bearer <PARTNER_TOKEN>
Accept: application/vnd.api.v2+json

{"salon_id": 4564, "application_id": 2391, "type": "chat",
 "url": "https://example.com/frame/chat"}
```

**Verified in production for an ordinary, non-allowlisted, unmoderated application:**
`200`, and a row appears in the salon database
(`marketplace_sidebar_frame_urls`: type_slug `chat`, the URL, `is_lead_saving_enabled 0`,
`is_push_enabled 1`). The historical `isAppFrameValidated` allowlist (186/121/39) and the
eight-location test list are gone from `MarketplaceFramesService` on `master` and behave
as removed in production.

Verification is the real gap: the partner API has no read endpoint for effective sidebar
frames, and the installation status keeps reporting `special_settings.chat_url: null`
because that field belongs to the install callback's stored settings, a _different_ table
from the frames row. Do not read it as failure, and do not read `200` as proof — at the
per-type limit the installer logs `Frames limit reached` and still returns success.

## Layout facts for the panel

- `TIMETABLE_SIDEBAR_WIDTH = 321` px, full height. Design a phone-width column, not a
  scaled-down page: one-column suggestions, numbers before tables, wide tables scrolling.
- The iframe is served with `allow="microphone *; clipboard-write *"` — voice input is
  possible; the Settings tab only gets `clipboard-write`.
- A stub is rendered when no frame is available, so an unreachable URL looks like "no
  integration" rather than an error.
- Attention signals are separate calls: `POST /marketplace/application/new_message` sets
  the unread highlight, socket update and optional notification-center entry;
  `POST /marketplace/application/toggle_highlight` clears or sets it.
- Location settings that change behaviour: push, and _lead saving_ — with lead saving on,
  a message from an unknown phone creates a lead. Leave it off unless the application is
  really a messaging channel.
- `PartnerChatChannel`: the frame sends `{action:'load_client', payload:<phone>}` to make
  the ERP open that client; the ERP sends `{action:'phone_change', payload:{phone,
phone_code}}` when the booking context changes.

## Turning the Settings tab on without losing the card

`is_iframe` changes more than the rendering: with it on, `MarketplaceProductDefault.vue`
routes the owner to the Settings tab after Connect (`$router.push`) instead of opening the
redirect in a new browser tab, and the mass/group grant flows call `setRedirectUrl(...)`
so the same tab shows the built URL. One entry point can therefore serve both the
post-install screen and the permanent settings surface.

The application update is a **full replacement** (`PUT
/api/v1/marketplace/developers/companies/{partnerId}/applications/{applicationId}`), and
omissions clear values. The recipe that changed exactly two fields on a live card,
verified by diffing the record before and after:

1. `GET …/companies/{partnerId}/applications` and take the application object.
2. Keep: `title`, `short_description`, `category_id`, `country_ids`, `website_url`,
   `price`, `trial_duration`, `channels`, `permissions`, `callback_url`,
   `registration_redirect_url`, `is_personal_data_access_needed`,
   `is_multiple_salons_allowed`, `is_iframe`, `slug`, `is_nonpublic`,
   `nonpublic_webhook_url`, `monetization_type`, `full_description`,
   `features_description`, `promo_materials`, `questions`, `functionalities`.
3. Drop: `icon` (round-tripping the hosted URL corrupts it — omit to keep the current
   one), `application_token`, `system_user_id`, `short_links`, `id`,
   `marketplace_partner_id`, `created_at`, `moderated_at`, `moderation`.
4. `status` exists in `UpdateApplicationDto` but the update service never reads it; omit.
5. Diff the record afterwards and assert only the intended fields moved.

Moderation state is unaffected by this: an unmoderated draft keeps `moderated_at: null`
and stays installable on your own locations.

## Not verified here

- Entity frames end to end: the declarations endpoint answers, the code gates are gone on
  `master`, but no `employee`/`client`/`visit` tab was opened in a production UI.
- `new_message` / `toggle_highlight` against a live panel.
- The Settings `postMessage` bridge (`show_modal`, `show_toast`, `open_tab`) from a real
  embedded page.
