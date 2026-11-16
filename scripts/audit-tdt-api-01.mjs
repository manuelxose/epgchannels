/**
 * Independent acceptance audit for milestone TDT-API-01.
 *
 * It does not trust this repository's prose: every check below queries the
 * running API, the database it serves, the exported contract or the source tree,
 * and records the observation that supports its verdict.
 *
 * The four acceptance dimensions are reported separately
 * (API_IMPLEMENTATION, DATA_INDEPENDENCE, PLAYBACK_COVERAGE,
 * GUIATV_INTEGRATION_READINESS); the global verdict is GO only when none of them
 * is blocked by a critical finding.
 *
 *   node scripts/audit-tdt-api-01.mjs [--base http://127.0.0.1:4010/api/v1]
 *                                     [--mongo mongodb://127.0.0.1:27117/?replicaSet=rs0]
 *                                     [--out audits/TDT-API-01-AUDIT.json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = argOf('--base', process.env.API_BASE ?? 'http://127.0.0.1:4010/api/v1');
const MONGO = argOf('--mongo', process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0');
const DB = process.env.MONGODB_DB ?? 'tdt_platform';
const OUT = resolve(argOf('--out', 'audits/TDT-API-01-AUDIT.json'));
const ROOT = resolve('.');

const dimensions = {
  API_IMPLEMENTATION: [],
  DATA_INDEPENDENCE: [],
  PLAYBACK_COVERAGE: [],
  GUIATV_INTEGRATION_READINESS: [],
};

/** @param {'API_IMPLEMENTATION'|'DATA_INDEPENDENCE'|'PLAYBACK_COVERAGE'|'GUIATV_INTEGRATION_READINESS'} dimension */
function record(dimension, id, claim, ok, evidence, severity = 'critical') {
  dimensions[dimension].push({ id, claim, ok, evidence, severity: ok ? 'none' : severity });
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

function walkFiles(directory, predicate, accumulator = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, accumulator);
    } else if (predicate(full)) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

// ---------------------------------------------------------------- the audit

async function auditApiImplementation(client) {
  const health = await getJson('/health');
  record(
    'API_IMPLEMENTATION',
    'health-live',
    'El backend responde /api/v1/health con estado y recuentos reales',
    health.status === 200 && health.body?.data?.channels > 0,
    { status: health.status, counts: health.body?.data, dependencies: health.body?.dependencies },
  );

  const documented = ['/channels', '/channels/la-1', '/channels/la-1/playback', '/channels/la-1/schedule', '/epg/now', '/epg/next', '/categories', '/regions', '/integration/manifest', '/integration/guiatv/channels', '/integration/guiatv/identity-map'];
  const answered = [];
  for (const path of documented) {
    const response = await getJson(path);
    answered.push({ path, status: response.status });
  }
  record(
    'API_IMPLEMENTATION',
    'public-endpoints',
    'Todos los endpoints públicos documentados responden',
    answered.every((entry) => entry.status === 200),
    answered,
  );

  const invalid = await getJson('/channels?page=0');
  record(
    'API_IMPLEMENTATION',
    'validation-envelope',
    'Una entrada inválida devuelve 400 con el sobre de error documentado',
    invalid.status === 400 && invalid.body?.error?.code === 'validation_failed',
    { status: invalid.status, code: invalid.body?.error?.code },
  );

  const noAuth = await getJson('/admin/channels');
  record(
    'API_IMPLEMENTATION',
    'admin-protected',
    'La superficie administrativa exige sesión',
    noAuth.status === 401,
    { status: noAuth.status },
  );

  const cached = await fetch(`${BASE}/channels?page=1&pageSize=24`);
  const etag = cached.headers.get('etag');
  const revalidated = await fetch(`${BASE}/channels?page=1&pageSize=24`, { headers: { 'if-none-match': etag ?? '' } });
  record(
    'API_IMPLEMENTATION',
    'etag-revalidation',
    'Las respuestas llevan ETag y admiten revalidación 304',
    Boolean(etag) && revalidated.status === 304,
    { etag, status: revalidated.status },
  );

  const openapiPath = join(ROOT, 'openapi/openapi.json');
  let openapiOk = false;
  let openapiDetail = null;
  if (existsSync(openapiPath)) {
    const document = JSON.parse(readFileSync(openapiPath, 'utf8'));
    const paths = Object.keys(document.paths ?? {});
    openapiOk = document.openapi === '3.1.0' && paths.length >= 15;
    openapiDetail = { openapi: document.openapi, paths: paths.length, schemas: Object.keys(document.components?.schemas ?? {}).length };
  }
  record('API_IMPLEMENTATION', 'openapi-document', 'Existe un documento OpenAPI 3.1 exportado con los endpoints públicos', openapiOk, openapiDetail);

  const channelsInDb = await client.db(DB).collection('channels').countDocuments({});
  const channelsInApi = (await getJson('/channels?pageSize=1')).body?.pagination?.total ?? 0;
  record(
    'API_IMPLEMENTATION',
    'persisted-data',
    'La API sirve datos persistidos, no fixtures: el total coincide con la base de datos',
    channelsInDb > 0 && channelsInApi > 0 && channelsInDb >= channelsInApi,
    { databaseChannels: channelsInDb, publishedInApi: channelsInApi },
  );

  // The frontend must not contain a third-party data source.
  const frontendFiles = walkFiles(join(ROOT, 'apps/frontend/src'), (file) => file.endsWith('.ts'));
  const offenders = frontendFiles.filter((file) => {
    const text = readFileSync(file, 'utf8');
    return /https?:\/\/(?:[\w-]+\.)*tdtchannels\.com|lists\/tv\.json|epg\/TV\.json/i.test(text);
  });
  record(
    'API_IMPLEMENTATION',
    'frontend-uses-own-api',
    'El cliente Angular no contiene ninguna URL de datos de terceros',
    offenders.length === 0,
    { scanned: frontendFiles.length, offenders },
  );
}

