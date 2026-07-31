# OpenCodex Local Gateway Security Hardening Plan

Date: 2026-07-31

Status: P0, P1, and P2 implemented in the current working tree on 2026-07-31.

P0 verification evidence:

- `npm run build:all`: passed on Windows; the gateway compiled and the
  macOS-only companion was skipped as designed.
- `npm test`: 79/79 tests passed, including the new boundary and credential
  isolation cases.
- Isolated built-gateway smoke test: allowed health and Dashboard requests
  returned `200`; hostile Host returned `421`; hostile Origin returned `403`;
  tokenless API and Responses requests returned `401`.
- Isolated WebSocket smoke test: tokenless voice returned `401`; hostile
  Origin returned `403`; authenticated `/ws/voice` upgraded with `101`;
  authenticated unknown path returned `404`; Responses WebSocket returned
  `426`.
- `npm audit --omit=dev`: 0 known production dependency vulnerabilities.
- The isolated runtime used a temporary profile and data directory, stopped
  its exact child process, and removed the temporary credentials afterward.

P1 verification evidence:

- `npm run build:all` passed on Windows, `npm test` passed 85/85, and
  `npm audit --omit=dev --audit-level=low` reported 0 known production
  dependency vulnerabilities.
- Windows stores the four-token vault as DPAPI CurrentUser ciphertext. A
  migration test proved the legacy plaintext token is deleted only after an
  encrypted write and successful decrypt/readback.
- Admin, gateway, voice, and mobile route matrices are enforced separately
  for HTTP and WebSocket traffic.
- An isolated runtime proved all four tokens fail outside their allowed
  capabilities.
- Isolated rotations proved the new token and the previous five-minute grace
  token work for all four capabilities. Admin rotation also updates the
  HttpOnly Dashboard cookie.
- Managed Codex configuration contains only the gateway token. OpenCodexBar
  reads only the voice token, Live Picker reads only the gateway token, and
  the mobile client stores only the mobile token.
- Dashboard controls expose secure-store status, rotation, and explicit
  mobile pairing without rendering gateway, voice, or admin bearer values.
- The default Windows user profile was migrated in place after vault
  readback: the legacy plaintext file is absent, the DPAPI vault exists, and
  its serialized JSON does not contain any of the decrypted token values.
- A default-profile runtime smoke test returned `200` for health and
  Dashboard, then stopped cleanly with no listener on port `8765` and no
  remaining gateway lock file.

P2 verification evidence:

- `npm run build:all` passed on Windows. The TypeScript gateway compiled and
  the macOS-only OpenCodexBar build was skipped as designed.
- `npm test` passed 95/95, including 10 P2-specific privacy and
  defense-in-depth tests.
- `npm audit --omit=dev --audit-level=low` reported 0 known production
  dependency vulnerabilities.
- An isolated built-gateway probe verified nonce-matched CSP headers,
  `nosniff`, no-referrer, frame denial, route-specific `413` handling, and
  deletion of the exact private runtime directory after shutdown.
- Tests prove request decompression fails closed above the route limit,
  concurrency and per-minute ceilings release correctly, and failed gateway
  startup also removes its private runtime directory.
- Dashboard and visualizer HTML contain no remote icon or font dependencies.
  Imported remote session images remain inert until the user clicks the load
  control; the resulting request uses a no-referrer policy.
- Voice helper scripts and audio use random per-process directories and UUID
  filenames. Node creates `0700` directories and `0600` files on POSIX;
  OpenCodexBar applies the same permissions and cleans the directory on exit.
