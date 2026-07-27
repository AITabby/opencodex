# OpenCodex Mobile companion

This is the iPhone companion for the Mac gateway task-status stream and remote
conversation view. It is deliberately separate from the TypeScript gateway
and does not change Codex's native or third-party model routing.

## Generate the Xcode project

Install XcodeGen once, then run:

```sh
cd mobile
xcodegen generate
open OpenCodexMobile.xcodeproj
```

Set the Apple development team and signing profile for both targets. The
deployment target is iOS 16.2 because the ActivityKit APIs used by this
companion require it.

## Current connection boundary

The Mac gateway currently binds only to `127.0.0.1`, so an iPhone cannot
connect to 8765 directly. Do not change that bind address and do not
port-forward 8765. The direct SSE field is for Mac-side simulator/development
checks. A real iPhone uses the paired outbound relay for both live task events
and encrypted RPC calls for session lists, session details, models, and mobile
messages.

The app stores the gateway URL, relay token, and event key locally in the
device Keychain; clearing the notification pairing deletes the relay
credentials.
The event payload intentionally contains only task metadata:

```json
{
  "version": 1,
  "sequence": 12,
  "occurredAt": "2026-07-21T00:00:00.000Z",
  "taskId": "task_…",
  "sessionId": "session-…",
  "state": "running",
  "source": "native",
  "model": "gpt-5.6",
  "contextUsedTokens": 42000,
  "contextWindowTokens": 258400,
  "quotaUsedPercent": 41,
  "quotaWindowMinutes": 10080,
  "quotaResetsAt": 1785177195,
  "requiresAction": false
}
```

No prompt text, tool arguments, file contents, or API credentials are sent to
the Live Activity.

Task events also carry the selected Mac HUD theme as `petTheme`. The current
themes map to compact iPhone visuals as follows:

- `vortex`: purple sparkles/orb mark
- `siri`: cyan waveform mark

The theme is captured when a task starts, so changing the Mac theme affects
the next task without rewriting an active task's identity.

## Notification boundary

The remote notification path is outbound-only from the Mac: encrypted task
metadata goes to the relay, and the relay may forward state updates to APNs.
The phone never accepts an inbound public connection to the Mac gateway. The
payload contains state, model, timing, context usage, quota metadata, and a
short error only; it does not contain prompts, tool arguments, file contents,
or credentials. Context and quota fields are optional: native Codex rollout
events can provide them in real time, while third-party providers may report
them as unknown when their API does not expose a compatible usage endpoint.

## Relay prototype

The repository includes a minimal relay at `mobile/relay/server.mjs`. It is
intended to run behind a TLS reverse proxy on a VPS or another trusted host;
the relay itself binds to loopback by default:

```sh
RELAY_PAIRINGS_JSON='{"my-phone":"one-time-token"}' \
RELAY_REQUIRE_TLS=1 node mobile/relay/server.mjs
```

For a VPS installation, use `mobile/relay/opencodex-relay.service`,
`mobile/relay/relay.env.example`, and `mobile/relay/DEPLOY.md`. The relay can
persist only Live Activity push-token metadata under `RELAY_STATE_PATH`; it
does not persist chat text or task payloads. RPC requests and responses are
encrypted end-to-end between the Mac and phone; the VPS only forwards opaque
WebSocket frames.

Generate a 32-byte event key locally and configure the Mac gateway process:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
OPENCODEX_RELAY_URL=wss://relay.example.com/v1/relay \
OPENCODEX_RELAY_CHANNEL=my-phone \
OPENCODEX_RELAY_TOKEN=one-time-token \
OPENCODEX_RELAY_KEY=the-generated-base64url-key \
npm start
```

The same channel, token, and key are entered in the iPhone companion. This is
still a prototype pairing flow: before public deployment, add QR pairing,
keychain storage, token rotation/revocation, APNs push credentials, and a
real persistent pairing store.

To enable background Live Activity updates on the relay, configure an Apple
ActivityKit push key on the relay host:

```sh
APNS_KEY_ID=ABC123 \
APNS_TEAM_ID=DEF456 \
APNS_BUNDLE_ID=com.aitabby.opencodex.mobile \
APNS_PRIVATE_KEY_PATH=/secure/AuthKey_ABC123.p8 \
APNS_ENV=production \
RELAY_PAIRINGS_JSON='{"my-phone":"one-time-token"}' \
RELAY_REQUIRE_TLS=1 \
node mobile/relay/server.mjs
```

The relay sends only task-state metadata to APNs. If these variables are not
present, foreground encrypted WebSocket updates still work and APNs is simply
disabled.
