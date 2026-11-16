# TDT Platform — GuíaTV integration guide

`@tdt/api-client` is the supported way for GuíaTV to consume this platform. This
guide states what GuíaTV can rely on, what it must decide on its side, and how to
migrate without creating two identities for one channel.

## 1. What the SDK gives you

```ts
import { createGuiaTvPlaybackAdapter } from '@tdt/api-client';

const guiatv = createGuiaTvPlaybackAdapter({
  baseUrl: process.env.TDT_API_URL!,       // server-to-server, no browser secrets
  headers: { 'x-client': 'guiatv' },
});

const link = await guiatv.link('la-1');            // our slug or GuíaTV's slug
const availability = await guiatv.resolvePlayback(link!.slug);

switch (availability.selectable.kind) {
  case 'hls':      playWithHls(availability.selectable.url); break;
  case 'dash':     playWithDash(availability.selectable.url); break;
  case 'youtube':  mountOfficialPlayer(availability.selectable.url); break;
  case 'external': openOfficialPage(availability.selectable.url); break;
  case 'none':     showReason(availability.selectable.reason); break;
}
```

`resolvePlayback` never returns a URL we are not authorised to expose, and it
never turns an `external` route into in-app playback: `kind: 'external'` is the
emitter's own player, and the consumer should open it, not embed it.

## 2. Identity: one public URL per channel

The identity map (`GET /integration/guiatv/identity-map`) is the cross-reference
table:

| Field | Meaning |
| --- | --- |
| `tdtId` | Our internal UUID (never a URL segment) |
| `slug` | Our public slug |
| `guiatvSlug` | GuíaTV's own slug when already mapped |
| `match` | `alias` when mapped, `unmapped` otherwise |

**Policy (also exposed in `/integration/manifest`):**

1. When `guiatvSlug` is present, **GuíaTV's slug is the public one**; we do not
   mint a competing URL and we keep the mapping recorded on our side.
2. When it is absent, the first side to publish decides, and the other records
   the alias. Do not publish both.
3. A channel merged on our side keeps its old identifiers as `merged-from`
   aliases, so a stale link in GuíaTV resolves instead of breaking.

Mapping a channel on our side is an administrator operation (add an
`{ namespace: 'guiatv', value: '<slug>' }` alias). It is deliberately not
automatic: a wrong match would silently merge two different channels.

## 3. Server-to-server and SSR

- The SDK uses `fetch`; it works in Node, in a browser and inside Angular SSR
  without changes.
- A server-to-server deployment can be protected with `SERVICE_API_KEY_SHA256`
  (a digest, never the key itself). When it is configured, the manifest reports
  `serverToServer.requiresApiKey: true`.
- Do not ship any credential to a browser: the public API needs none, and the
  administrative API uses per-user sessions.
- If GuíaTV is offline, this platform is unaffected, and vice versa: there is no
  import, no shared database and no callback between the two.

## 4. Caching

Every public GET carries `Cache-Control` and a weak `ETag`. Send
`If-None-Match` and expect `304`: the SDK does this automatically and reuses the
body. That keeps SSR renders cheap and client navigation instant.

## 5. EPG: one guide or two?

Both projects hold a guide. Two integration options:

| Option | When it fits | Work |
| --- | --- | --- |
| GuíaTV keeps its guide and ignores ours | GuíaTV's guide is broader or better sourced | Use `playback` and `channels` only; skip `/schedule` |
| GuíaTV consumes our guide | Our sources are the ones it is licensed to serve | Map our `schedule` into GuíaTV's model; keep our `provenance` block for the attribution |

Do not run both guides *and* merge them automatically: two sources can disagree
about the same emission, and merging them silently would fabricate a schedule.
If merging is needed, do it per channel with an explicit precedence rule.

## 6. Migration checklist for GuíaTV

1. Import our channels once (`/integration/guiatv/channels`, paged) and store
   `tdtId` + `slug` against your records.
2. For every channel you already publish, record your slug as the `guiatv` alias
   on our side; do not create a second public URL.
3. Start resolving playback through `playback.get(slug)` and drive whichever
   engine the descriptor selects.
4. Keep your own `external` handling: an `external` descriptor is a link, not an
   embed.
5. Run both consumers against the same channel for a period and compare the
   descriptors before switching.

## 7. Contract stability

- The API is versioned (`/api/v1`); a breaking change ships as `/api/v2`.
- The OpenAPI 3.1 document (`openapi/openapi.json`) is generated from the same
  Zod contracts the server validates with, and the contract tests fail if a
  response stops matching them.
- Generated TypeScript types are checked in
  (`packages/api-client/src/generated/openapi-types.ts`); regenerate them with
  `npm run client:generate`.
