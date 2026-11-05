# Security

Security fixes target the current `main` branch and maintained hosted service. Older source snapshots are not separately maintained.

Report suspected vulnerabilities privately through [Altegio's support contact page](https://alteg.io/en/contact/), requesting escalation to the Integrations Hub MCP maintainers. Include this repository URL, affected revision, impact and a minimal synthetic reproduction. Do not post credentials, customer records or exploitable details in public issues. GitHub private vulnerability reporting is not currently enabled for this repository.

The HTTP backend expects a trusted authentication proxy. Keep the backend listener private; strip incoming identity headers and forward only the authenticated caller's `X-Altegio-User-Token`. The server validates ownership through Developer Cabinet. Host/Origin checks prevent browser-origin and DNS-rebinding requests; they do not authenticate a proxy or make the backend safe to expose directly. This repository does not currently verify signed proxy identity headers.

Local HTTP binds to loopback by default. Containers bind to all interfaces inside the container; publish only to loopback or a trusted private network. `ALTEGIO_USER_TOKEN` is for stdio and is never an HTTP fallback. Keep credentials outside images and repository files, and restrict the durable financial state directory to its service account.

Every financial write reserves its key before the request. An interrupted or failed operation can therefore require reconciliation even if the upstream write never happened. A pending reservation must not be deleted or bypassed with a new key until its outcome is established. See [RELEASING.md](RELEASING.md).
