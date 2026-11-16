# TDT Platform — provenance, licences and integration conditions

This is the document the audit checks against. It states, for every class of data
the platform holds, where it came from, under which terms, and what the platform
may therefore do with it.

## 1. The rule the platform enforces

> A source is exposed only when a recorded permission allows it, its conditions
> allow it, and its owner channel is published. Availability never overrides
> authorisation.

That rule is implemented once (`apps/backend/src/modules/playback/publication-policy.ts`)
and tested from both sides: authorised-but-unhealthy is reported, healthy-but-
unlicensed is hidden.

## 2. What the platform stores, and under which terms

| Data | Origin | Licence / basis | What we may do | Attribution |
| --- | --- | --- | --- | --- |
| Channel identity (name, category, region, website) | Reference snapshot supplied by the operator, cross-checked against the emitter's own site | Apache-2.0 (reference catalogue) | Store, transform, index, expose | Required: "Datos de referencia: proyecto TDTChannels (Apache-2.0)" appears in `/channels` and `/channels/:slug` responses |
| Editorial description, taxonomy, slugs | Our editorial decision | Own work | Anything | None needed |
| Playback source URL | The emitter's own public publication | Per-source permission record | Expose only when the permission and conditions allow it | The source is presented as the emitter's signal |
| Source health | Our own verification job | Our observation | Report as a technical fact | None needed |
| Guide programmes | A guide source the operator registered | Per-source licence and attribution in `epg_sources` | Serve with the attribution | Shown with the schedule |
| Brand logo URL | The emitter | `logoSrcPermission` on the channel (`emitter`, `open-data`, `explicit-permission`, `none`) | Display only when the permission is not `none` | The logo is the emitter's mark |

### What we deliberately never do

- We never copy editorial prose from a third party. Descriptions start empty and
  are written by us.
- We never present an emitter's signal as our own content: every public payload
  names the provider and the channel is the emitter's.
- We never proxy, record, transcode or modify a signal. The browser plays the
  emitter's own address; the backend never fetches media.
- We never transmit or store credentials for a source. A source whose URL would
  need client data we refuse to synthesise is recorded as withheld
  (`credentials-required`), never rewritten.

## 3. Integration conditions recorded per source

Each `playback_source` records the conditions it was granted under:

| Field | Meaning | Effect when false |
| --- | --- | --- |
| `embedAllowed` | The emitter's terms allow embedding in our UI | The source is linked, not embedded |
| `proxyAllowed` | A server-side segment may proxy it | The backend never proxies media |
| `worldwide` / `restrictedRegions` | Geographic reach chosen by the emitter | The descriptor marks `geoRestricted` and the UI says so |
| `browserCompatibility` | Browsers that can reproduce it | Informational for the source picker |
| `requiresForgedHeader` | It needs a Referer/User-Agent we will not forge | **Never published** |
| `emitterAppOnly` | The emitter restricts it to its own application | **Never published** |
| `permission` | The modality (see below) | `unlicensed` → **never published** |

Permission modalities: `emitter-public-stream`, `emitter-embeddable`,
`official-player-only`, `open-data-licence`, `explicit-permission`, `unlicensed`.

## 4. Emitter decisions

`apps/backend/src/modules/providers/emitters.ts` lists the emitters the platform
has *decided* about, with the basis:

- `public-broadcaster` — statutory public broadcasters and public institutions
  (RTVE, 3Cat, CRTVG, EITB, RTP, SNRT, TV Perú …) publishing their own channel;
- `operator-published` — operators publishing their own linear channel on their
  own site;
- `platform-embed` — YouTube and Twitch, integrated only through the official
  player, with the emitter keeping control of the stream;
- `reference-only` — media outlets whose catalogue entry is kept but whose signal
  is never exposed;
- **everything else is `unreviewed`**: the record is stored, the source is
  drafted with permission `unlicensed`, and nothing is published until an editor
  records a decision.

An unreviewed emitter is therefore never a silent publication.

## 5. Legal positions this platform does **not** take

- It does not claim rights over any emitter's signal. The rights belong to the
  emitters, and a retirement request is implemented as an editorial action: mark
  the source `withdrawn` (kept for history, immediately invisible) or withdraw
  the channel.
- It does not claim that a public URL is a licence. A URL is integrated only under
  a recorded permission; the reference catalogue's URL for a channel is treated
  exactly like any other source.
- It does not redistribute a guide whose terms are unknown. A guide is served with
  its own licence and attribution, and only when the operator registered it with
  that basis.

## 6. What the acceptance audit must verify

1. Every public channel has provenance, and every non-editorial provenance entry
   carries an attribution.
2. No public source has permission `unlicensed`, `requiresForgedHeader` or
   `emitterAppOnly`.
3. The frontend contains no third-party data URL and makes no request to one.
4. Every excluded source has a recorded reason, and the migration report counts
   them.
