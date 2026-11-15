// Admin flow probe against a real server and real database.
const base = process.env.API_BASE ?? 'http://127.0.0.1:4010/api/v1';
const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN ?? '';

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function log(label, result) {
  console.log(`${label} -> ${result.status}`, JSON.stringify(result.body).slice(0, 400));
}

// 1. Bootstrap the first administrator (only possible while none exists).
log('bootstrap', await call('POST', '/auth/bootstrap', {
  body: { email: 'editor@tdt.invalid', password: 'Correct-Horse-Battery-9', bootstrapToken, roles: ['admin'] },
}));
log('bootstrap again (must refuse)', await call('POST', '/auth/bootstrap', {
  body: { email: 'second@tdt.invalid', password: 'Correct-Horse-Battery-9', bootstrapToken, roles: ['admin'] },
}));

// 2. Login.
const login = await call('POST', '/auth/login', {
  body: { email: 'editor@tdt.invalid', password: 'Correct-Horse-Battery-9' },
});
log('login', login);
const token = login.body?.data?.token;

// 3. Wrong password must not reveal whether the user exists.
log('bad password', await call('POST', '/auth/login', {
  body: { email: 'editor@tdt.invalid', password: 'wrong-password-123' },
}));
log('unknown user', await call('POST', '/auth/login', {
  body: { email: 'nobody@tdt.invalid', password: 'wrong-password-123' },
}));

// 4. Create a channel, then edit it, then revert.
const created = await call('POST', '/admin/channels', {
  token,
  body: {
    name: 'Canal de Prueba Editorial',
    country: 'ES',
    category: 'local',
    description: 'Canal de prueba creado por la API administrativa.',
    provenance: [
      {
        source: 'editorial',
        label: 'Alta manual de prueba',
        url: null,
        licence: 'editorial',
        attribution: null,
        editorial: true,
      },
    ],
  },
});
log('create channel', created);
const channelId = created.body?.data?.id;

const updated = await call('PATCH', `/admin/channels/${channelId}`, {
  token,
  body: { description: 'Descripción corregida por la redacción.', expectedUpdatedAt: created.body?.data?.updatedAt },
});
log('update channel', updated);

log('update with stale version (must 409)', await call('PATCH', `/admin/channels/${channelId}`, {
  token,
  body: { description: 'Conflicto esperado', expectedUpdatedAt: created.body?.data?.updatedAt },
}));

// 5. Attach a licence-cleared HLS source whose emitter is on the allowlist.
const source = await call('POST', '/admin/sources', {
  token,
  body: {
    channelId,
    provider: 'emitter:example.org',
    type: 'hls',
    url: 'https://example.org/live/master.m3u8',
    officialPageUrl: 'https://example.org/directo',
    permission: 'explicit-permission',
    authorisationEvidence: 'Prueba automatizada: fuente sintética local.',
    conditions: {
      embedAllowed: true,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: 'Prueba autorizada',
    },
    priority: 10,
  },
});
log('create source', source);

const afterSource = await call('GET', `/admin/channels/${channelId}`, { token });
console.log(
  'admin channel after source ->',
  afterSource.status,
  JSON.stringify({
    playbackStatus: afterSource.body?.data?.playbackStatus,
    sources: afterSource.body?.data?.sourceRecords?.map((record) => ({
      type: record.type,
      permission: record.permission,
      publiclyExposed: record.publiclyExposed,
      exclusionReason: record.exclusionReason,
    })),
  }),
);

// 6. A source that must never be published: unlicensed, forged header required.
const blocked = await call('POST', '/admin/sources', {
  token,
  body: {
    channelId,
    provider: 'emitter:unknown-host.example',
    type: 'hls',
    url: 'https://unknown-host.example/live/master.m3u8',
    permission: 'open-data-licence',
    conditions: {
      embedAllowed: false,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: true,
      emitterAppOnly: false,
      notes: 'Requiere Referer',
    },
  },
});
log('create withheld source', blocked);
const afterBlocked = await call('GET', `/admin/channels/${channelId}`, { token });
console.log(
  'public exposure:',
  JSON.stringify(afterBlocked.body?.data?.sourceRecords?.map((r) => ({ type: r.type, ok: r.publiclyExposed, why: r.exclusionReason }))),
);

// 7. Public playback descriptor for the new channel.
const publicChannel = await call('GET', '/channels/canal-de-prueba-editorial');
log('public channel', publicChannel);
const playback = await call('GET', '/channels/canal-de-prueba-editorial/playback');
console.log('public playback ->', playback.status, JSON.stringify(playback.body?.data?.playback));

// 8. Audit log has every step.
const audits = await call('GET', '/admin/audits?pageSize=10', { token });
console.log('audits ->', audits.status, audits.body?.pagination?.total, JSON.stringify(audits.body?.data?.map((entry) => entry.action)));

// 9. Revert to the first revision.
if (channelId) {
  const history = await call('GET', `/admin/audits?entityId=${channelId}&pageSize=10`, { token });
  const createEntry = history.body?.data?.find((entry) => entry.action === 'channel.create');
  if (createEntry) {
    const reverted = await call('POST', `/admin/channels/${channelId}/revert`, { token, body: { auditId: createEntry.id } });
    log('revert', reverted);
  }
}

// 10. Session must not survive logout.
log('logout', await call('POST', '/auth/logout', { token }));
log('me after logout (must 401)', await call('GET', '/admin/me', { token }));