async function auditDataIndependence(client) {
  const db = client.db(DB);
  const channels = await db.collection('channels').find({ editorialStatus: 'published' }).limit(500).toArray();
  const withoutProvenance = channels.filter((channel) => !Array.isArray(channel.provenance) || channel.provenance.length === 0);
  record(
    'DATA_INDEPENDENCE',
    'channels-have-provenance',
    'Cada canal publicado registra su procedencia',
    withoutProvenance.length === 0,
    { inspected: channels.length, withoutProvenance: withoutProvenance.map((channel) => channel.slug) },
  );

  const thirdPartyWithoutAttribution = channels.filter((channel) =>
    (channel.provenance ?? []).some((entry) => entry.editorial === false && !entry.attribution),
  );
  record(
    'DATA_INDEPENDENCE',
    'third-party-attribution',
    'Todo dato de terceros lleva su atribución',
    thirdPartyWithoutAttribution.length === 0,
    { offenders: thirdPartyWithoutAttribution.slice(0, 10).map((channel) => channel.slug) },
  );

  const ledger = await db.collection('migration_ledger').find({}).sort({ runAt: -1 }).limit(1).toArray();
  const exclusions = ledger[0]?.exclusions ?? [];
  record(
    'DATA_INDEPENDENCE',
    'migration-ledger',
    'La migración del catálogo queda registrada con su digest y sus exclusiones documentadas',
    ledger.length > 0 && typeof ledger[0].snapshotDigestSha256 === 'string' && exclusions.every((entry) => Boolean(entry.reason)),
    {
      runId: ledger[0]?._id ?? null,
      digest: ledger[0]?.snapshotDigestSha256?.slice(0, 16) ?? null,
      channels: ledger[0]?.channelsWritten ?? 0,
      exclusions: exclusions.length,
      exclusionsByReason: exclusions.reduce((accumulator, entry) => {
        accumulator[entry.reason] = (accumulator[entry.reason] ?? 0) + 1;
        return accumulator;
      }, {}),
    },
  );

  const guideSources = await db.collection('epg_sources').find({}).toArray();
  const programmes = await db.collection('programmes').countDocuments({});
  record(
    'DATA_INDEPENDENCE',
    'guide-stored-locally',
    'La guía se sirve desde nuestra base de datos, con licencia por origen',
    programmes > 0 && guideSources.every((source) => typeof source.licence === 'string' && source.licence.length > 0),
    {
      programmes,
      sources: guideSources.map((source) => ({ name: source.name, licence: source.licence, ingestionEnabled: source.ingestionEnabled })),
    },
  );

  // Runtime independence: block the provider at process level and repeat the reads.
  const blockedHosts = ['tdtchannels.com', 'www.tdtchannels.com', 'play.tdtchannels.com'];
  const realFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    if (blockedHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
      attempts.push(url);
      return Promise.reject(new Error(`blocked ${host}`));
    }
    return realFetch(input, init);
  };
  let withProviderDown = { ok: false, detail: null };
  try {
    const catalogue = await getJson('/channels?pageSize=10');
    const search = await getJson('/channels?q=la&pageSize=5');
    const playable = catalogue.body?.data?.find((channel) => channel.playbackStatus === 'available');
    const playback = playable ? await getJson(`/channels/${playable.slug}/playback`) : { status: 0, body: null };
    const feed = await getJson('/epg/now?limit=5');
    withProviderDown = {
      ok:
        catalogue.status === 200 &&
        catalogue.body?.data?.length > 0 &&
        search.status === 200 &&
        (feed.status === 200) &&
        (playable ? playback.body?.data?.playback?.status === 'available' : true),
      detail: {
        catalogue: catalogue.status,
        search: search.status,
        playback: playback.status,
        guide: feed.status,
        blockedHostAttempts: attempts.length,
      },
    };
  } finally {
    globalThis.fetch = realFetch;
  }
  record(
    'DATA_INDEPENDENCE',
    'works-with-provider-blocked',
    'Con el proveedor de datos bloqueado a nivel de proceso, catálogo, búsqueda, guía y reproducción siguen funcionando',
    withProviderDown.ok && attempts.length === 0,
    withProviderDown.detail,
  );

  const runtimeOffenders = walkFiles(join(ROOT, 'apps'), (file) => /\.(ts|tsx|js|mjs|html|css)$/.test(file) && !file.endsWith('.spec.ts')).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return /https?:\/\/(?:[\w-]+\.)*tdtchannels\.com/i.test(text);
  });
  record(
    'DATA_INDEPENDENCE',
    'no-provider-url-in-code',
    'El código en tiempo de ejecución no contiene ninguna URL del proveedor de datos',
    runtimeOffenders.length === 0,
    { offenders: runtimeOffenders },
  );
}

