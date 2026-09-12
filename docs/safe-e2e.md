# Safe draft application lifecycle

Use a dedicated test location whose owner has agreed to the installation. Keep the application `is_nonpublic=true` until moderation. Run each mutation with `mode=plan`, inspect its path/payload, then repeat with `mode=apply`.

1. Call `marketplace_list_developer_accounts`. Create an account only if none is suitable.
2. Call `marketplace_get_catalog_metadata` and `marketplace_list_available_rights`. Select the smallest permission set needed by the application.
3. Call `marketplace_create_application` with a stable alphanumeric slug, `is_nonpublic=true`, HTTPS callback/registration URLs, explicit countries, and minimal rights. Repeating the same slug is idempotent and returns the existing draft.
4. Call `marketplace_update_application` with the full card: long description, feature list, screenshots/video, FAQ, iframe/multi-location/privacy flags, callbacks, channels, and monetization.
5. If entity frames are needed, call `marketplace_replace_entity_frames` in plan mode. They will remain runtime-disabled for a normal new application until the Biz.ERP feature and allowlist gates are changed. Use `registration_redirect_url + is_iframe=true` for the supported Settings iframe.
6. Call `marketplace_grant_location_access` as the test-location owner. A normal public app becomes `pending`; an eligible private/draft app may fast-install to `active`.
7. If status is `pending`, call `marketplace_activate_installation` within the current 12-hour window with entity webhook URLs and optional `chat_url`. The callback links the system user and moves the installation to `active`.
8. Call `marketplace_get_installation_status` and verify `active`. Call one harmless Business Management API read using `Authorization: Bearer <partner>, User <application_token>` outside this server, or through Altegio Pro MCP. Verify callback delivery in the application backend.
9. Change one reversible card field with `marketplace_update_application`; read the app again and compare. Frame declarations are full replacement, so always read them first.
10. To disable the test integration, call `marketplace_uninstall` in plan mode. Apply only with `UNINSTALL APPLICATION <application_id> FROM LOCATION <location_id>`. Verify `uninstalled` in the status log/list. Re-grant is required for a new install.

Do not publish through backoffice as part of testing. Normal publication starts with `marketplace_save_moderation_instructions` and `marketplace_submit_for_moderation`; human review remains an intentional product gate.

Freeze has no partner command. It is driven by expiry/billing inside Biz.ERP. A successful `marketplace_record_payment` can unfreeze an eligible installation and must use a durable idempotency key.
