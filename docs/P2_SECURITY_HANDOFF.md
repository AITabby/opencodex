# OpenCodex P2 Security Hardening Handoff

Date: 2026-07-31  
Repository: `D:\Project\opencodex`  
Branch: `master`  
Base commit: `aea87023713566e1ad995eb2475a9992d91460da`  
Status: P2 source implementation and Windows verification complete; changes are not committed or pushed.

## Executive summary

P2 implements the privacy and defense-in-depth work defined in
`docs/SECURITY_HARDENING_PLAN.md`:

- persistent diagnostics no longer retain raw tool arguments, prompts, voice
  transcripts, credentials, or upstream response bodies;
- voice audio and generated helper files use random per-process private
  directories, UUID filenames, POSIX owner-only permissions, and bounded
  cleanup;
- runtime Python packages are pinned to exact versions;
- Dashboard and visualizer assets are local, scripts are nonce-bound by CSP,
  and imported remote images require an explicit click before loading;
- HTTP and WebSocket routes have specific body-size, request-rate, and
  concurrency ceilings.

The Node gateway is build- and runtime-verified on Windows. The Swift changes
have source-contract coverage but still require a macOS compilation and
physical voice regression before platform acceptance.

## Git and remote snapshot

At handoff time:

- local `master` points to `aea8702`;
- `fork/master` (`https://github.com/HackSing/opencodex.git`) also points to
  `aea8702`;
- upstream `origin/master` points to `6952bbc`;
- all P2 changes, including this document, remain in the working tree;
- no P2 commit or push has been performed.

Do not discard or overwrite the working tree. In particular, do not use
`git reset --hard` or checkout-based cleanup.

## Implemented work

### 1. Persistent-log privacy

New shared redaction logic lives in `src_v2/server/privacy.ts`.

It removes or masks:

- bearer tokens, API keys, cookies, passwords, OAuth tokens, and secret query
  parameters;
- JSON-form credentials;
- Cursor/native tool arguments;
- prompts, transcripts, voice text, STT/model chunks, and Semantic AEC text;
- upstream error bodies and sensitive query strings in diagnostic URLs.

Call sites in the gateway, router, upstream fetcher, credential/catalog
services, Realtime proxy, and server entrypoints now log sanitized messages or
only status/byte counts. The Swift companion applies equivalent redaction
before appending to its private log.

### 2. Private runtime storage

Node implementation: `src_v2/server/private_runtime.ts`.

- One random directory per gateway instance beneath the OS user temp root.
- Directory mode `0700` and file mode `0600` on POSIX.
- UUID audio filenames.
- Exact-root validation before recursive cleanup.
- Cleanup on normal stop, initial listen failure, lock acquisition failure,
  and helper preparation failure.
- Audio removal in `finally` paths for STT chunks, final STT, Edge TTS, and
  native `say` fallback.

Swift implementation:
`voice/OpenCodexBar/Sources/OpenCodexBar/PrivateRuntimeStorage.swift`.

- Random `OpenCodexBar-<pid>-<uuid>` directory.
- Owner-only directory and file permissions.
- Private status, log, TTS audio, dropped-file, and helper-script paths.
- Runtime directory cleanup during application termination.
- `wake_word_listener.py` discovers only same-owner, owner-only status files
  under the user's temp root, or a validated
  `OPENCODEX_VOICE_STATUS_FILE` path.

`startup.sh` no longer writes a predictable global `/tmp` log. It uses an
owner-only `~/Library/Logs/OpenCodex/startup.log` location.

### 3. Pinned voice dependencies

`VOICE_RUNTIME_PACKAGES` currently pins:

- `edge-tts==7.2.8`
- `openai-whisper==20250625`
- `silero-vad==6.2.1`

All `uvx` invocations use these exact package specifications. The former
fallback to an arbitrary system Python/Whisper installation was removed.

Important nuance: packages are version-pinned but not vendored and not pinned
by artifact hash. First use may still download the selected version through
`uvx`.

### 4. Dashboard, visualizer, and CSP

- Removed Google Fonts and remote Simple Icons dependencies.
- Provider/subscription symbols are inline or locally embedded.
- Dashboard and visualizer top-level style/script blocks receive a per-request
  CSP nonce.
