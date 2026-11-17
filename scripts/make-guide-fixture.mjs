/**
 * Generate a GUIDE FIXTURE (XMLTV) for local demonstration and smoke tests.
 *
 * Why this file exists, stated plainly:
 *
 * - It produces **synthetic programming**, and every programme title ends with
 *   the word "demo" so no human can mistake it for a real emission.
 * - It only exists because this checkout has no downloadable guide: the guide
 *   snapshots were deliberately never committed (`data/` is git-ignored), so the
 *   live database's `programmes` are historical rows.
 * - It is **not** ingested by the normal boot path. `npm run demo` imports it
 *   only when `DEMO_SEED_GUIDE=true` in `.env`, and the documentation states
 *   that these are synthetic.
 *
 * The channel list is data-driven: it reads the published channels of the
 * database that actually have a guide alias, and asks the product's own time-zone
 * module for Madrid instants — no second implementation of day boundaries.
 *
 *   node scripts/make-guide-fixture.mjs [--out data/guide-demo.xml]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { MongoClient } from 'mongodb';
import { zonedToUtc } from '../apps/backend/src/modules/epg/epg.timezone.ts';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
/* The fixture is local working data: `data/` is git-ignored on purpose. */
const OUT = resolve(process.cwd(), outIndex >= 0 ? args[outIndex + 1] : 'data/guide-demo.xml');
const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const DB = process.env.MONGODB_DB ?? 'tdt_platform';
const CHANNELS = Number(process.env.DEMO_GUIDE_CHANNELS ?? 60);
const DAYS = Number(process.env.DEMO_GUIDE_DAYS ?? 3);

/** A short, clearly synthetic schedule; titles always end with "demo". */
const SLOTS = [
  { start: '07:00', end: '09:30', genre: 'NEWS', title: 'Informativo matinal' },
  { start: '09:30', end: '12:00', genre: 'MAGAZINE', title: 'Magacín de mañana' },
  { start: '12:00', end: '14:00', genre: 'NEWS', title: 'Boletín de mediodía' },
  { start: '14:00', end: '16:00', genre: 'MOVIE', title: 'Película de la sobremesa' },
  { start: '16:00', end: '18:00', genre: 'SERIES', title: 'Serie de la tarde' },
  { start: '18:00', end: '20:00', genre: 'SPORT', title: 'Deportes de la tarde' },
  { start: '20:00', end: '21:00', genre: 'NEWS', title: 'Informativo nocturno' },
  { start: '21:00', end: '23:00', genre: 'MOVIE', title: 'Cine de la noche' },
  { start: '23:00', end: '01:00', genre: 'SERIES', title: 'Serie de madrugada' },
];

function splitTime(value) {
  const [hour, minute] = value.split(':').map(Number);
  return { hour, minute };
}

/** Madrid local date + time → UTC instant, through the product's own module. */
function instant(day, time, timezone) {
  const { hour, minute } = splitTime(time);
  return zonedToUtc({ year: day.year, month: day.month, day: day.day, hour, minute, second: 0 }, timezone);
}

/** XMLTV dates are `YYYYMMDDHHMMSS +0000`. */
function xmltvDate(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)} +0000`;
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  const db = client.db(DB);
  const channels = await db
    .collection('channels')
    .find(
      { editorialStatus: 'published', mergedInto: null, 'aliases.namespace': 'epg' },
      { projection: { name: 1, slug: 1, timezone: 1, aliases: 1 } },
    )
    .sort({ name: 1 })
    .limit(CHANNELS)
    .toArray();
  await client.close();

  if (channels.length === 0) {
    console.error('No hay canales publicados con alias de guía: no se genera nada.');
    process.exit(1);
  }

  const today = new Date();
  const days = [];
  for (let offset = 0; offset < DAYS; offset += 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
    days.push({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() });
  }

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
  lines.push('<!-- CONTENIDO SINTÉTICO de demostración: todos los títulos terminan en "demo". -->');
  lines.push('<tv generator-info-name="tdt-platform make-guide-fixture">');

  for (const channel of channels) {
    const externalId = channel.aliases.find((alias) => alias.namespace === 'epg')?.value;
    if (!externalId) continue;
    lines.push(`  <channel id="${escapeXml(externalId)}"><display-name>${escapeXml(channel.name)}</display-name></channel>`);
  }

  const timezone = 'Europe/Madrid';
  let events = 0;
  for (const channel of channels) {
    const externalId = channel.aliases.find((alias) => alias.namespace === 'epg')?.value;
    if (!externalId) continue;
    for (const day of days) {
      for (const slot of SLOTS) {
        const start = instant(day, slot.start, timezone);
        /* The last slot ends at 01:00 of the following day. */
        const end =
          slot.end < slot.start
            ? instant({ ...day, day: day.day + 1 }, slot.end, timezone)
            : instant(day, slot.end, timezone);
        events += 1;
        lines.push(
          `  <programme channel="${escapeXml(externalId)}" start="${xmltvDate(start)}" stop="${xmltvDate(end)}">` +
            `<title>${escapeXml(`${slot.title} · ${channel.name} (demo)`)}</title>` +
            `<desc>${escapeXml('Programación sintética de demostración generada por make-guide-fixture.mjs. No es una emisión real.')}</desc>` +
            `<category>${escapeXml(slot.genre)}</category>` +
            '</programme>',
        );
      }
    }
  }
  lines.push('</tv>');

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        command: 'make-guide-fixture',
        out: OUT,
        channels: channels.filter((channel) => channel.aliases.some((alias) => alias.namespace === 'epg')).length,
        days: days.length,
        events,
        synthetic: true,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
