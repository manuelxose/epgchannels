# PLAYBACK-VERIFICATION — TDT-API-02E

Measured evidence for the 02E player. Every number below comes from a command that was
actually run, with its real exit code recorded. Nothing here is derived from a render, an
assertion, or a model's confidence.

**Tree measured:** `feat/tdt-api02-e-player`, base `a2a2ed3`, evidence commits `93c297c`
and `132f0e5`.
**Browser:** Chromium 158.0.8127.18 (Playwright 1.65.0). **Engine:** hls.js 1.7.4 — the
same build the app ships from `apps/frontend/node_modules/hls.js`.
**Overall status: directly measured.** This is **not** an engine-04-certified gate: that
runner cannot spawn `npm` on this host (`CreateProcessAsUserW Win32 2`), so every stage was
executed directly with its exit code recorded.

---

## 1. The headline result

**Six of six authorized catalogue sources — one per healthy CDN — play in Chromium through
hls.js, with real media progression and zero media errors.**

Command (`evidence/02e/hls-comparison.mjs`, committed): loads the shipped hls.js build in
Chromium, points it at each URL, samples once per second for ~9 s. No proxy, no forged
headers, no CORS manipulation. **Exit 0.** Output: `evidence/02e/hls-comparison.json`.

| Host | Verdict | Manifest parsed | Playing observed | Media time advanced | Geometry |
|---|---|---|---|---|---|
| `ztnr.rtve.es` | `played-via-hlsjs` | 98 ms | 1009 ms | +8.00 s | 1280×720 |
| `rtvelivestream.rtve.es` | `played-via-hlsjs` | 67 ms | 1009 ms | +8.00 s | 1280×720 |
| `www.bloomberg.com` | `played-via-hlsjs` | 104 ms | 1009 ms | +7.98 s | 1920×1080 |
| `cdn1.etbon.eus` | `played-via-hlsjs` | 118 ms | 1014 ms | +8.00 s | 1920×1080 |
| `rtvelivestream-rtveplayplus.rtve.es` | `played-via-hlsjs` | 74 ms | 1009 ms | +8.00 s | 1920×1080 |
| `streaming-1.eltorotv.com` | `played-via-hlsjs` | 312 ms | 1009 ms | +8.00 s | 1920×1080 |

Zero `MediaError`, zero fatal errors, zero network failures across all six.

**Reading the startup column honestly:** "playing observed 1009 ms" is the *first sampling
tick at which playback was already underway*, and the sampler runs at 1 Hz. So the
measured statement is **"playing within ~1.01 s of navigation"**, which is an upper bound
set by the sampling cadence, not an exact startup latency. The precise figure that *is*
measured is manifest parse time (67–312 ms). No tighter startup number is claimed.

Media progression is measured, not inferred: it is the delta between the first and last
sampled `currentTime` on the same element (≈8.0 s over ≈8.0 s of wall clock), with
`readyState` 4 throughout.

## 2. Why the engine choice is load-bearing — the contrast that matters

The same six URLs were also checked the way 02D's harness checks them: a raw `<video>`
element pointed straight at the manifest. Command
`apps/backend/scripts/browser-playback-check.mjs` → **exit 0**, output
`evidence/02e/catalogue-browser-playback.json`.

| Host | Native `<video>` verdict | hls.js verdict |
|---|---|---|
| `ztnr.rtve.es` | `http-unreachable` (HTTP 302, no manifest body) | **played** |
| `rtvelivestream.rtve.es` | `playback-failed-codec` — `MediaError 4 / DEMUXER_ERROR_COULD_NOT_PARSE` | **played** |
| `www.bloomberg.com` | `playback-failed-codec` — `MediaError 4 / DEMUXER_ERROR_COULD_NOT_PARSE` | **played** |
| `cdn1.etbon.eus` | played | **played** |
| `rtvelivestream-rtveplayplus.rtve.es` | played | **played** |
| `streaming-1.eltorotv.com` | `http-unreachable` (HTTP 302, no manifest body) | **played** |

Native summary: `played 2, failed 4`. hls.js summary: `played 6`.

**Four of six would have been reported as failures if the native path had been mistaken for
ours.** Two conclusions, both measured:

1. The two codec verdicts are **Chromium's native HLS parser being unable to demux
   MPEG-TS**, not a fault in the stream or in our player. The evidence shows the element
   reaching `readyState 4`, `videoWidth 640`, `videoHeight 360` and firing `playing` before
   the demux error — it read the metadata, then failed on the payload.
2. The two `302` verdicts are **the raw element not following the redirect**, not broken
   sources. hls.js follows it internally and plays.

So: **our player must use hls.js in Chromium**, and that selection is load-bearing rather
than decorative. Measuring the native path and calling the result "the source is broken"
would have been exactly the class of error this programme keeps finding.

## 3. Failover only between separately authorized candidates

Mission constraint: *"Support failover only between separately authorized candidates."*
Proven through the **real selector** (`selectPlaybackCandidates`) on **real catalogue rows**
from `ztnr.rtve.es`, not fixtures. Command `evidence/02e/failover-proof.cjs` → **exit 0**,
output `evidence/02e/failover-proof.json`.

**Case 1 — a failing authorized source does not win, and its cause is named.**
Sources: `097a2a33…` (measured `failing`, `http-404`) and `06a4d4e8…` (measured `healthy`),
both carrying a valid authorization.

