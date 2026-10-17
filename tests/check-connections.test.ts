import assert from 'node:assert/strict';
import test from 'node:test';

// Read-only deployment helpers are JavaScript outside the application TS build.
const { checkConnections, classifyTransportFailure } = await import('../scripts/deployment/' + 'check-connections.mjs');
const env = { VERCEL_TOKEN: 'vercel-secret-placeholder', NEON_API_KEY: 'neon-secret-placeholder', ADMIN_SETUP_TOKEN: 'optional-admin-secret' };
const project = { id: 'prj_R9ghX1USsX04IwvFRJYN4vY8U1tK', accountId: 'team_4zZUxLEnbWP7KnDSrjuOlQnp', name: 'greentaxi' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function healthy(input: string, init: RequestInit) {
  const url = new URL(input);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.body, undefined);
  const headers = init.headers as Record<string, string>;
  if (url.hostname === 'api.vercel.com') {
    assert.equal(url.pathname, `/v9/projects/${project.id}`);
    assert.equal(url.searchParams.get('teamId'), project.accountId);
    assert.equal(headers.Authorization, `Bearer ${env.VERCEL_TOKEN}`);
    return json(project);
  }
  if (url.hostname === 'console.neon.tech') {
    assert.equal(url.pathname, '/api/v2/projects/still-thunder-13359416');
    assert.equal(headers.Authorization, `Bearer ${env.NEON_API_KEY}`);
    return json({ project: { id: 'still-thunder-13359416' } });
  }
  assert.equal(url.origin, 'https://green-taxi.ge');
  assert.equal(headers.Authorization, undefined);
  if (url.pathname === '/api/auth/session') return json({ user: null, needsSetup: false, requiresSetupToken: true });
  if (url.pathname === '/api/public/config') return json({ didubeName: 'დიდუბე', didubeAddress: 'თბილისი', stops: [{ id: 1, name: 'Stop', address: 'Address', active: true }] });
  assert.equal(url.pathname, '/api/admin/bookings');
  return json({ error: 'Sign in', code: 'UNAUTHORIZED' }, 401);
}

test('connection preflight verifies all established resources with GET only and never returns credentials', async () => {
  const requests: string[] = [];
  const report = await checkConnections({ env, fetchImpl: async (url: string, init: RequestInit) => {
    requests.push(url);
    return healthy(url, init);
  } });
  assert.equal(report.ok, true);
  assert.equal(requests.length, 5);
  assert.deepEqual(report.bindings, { VERCEL_TOKEN: true, NEON_API_KEY: true, ADMIN_SETUP_TOKEN: true });
  assert.equal(report.adminSetupTokenRequired, false);
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(report).includes(secret));
});

test('missing required bindings skip their requests while independent public checks continue', async () => {
  const requests: string[] = [];
  const report = await checkConnections({ env: { VERCEL_TOKEN: ' ', NEON_API_KEY: '' }, fetchImpl: async (url: string, init: RequestInit) => {
    requests.push(url);
    return healthy(url, init);
  } });
  assert.equal(report.ok, false);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(url => new URL(url).hostname === 'green-taxi.ge'));
  assert.deepEqual(report.checks.slice(0, 2).map((check: any) => check.result), ['missing_binding', 'missing_binding']);
  assert.ok(report.checks.slice(0, 2).every((check: any) => check.requestSent === false));
  assert.equal(report.bindings.ADMIN_SETUP_TOKEN, false);
});

test('optional missing setup token does not block an existing administrator', async () => {
  const report = await checkConnections({ env: { ...env, ADMIN_SETUP_TOKEN: undefined }, fetchImpl: healthy });
  assert.equal(report.ok, true);
  assert.equal(report.bindings.ADMIN_SETUP_TOKEN, false);
});

test('nested proxy HTTP 403 is a transport block, while returned API HTTP 403 remains an API response', async () => {
  const proxyFailure = new TypeError('fetch failed', { cause: new AggregateError([
    new Error(`Proxy response (403) !== 200; https://proxy-user:${env.VERCEL_TOKEN}@private-proxy.invalid`),
  ]) });
  const report = await checkConnections({ env, fetchImpl: async (url: string, init: RequestInit) => {
    if (new URL(url).hostname === 'api.vercel.com') throw proxyFailure;
    if (new URL(url).hostname === 'console.neon.tech') return json({ error: env.NEON_API_KEY }, 403);
    return healthy(url, init);
  } });
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].result, 'network_blocked');
  assert.equal(report.checks[0].httpStatus, undefined);
  assert.equal(report.checks[1].result, 'unexpected_http_status');
  assert.equal(report.checks[1].httpStatus, 403);
  assert.ok(!JSON.stringify(report).includes('proxy-user'));
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(classifyTransportFailure(new Error('Request failed (403)')), 'connection_failed');
  assert.equal(classifyTransportFailure(new DOMException('timeout', 'TimeoutError')), 'timeout');
});

test('wrong resource identity, invalid payloads, missing admin and exposed admin endpoint fail closed', async t => {
  const cases = [
    { path: '/v9/projects/' + project.id, response: () => json({ ...project, id: 'prj_wrong' }), result: 'unexpected_payload' },
    { path: '/v9/projects/' + project.id, response: () => json({ ...project, accountId: 'team_wrong' }), result: 'unexpected_payload' },
    { path: '/api/v2/projects/still-thunder-13359416', response: () => json({ project: { id: 'wrong-project' } }), result: 'unexpected_payload' },
    { path: '/api/auth/session', response: () => json({ user: null, needsSetup: true }), result: 'existing_admin_missing' },
    { path: '/api/public/config', response: () => json({ stops: [] }), result: 'unexpected_payload' },
    { path: '/api/public/config', response: () => new Response('<html>Unavailable</html>', { status: 200 }), result: 'invalid_json' },
    { path: '/api/admin/bookings', response: () => json({ bookings: [] }), result: 'unexpected_http_status' },
    { path: '/api/admin/bookings', response: () => json({ error: 'wrong service' }, 401), result: 'unexpected_payload' },
  ];
  for (const item of cases) await t.test(`${item.path}: ${item.result}`, async () => {
    const report = await checkConnections({ env, fetchImpl: async (url: string, init: RequestInit) => new URL(url).pathname === item.path ? item.response() : healthy(url, init) });
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.filter((check: any) => !check.ok).map((check: any) => check.result), [item.result]);
  });
});
