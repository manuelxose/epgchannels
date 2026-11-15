// Build the bundled demo fixtures in the published data schemas.
// Channels are synthetic; media is the self-generated demo HLS under /demo/media.
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('public/demo', { recursive: true });

const HOUR = 3600;

function hourFromNow(offsetHours) {
  const base = new Date();
  base.setMinutes(0, 0, 0);
  return Math.floor(base.getTime() / 1000) + offsetHours * HOUR;
}

const AMBIT = (name, channels) => ({ name, channels });

const demoChannels = {
  Generalistas: [
    {
      name: 'Demo Directo HD',
      web: 'https://example.org/demo-directo',
      epg_id: 'Demo1.TV',
      options: [
        { format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: null },
        { format: 'm3u8', url: '/demo/media/single/index.m3u8', geo2: null, res: '480p', lang: null },
      ],
      extra_info: [],
    },
    {
      name: 'Demo Alternativa',
      web: 'https://example.org/demo-alternativa',
      epg_id: 'Demo2.TV',
      options: [{ format: 'm3u8', url: '/demo/media/single/index.m3u8', geo2: null, res: '480p', lang: null }],
      extra_info: [],
    },
    {
      name: 'Demo Caída',
      web: 'https://example.org/demo-caida',
      epg_id: 'Demo3.TV',
      options: [{ format: 'm3u8', url: '/demo/media/broken/index.m3u8', geo2: null, res: null, lang: null }],
      extra_info: [],
    },
    {
      name: 'Demo Externo',
      web: 'https://example.org/demo-externo',
      epg_id: 'Demo4.TV',
      options: [],
      extra_info: ['EXTA', 'GEO'],
    },
    {
      name: 'Demo Sin Emisión',
      web: 'https://example.org/demo-noem',
      epg_id: 'Demo5.TV',
      options: [],
      extra_info: ['NOEM'],
    },
    {
      name: 'Demo Sin EPG',
      web: 'https://example.org/demo-sin-epg',
      options: [{ format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: null }],
      extra_info: [],
    },
    {
      name: 'Demo Vídeo Incompatible',
      web: 'https://example.org/demo-incompatible',
      epg_id: 'Demo6.TV',
      options: [{ format: 'stream', url: '/demo/media/broken/not-a-video.mp4', geo2: null, res: null, lang: null }],
      extra_info: [],
    },
    {
      name: 'Demo Embed Oficial',
      web: 'https://example.org/demo-embed',
      options: [{ format: 'youtube', url: 'https://www.youtube.com/watch?v=example', geo2: null, res: null, lang: null }],
      extra_info: ['EMB'],
    },
  ],
  Informativos: [
    {
      name: 'Demo 24 Horas',
      web: 'https://example.org/demo-24h',
      epg_id: 'Demo24.TV',
      options: [{ format: 'm3u8', url: '/demo/media/high/index.m3u8', geo2: null, res: '720p', lang: null }],
      extra_info: [],
    },
    {
      name: 'Demo Prensa Local',
      web: 'https://example.org/demo-prensa',
      epg_id: 'DemoPrensa.TV',
      options: [{ format: 'm3u8', url: '/demo/media/low/index.m3u8', geo2: null, res: '360p', lang: null }],
      extra_info: [],
    },
  ],
  Deportivos: [
    {
      name: 'Demo Deportes',
      web: 'https://example.org/demo-deportes',
      epg_id: 'DemoDeportes.TV',
      options: [{ format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: null }],
      extra_info: ['EVT'],
    },
    {
      name: 'Demo Motor',
      web: 'https://example.org/demo-motor',
      epg_id: 'DemoMotor.TV',
      options: [{ format: 'm3u8', url: '/demo/media/single/index.m3u8', geo2: null, res: null, lang: null }],
      extra_info: [],
    },
  ],
  Infantiles: [
    {
      name: 'Demo Infantil',
      web: 'https://example.org/demo-infantil',
      epg_id: 'DemoInfantil.TV',
      options: [{ format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: null }],
      extra_info: [],
    },
    {
      name: 'Demo Dibujos',
      web: 'https://example.org/demo-dibujos',
      epg_id: 'DemoDibujos.TV',
      options: [{ format: 'm3u8', url: '/demo/media/low/index.m3u8', geo2: null, res: null, lang: null }],
      extra_info: [],
    },
  ],
};

