// Build reference media vectors for the 02C targets from the LOCAL TDTChannels snapshot
// (reference/data/tv.json, captured earlier by other milestones - NOT an observation of
// this run). Emits one vector per requested provider with the candidate playlist URLs and
// their tdtchannels option type. It never fetches anything; outputs are inputs to a later
// HLS probe, not playback evidence.
// usage: node build-reference-vectors.mjs <tv.json> > vectors.json
import { readFileSync } from 'node:fs';

const FILE = process.argv[2];
const doc = JSON.parse(readFileSync(FILE, 'utf8'));

const TARGETS = [
  { key: 'rtve', match: /^(La ?1|La 2|Canal 24 ?h|Teledeporte|Clan|RTVE)/i, hint: /rtve/i },
  { key: 'mediaset', match: /(Telecinco|Cuatro|Factor[ií]a|Boing|Divinity|Energy)/i, hint: /mediaset|mitele|mediasettv/i },
  { key: 'atresmedia', match: /(Antena ?3|laSexta|Neox|Nova|Mega|Atreseries)/i, hint: /atres|antena3|laSexta|a3media/i },
  { key: 'ccma_3cat', match: /(TV3|3\/24|SX3|Esport3|33 ?\b|TV3 CAT)/i, hint: /ccma|3cat|tv3/i },
  { key: 'canalsur', match: /(Canal Sur|Andaluc[ií]a TV)/i, hint: /canalsur|andaluciatv/i },
  { key: 'eitb', match: /\b(ETB|eitb)\b/i, hint: /eitb|etb/i },
  { key: 'crtvg', match: /\b(TVG|Galicia)\b/i, hint: /crtvg|tvg/i },
  { key: 'apunt', match: /(À Punt|A Punt)/i, hint: /apunt/i },
];

const channels = [];
for (const country of doc.countries ?? []) {
  for (const amb of country.ambits ?? []) {
    for (const ch of amb.channels ?? []) channels.push(ch);
  }
}

const out = [];
for (const t of TARGETS) {
  const hits = channels.filter((c) => t.match.test(c.name ?? ''));
  const options = [];
  for (const c of hits) {
    for (const o of c.options ?? []) {
      const urls = [o.url, ...(o.urls ?? [])].filter(Boolean);
      for (const u of urls) {
        const looksOfficial = t.hint.test(u);
        if (o.format === 'm3u8' || /\.m3u8(\?|$)/i.test(u)) {
          options.push({ channel: c.name, format: 'm3u8', official_hint: looksOfficial, url: u });
        }
      }
    }
  }
  const uniq = [...new Map(options.map((o) => [o.url, o])).values()];
  out.push({
    provider: t.key,
    channels_matched: hits.slice(0, 12).map((c) => ({
      name: c.name,
      web: c.web ?? null,
      epg_id: c.epg_id ?? null,
      option_types: [...new Set((c.options ?? []).map((o) => o.format))],
    })),
    m3u8_options: uniq.slice(0, 12),
    m3u8_option_count: uniq.length,
  });
}
console.log(JSON.stringify({ source: FILE, source_kind: 'local snapshot, not a live observation', vectors: out }, null, 1));
