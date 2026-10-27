# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: on this repository, open **Security › Report a vulnerability**. Don't open a public issue. We'll confirm receipt and keep you updated while we work on a fix.

## What to expect from Marionette

Marionette is built for robots on a trusted network:

- The gateway asks for a pairing code but has no TLS. Keep it on a local network or a private tailnet, never on the open internet.
- Clients on the gateway's own computer don't need the code by default. Behind a reverse proxy on the same computer, use `MARIONETTE_AUTH=strict` (see [docs/GATEWAY.md](docs/GATEWAY.md#configuration)).
- Phone screens are trusted developer content: the HTML a gateway or robot sends is not sanitized.
- Marionette doesn't decide about motion. Stop, deadman and every other safety check belong to the robot's own software.

Reports that break these assumptions are welcome. Examples: getting past the pairing code, a page on another site driving the gateway, or one phone reaching another phone's data.