- Runtime Python package requirements are pinned to
  [`edge-tts==7.2.8`](https://pypi.org/project/edge-tts/),
  [`openai-whisper==20250625`](https://pypi.org/project/openai-whisper/), and
  [`silero-vad==6.2.1`](https://pypi.org/project/silero-vad/).

Remaining acceptance: the macOS Keychain and Swift source changes still need
a macOS build plus a physical voice capture/STT/model-output regression. The
iOS client also needs a device-level mobile-pairing regression through its
supported transport.

## Purpose

OpenCodex is a loopback gateway that can read local Codex credentials,
conversation history, provider configuration, and voice data. Binding to
`127.0.0.1` reduces network exposure, but it does not by itself protect the
gateway from hostile browser origins, DNS rebinding, or untrusted local
processes.

This plan closes the externally triggerable local-gateway boundary first,
then separates credentials and reduces the amount of sensitive data retained
by the runtime.

## Confirmed risks

The source audit and isolated runtime checks confirmed that:

1. Only `/api/*` was consistently protected by the administrator token.
   Responses, Realtime, backend proxy, and WebSocket surfaces did not share
   the same authorization boundary.
2. A WebSocket with no token and an untrusted `Origin` could connect to the
   catch-all voice socket.
3. The Dashboard accepted an untrusted `Host` and issued an administrator
   cookie, leaving a DNS-rebinding boundary.
4. Realtime routing could replace an empty or placeholder bearer with the
   native token read from `~/.codex/auth.json`.
5. Voice and tool logs, predictable temporary files, and remote Dashboard
   assets increased the privacy and supply-chain surface.

## Security invariants

The completed implementation must satisfy all of the following:

- Loopback binding remains mandatory.
- A loopback address is not treated as authentication.
- Every sensitive HTTP and WebSocket route is authenticated before reading a
  body, opening a local file, launching a process, or contacting an upstream.
- `Host` and browser `Origin` are validated independently of credentials.
- A local gateway credential is never forwarded to an external service.
- Missing, empty, or placeholder credentials fail closed.
- WebSocket routes are exact and purpose-specific; there is no catch-all
  upgrade handler.
- Sensitive model output is sent only to authenticated, purpose-specific
  clients.

## P0 - close the reachable boundary

P0 is the minimum required before recommending that the gateway run
continuously.

### HTTP boundary

- Accept only `127.0.0.1:<runtime-port>` and
  `localhost:<runtime-port>` as `Host`.
- Return `421 Misdirected Request` for every other authority.
- If an `Origin` header is present, allow only the current loopback origin or
  the native Codex origin `app://-`.
- Return `403 Forbidden` for every other origin.
- Protect `/api`, `/v1`, `/responses`, and `/backend-api` surfaces with the
  existing local administrator credential.
- Keep only health, local assets, and the Host/Origin-validated Dashboard and
  visualizer bootstrap public.
- Allow an explicit `X-OpenCodex-Token` local-authentication header so API
  Realtime callers can keep their upstream API key in `Authorization`.

### WebSocket boundary

- Authenticate every upgrade before routing it.
- Replace the catch-all voice socket with `/ws/voice`.
- Accept Realtime upgrades only on exact `/v1/realtime`, `/v1/audio`,
  `/v1/voice`, `/v1/live`, and `/backend-api` path families.
- Return an authenticated `426` for Responses WebSocket attempts.
- Return `404` for every other upgrade path.
- Add only authenticated `/ws/voice` clients to the voice broadcast set.
- Update OpenCodexBar to send the existing local bearer during the WebSocket
  handshake.

### Upstream credential boundary

- Empty and placeholder bearers must never select a native session.
- Strip the local cookie and `X-OpenCodex-Token` before proxying.
- Replace the local bearer with the native Codex bearer only after local
  authentication has succeeded.
- For native Responses, explicitly load the native Codex token and never
  forward the local administrator bearer.
- Fail closed when native authentication is unavailable.

### P0 compatibility matrix

| Caller | P0 authentication |
| --- | --- |
| Dashboard / visualizer | Host/Origin-validated HttpOnly same-site cookie |
| Codex Responses / native Realtime | Existing local bearer |
| API Realtime with its own API key | `X-OpenCodex-Token` plus upstream `Authorization` |
| OpenCodexBar | Existing local bearer added to `/ws/voice` handshake |
| Live Picker | Existing bearer; no protocol change |
| Mobile client | Existing bearer; no protocol change |

## P1 - separate capabilities (implemented)

P1 removes the single-token blast radius:

- `admin_token`: configuration, session management, restart, and reset.
- `gateway_token`: Responses and Realtime only.
- `voice_token`: `/ws/voice` and voice endpoints only.
- A separately paired mobile token: only the explicitly supported mobile
  routes.

The managed Codex configuration must contain only `gateway_token`.
OpenCodexBar must read only `voice_token`. Local tokens must rotate safely and
must never be used as upstream credentials.

Windows secrets must use Credential Manager or DPAPI. macOS continues to use
Keychain. No platform may silently fall back to plaintext credentials.

## P2 - privacy and defense in depth (implemented)

- Remove raw tool arguments, voice text, prompt content, and upstream bodies
  from persistent logs.
- Use per-run private temporary directories, UUID filenames, `0600` files,
  and guaranteed cleanup for voice audio.
- Move helper scripts out of predictable global `/tmp` paths.
- Pin or bundle runtime Python dependencies instead of downloading an
  unpinned package through `uvx` during production use.
- Self-host Dashboard icons and fonts.
- Add a restrictive Content Security Policy, `frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- Do not load remote images from imported sessions without explicit user
  action.
- Add route-specific size, concurrency, and rate limits.

### P2 route budgets

| Route family | Body limit | Requests/minute | Concurrent |
| --- | ---: | ---: | ---: |
| Session import | 36 MiB | 6 | 1 |
| Voice STT | 16 MiB | 30 | 2 |
| Voice TTS | 512 KiB | 90 | 3 |
| Voice prompt injection | 256 KiB | 60 | 2 |
| Provider connectivity test | 1 MiB | 20 | 2 |
| Mobile message | 512 KiB | 60 | 4 |
| Responses / Realtime HTTP | 24 MiB | 120 | 8 |
| Other administrator writes | 2 MiB | 90 | 8 |

WebSocket upgrades have separate budgets: voice allows 30 upgrades per minute
and 2 concurrent connections; Realtime allows 60 and 8; Responses attempts
allow 30 and 4 before the transport-specific response is returned.

Authentication runs before protected-route budget accounting, so an
unauthenticated local process cannot consume the legitimate client's rate or
concurrency allowance.

## P0 regression requirements

Automated tests must prove:

1. An untrusted `Host` receives `421` and no administrator cookie.
2. An untrusted browser `Origin` receives `403`.
3. Tokenless sensitive HTTP routes receive `401`.
4. A tokenless or cross-origin WebSocket upgrade is rejected.
5. `/ws/voice` accepts an authenticated native client.
6. An authenticated request to an unknown WebSocket path receives `404`.
7. Empty and placeholder bearers never select or receive a native token.
8. The local token and local cookie are absent from every upstream request.
9. The existing Dashboard, provider, model, session, Live Picker, and mobile
   contracts continue to pass.

## Delivery and acceptance

P0 is source-complete only when:

- `npm run build:all` succeeds on Windows.
- The complete Node test suite and the new negative security tests pass.
- A real isolated `npm start` rejects the previously successful hostile
  Host/Origin/WebSocket probes.
- `/health` and `/dashboard` still work from the allowed loopback authority.
- No test modifies the real user profile, Codex configuration, credentials,
  or session database.

The OpenCodexBar change additionally requires a macOS Swift build and a real
voice capture/STT/model-output regression. Windows source verification cannot
substitute for that macOS acceptance layer.

P2 does not change that platform boundary: the Node gateway is source- and
runtime-verified on Windows, while the new Swift private-runtime behavior still
requires the macOS build and physical voice regression above.