| Observation | Value |
|---|---|
| Selected candidates | `["06a4d4e8…"]` — exactly one, the healthy one |
| `selectedIsHealthy` | **true** |
| Refused | `097a2a33…`, axis `health`, code `http-404` |

The failing source is refused **with its measured cause**, not silently dropped, and it
never becomes the selected candidate.

**Case 2 — an unauthorized source can never be a fallback, even with top priority.**
A third source was added: identical to the healthy one but **with no authorization record**
and `priority: 1` (i.e. it would sort first if authorization were not evaluated first).

| Observation | Value |
|---|---|
| `unauthorizedHasTopPriority` | true |
| Selected candidates | `["06a4d4e8…"]` — the authorized source |
| `unauthorizedAppearsAsCandidate` | **false** |
| `unauthorizedAppearsAsRefusal` | **false** |

The unauthorized source appears neither as a candidate nor as a refusal: it is not a
fallback with a reason, it is simply not a candidate. That is the fail-closed behaviour
required.

## 4. Mobile, keyboard and accessibility — real Chromium

Commands run against the built bundle at the frozen tree.

| Command | Exit | Result |
|---|---|---|
| `npx playwright test e2e/player-keyboard-mobile.spec.ts` | **0** | **7 passed** |
| `npx playwright test e2e/a11y-responsive.spec.ts e2e/player.spec.ts` | **0** | **22 passed** |

The seven new tests include the ones that matter for WCAG 2.2 and for real usability:

- `las flechas NO desplazan la página cuando el foco está fuera del reproductor` — arrow
  keys do not hijack page scroll when focus is outside the player. This is the classic
  media-player accessibility bug and it is now pinned by a test that asserts the page
  *did* scroll and the volume *did not* change.
- `ningún control del reproductor baja de 44x44 y la página no desborda a 360px` — a real
  Chromium render at 360×740 asserting no horizontal overflow and that every visible
  control's bounding box is at least 44×44.
- `F entra y sale de pantalla completa, y el botón refleja el estado real` — fullscreen
  state is truthful in both directions via `aria-pressed`.
- `el control de subtítulos solo aparece si la fuente los ofrece` — the subtitle control is
  absent when a source has no text tracks (see §5: that is the only subtitle case that can
  be exercised here).
- `los filtros de país e idioma existen y filtran de verdad` — country and language filters
  exist and actually filter.

The 22 pre-existing tests passing unchanged is the regression evidence: play/pause, mute
without restarting, channel switching without accumulating elements, a dead source showing
an error with a retry action, a non-playable channel explaining itself instead of showing a
player, wrong/internet-less channels, and fullscreen offered only when supported.

## 5. NOT VERIFIED — what this document does not claim

Stated plainly, because an honest gap is worth more than a vague success.

| Area | Status | Reason |
|---|---|---|
| **Subtitles** | **NOT verified end-to-end** | The control is wired and unit-tested, but **no playlist in the repo or the catalogue declares `EXT-X-MEDIA:TYPE=SUBTITLES`**. I checked every bundled `.m3u8` myself; the demo `master.m3u8` has two `EXT-X-STREAM-INF` entries and no media groups. The E2E therefore asserts the honest inverse (control absent when there are no tracks). Proving it needs an authored fixture playlist, clearly labelled a controlled fixture. |
| **DASH** | **NOT tested** | All 81 published catalogue sources are HLS; no MPD exists. Testing it would require a controlled dash.js scenario, not a catalogue source. |
| **Firefox / WebKit** | **NOT measured** | Binaries are **absent** from this environment (Chromium 1254 present; Firefox 1572 and WebKit 2388 absent). Installing them is not authorized by this milestone. Cross-engine claims are limited to static capability detection, which is not a playback measurement. |
| **Full 63-source matrix** | **NOT measured** | A **6-source sample, one per healthy CDN**, was measured. That covers distinct CDNs rather than 22 near-identical rows from one host, but it is a sample, not a census. |
| **Buffering / stall engineering** | **NOT tested** | Sustained progression was sampled; deliberate stall, rebuffer, live-seek, PiP and Cast were not exercised. |
| **YouTube engine** | **NOT exercised** | Out of scope for this milestone's playback verification. |
| **Audio-track switching** | **NOT verified** | Control surface exists; no stream in the catalogue was used to switch between audio tracks. |

## 6. What must not be read into this document

- **These are not broadcast rights.** The authorizations behind these sources are
  **owner authorizations for verification** (`reviewStatus: pending-review`), whose own
  clause states they are *"not evidence that the emitter granted redistribution rights"*.
  A source playing here says nothing about redistribution.
- **`healthy` is not `playable`, and this document is the proof.** 02D recorded 63 sources
  `healthy` at `segments` depth by retrieving manifest, variant and sampled segments. That
  verdict says nothing about a browser rendering them — §2 shows four of six sources that
  the *native* path refused and the hls.js path played. The two axes are measured
  separately and never derived from each other.
- **A playing stream is not a guarantee.** These are observations with timestamps. A live
  stream can drop a minute later; one catalogue source (`english-livebkali.cgtn.com`)
  returned 404 during the REA investigation despite its earlier `healthy` verdict.