- Response headers include CSP, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cross-Origin-Resource-Policy: same-origin`, and a restrictive
  `Permissions-Policy`.
- Imported HTTP(S) session images render as inert buttons. Only a user click
  creates the image request, with `referrerPolicy = no-referrer`.
- The session import picker refuses files larger than 24 MiB before upload.

Residual CSP note: `style-src 'unsafe-inline'` remains because the existing UI
uses inline style attributes and dynamically inserted style blocks. Script
execution is nonce-bound and `script-src-attr 'none'` remains enforced.

### 5. Request budgets

The policy and guard implementation is in
`src_v2/server/request_limits.ts`.

| Route family | Body limit | Requests/minute | Concurrent |
| --- | ---: | ---: | ---: |
| Session import | 36 MiB | 6 | 1 |
| Voice STT | 16 MiB | 30 | 2 |
| Voice TTS | 512 KiB | 90 | 3 |
| Voice prompt injection | 256 KiB | 60 | 2 |
| Provider connectivity test | 1 MiB | 20 | 2 |
| Mobile messages | 512 KiB | 60 | 4 |
| Responses/Realtime HTTP | 24 MiB | 120 | 8 |
| Other administrator writes | 2 MiB | 90 | 8 |

WebSocket budgets:

| Route | Upgrades/minute | Concurrent |
| --- | ---: | ---: |
| Voice | 30 | 2 |
| Realtime | 60 | 8 |
| Responses | 30 | 4 |

Protected routes authenticate before consuming their request budget, so an
unauthenticated local caller cannot exhaust the legitimate client's allowance.
Compressed request bodies are bounded by their decompressed output size and
unsupported or invalid encodings fail closed.

## Files in the P2 working set

Documentation:

- `docs/SECURITY_HARDENING_PLAN.md`
- `docs/P2_SECURITY_HANDOFF.md`

Node gateway and services:

- `src_v2/core/decompressor.ts`
- `src_v2/server/privacy.ts` (new)
- `src_v2/server/private_runtime.ts` (new)
- `src_v2/server/request_limits.ts` (new)
- `src_v2/server/gateway.ts`
- `src_v2/server/router.ts`
- `src_v2/server/webrtc_proxy.ts`
- `src_v2/server.ts`
- `src_v2/start.ts`
- `src_v2/services/upstream_fetch.ts`
- `src_v2/services/credential_store.ts`
- `src_v2/services/catalog_sync.ts`
- `src_v2/services/dashboard.ts`
- `src_v2/services/visualizer.ts`

macOS/runtime support:

- `voice/OpenCodexBar/Sources/OpenCodexBar/PrivateRuntimeStorage.swift` (new)
- `voice/OpenCodexBar/Sources/OpenCodexBar/AppDelegate.swift`
- `voice/OpenCodexBar/Sources/OpenCodexBar/StatusBarController.swift`
- `voice/OpenCodexBar/Sources/OpenCodexBar/NotchDropZoneController.swift`
- `wake_word_listener.py`
- `startup.sh`

Tests:

- `test/p2_security.test.mjs` (new)
- `test/security_contract.test.mjs`
- `test/gateway_lock.test.mjs`

## Verification evidence

The following checks passed on Windows after the final source changes:

```text
npm run build:all
PASS - gateway compiled; macOS-only OpenCodexBar skipped as designed

npm test
PASS - 95/95

npm audit --omit=dev --audit-level=low
PASS - found 0 vulnerabilities
```

The P2 test file contains 10 focused tests covering:

- private runtime path isolation, UUID naming, permissions where supported,
  exact cleanup, and refusal to access files outside the runtime root;
- exact Python dependency pins;
- credential, tool-argument, voice-content, and upstream-body redaction;
- compressed-body output limits and unsupported encodings;
- route policy mapping plus concurrency/rate release behavior;
- local Dashboard/visualizer resources and nonce placement;
- remote session-image click-to-load behavior;
- CSP directives;
- a real built-gateway start that verifies security headers, matching HTML
  nonce, a `413` body-limit response, and runtime-directory removal on stop;
- absence of predictable `/tmp` paths in voice/runtime implementations.

Additional checks:

- `wake_word_listener.py` compiled successfully with Python's built-in
  `compile()` function without importing macOS-only modules;
- `git diff --check` passed;
- the remote icon/font source audit passed;
- the only remaining `/tmp/` text match is a generated protobuf comment that
  documents sandbox default paths;
- TCP port `8765` was free at the final Windows check.

## Not yet accepted

These are platform acceptance gaps, not unimplemented P2 source items:

1. Build OpenCodexBar on macOS 13 or later.
2. Verify the private runtime directory is `0700` and files are `0600` on the
   target filesystem.
3. Verify audio/helper/dropped files disappear after playback, cancellation,
   normal quit, and failed startup.
4. Run the complete physical chain: hotkey/wake word -> microphone capture ->
   VAD -> STT -> model output -> streaming/final TTS.
5. Confirm the wake-word busy-state guard finds the current private status
   file and ignores triggers while the companion is busy.
6. Run the existing iOS/mobile-pairing device regression from the broader
   P1 acceptance plan. P2 does not modify the iOS client.

Windows cannot substitute for the AppKit/AVFoundation build or physical audio
acceptance.

## Recommended continuation

### A. Review without modifying the working tree

```powershell
cd D:\Project\opencodex
git status --short
git diff --check
git diff --stat
git diff
```

### B. Re-run Windows verification if the tree changes

```powershell
npm run build:all
npm test
npm audit --omit=dev --audit-level=low
```

### C. Run macOS source and physical acceptance

From the repository root on macOS:

```bash
npm install
npm run build:all
```

The macOS build script runs:

```bash
swift build -c release \
  --package-path voice/OpenCodexBar \
  --product OpenCodexBar
```

While OpenCodexBar is running, locate the private runtime directory beneath
`$TMPDIR`, inspect owner/mode, exercise the voice chain, then quit the app and
confirm the exact directory is gone.

### D. Commit and publish only after approval

Suggested commit subject:

```text
feat: complete P2 privacy hardening
```

The intended fork remote is `fork`, not `origin`. If publication is approved,
run the required checks again, commit the complete P2 working set, push
`master` to `fork`, and read back the exact remote head:

```powershell
git push fork master
git ls-remote fork refs/heads/master
```

Do not push to upstream `origin` unless separately authorized.

## Completion criteria for the next owner

The handoff is fully closed when:

- macOS `npm run build:all` succeeds with the Swift companion included;
- the physical voice regression passes without raw content in persistent logs
  or leftover private runtime files;
- Windows checks remain green after any macOS fixes;
- the final diff is reviewed;
- an approved commit is pushed to `fork/master` and the remote head is read
  back successfully.
