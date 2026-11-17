# PLAYBACK-VERIFICATION — TDT-API-02E

Measured evidence for the 02E player. Every number comes from a command that was run, with
its real exit code. Nothing is derived from a render, an assertion, or a model's confidence.

**Engine under test:** hls.js 1.7.4 — the build our app ships (`apps/frontend/node_modules/hls.js`).
**Browser:** Chromium 158.0.8127.18 (Playwright 1.65.0).
**Overall status: directly measured.** This is **not** an engine-04-certified gate: that
runner cannot spawn `npm` on this host (`CreateProcessAsUserW Win32 2`), so every stage was
executed directly with its exit code recorded.

> **Correction notice (important).** An earlier revision of this document claimed that the
> raw `<video>` "native" path played 2 of 6 while hls.js played 6 of 6, and used that as the
> justification for the engine choice. **That claim was wrong.** It came from a defect in the
> measurement tool: a source whose browser axis recorded `played` was relabelled
> `http-unreachable` ("the browser could not start playback") whenever axis A (a plain fetch)
> failed to obtain a manifest. The tool has been fixed to let a demonstrated playback win, and
> the re-run below shows the native path plays **6 of 6** as well. The hls.js result stands;
> the contrast used to justify it did not.

---

## 1. Result: every sampled authorized source plays through hls.js

Command: `node evidence/02e/hls-comparison.mjs <6 urls>` → **exit 0**.
Output: `evidence/02e/hls-comparison.json`.

The six sources are **one per healthy CDN**, drawn from the 63 catalogue sources measured
`healthy` at `segments` depth in 02D. This is a **6-of-81 sample, not a census**.

| Host | Verdict | Manifest parsed | Media time advanced | Samples while running | Geometry |
|---|---|---|---|---|---|
| `ztnr.rtve.es` | `played-via-hlsjs` | 152 ms | +8.00 s | 9 | 1280×720 |
| `rtvelivestream.rtve.es` | `played-via-hlsjs` | 83 ms | +6.99 s | 8 | 1280×720 |
| `www.bloomberg.com` | `played-via-hlsjs` | 730 ms | +1.98 s | 3 | 1280×720 |
| `cdn1.etbon.eus` | `played-via-hlsjs` | 131 ms | +7.98 s | 9 | 1920×1080 |
| `rtvelivestream-rtveplayplus.rtve.es` | `played-via-hlsjs` | 98 ms | +8.00 s | 9 | 1920×1080 |
| `streaming-1.eltorotv.com` | `played-via-hlsjs` | 221 ms | +8.00 s | 9 | 1920×1080 |

Zero media errors, zero fatal errors. Summary block: `sources 6, played 6, notPlayed 0`.

**How progression is measured.** The sampler ticks once per second. Progression is the delta
between the first and last samples in which media time was **already running**
(`currentTime > 0`, `readyState ≥ 2`), so the figure means "media time advanced by N seconds
during the observation window" — it is not a DVR position difference. `bloomberg` advancing
only ~2 s over 3 samples reflects a slower start within the 9 s window, not a stall; it did
produce frames.

**The harness can now fail.** It exits non-zero if any source does not play — verified with a
nonexistent manifest: `verdict: no-frames`, **exit 1**. Previously it exited 0 regardless,
which is how one reviewer's flaky run looked green.

## 2. The native path also plays — so this is not the justification

Command: `node apps/backend/scripts/browser-playback-check.mjs --url …(same 6)` → **exit 0**.
Output: `evidence/02e/catalogue-browser-playback.json`. Summary: **played 6, failed 0**.

| Host | Axis A (fetch) | Axis B (native `<video>`) |
|---|---|---|
| `ztnr.rtve.es` | 302, no manifest | **played** — 0.12 s at 640×360 |
| `rtvelivestream.rtve.es` | 200, HLS | **played** — 0.33 s at 640×360 |
| `www.bloomberg.com` | 200, HLS | **played** — 1.76 s at 480×272 |
| `cdn1.etbon.eus` | 200, HLS | **played** — 0.92 s at 640×360 |
| `rtvelivestream-rtveplayplus.rtve.es` | 200, HLS | **played** — 0.30 s at 1920×1080 |
| `streaming-1.eltorotv.com` | 302, no manifest | **played** — 0.52 s at 1920×1080 |

Two honest observations, and no more:

1. **In this Chromium build the native path plays these streams too.** So the engine choice
   is **not** justified by "native cannot play them" — that claim is withdrawn.
2. **Axis A and axis B genuinely disagree** on the two 302 sources: a plain fetch saw no
   manifest while the media element followed it and played. This is a real reminder that
   HTTP reachability is not playback — but it says nothing against hls.js.

Why the app still uses hls.js in Chromium: it gives explicit control over ABR, buffer and
error recovery that a native element does not expose, and it is the engine that already
carries the recovery logic in this codebase. That is an engineering preference, **not** a
measurement in this document, and it is recorded here as such.

