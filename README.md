# komoot-mcp

A private MCP server that lets Claude (including the Claude mobile app) search komoot
for trails near a location and bookmark them to Filip's komoot account.

It is a standalone sibling of `home-bridge-mcp`: one plain-HTTP origin that is both an
OAuth 2.1 authorization-server facade (delegating login to Authelia) and the protected
MCP resource. TLS is terminated by Zoraxy.

## Why it looks like this

komoot has no official public API for personal use. These endpoints are the
reverse-engineered mobile API (`api.komoot.de`), confirmed empirically against a real
account. They can change without notice. Auth is HTTP Basic: `(email, password)` mints a
session token, then `(userId, token)` for every call. SSO (Google/Apple) accounts cannot
mint a token, so an email+password account is required.

## Tools

- `search_trails` — trails near a place (`near` name, geocoded via komoot's Photon, or
  `lat`/`lng`, or the server's home default). Returns ready-made routes plus nearby
  Highlights. Highlights carry a `highlight_id`.
- `bookmark_trail` — save a Highlight (`highlight_id`) to komoot Saved.
- `remove_bookmark` — un-save a Highlight.
- `list_bookmarks` — list saved Highlights.

Note: komoot only lets you bookmark Highlights, not ready-made routes, so bookmarking
targets a highlight id.

## Verified endpoints

| Purpose | Call (Basic auth `userId:token`, `Accept: application/hal+json`) |
|---|---|
| Login | `GET /v006/account/email/{email}/` -> `{username, password}` |
| Search trails | `GET /v007/discover_tours/from_location/?lat&lng&sport[&q]` |
| Nearby highlights | `GET /v006/user_highlights/?lon&lat&max_distance&items_range=0-24&srid=4326` |
| List bookmarks | `GET /v006/users/{id}/bookmarked_user_highlights/recent/?srid=4326&items_range=0-99` |
| Add bookmark | `POST /v006/users/{id}/bookmarked_user_highlights/{highlightId}` |
| Remove bookmark | `DELETE` same URL |

Geocoding: `GET https://photon.komoot.io/api/?q={place}&limit=1` (no auth).

## Run

    bun install
    cp .env.example .env   # fill in Authelia client secret + komoot creds
    bun run start          # or: bun run dev  (KOMOOT_MCP_DEV_NO_AUTH=1, no login)

Production runs under systemd on the NAS (`deploy/komoot-mcp.service`), data dir
`/var/lib/komoot-mcp`, behind Zoraxy at `komoot-mcp.filipkin.com`.

## Add to the Claude app

Settings -> Connectors -> add custom connector -> `https://komoot-mcp.filipkin.com/mcp`.
Log in through Authelia once; the app registers itself (DCR) and stores a refresh token.
