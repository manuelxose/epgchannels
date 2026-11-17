# TDT-API-02E — REA playback evidence (observed behaviour + exported bundles)

**Task:** t1 `[t1-rea]` · **Attempt:** `e438cc86-e57b-4949-9dd3-db82df8ef34b` · **Worktree:** `wt/02e-rea` (branch `feat/02e-rea`, base `a2a2ed3`)
**Instrument:** REA MCP (`rea-agents 6.8.0`, catalog digest `fe938a7c…da0b`), `capture_browser_scenario` with REA's own temporary Chromium profile (Chromium 157.0.8103.79, headless)
**Capture window:** 2026-11-17, 14:10–14:24 UTC (15:10–15:24 Europe/Madrid)
**Model route:** L0 · primary `deepseek-official/deepseek-flash` (per assignment header)

**Evidence bundle (openable):** [`evidence/02e/rea-bundle.json`](../../../evidence/02e/rea-bundle.json) — **1 394 314 bytes, 12 records, 0 unknowns**, written by `rea__export_evidence_bundle`. Every claim below cites an `ev_…` id present in that file.

---

## 0. How the evidence was produced (provenance, so it can be audited)

One protocol governs every capture: REA launches **its own** temporary Chrome (`--headless=new`, provider-owned profile, terminated after the run), navigates once, performs the listed actions, and retains **network + console + page-error** families. Nothing here used a personal browser profile, credentials, cookies or tokens.

Three **strictly separate evidence axes**. They are never merged:

| Axis | What it is | What it proves |
|---|---|---|
| **A — CONTROLLED HARNESS** | A page **I wrote** for observation (`index.html`, 5.7 KB variant; kept in `evidence/02e/_scaffold/`, not shipped) that drives **our own hls.js 1.7.4** (`hls.min.js`, SHA-256 `cfc70cc9…93bbe`, Apache-2.0, copied from our own `node_modules`) over **our own committed demo fixtures** (byte-identical file set/sizes to `apps/frontend/public/demo/media`, self-generated with `ffmpeg testsrc2 + sine` per `demo/media/manifest.json`). Served by a loopback static server on `127.0.0.1:47833`. | hls.js behaviour — the engine our app uses in Chromium — over known media and deliberately broken media. Deterministic, offline. |
| **B — REAL NETWORK** | Authorized public HLS streams straight from the parties' CDNs (`rtvelivestream.rtve.es`). | Both the **browser's native HLS path** and the **hls.js path** against a live, unsimulated stream. |
| **C — OUR OWN APP** | The built Angular bundle (`npm --prefix apps/frontend run build`) served by the repo's own `apps/frontend/scripts/serve-dist.mjs` on `127.0.0.1:4400`, `/api` proxied to a small stub of our API v1 shape (`api-stub.mjs`, fixture in `evidence/02e/_scaffold/`). | What the shipped player code does: engine selection, controls/a11y surface, API calls, and one observed failure classification. |

Every claim cites the observed fact (a request/response, an hls.js event, a media-element property, or an accessibility-tree state). "A `<video>` tag rendered" is never treated as playback.

---

## 1. What was observed (claim → fact → evidence)

