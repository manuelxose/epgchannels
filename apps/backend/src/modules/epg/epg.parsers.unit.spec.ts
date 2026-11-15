/**
 * Guide parsing and normalisation.
 *
 * The parsers are the boundary between a third-party feed and our store, so the
 * tests are adversarial: broken XML, missing fields, out-of-order and duplicate
 * emissions, and time zones/DST.
 */
import { describe, expect, it } from 'vitest';
import { parseJsonGuide, parseXmltv, parseXmltvDate, zonedToUtc } from './epg.parsers.js';
import { normaliseProgrammes, pickNowNext } from './epg.service.js';

const XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="La1.TV"><display-name>La 1</display-name></channel>
  <programme start="20261114200000 +0100" stop="20261114203000 +0100" channel="La1.TV">
    <title lang="es">Telediario</title>
    <desc>Informativo de la noche.</desc>
    <category>NEWS</category>
    <icon src="https://example.org/telediario.jpg" />
  </programme>
  <programme start="20261114203000 +0100" stop="20261114203000 +0100" channel="La1.TV">
    <title>Emisión nula</title>
  </programme>
  <programme start="20261114210000" stop="20261114220000" channel="La2.TV">
    <title>Sin zona (se interpreta en Europe/Madrid)</title>
  </programme>
  <programme channel="La1.TV"><title>Sin fechas</title></programme>
</tv>`;

describe('XMLTV parsing', () => {
  it('reads a programme with its metadata and rejects impossible emissions', () => {
    const result = parseXmltv(XMLTV, 'Europe/Madrid');
    // Two valid emissions; the zero-length and the dateless ones are rejected.
    expect(result.events).toHaveLength(2);
    expect(result.rejected).toBe(2);
    const first = result.events[0];
    expect(first?.title).toBe('Telediario');
    expect(first?.upstreamChannel).toBe('La1.TV');
    expect(first?.description).toBe('Informativo de la noche.');
    expect(first?.genre).toBe('NEWS');
    expect(first?.coverUrl).toBe('https://example.org/telediario.jpg');
    expect(first?.start.toISOString()).toBe('2026-11-14T19:00:00.000Z');
    expect(first?.end.toISOString()).toBe('2026-11-14T19:30:00.000Z');
  });

  it('interprets a timestamp without offset in the declared zone', () => {
    const result = parseXmltv(XMLTV, 'Europe/Madrid');
    const naive = result.events.find((event) => event.upstreamChannel === 'La2.TV');
    // 2026-11-14 21:00 Europe/Madrid is CET (UTC+1) at that date.
    expect(naive?.start.toISOString()).toBe('2026-11-14T20:00:00.000Z');
  });

  it('handles daylight-saving boundaries deterministically', () => {
    // 2026-03-29 02:30 Europe/Madrid does not exist (clocks jump to 03:00).
    const spring = parseXmltvDate('20260329023000', 'Europe/Madrid');
    expect(spring).not.toBeNull();
    // 2026-10-25 02:30 happens twice; the conversion is deterministic.
    const autumn = parseXmltvDate('20261025023000', 'Europe/Madrid');
    expect(autumn).not.toBeNull();
    expect(parseXmltvDate('20261025023000', 'Europe/Madrid')?.toISOString()).toBe(autumn?.toISOString());
  });

  it('rejects malformed timestamps and unknown zones', () => {
    expect(parseXmltvDate('not-a-date', 'Europe/Madrid')).toBeNull();
    expect(zonedToUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, 'Not/AZone')).toBeNull();
  });

  it('survives broken markup without inventing emissions', () => {
    const broken = '<tv><programme start="20260101000000" stop="20260101010000" channel="X"><title>A</title></programme>';
    const result = parseXmltv(broken, 'Europe/Madrid');
    expect(result.events).toHaveLength(1);
    expect(parseXmltv('', 'Europe/Madrid').events).toHaveLength(0);
    expect(parseXmltv('<tv><programme>', 'Europe/Madrid').events).toHaveLength(0);
  });

  it('decodes XML entities in titles', () => {
    const result = parseXmltv(
      '<tv><programme start="20260101000000" stop="20260101010000" channel="X"><title>Tom &amp; Jerry &lt;3</title></programme></tv>',
      'Europe/Madrid',
    );
    expect(result.events[0]?.title).toBe('Tom & Jerry <3');
  });
});

describe('JSON guide parsing', () => {
  const payload = {
    0: {
      name: 'La1.TV',
      events: [
        { hi: 1763150400, hf: 1763152200, t: 'Telediario', d: 'desde epoch', g: 'NEWS' },
        { hi: 1763152200, hf: 1763152200, t: 'Cero', d: '' },
        { hi: 'x', hf: 1763152200, t: 'Roto' },
      ],
    },
    1: { events: [] },
  };

  it('accepts the object shape and rejects invalid events', () => {
    const result = parseJsonGuide(payload);
    expect(result.events).toHaveLength(1);
    expect(result.rejected).toBe(3);
    expect(result.channels).toEqual(['La1.TV']);
  });

  it('accepts the same entries as an array', () => {
    const result = parseJsonGuide(Object.values(payload));
    expect(result.events).toHaveLength(1);
  });

  it('rejects a payload that is not a guide at all', () => {
    expect(parseJsonGuide(null).rejected).toBe(1);
    expect(parseJsonGuide('nope').rejected).toBe(1);
    expect(parseJsonGuide([]).rejected).toBe(1);
  });
});

describe('programme normalisation', () => {
  const base = {
    title: 'Programa',
    description: '',
    genre: null,
    coverUrl: null,
    start: new Date('2026-11-14T20:00:00Z'),
    end: new Date('2026-11-14T21:00:00Z'),
    externalKey: 'k1',
  };

  it('drops invalid windows and de-duplicates identical emissions', () => {
    const { programmes, rejected } = normaliseProgrammes([
      base,
      { ...base, externalKey: 'k2' },
      { ...base, externalKey: 'k3', end: base.start },
      { ...base, externalKey: 'k4', title: '   ' },
      { ...base, externalKey: 'k5', start: new Date('2026-11-14T19:00:00Z') },
    ]);
    expect(programmes).toHaveLength(2);
    expect(rejected).toBe(3);
    // Sorted by start.
    expect(programmes[0]?.start.toISOString()).toBe('2026-11-14T19:00:00.000Z');
  });

  it('picks the programme on air and the ones after it', () => {
    const programmes = normaliseProgrammes([
      base,
      {
        ...base,
        externalKey: 'k2',
        start: new Date('2026-11-14T21:00:00Z'),
        end: new Date('2026-11-14T22:00:00Z'),
      },
    ]).programmes.map((programme) => ({
      id: programme.externalKey,
      title: programme.title,
      description: '',
      genre: null,
      coverUrl: null,
      start: programme.start.toISOString(),
      end: programme.end.toISOString(),
    }));
    const { now, next } = pickNowNext(programmes, new Date('2026-11-14T20:30:00Z'), 5);
    expect(now?.title).toBe('Programa');
    expect(next).toHaveLength(1);
    expect(pickNowNext(programmes, new Date('2026-11-14T23:00:00Z'), 5).now).toBeNull();
  });
});
