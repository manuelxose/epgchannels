# Playback parity report — TDT-CLONE-10

- Generated: 2026-11-14T18:26:08.847Z
- Catalogue snapshot: `f1ceaef3f9ffd313…` (515062 bytes)
- Channels in catalogue: **768** · audited in this run: **768**
- Playback window per channel: 10s, sequential, real Chromium

## Verdicts

| Verdict | Channels |
| --- | ---: |
| PARITY_PASS | 318 |
| EXTERNAL_ONLY | 249 |
| EVENT_ONLY | 87 |
| OUR_PLAYER_FAIL | 63 |
| RIGHTS_BLOCKED | 35 |
| GEO_RESTRICTED | 13 |
| MISCLASSIFIED | 2 |
| UNVERIFIED | 1 |

## What each verdict means

- **PARITY_PASS** — our own player decoded video and advanced media time for an authorised source.
- **OUR_PLAYER_FAIL** — an authorised in-app source exists, the player mounted, and it still did not play.
- **EXTERNAL_ONLY** — the emitter only serves it from its own player/page.
- **RIGHTS_BLOCKED** — it needs the emitter app or a Referer we do not forge.
- **EVENT_ONLY** — the catalogue marks it as an eventual emission.
- **GEO_RESTRICTED** — the publisher marks the source region-restricted.
- **ORIGINAL_UNAVAILABLE** — nothing playable is published anywhere.
- **UNVERIFIED** — evidence is insufficient to conclude.

## Observation limits

- Only channels whose published source our rules allow us to attempt are opened in the browser.
- GEO_RESTRICTED / RIGHTS_BLOCKED / EXTERNAL_ONLY / EVENT_ONLY come from published catalogue facts, not playback attempts.
- The catalogue and guide are served from the pinned snapshot because the live endpoints send no CORS headers.
- Our-player failure causes are recorded per channel; absence here is not proof a channel will work tomorrow.