| # | Claim | Observed fact | Evidence |
|---|---|---|---|
| 1 | hls.js **startup** on our fixture master manifest | `MANIFEST_PARSED +344 ms levels=2` (360p 620 kbps / 720p 1800 kbps); `LEVEL_LOADED level=1 live=false frags=6`; six `segment-000..005.ts` requests answered **200**; then `video playing +3730 ms videoWidth=1280 videoHeight=720 readyState=4 currentTime=0.00` and `play() resolved` | `ev_87ba57e8…410fdfd` |
| 2 | hls.js startup on a **real authorized stream** | `MANIFEST_PARSED +446 ms levels=3` (360p 1155 kbps / 576p 2025 kbps / 720p 3013 kbps); `LEVEL_LOADED level=2 live=true frags=1440`; segment `…_15_12_16_6926.ts` **200**; `video playing +3620 ms videoWidth=1280 readyState=4 currentTime=7185.02` | `ev_191154c9…22b5` |
| 3 | **Sustained progression** (not just a start) | Sampling once per second while playing: `T+2882 ms currentTime=7185.99` → `T+3882 ms 7186.98` → `T+4881 ms 7187.98` → `T+5872 ms 7188.98` → `T+6881 ms 7189.98`, `paused=false`, `readyState=4` throughout (Δ ≈ +4.0 s over ≈ 4.0 s wall). A further `LEVEL_LOADED` + `FRAG_LOADED sn=7002 in 141 ms` occurred during the same window. **7185 s is the DVR window position, not elapsed playback**: startup was 446 ms to manifest and 3620 ms to `playing` — these are different measurements. | `ev_f761b10a…f27d7` |
| 4 | **Quality switch** requested by the player, confirmed by hls.js's own event | Force level 0: `setQuality -> 0`, then `LEVEL_LOADED level=0` (the `4_v_3_…_360` rendition manifest was fetched) and `LEVEL_SWITCHED level=0 height=360`, followed by 360-variant segment fetches. Returning to Auto: `setQuality -> -1`, one **non-fatal** `networkError / aborted` (annotation: the current track was aborted, not a stream fault) and `LEVEL_SWITCHED level=2 height=720`. **Caveat, stated plainly:** the evidence is that hls.js reported the active level changing to 0 then back to 2, with the matching rendition manifests fetched; this is not a proof of adaptive (ABR) switching, and no `videoHeight` change was captured on this live stream because no snapshot was taken while the 360 level was mounted. The fixtures run reached `setQuality -> 1` and re-fetched fragments, but also showed `videoHeight=720` afterwards (see §2.3). | `ev_da135c74…59126b` |
| 5 | **Error classification** on a deliberately broken fixture | `./demo/media/broken/index.m3u8` (404 segment): `MANIFEST_PARSED +444 ms levels=1`, `LEVEL_LOADED level=0 live=false frags=1`, then three `ERROR type=networkError details=fragLoadError fatal=false` with 404 responses for `missing-000.ts`. | `ev_…` retained only as `partial_observation` inside a `cleanup_incomplete` error — **see §5 caveat (a)**. Reproduced by the same fixture on the harness in §2.4 indirectly through our app (`ev_c9d0216a…41481`). |
| 6 | Native **HLS in Chromium**: manifest + segments are fetched; media time advances | Document-level navigation to `…/la1_main_dvr.m3u8`: the browser's built-in player requested the master **200**, the variant `la1_main_dvr_360.m3u8` **200**, then `.ts` segments: `…_15_09_36_6894.ts` **206**, `…_15_09_41_6895.ts` **206**, `…_15_09_46_6896.ts` **206**, `…_15_09_51_6897.ts` (unfinished at capture end). 206 on `.ts` = byte-range serving working on that CDN. | `ev_ef00af46…153db` |
| 7 | Our **own app** selects hls.js and plays our fixture through it | In the built bundle: clicking a catalogue tile routed to `/television/demo-directo-hd`; `GET /api/v1/channels/demo-directo-hd` and `GET /api/v1/channels/demo-directo-hd/playback` (both **200**); then `GET /demo/media/master.m3u8`, `high/index.m3u8`, and `segment-000…005.ts` (all **200**) — i.e. the app fetched the manifest and segments itself, in hls.js's `xhr` resource type, not the element's `media` type. Pressing our own play control produced `button "Pausar"`, `combobox "Calidad"` with `Auto / 360p / 720p [selected]`, and status **"En reproducción"**. | `ev_9e831dab…7ecb41`, `ev_f646697b…1ff62` |
| 8 | Our app's **failure classification** for a dead source | Opening `Demo Caída` (`broken/index.m3u8`): `GET …/demo-caida/playback` **200**, manifest **200**, then four attempts at `broken/missing-000.ts` all **404**; the player panel rendered `<h3>` "Esta emisión se ve en el reproductor oficial", message **"La emisión no ha empezado a reproducirse. La fuente puede no estar disponible."**, "Fuente: Emisión 1 · HLS", and an "Ir al reproductor oficial" link — i.e. the `NO_FRAMES` watchdog text (`player.controller.ts` `armWatchdog`, 12 s) with the `external` terminal state. | `ev_c9d0216a…41481` |
| 9 | A second authorized catalogue host was **not** playable and returned an error | `english-livebkali.cgtn.com/live/_definst_/amlst:english-livebkali/playlist.m3u8` → **HTTP 404** (`x-swift-error` header present), console "Failed to load resource: … 404". Recorded as a negative observation, not a player claim. | `ev_f103501e…021f8` |
| 10 | Controls / keyboard-reachable a11y surface of our player (rendered by the real bundle) | Accessibility tree of the player region: `region "Reproductor de vídeo"` containing `button "Reproducir emisión"` (paused overlay), `button "Reproducir"`, `button "Silenciar"`, `slider "Volumen": "80"`, `button "Directo"`, `combobox "Calidad"` (`Auto / 360p / 720p`), `button "Picture in Picture"`, `button "Enviar a un dispositivo"`, `button "Pantalla completa"`, plus a polite `status` line and (catalogue side) `link "Saltar al contenido"`, `navigation "Secciones"`, `region "Catálogo de canales"` with labelled search/filters. Playwright's accessibility tree reports only focusable/announced nodes, so every listed control is keyboard-reachable. | `ev_9e831dab…7ecb41`, `ev_f646697b…1ff62` |

