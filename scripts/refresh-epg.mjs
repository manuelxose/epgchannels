#!/usr/bin/env node
/**
 * refresh-epg.mjs — actualiza la guía de programación de todos los canales.
 *
 *   node scripts/refresh-epg.mjs              # descarga + carga en MongoDB
 *   node scripts/refresh-epg.mjs --dry-run    # descarga y verifica, sin escribir
 *
 * Fuentes (catálogos públicos de guías, ninguna requiere clave):
 *   - open-epg.com       XMLTV por país
 *   - epgshare01.online  EPG mundial agregado
 *   - gatotv.com         programación CON GÉNERO por programa
 *
 * Idempotente: reejecutar reemplaza las emisiones por su clave externa
 * (`sourceId|guideId|start`), así que dos ejecuciones no duplican nada.
 * Requiere Node >= 20 y un MongoDB alcanzable en MONGODB_URI.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import process from 'node:process';
import { MongoClient } from 'mongodb';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'data', 'epg-cache');
const SOURCE_ID = 'epg-global-merged';
const DRY = process.argv.includes('--dry-run');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'es-ES,es;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** Países con fichero en open-epg (los que responden con datos reales). */
const OPEN_EPG_COUNTRIES = [
  'spain', 'germany', 'france', 'italy', 'portugal', 'poland', 'romania', 'hungary',
  'croatia', 'bulgaria', 'slovakia', 'sweden', 'netherlands', 'belgium', 'austria',
  'greece', 'israel', 'latvia', 'lithuania', 'slovenia', 'montenegro', 'iceland',
  'estonia', 'albania', 'macedonia', 'cyprus', 'canada', 'japan', 'china', 'india',
  'indonesia', 'thailand', 'australia', 'brazil', 'mexico', 'argentina', 'chile',
  'colombia', 'peru', 'uruguay', 'bolivia', 'venezuela', 'guatemala', 'honduras',
  'panama', 'dominican-republic', 'puerto-rico', 'jamaica', 'russia', 'ukraine',
  'uzbekistan', 'mongolia', 'egypt', 'morocco', 'nigeria', 'senegal', 'qatar',
  'palestine', 'pakistan', 'tanzania', 'zambia', 'zimbabwe', 'mozambique', 'macau',
  'moldova', 'korea',
];

/** Género canónico de la plataforma por cada valor que publican las fuentes. */
const GENRE_MAP = {
  Series: 'Series', Movie: 'Movie', Documentary: 'Documentary', Children: 'Children',
  Sports: 'Sports', News: 'News', Soap: 'Soap', Music: 'Music',
  programa: 'Series', pelicula: 'Movie', documental: 'Documentary', caricatura: 'Children',
  deporte: 'Sports', noticiero: 'News', telenovela: 'Soap', musica: 'Music',
};

const log = (message) => process.stdout.write(`[refresh-epg] ${message}\n`);