## 3. Failover only between separately authorized candidates

Proven through the **real selector** (`selectPlaybackCandidates`) on catalogue rows from
`ztnr.rtve.es`. Command `node evidence/02e/failover-proof.cjs` → **exit 0**.
Output `evidence/02e/failover-proof.json`.

**Case 1 — a failing authorized source does not win and its cause is named.**
`097a2a33…` (measured `failing`, `http-404`) and `06a4d4e8…` (measured `healthy`), both
authorized. Selected: **`["06a4d4e8…"]`** — exactly one, the healthy one. Refused:
`097a2a33…`, axis `health`, code `http-404`.

**Case 2 — an unauthorized source can never be a fallback, even at priority 1.**
A third source identical to the healthy one but with **no authorization record** and
`priority: 1`. Result: `unauthorizedAppearsAsCandidate: false`,
`unauthorizedAppearsAsRefusal: false`, selected `["06a4d4e8…"]`.

**Fixture disclosure.** The authorization records are constructed to satisfy the 02C gate
(they mirror the owner-verification records in the live database), and the health verdicts are
supplied as recorded checks rather than read from a live ledger. The **source rows and their
`http-404` cause come from the real committed 02D measurement**; the surrounding record shape
is built by the proof script. The claim being proven is the selector's ordering — that
authorization is evaluated before health and that a denial is never a candidate — and that is
a property of the code, not of the fixture.

Authorization-first failover is also confirmed by reading `decideCandidate`: it returns
`selectable: false` on denial, excludes `authorization` refusals from `refused`, and
`buildDescriptor` derives options only from `candidates`.

## 4. Mobile, keyboard and accessibility — real Chromium

Run from `apps/frontend` (the `npm --prefix … exec` form fails to resolve Playwright's
config; that is a harness quirk, not a test failure).

| Command | Exit | Result |
|---|---|---|
| `npx playwright test e2e/player-keyboard-mobile.spec.ts` | **0** | **7 passed** |
| `npx playwright test e2e/a11y-responsive.spec.ts e2e/player.spec.ts` | **0** | **22 passed** |

The seven new tests include:

- `las flechas NO desplazan la página cuando el foco está fuera del reproductor` — arrow keys
  do not hijack page scroll when focus is outside the player; asserts the page *did* scroll
  and the volume *did not* change.
- `ningún control del reproductor baja de 44x44 y la página no desborda a 360px` — real
  Chromium render at 360×740: no horizontal overflow, every visible control ≥ 44×44.
- `F entra y sale de pantalla completa, y el botón refleja el estado real` — `aria-pressed`
  flips truthfully in both directions.
- `el control de subtítulos solo aparece si la fuente los ofrece`.
- Spanish/language filters exist and filter.

The 22 pre-existing tests passing unchanged is the regression evidence: play/pause, mute
without restarting, channel switching without accumulating elements, a dead source showing an
error with retry, a non-playable channel explaining itself, and fullscreen offered only when
supported.

## 5. NOT VERIFIED — what this document does not claim

| Area | Status | Reason |
|---|---|---|
| **Subtitles** | **NOT verified end-to-end** | Wired and unit-tested, but **no playlist in the repo or the catalogue declares `EXT-X-MEDIA:TYPE=SUBTITLES`** (verified by reading every bundled `.m3u8`; the demo master has two `STREAM-INF` entries and no media groups). The E2E asserts the honest inverse. |
| **DASH** | **NOT tested** | All 81 published catalogue sources are HLS; no MPD exists. |
| **Firefox / WebKit** | **NOT measured** | Binaries **absent** (Chromium 1254 present; Firefox 1572 and WebKit 2388 absent). Installing is not authorized. Cross-engine claims limited to static capability detection. |
| **Full 63-source matrix** | **NOT measured** | A 6-source sample, one per healthy CDN. |
| **Compatibility axis** | **Populated by nothing** | `playback.service` returns an empty reproduction map, so no compatibility verdict is ever produced in the deployed path. It is declared and wired but has no data source. |
| **Buffering / stall / live-seek / PiP / Cast** | **NOT tested** | Sustained progression sampled; deliberate stall, rebuffer and seek were not exercised. |
| **YouTube engine / audio-track switching** | **NOT exercised** | Out of scope for this verification. |

## 6. What must not be read into this document

- **These are not broadcast rights.** The underlying authorizations are **owner authorizations
  for verification** (`reviewStatus: pending-review`), whose clause states they are *"not
  evidence that the emitter granted redistribution rights"*.
- **`healthy` is not `playable`.** 02D's verdict means manifest, variant and sampled segments
  were retrieved. This document measures a separate axis in a real browser.
- **A playing stream is not a guarantee.** These are timestamped observations; one catalogue
  source (`english-livebkali.cgtn.com`) returned 404 during the REA work despite an earlier
  `healthy` verdict.