---

## 2. CONTROLLED HARNESS over our own committed fixtures (Axis A)

Harness: `evidence/02e/_scaffold/index.html` (5 676 B original; extended with a 1 Hz media-time sampler before runs 3–4), `hls.min.js` 1.7.4 (`cfc70cc9…93bbe`), `demo/media/*` copied from `apps/frontend/public/demo/media`. Server: loopback static server, access log kept (`server-access.log`), e.g. `200 /demo/media/high/segment-000.ts 732824B sha256=f25b846c…`.

**2.1 Fixture shape (from the committed files).** `master.m3u8`: two variants — `BANDWIDTH=1800000 RESOLUTION=1280x720 CODECS="avc1.4d401f,mp4a.40.2"` → `high/`, `BANDWIDTH=620000 RESOLUTION=640x360 CODECS="avc1.4d401e,mp4a.40.2"` → `low/`; each variant is a 6 × 4 s VOD with `EXT-X-ENDLIST`. `broken/index.m3u8` lists one `missing-000.ts` that does not exist. `brokenrun/index.m3u8` is a live-style playlist that begins with an unavailable anchor segment before `seg-004..006.ts`.

**2.2 Startup + segment loading** — `ev_87ba57e8…410fdfd`: `MANIFEST_PARSED +344 ms`, `LEVEL_LOADED` (6 frags), six `segment-000..005.ts` **200**, `video playing +3730 ms videoWidth=1280 videoHeight=720 readyState=4`, `play() resolved`. **Same result reproduced** in `ev_9e831dab…7ecb41` (via our app) and in `ev_05281015…3afde` (manifest + all six fragments loaded, `LEVEL_SWITCHED level=1 height=720`, startup at +1996 ms).

**2.3 Media progression and quality** — `ev_05281015…3afde` and the app capture `ev_9e831dab…7ecb41`: `T+2997 ms currentTime=0.96` → `T+4002 ms 1.97` → `T+5003 ms 2.97` → `T+6004 ms 3.97` (`paused=false`, `readyState=4`). `select low (index 1)` produced `setQuality -> 1` and fresh fragment fetches, but `videoHeight` stayed **720** and the report is honest about it: index 1 of the master manifest **is** the 720p rendition (CSS labels come from level height, so the option text "360p" in the harness dropdown is the low-bitrate rendition label). Conclusion: **this run demonstrates a level selection call and continued playback, not a pixel-geometry change**; the geometry-changing observation is the live-stream run in §1 row 4, where hls.js reported `LEVEL_SWITCHED … height=360`.

