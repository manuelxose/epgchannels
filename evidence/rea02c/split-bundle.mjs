// Split an exported REA Evidence bundle into per-record JSON files (one record per file),
// so each capture can be summarized independently. Never prints record contents.
// usage: node split-bundle.mjs <bundle.json> <outDir>  (outDir must be an empty/new dir)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , bundlePath, outDir] = process.argv;
const doc = JSON.parse(readFileSync(bundlePath, 'utf8'));

const candidates = [
  doc.export?.records,
  doc.records,
  doc.evidence?.records,
  doc.bundle?.records,
  doc,
];
const records = candidates.find((c) => Array.isArray(c) && c.length && (c[0]?.evidence_id || c[0]?.record?.evidence_id));
if (!records) {
  console.error(`no records array found; top-level keys: ${Object.keys(doc).join(', ')}`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: false });
const index = [];
for (const rec of records) {
  const ev = rec.evidence_id ? rec : rec.record;
  const id = ev.evidence_id;
  const op = ev.operation;
  const file = `${op}-${id.slice(3, 15)}.json`;
  writeFileSync(join(outDir, file), JSON.stringify(ev, null, 1));
  index.push({ file, evidence_id: id, operation: op });
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 1));
console.log(JSON.stringify({ records: records.length, index }, null, 1));