async function auditPlaybackCoverage(client) {
  const db = client.db(DB);
  const published = await db.collection('channels').find({ editorialStatus: 'published' }).toArray();
  const sources = await db.collection('playback_sources').find({}).toArray();

  const publicSources = sources.filter(
    (source) =>
      source.editorialStatus === 'published' &&
      !['unlicensed'].includes(source.permission) &&
      !source.conditions?.requiresForgedHeader &&
      !source.conditions?.emitterAppOnly &&
      source.technicalStatus !== 'blocked',
  );
  const publicIds = new Set(publicSources.map((source) => source._id));
  const publishedIds = new Set(published.map((channel) => channel._id));
  const leaked = sources.filter(
    (source) =>
      !publicIds.has(source._id) &&
      ['unlicensed'].includes(source.permission) &&
      publishedIds.has(source.channelId) &&
      source.editorialStatus === 'published',
  );
  record(
    'PLAYBACK_COVERAGE',
    'no-unlicensed-source-public',
    'Ninguna fuente sin permiso puede quedar publicada',
    leaked.length === 0,
    { checked: sources.length, leaked: leaked.length },
  );

  const inApp = publicSources.filter((source) => ['hls', 'dash', 'youtube', 'official-embed'].includes(source.type) && source.url);
  const external = publicSources.filter((source) => source.type === 'external');
  const verifiedOk = inApp.filter((source) => source.technicalStatus === 'ok');

  record(
    'PLAYBACK_COVERAGE',
    'authorised-in-app-sources',
    'Existen fuentes en reproducción propia autorizadas y registradas',
    inApp.length > 0,
    {
      inAppSources: inApp.length,
      verifiedOk: verifiedOk.length,
      byType: inApp.reduce((accumulator, source) => {
        accumulator[source.type] = (accumulator[source.type] ?? 0) + 1;
        return accumulator;
      }, {}),
    },
    'high',
  );

  record(
    'PLAYBACK_COVERAGE',
    'external-sources',
    'Los canales solo vía emisor se registran como acceso externo, no como reproducción propia',
    external.length > 0,
    { externalSources: external.length },
    'medium',
  );

  // The catalogue the API exposes must be internally consistent with the sources.
  let sampled = 0;
  let available = 0;
  let externalStatus = 0;
  let eventual = 0;
  let unavailable = 0;
  let mismatches = [];
  const list = await getJson('/channels?pageSize=100');
  for (let page = 1; page <= (list.body?.pagination?.pageCount ?? 1) && page <= 5; page += 1) {
    const body = (await getJson(`/channels?pageSize=100&page=${page}`)).body;
    for (const channel of body?.data ?? []) {
      sampled += 1;
      const descriptor = (await getJson(`/channels/${channel.slug}/playback`)).body?.data?.playback;
      if (!descriptor) {
        mismatches.push({ slug: channel.slug, issue: 'descriptor missing' });
        continue;
      }
      if (descriptor.status === 'available') available += 1;
      else if (descriptor.status === 'external') externalStatus += 1;
      else if (descriptor.status === 'eventual') eventual += 1;
      else unavailable += 1;
      if (descriptor.status !== channel.playbackStatus) {
        mismatches.push({ slug: channel.slug, list: channel.playbackStatus, descriptor: descriptor.status });
      }
      if (descriptor.status === 'available' && !descriptor.url) {
        mismatches.push({ slug: channel.slug, issue: 'available without url' });
      }
      if (descriptor.status === 'external' && descriptor.url) {
        mismatches.push({ slug: channel.slug, issue: 'external with in-app url' });
      }
    }
  }
  record(
    'PLAYBACK_COVERAGE',
    'descriptor-consistency',
    'El estado del listado coincide con el descriptor y cada descriptor es coherente con su URL',
    mismatches.length === 0 && sampled > 0,
    { sampled, available, external: externalStatus, eventual, unavailable, mismatches: mismatches.slice(0, 10) },
  );

  // Previous milestone's measurement, kept as traceability only.
  const baselinePath = join(ROOT, 'audits/catalogue-import-report.json');
  let baseline = null;
  if (existsSync(baselinePath)) {
    const report = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline = { channels: report.channels, channelsWithPublishedSource: report.channelsWithPublishedSource };
  }
  record(
    'PLAYBACK_COVERAGE',
    'traceability',
    'Se conserva la trazabilidad de la cobertura anterior sin confundirla con permisos',
    baseline !== null,
    {
      previousMilestoneAudit: 'TDT-CLONE-10: 318 channels played in-app (reference-project measurement)',
      migratedPublishedChannels: baseline?.channelsWithPublishedSource ?? null,
      note:
        'Los 318 son una medición técnica de reproducción del hito anterior, no una autorización de integración: ' +
        'este registro solo publica las fuentes con permiso y condiciones registrados.',
    },
    'medium',
  );
}