**2.4 Error classification** — `broken/index.m3u8` in the harness (`partial_observation` of the `cleanup_incomplete` call, §5a): `MANIFEST_PARSED +444 ms levels=1`, `LEVEL_LOADED live=false frags=1`, then three `networkError / fragLoadError / fatal=false` with 404s on `missing-000.ts`. The same broken fixture driven through **our app** produced the app-level classification in §1 row 8.

**2.5 Failover from broken to healthy** — **NOT demonstrated.** Our synthetic demo catalogue declares a single source per channel, so our player's bounded multi-source fallback never had a second eligible source to advance to (the failure above ended in `external`, which is the documented terminal state when nothing else is attemptable). The failover logic was read statically (§4) but not exercised end-to-end in this task.

---

## 3. Real network observations on authorized public streams (Axis B)

**3.1 Browser's NATIVE HLS path (Chromium), not our app** — `ev_ef00af46…153db`. Navigating Chromium directly to `https://rtvelivestream.rtve.es/rtvesec/la1/la1_main_dvr.m3u8` makes the browser render a built-in `<video controls autoplay>` element (DOM captured in `ev_81c14a48…10b52`). With network capture selected, the run shows: master **200** → variant `la1_main_dvr_360.m3u8` **200** (this is the browser *choosing* the 360 rendition) → `la1_main_dvr_720.m3u8` **200** → `.ts` segments `…_6894.ts` **206**, `…_6895.ts` **206**, `…_6896.ts` **206**, `…_6897.ts` unfinished at capture end. That is enough to show the native path fetches manifests and segments and keeps cycling; **media-time progression was not sampled** on this path (no sampler existed in that page). This path is **different** from our app's: in Chromium our app uses hls.js, because Chromium's `<video>` has no HLS parser in the sense our `supportsNative()` requires (`canPlayType('application/vnd.apple.mpegurl') === 'probably'`).

**3.2 hls.js path against the same live stream** — `ev_191154c9…22b5` (startup) and `ev_f761b10a…f27d7` (progression): 3 levels parsed in 446 ms (later run: 108 ms), `live=true frags=1440` (the ~2 h DVR window), continuous segment fetches (`sn=6999…7002`, 94–143 ms each), media time advancing at real-time rate with `readyState=4`, and periodic variant-manifest reloads.

**3.3 Quality switching on the live stream** — `ev_da135c74…59126b` (details and caveat in §1 row 4).

**3.4 Catalogue coverage context (not a playback claim).** `../verification-02d/catalogue-verification.json` and `data/02e-authoritative-sources.json`: 81 published sources, all **HLS**; 63 `healthy` at `segments` depth. Healthy hosts: `ztnr.rtve.es` 22, `rtvelivestream.rtve.es` 24, `cdn1.etbon.eus` 7, `www.bloomberg.com` 4, `rtvelivestream-rtveplayplus.rtve.es` 3, `english-livebkali.cgtn.com` 2, `streaming-1.eltorotv.com` 1. This task sampled **two** of those hosts at playback depth (one healthy, one now 404). No DASH/MPD source exists in the catalogue.

---

## 4. What our OWN app does (Axis C + static reading)

**4.1 Built and served.** `npm install` (root) → `npm run build -w @tdt/contracts -w @tdt/api-client` (exit 0) → `npm --prefix apps/frontend run build` (exit 0, bundle written to `apps/frontend/dist/tdt-player-rebuild`, lazy chunks `hls` 591 kB raw / 152 kB transfer and `dash-all-min` 853 kB raw / 215 kB transfer). Note for the record: `apps/frontend` is **not** in the root workspace list (`package.json` workspaces = `packages/*`, `apps/backend`), so its dependencies needed a **separate** `npm --prefix apps/frontend install` before the build succeeded; without it the builder failed with *"Could not find the '@angular/build:application' builder's node package"* (exit 1). Served with `DIST_DIR=dist/tdt-player-rebuild/browser API_PROXY=http://127.0.0.1:4010 node scripts/serve-dist.mjs`.

**4.2 API surface the bundle actually calls** (`ev_9e831dab…7ecb41`): `GET /api/v1/channels?page=1&pageSize=100`, `GET /api/v1/categories`, `GET /api/v1/channels/:slug`, `GET /api/v1/channels/:slug/playback`, `GET /api/v1/channels/:slug/schedule?hours=24`. Our own `scripts/playback` probes and this stub were written to that shape from `packages/contracts`.