const decodeEntities = (value) =>
  String(value ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

async function fetchBytes(url, timeoutMs = 180_000) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ids de guía que aporta open-epg, por país. */
async function downloadOpenEpg() {
  fs.mkdirSync(CACHE, { recursive: true });
  const perCountry = new Map();
  const queue = [...OPEN_EPG_COUNTRIES];

  async function worker() {
    while (queue.length > 0) {
      const country = queue.shift();
      const cached = path.join(CACHE, `${country}.xml`);
      const fresh = fs.existsSync(cached) && Date.now() - fs.statSync(cached).mtimeMs < 6 * 3_600_000;
      try {
        const xml = fresh
          ? fs.readFileSync(cached, 'utf8')
          : zlib.gunzipSync(await fetchBytes(`https://www.open-epg.com/files/${country}.xml.gz`)).toString('utf8');
        if (!fresh) fs.writeFileSync(cached, xml);
        perCountry.set(country, xml);
      } catch (error) {
        log(`  ${country}: sin datos (${error.message})`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  log(`open-epg: ${perCountry.size} países`);
  return perCountry;
}

/** Descarga los XMLTV de iptv-epg.org (la fuente que sí publica `<category>`). */
async function downloadIptvEpg(countryCodes) {
  fs.mkdirSync(CACHE, { recursive: true });
  const perCountry = new Map();
  const queue = [...new Set(countryCodes.map((code) => code.toLowerCase()))];

  async function worker() {
    while (queue.length > 0) {
      const cc = queue.shift();
      const cached = path.join(CACHE, `iptvepg-${cc}.xml`);
      const fresh = fs.existsSync(cached) && Date.now() - fs.statSync(cached).mtimeMs < 6 * 3_600_000;
      if (fresh) {
        perCountry.set(cc, cached);
        continue;
      }
      try {
        const gz = await fetchBytes(`https://iptv-epg.org/files/epg-${cc}.xml.gz`, 600_000);
        // EEUU descomprime a ~2 GB: se guarda en disco y se lee por streaming, nunca como string único.
        await new Promise((resolve, reject) => {
          const input = zlib.createGunzip();
          const output = fs.createWriteStream(cached);
          input.on('error', reject);
          output.on('error', reject);
          output.on('finish', resolve);
          input.pipe(output);
          input.end(gz);
        });
        perCountry.set(cc, cached);
      } catch (error) {
        log(`  iptv-epg ${cc}: sin datos (${error.message})`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  log(`iptv-epg: ${perCountry.size} países`);
  return perCountry;
}

/** Extrae emisiones de un fichero XMLTV en disco, sin cargarlo entero en memoria. */
async function extractFromFile(filePath, wanted, sink, authoritative = false) {
  let buffer = '';
  const lines = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    // Solo interesado en bloques <programme>: la coincidencia se decide por el
    // `channel` del propio bloque, porque no todos los ficheros repiten <channel>.
    if (line.includes('<programme')) buffer = line;
    else if (buffer) buffer += `\n${line}`;
    if (!buffer.includes('</programme>')) continue;

    const guideId = buffer.match(/channel="([^"]+)"/)?.[1];
    if (guideId && wanted.has(guideId) && (authoritative || !sink.has(guideId))) {
      const start = buffer.match(/start="([^"]+)"/)?.[1];
      const stop = buffer.match(/stop="([^"]+)"/)?.[1];
      const title = buffer.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
      if (start && title) {
        if (authoritative) sink.delete(guideId);
        const list = sink.get(guideId) ?? [];
        const category = buffer.match(/<category[^>]*>([^<]+)<\/category>/)?.[1] ?? null;
        list.push({ start, stop: stop ?? null, title: decodeEntities(title), genre: category });
        sink.set(guideId, list);
      }
    }
    buffer = '';
  }
}

/**
 * Emisiones de las que solo importa el canal de guía y el rango.
 *
 * `authoritative` marca las fuentes que publican `<category>`: una fuente sin
 * categorías nunca debe pisar lo que otra ya aportó con género.
 */
function extractFromXml(xml, wanted, sink, authoritative = false) {
  const pattern =
    /<programme start="([^"]+)"(?: stop="([^"]+)")? channel="([^"]+)"[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>([\s\S]*?)<\/programme>/g;
  for (const match of xml.matchAll(pattern)) {
    const guideId = match[3];
    if (!wanted.has(guideId)) continue;
    if (!authoritative && sink.has(guideId)) continue;
    if (authoritative) sink.delete(guideId);
    const categories = [...(match[5] ?? '').matchAll(/<category[^>]*>([^<]+)<\/category>/g)].map((m) => m[1]);
    const list = sink.get(guideId) ?? [];
    list.push({ start: match[1], stop: match[2] ?? null, title: decodeEntities(match[4]), genre: categories[0] ?? null });
    sink.set(guideId, list);
  }
}

/** Programación con género de gatotv (tabla HTML). */
function parseGatotv(html) {
  const rows = [...html.matchAll(/<tr class="tbl_EPG_row[^"]*">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const out = [];
  for (const row of rows) {
    const times = [...row.matchAll(/<time datetime="([^"]+)">/g)].map((m) => m[1]);
    const title = row.match(/div_program_title_on_channel[\s\S]*?<span>([\s\S]*?)<\/span>/);
    const kind = row.match(/class="tbl_EPG_ProgramsColumn\s+([a-z_]+)"/);
    if (times.length < 2 || !title) continue;
    out.push({
      start: times[0],
      end: times[1],
      title: decodeEntities(title[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
      genre: kind ? kind[1] : null,
    });
  }
  return out;
}

async function downloadGatotv(guideIds) {
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const targets = [null];
  for (let day = 1; day <= 2; day += 1) {
    const date = new Date();
    date.setDate(date.getDate() + day);
    targets.push(isoDate(date));
  }

  const out = new Map();
  const queue = [...guideIds];
  async function worker() {
    while (queue.length > 0) {
      const guideId = queue.shift();
      const collected = [];
      for (const target of targets) {
        try {
          const url = target
            ? `https://www.gatotv.com/canal/${guideId}/${target}`
            : `https://www.gatotv.com/canal/${guideId}`;
          const html = (await fetchBytes(url, 30_000)).toString('utf8');
          for (const programme of parseGatotv(html)) collected.push({ ...programme, day: target });
        } catch {
          /* una cadena caída no aborta el refresco */
        }
      }
      if (collected.length > 0) out.set(guideId, collected);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  log(`gatotv: ${out.size} cadenas con género`);
  return out;
}

/** Convierte "HH:MM" del día indicado en un instante UTC. */
function instantFor(dayAnchor, hhmm, dayOffset = 0) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const date = new Date(dayAnchor);
  date.setHours(hours, minutes, 0, 0);
  if (dayOffset) date.setDate(date.getDate() + dayOffset);
  return date;
}

async function main() {
  const uri = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
  const dbName = process.env['MONGODB_DB'] ?? 'tdt_platform';

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  const db = client.db(dbName);

  try {
    // 1) Los enlaces canal -> id de guía definen qué descargar.
    const mappings = db.collection('epg_mappings');
    const confirmed = await mappings
      .find({ status: 'confirmed' }, { projection: { externalId: 1, channelId: 1 } })
      .toArray();
    const channels = db.collection('channels');
    const legacy = await channels
      .find(
        { editorialStatus: 'published', mergedInto: null, 'epg.externalId': { $ne: null } },
        { projection: { _id: 1, epg: 1 } },
      )
      .toArray();

    const guideToChannel = new Map();
    for (const row of confirmed) guideToChannel.set(row.externalId, row.channelId);
    for (const channel of legacy) {
      if (channel.epg?.externalId && !guideToChannel.has(channel.epg.externalId)) {
        guideToChannel.set(channel.epg.externalId, channel._id);
      }
    }
    log(`enlaces vigentes: ${guideToChannel.size}`);
    if (guideToChannel.size === 0) {
      log('no hay enlaces; ejecuta primero la vinculación de canales. Nada que hacer.');
      return;
    }

    // 2) Descarga de fuentes. iptv-epg va primero porque es la única que publica
    //    `<category>`, que es de donde sale el género del programa.
    const wanted = new Set(guideToChannel.keys());
    const programmes = new Map();

    const channelCountries = await channels.distinct('country', {
      editorialStatus: 'published',
      mergedInto: null,
      $or: [
        { 'epg.externalId': { $ne: null } },
        { 'aliases.namespace': 'epg' },
      ],
    });
    const iptv = await downloadIptvEpg(channelCountries.filter(Boolean));
    for (const filePath of iptv.values()) await extractFromFile(filePath, wanted, programmes, true);
    log(`iptv-epg: ${programmes.size} canales, ${[...programmes.values()].reduce((a, b) => a + b.length, 0)} emisiones`);

    // 2-bis) open-epg rellena lo que iptv-epg no cubre (sin género).
    const perCountry = await downloadOpenEpg();
    for (const [country, xml] of perCountry) {
      const filePath = path.join(CACHE, `${country}.xml`);
      if (fs.existsSync(filePath)) await extractFromFile(filePath, wanted, programmes, false);
      else extractFromXml(xml, wanted, programmes, false);
    }
    log(`open-epg: ${programmes.size} canales acumulados`);

    // 3) epgshare cubre lo que ninguna de las dos trae.
    const missing = [...wanted].filter((id) => !programmes.has(id));
    if (missing.length > 0) {
      log(`epgshare: descargando para ${missing.length} canales pendientes…`);
      const gz = await fetchBytes('https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz', 600_000);
      const pending = new Set(missing);
      let buffer = '';
      const lines = readline.createInterface({ input: zlib.createGunzip().end(gz), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.includes('<programme')) buffer = `${line}\n`;
        else if (buffer) buffer += `${line}\n`;
        if (!buffer.includes('</programme>')) continue;
        const channelId = buffer.match(/channel="([^"]+)"/)?.[1];
        if (channelId && pending.has(channelId)) {
          const start = buffer.match(/start="([^"]+)"/)?.[1];
          const stop = buffer.match(/stop="([^"]+)"/)?.[1];
          const title = buffer.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
          if (start && title) {
            const list = programmes.get(channelId) ?? [];
            list.push({ start, stop: stop ?? null, title: decodeEntities(title), genre: null });
            programmes.set(channelId, list);
          }
        }
        buffer = '';
      }
      log(`epgshare: ${programmes.size} canales acumulados`);
    }

    // 4) gatotv aporta el género, así que sus datos tienen prioridad.
    const gatotv = await downloadGatotv([...wanted]);
    const base = new Date();
    const today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    for (const [guideId, list] of gatotv) {
      const converted = [];
      for (const programme of list) {
        const [startHours, startMinutes] = programme.start.split(':').map(Number);
        const [endHours, endMinutes] = programme.end.split(':').map(Number);
        const day = programme.day
          ? new Date(...programme.day.split('-').map((part, index) => (index === 1 ? Number(part) - 1 : Number(part))))
          : today;
        const start = instantFor(day, `${pad2(startHours)}:${pad2(startMinutes)}`);
        let end = instantFor(day, `${pad2(endHours)}:${pad2(endMinutes)}`);
        if (end <= start) end = new Date(end.getTime() + 86_400_000);
        converted.push({
          start: start.toISOString(),
          stop: end.toISOString(),
          title: programme.title,
          genre: programme.genre,
        });
      }
      if (converted.length > 0) programmes.set(guideId, converted);
    }

    // 5) Materializa las emisiones.
    const now = new Date();
    const operations = [];
    let total = 0;
    for (const [guideId, list] of programmes) {
      const channelId = guideToChannel.get(guideId);
      if (!channelId) continue;
      for (const programme of list) {
        const start = parseSourceInstant(programme.start);
        const end = parseSourceInstant(programme.stop);
        if (!start || !end || end <= start) continue;
        operations.push({
          updateOne: {
            filter: { externalKey: `${SOURCE_ID}|${guideId}|${start.toISOString()}` },
            update: {
              $set: {
                channelId,
                sourceId: SOURCE_ID,
                externalKey: `${SOURCE_ID}|${guideId}|${start.toISOString()}`,
                title: programme.title,
                description: '',
                genre: genreOf(programme.genre),
                coverUrl: null,
                start,
                end,
                duplicateOf: null,
                updatedAt: now,
              },
              $setOnInsert: { createdAt: now, editedAt: null },
            },
            upsert: true,
          },
        });
        total += 1;
      }
    }

    log(`emisiones preparadas: ${total} en ${programmes.size} canales`);
    if (DRY) {
      log('dry-run: sin cambios en la base.');
      return;
    }

    const collection = db.collection('programmes');
    for (let index = 0; index < operations.length; index += 2_000) {
      await collection.bulkWrite(operations.slice(index, index + 2_000), { ordered: false });
    }

    // 6) Retira lo que ya terminó para que la guía no crezca sin límite.
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    const pruned = await collection.deleteMany({ sourceId: SOURCE_ID, end: { $lt: cutoff } });

    await db.collection('epg_sources').updateOne(
      { _id: SOURCE_ID },
      {
        $set: {
          name: 'Guía global de programación',
          kind: 'xmltv',
          url: 'https://www.open-epg.com/',
          licence: 'public-aggregated',
          attribution: 'Programación: open-epg.com, epgshare01.online y gatotv.com (catálogos públicos de guías).',
          status: 'published',
          lastRunAt: now,
          lastRunStatus: 'ok',
          lastRunProgrammes: total,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now, ingestionEnabled: false },
      },
      { upsert: true },
    );

    log(`listo: ${total} emisiones escritas, ${pruned.deletedCount} antiguas retiradas`);
  } finally {
    await client.close();
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYYMMDDHHmmSS +ZZZZ` (XMLTV) o ISO -> Date. */
function parseSourceInstant(value) {
  if (!value) return null;
  const xmltv = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2})(\d{2})$/.exec(String(value).trim());
  if (xmltv) {
    const [, year, month, day, hour, minute, second = '00', offsetHours, offsetMinutes] = xmltv;
    const utc = Date.UTC(
      Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
    );
    const offset = (offsetHours === '-00' ? 0 : Number(offsetHours)) * 60 + (offsetHours.startsWith('-') ? -Number(offsetMinutes) : Number(offsetMinutes));
    return new Date(utc - offset * 60_000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function genreOf(raw) {
  if (!raw) return null;
  return GENRE_MAP[raw] ?? GENRE_MAP[String(raw).toLowerCase()] ?? null;
}

await main();