const autonomyChannels = {
  'Andalucía': [
    { name: 'Demo Andalucía 1', web: 'https://example.org/an1', epg_id: 'DemoAN1.TV', options: [{ format: 'm3u8', url: '/demo/media/single/index.m3u8', geo2: null, res: null, lang: null }], extra_info: ['GEO'] },
    { name: 'Demo Andalucía 2', web: 'https://example.org/an2', options: [], extra_info: ['NOEM'] },
  ],
  'Cataluña': [
    { name: 'Demo Catalunya', web: 'https://example.org/cat', epg_id: 'DemoCAT.TV', options: [{ format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: null }], extra_info: ['GEO'] },
  ],
  'Galicia': [
    { name: 'Demo Galicia TV', web: 'https://example.org/gal', epg_id: 'DemoGAL.TV', options: [{ format: 'm3u8', url: '/demo/media/low/index.m3u8', geo2: null, res: null, lang: null }], extra_info: [] },
    { name: 'Demo Galicia Alternativa', web: 'https://example.org/gal2', options: [], extra_info: ['EXTA'] },
  ],
  'País Vasco': [
    { name: 'Demo Euskadi', web: 'https://example.org/eus', epg_id: 'DemoEUS.TV', options: [{ format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: null }], extra_info: [] },
  ],
};

const international = {
  'Int. Europa': [
    { name: 'Demo Europe News', web: 'https://example.org/eu-news', epg_id: 'DemoEUNews.TV', options: [{ format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: 'en' }], extra_info: [] },
    { name: 'Demo Europe Music', web: 'https://example.org/eu-music', options: [{ format: 'youtube', url: 'https://www.youtube.com/watch?v=example', geo2: null, res: null, lang: null }], extra_info: ['EMB'] },
  ],
  'Int. América': [
    { name: 'Demo América Noticias', web: 'https://example.org/am-news', epg_id: 'DemoAMNews.TV', options: [{ format: 'm3u8', url: '/demo/media/single/index.m3u8', geo2: null, res: null, lang: 'es' }], extra_info: [] },
  ],
  Musicales: [
    { name: 'Demo Music Hits', web: 'https://example.org/music', epg_id: 'DemoMusic.TV', options: [{ format: 'm3u8', url: '/demo/media/master.m3u8', geo2: null, res: null, lang: null }], extra_info: [] },
  ],
};

const catalog = {
  license: {
    source: 'tdt-player-rebuild demo fixtures (synthetic)',
    url: 'https://example.org/license',
  },
  epg: { xml: 'demo/epg.demo.xml', 'xml.gz': 'demo/epg.demo.xml.gz', json: 'demo/epg.demo.json' },
  countries: [
    { name: 'Spain', ambits: [...Object.entries(demoChannels).map(([name, channels]) => AMBIT(name, channels)), ...Object.entries(autonomyChannels).map(([name, channels]) => AMBIT(name, channels))] },
    { name: 'International', ambits: Object.entries(international).map(([name, channels]) => AMBIT(name, channels)) },
  ],
  updated: Math.floor(Date.now() / 1000),
};

writeFileSync('public/demo/catalog.demo.json', JSON.stringify(catalog, null, 2));

// Programme guide covering -6h .. +30h for the demo channels with an epg_id.
const titles = ['Tarde en directo', 'Boletín informativo', 'Documental: mar y tierra', 'Cine de sobremesa', 'Concurso abierto', 'Magacín de tarde', 'Debate ciudadano', 'Reportaje musical'];
const genres = ['NEWS', 'CULTURE', 'FILM', 'ENTERTAINMENT', 'SPORTS', 'MUSIC'];
const epgOut = {};
let index = 0;
for (const country of catalog.countries) {
  for (const ambit of country.ambits) {
    for (const channel of ambit.channels) {
      if (!channel.epg_id) continue;
      const events = [];
      let cursor = hourFromNow(-6);
      let slot = 0;
      while (cursor < hourFromNow(30)) {
        const duration = [1800, 3600, 5400, 7200][slot % 4];
        events.push({
          hi: cursor,
          hf: cursor + duration,
          t: `${titles[(slot + index) % titles.length]} · ${channel.name}`,
          d: `Programa de demostración para ${channel.name}. Contenido sintético generado para las pruebas del reproductor.`,
          g: genres[(slot + index) % genres.length],
        });
        cursor += duration;
        slot += 1;
      }
      epgOut[String(index)] = { name: channel.epg_id, events };
      index += 1;
    }
  }
}
writeFileSync('public/demo/epg.demo.json', JSON.stringify(epgOut, null, 2));

console.log(`demo catalog: ${catalog.countries.reduce((n, c) => n + c.ambits.reduce((m, a) => m + a.channels.length, 0), 0)} channels`);
console.log(`demo epg: ${index} channels`);
