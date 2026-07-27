# VPS relay deployment

This service is a small WebSocket/APNs relay. It does not run Codex and must
not receive Codex credentials, prompts, tool arguments, or repository files.

## Install layout

Copy `server.mjs` to `/opt/opencodex-relay/server.mjs`, create the dedicated
`opencodex-relay` user, and create `/var/lib/opencodex-relay` and
`/etc/opencodex-relay`. Copy `relay.env.example` to
`/etc/opencodex-relay/relay.env`, replace every placeholder, and make that
file readable only by root and the service account as appropriate.

Install `opencodex-relay.service` into `/etc/systemd/system/`, then run:

```sh
systemctl daemon-reload
systemctl enable --now opencodex-relay
curl http://127.0.0.1:8787/health
systemctl status opencodex-relay --no-pager
```

The relay intentionally listens on loopback. Put Caddy or Nginx in front of
it once a domain is available and expose only `wss://<domain>/v1/relay`.

## Security boundary

The relay stores only pairing metadata and Live Activity push tokens. Task
events are sent as AES-GCM envelopes; the relay can route them without reading
the encrypted event body. The separate `push_state` message contains only the
minimal task-state metadata needed for an APNs update.

The current pairing format is an explicit channel/token map. QR pairing and a
user-facing pairing API are a later product layer; do not expose the relay
without replacing the example token and putting it behind TLS.