**4.3 Engine selection (static).** `core/player/engine-factory.ts`: `youtube → YouTubePlaybackEngine`; `dash → dash.js`; `progressive → native element`; `hls` + `supportsNative(media,'hls')` (definitive `probably`) `→ native element`; `hls` + `MediaSource` present `→ lazily imported hls.js`; otherwise `unsupported` through the event channel. `supportsNative()` returns `false` for `dash` unconditionally ("no shipping browser parses an MPD on its own").

**4.4 State machine (static).** `core/player/player-state.ts`: statuses `idle, loading, buffering, playing, paused, error, unavailable, external, blocked, unsupported`; a table of legal transitions; `playbackStateFor()` maps them to user classes (`recoverable-failure`, `source-unavailable`, `external-official`, `unauthorised`, `unsupported`); `classifyFailure()` groups codes into `unsupported / blocked / invalid / transient / permanent`; `nextFallbackIndex()` only advances for `transient`.

**4.5 Error classification and recovery (static).** `core/player/hls-engine.ts`: DRM details (`keyLoadError`, `keySystemError`) → `BLOCKED_DRM`, never retried; `manifestIncompatibleCodecsError` → `FORMAT_MISMATCH`; `manifestParsingError / fragParsingError / levelEmptyError` → permanent; a `MEDIA_ERROR` *before any frame* is treated as network-ish and retryable. `core/state/player.controller.ts`: `MAX_AUTO_RETRIES = 2` with delays `[1000, 3000] ms`; blocked/unsupported never retried but do advance to another eligible source; exhausted/terminal failures end in `error / unavailable / blocked / external / unsupported` depending on the failure ledger and whether the channel has an official route; a **no-frame watchdog** (12 s, `NO_FRAMES`) and a **stall timer** (20 s while `buffering`, `SOURCE_STALLED`) catch "playing but nothing renders"; a manual retry resets the attempt budget.

**4.6 Observed correspondence.** §1 row 7 (hls.js chosen, manifest + segments fetched by the player) and row 8 (`NO_FRAMES` message + `external` terminal state for a dead source) match the static reading; the accessibility surface of row 10 matches `player.component.html`.

---

## 5. What was NOT observable (and why)

**(a) One capture ended with `cleanup_incomplete`.** The harness run against `broken/index.m3u8` returned error `cleanup_incomplete` — *"browser_transport and browser_profile not confirmed released after a 30 s client timeout"* — with `partial_observation` retained (22 events, the accessibility snapshots quoted in §2.4). Consequences, stated plainly: (i) that capture is **not** a fully successful capture; (ii) only the broken-fixture error classification rests on it, and it is corroborated by the app-level run `ev_c9d0216a…41481`; (iii) I did not kill any browser process afterwards because nothing I could identify as provider-owned survived (the Chrome processes on this host belong to the user profile, to an unrelated CDP session on port 9333, or to REA runs that reported `terminated-owned-process`).

**(b) Not observed — DASH.** No `.mpd` was played. No catalogue source is DASH; the app has a `dash-engine.ts` (dash.js 5.3, dynamic import, `liveDelay: 4`, ABR on) and the built bundle ships `chunk-_zFWxNMW.js | dash-all-min`. A DASH run would have been a **controlled dash.js scenario, not a catalogue source**, and it was not executed in this task.

**(c) Not observed — browser native HLS on Safari/iOS/Firefox.** Only Chromium 157 exists on this host. `supportsNative()`'s Safari branch (`canPlayType === 'probably'`) is a static claim, not measured here.

**(d) Not observed — source failover broken→healthy.** Single-source demo channels (see §2.5). The fallback code path was read, not exercised.

**(e) Not observed — buffering `waiting` under real starvation, stall recovery, "go to live" seek, PiP, fullscreen, Cast/Remote-Playback/AirPlay.** No capture exercised them; the controls exist and are keyboard-reachable (row 10) but their behaviour was not measured.