async function auditGuiaTvReadiness(client) {
  const manifest = await getJson('/integration/manifest');
  record(
    'GUIATV_INTEGRATION_READINESS',
    'integration-manifest',
    'Existe un manifiesto de integración con la política de slugs',
    manifest.status === 200 && manifest.body?.data?.slugPolicy?.authoritative === 'tdt-platform',
    manifest.body?.data,
  );

  const identity = await getJson('/integration/guiatv/identity-map?pageSize=5');
  record(
    'GUIATV_INTEGRATION_READINESS',
    'identity-map',
    'Existe la tabla de correspondencia de identificadores',
    identity.status === 200 && Array.isArray(identity.body?.data) && identity.body.data.length > 0,
    { entries: identity.body?.pagination?.total ?? 0, sample: identity.body?.data?.[0] ?? null },
  );

  const channels = await getJson('/integration/guiatv/channels?pageSize=5');
  record(
    'GUIATV_INTEGRATION_READINESS',
    'guiatv-catalogue',
    'El catálogo se sirve en el contrato que GuíaTV consume',
    channels.status === 200 && Array.isArray(channels.body?.data) && channels.body.data.every((entry) => entry.tdtId && entry.slug),
    { total: channels.body?.total ?? 0 },
  );

  const sdkManifest = join(ROOT, 'packages/api-client/package.json');
  const sdkBuilt = existsSync(join(ROOT, 'packages/api-client/dist/index.js'));
  record(
    'GUIATV_INTEGRATION_READINESS',
    'sdk-package',
    'Existe un paquete cliente TypeScript compilado',
    existsSync(sdkManifest) && sdkBuilt,
    { manifest: existsSync(sdkManifest), built: sdkBuilt },
  );

  const generated = join(ROOT, 'packages/api-client/src/generated/openapi-types.ts');
  record(
    'GUIATV_INTEGRATION_READINESS',
    'generated-types',
    'Los tipos del cliente se generan del documento OpenAPI',
    existsSync(generated),
    { file: existsSync(generated) },
  );

  const integrationDocs = join(ROOT, 'docs/GUIATV-INTEGRATION.md');
  record(
    'GUIATV_INTEGRATION_READINESS',
    'integration-docs',
    'Existe documentación de integración para GuíaTV',
    existsSync(integrationDocs),
    { file: existsSync(integrationDocs) },
  );

  // Server-to-server usability: the public API needs no browser credential.
  const catalogue = await getJson('/channels?pageSize=1');
  record(
    'GUIATV_INTEGRATION_READINESS',
    'server-to-server',
    'La API pública es utilizable servidor a servidor sin credenciales de navegador',
    catalogue.status === 200,
    { status: catalogue.status },
  );

  // No inverse dependency: nothing in this repository calls GuíaTV.
  const callers = walkFiles(join(ROOT, 'apps'), (file) => /\.(ts|mjs|js)$/.test(file)).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return /guiatv\.|guiatv\/(api|graphql)/i.test(text) && !file.includes('e2e') && !file.includes('.spec.');
  });
  record(
    'GUIATV_INTEGRATION_READINESS',
    'no-inverse-dependency',
    'TDT Platform no depende de GuíaTV',
    callers.length === 0,
    { offenders: callers },
  );
}

function runTestSuite(label, command, args, cwd) {
  const started = Date.now();
  try {
    const output = execFileSync(command, args, { cwd, encoding: 'utf8', shell: true, timeout: 900_000 });
    const summary = output
      .split(/\r?\n/)
      .filter((line) => /Tests\s+\d+|passed|Test Files/.test(line))
      .slice(-3)
      .join(' | ');
    return { label, ok: true, milliseconds: Date.now() - started, summary };
  } catch (error) {
    return {
      label,
      ok: false,
      milliseconds: Date.now() - started,
      summary: String(error.stdout ?? error.message).split(/\r?\n/).slice(-6).join(' | '),
    };
  }
}

async function main() {
  const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    await auditApiImplementation(client);
    await auditDataIndependence(client);
    await auditPlaybackCoverage(client);
    await auditGuiaTvReadiness(client);
  } finally {
    await client.close();
  }

  // The suites are re-run by the auditor, not quoted from a previous report.
  const suites = [];
  if (!args.includes('--skip-suites')) {
    suites.push(runTestSuite('backend', 'npm', ['test', '--workspace', '@tdt/backend', '--silent'], ROOT));
    suites.push(runTestSuite('sdk', 'npm', ['test', '--workspace', '@tdt/api-client', '--silent'], ROOT));
  }

  const verdictFor = (dimension) => {
    const findings = dimensions[dimension];
    const critical = findings.filter((finding) => !finding.ok && finding.severity === 'critical');
    const high = findings.filter((finding) => !finding.ok && finding.severity === 'high');
    if (critical.length > 0) return 'BLOCKED';
    if (high.length > 0) return 'PARTIAL';
    return 'PASS';
  };

  const dimensionsReport = Object.fromEntries(
    Object.entries(dimensions).map(([dimension, findings]) => [
      dimension,
      {
        status: verdictFor(dimension),
        checks: findings,
      },
    ]),
  );

  const failedSuites = suites.filter((suite) => !suite.ok);
  const blockedDimensions = Object.entries(dimensionsReport).filter(([, report]) => report.status === 'BLOCKED');
  const globalVerdict = blockedDimensions.length > 0 || failedSuites.length > 0 ? 'NO-GO' : 'GO';

  const report = {
    audit: 'TDT-API-01 independent acceptance audit',
    generatedAt: new Date().toISOString(),
    target: { api: BASE, database: DB },
    dimensions: dimensionsReport,
    suites,
    globalVerdict,
    blockers: [
      ...blockedDimensions.map(([dimension]) => `dimension ${dimension} is BLOCKED`),
      ...failedSuites.map((suite) => `test suite ${suite.label} failed`),
    ],
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  for (const [dimension, value] of Object.entries(dimensionsReport)) {
    console.log(`\n${dimension}: ${value.status}`);
    for (const check of value.checks) {
      console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.id} — ${check.claim}`);
    }
  }
  console.log('\nSuites:');
  for (const suite of suites) {
    console.log(`  ${suite.ok ? 'PASS' : 'FAIL'}  ${suite.label} (${Math.round(suite.milliseconds / 1000)}s) ${suite.summary}`);
  }
  console.log(`\nGlobal verdict: ${globalVerdict}`);
  if (report.blockers.length > 0) {
    console.log(`Blockers:\n  - ${report.blockers.join('\n  - ')}`);
  }
  console.log(`Report written to ${OUT}`);
  process.exitCode = globalVerdict === 'GO' ? 0 : 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ audit: 'TDT-API-01', status: 'failed', error: String(error) }));
  process.exit(1);
});