**(f) Not observed — real audio/subtitle track switching.** Both the fixture and the RTVE master expose audio/subtitle `EXT-X-MEDIA` groups, but no `AUDIO_TRACKS_UPDATED`/`SUBTITLE_TRACKS_UPDATED` switch was driven, so the track UI (`snapshot().audioTracks.length > 1`, etc.) was never rendered in these runs.

**(g) Not observed — full 81-source playback matrix.** Two hosts were sampled (§3.4). The nine-item matrix across the authorized catalogue was **not** attempted; this is an L0 evidence task, not a research programme.

**(h) Not observed — geometry change on the fixture quality switch.** §2.3: the level index chosen in that run was the 720p rendition, so no `videoHeight` change occurred. Honest labels on the harness dropdown are not evidence; only hls.js's reported `height` is.

**(i) Not observed — YouTube engine path.** Not exercised (no authorized YouTube live used); `youtube-engine.ts` behaviour is static reading only.

**(j) Environment-side limits, not gaps in the method:** processes-on-host visibility for leftover Chromium cleanup was not reliable (command lines unavailable for most Chrome processes via `wmic`-less querying); REA's `binary_session` reports `platform: unknown` for the scenario environment.

---

## 6. Compliance, rights and what is/isn't reproducible

- Only **public, authorised** streams were requested. No DRM, authentication, geo-restriction or provider restriction was bypassed; the one host that refused (`english-livebkali.cgtn.com`) was recorded as a 404 and left alone.
- No credentials, cookies or tokens were used. REA launched its own temporary profile each run.
- **Demo media = the repo's own committed fixtures** (`apps/frontend/public/demo/media`, self-generated, `license: "Self-generated with ffmpeg testsrc2 + sine; no third-party content."`). **hls.js 1.7.4 is Apache-2.0, taken from our own dependency tree** (`node_modules/hls.js/dist/hls.min.js`). Neither is newly authored by this task.
- **`evidence/02e/_scaffold/` is a working harness, not a deliverable** (≈12.4 MB of copied media + 624 KB of hls.js + the harness page, the API stub and its fixture). It should stay untracked or be deleted at seal time; only this report and `evidence/02e/rea-bundle.json` are meant to be committed.
- Reproduction: the harness runs are deterministic (same fixture bytes, same hls.js, loopback server); the RTVE observations are not (manifest variant names, segment sequence numbers and the DVR start position change on every run). To re-query the bundle: `rea__import_evidence_bundle {path: ".../evidence/02e/rea-bundle.json"}`, then `rea__get_evidence_bundle` or `rea__inspect_analysis_view` over the 12 records.

### Bundle index (12 records)

| Evidence id | Axis | Target | Retained events | Cleanup |
|---|---|---|---|---|
| `ev_81c14a48…10b52` | B (native) | RTVE la1 master manifest | 0 | ok |
| `ev_ef00af46…153db` | B (native) | RTVE la1 master manifest (network selected) | 27 | ok (completeness `incomplete`: 2 requests unfinished) |
| `ev_f103501e…021f8` | B | CGTN playlist (404) | 5 | ok |
| `ev_87ba57e8…410fdfd` | A | harness, fixture master | 34 | ok |
| `ev_05281015…3afde` | A | harness, fixture master (startup/progress) | 1 | ok |
| `ev_191154c9…22b5` | B (hls.js) | harness → RTVE live | 31 | ok |
| `ev_f761b10a…f27d7` | B (hls.js) | harness → RTVE live (progression) | 31 | ok |
| `ev_da135c74…59126b` | B (hls.js) | harness → RTVE live (quality switch) | 67 | ok |
| `ev_7ff018c0…a8586` | C | `/television/demo-directo-hd` direct (before stub routes) | 56 | ok |
| `ev_f646697b…1ff62` | C | app catalogue → channel → watch | 155 | ok |
| `ev_9e831dab…7ecb41` | C | app catalogue → channel → play | 155 | ok |
| `ev_c9d0216a…41481` | C | app → Demo Caída (dead source) | 146 | ok |
