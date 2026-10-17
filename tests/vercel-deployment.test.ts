import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';

// The deployment scripts are JavaScript tools outside the application TS build.
const { prepareExistingUpdatePlan, updateExistingDeployment } = await import('../scripts/deployment/' + 'vercel.mjs');
const PROJECT = { id: 'prj_R9ghX1USsX04IwvFRJYN4vY8U1tK', accountId: 'team_4zZUxLEnbWP7KnDSrjuOlQnp', name: 'greentaxi' };
const DATABASE_BINDING = { key: 'DATABASE_URL', target: ['production'], type: 'encrypted' };
const TOKEN = 'offline-test-token';

function sourceFixture(t: TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'greentaxi-deployment-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ engines: { node: '24.x' } }),
    'package-lock.json': '{}\n', 'vercel.json': '{}\n',
    'api/index.ts': 'export const api = true;\n',
    'server/index.ts': 'export const server = true;\n',
    'server/database.ts': 'export const database = true;\n',
    'server/migrations/002_rate_limits.postgres.sql': '-- migration\n',
    'src/committed.txt': 'committed source\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
  git('add', '.');
  git('-c', 'user.name=Deployment Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Fixture main');
  const commit = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src/committed.txt'), 'uncommitted source must not deploy\n');
  writeFileSync(join(repo, '.env.local'), 'DO_NOT_UPLOAD=untracked\n');
  return { repo, commit, files };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('existing-project plan is offline and excludes provisioning and environment writes', async t => {
  const source = sourceFixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Offline plan must not use the network.'); });
  const plan = prepareExistingUpdatePlan(source.repo);
  assert.equal(plan.sourceCommit, source.commit);
  assert.equal(plan.projectId, PROJECT.id);
  assert.equal(plan.teamId, PROJECT.accountId);
  assert.deepEqual(plan.endpoints, [
    `GET /v9/projects/${PROJECT.id}`, `GET /v10/projects/${PROJECT.id}/env (only if project metadata omits env)`,
    'POST /v2/files', 'POST /v13/deployments', 'GET /v13/deployments/{id}',
  ]);
});

test('existing-project update requires explicit authorization and the reviewed main commit', async t => {
  const source = sourceFixture(t);
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Preflight must not use the network.'); });
  await assert.rejects(updateExistingDeployment({ repo: source.repo, token: TOKEN }), /allowMutation:true/);
  await assert.rejects(updateExistingDeployment({ repo: source.repo, token: TOKEN, allowMutation: true, expectedCommit: '0'.repeat(40) }), /reviewed source commit/);
  assert.equal(network.mock.callCount(), 0);
});

test('existing-project update verifies identity and uploads only committed main without env or settings overrides', async t => {
  const source = sourceFixture(t);
  const requests: { method: string; path: string }[] = [];
  const uploaded = new Map<string, Buffer>();
  let deployed: any;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    assert.equal(url.origin, 'https://api.vercel.com');
    assert.equal(url.searchParams.get('teamId'), PROJECT.accountId);
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    if (method === 'GET' && url.pathname === `/v9/projects/${PROJECT.id}`) return json({ ...PROJECT, env: [DATABASE_BINDING], nodeVersion: '24.x' });
    if (method === 'POST' && url.pathname === '/v2/files') {
      assert.equal(requests[0].path, `/v9/projects/${PROJECT.id}`);
      assert.ok(Buffer.isBuffer(init?.body));
      const data = init.body as Buffer;
      const headers = init.headers as Record<string, string>;
      const digest = createHash('sha1').update(data).digest('hex');
      assert.equal(headers['x-vercel-digest'], digest);
      assert.equal(headers['Content-Length'], String(data.length));
      uploaded.set(digest, data);
      return json({});
    }
    if (method === 'POST' && url.pathname === '/v13/deployments') {
      deployed = JSON.parse(String(init?.body));
      return json({ id: 'dpl_offline', url: 'greentaxi-offline.vercel.app' });
    }
    throw new Error(`Unexpected operation: ${method} ${url.pathname}`);
  });
  const result = await updateExistingDeployment({ repo: source.repo, token: TOKEN, allowMutation: true, expectedCommit: source.commit });
  assert.deepEqual(result, { projectId: PROJECT.id, deploymentId: 'dpl_offline', url: 'greentaxi-offline.vercel.app', teamId: PROJECT.accountId, sourceCommit: source.commit });
  assert.equal(deployed.project, PROJECT.id);
  assert.equal(deployed.name, PROJECT.name);
  assert.equal(deployed.target, 'production');
  assert.equal(deployed.meta.sourceCommit, source.commit);
  for (const field of ['env', 'build', 'projectSettings', 'gitSource']) assert.equal(field in deployed, false);
  assert.deepEqual(deployed.files.map((file: { file: string }) => file.file).sort(), Object.keys(source.files).sort());
  for (const file of deployed.files) assert.equal(uploaded.get(file.sha)?.toString(), source.files[file.file]);
  assert.notEqual(readFileSync(join(source.repo, 'src/committed.txt'), 'utf8'), source.files['src/committed.txt']);
  assert.equal(requests.filter(request => request.path === '/v13/deployments').length, 1);
});

test('identity mismatch and missing/inaccessible projects stop before all remote mutations', async t => {
  const source = sourceFixture(t);
  for (const response of [
    { body: { ...PROJECT, id: 'prj_wrong' }, status: 200 },
    { body: { ...PROJECT, accountId: 'team_wrong' }, status: 200 },
    { body: { ...PROJECT, name: 'unrelated-project' }, status: 200 },
    { body: {}, status: 404 },
    { body: {}, status: 403 },
  ]) {
    await t.test(`project check ${response.status} ${JSON.stringify(response.body)}`, async child => {
      const requests: string[] = [];
      child.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init?.method ?? 'GET');
        return json(response.body, response.status);
      });
      await assert.rejects(updateExistingDeployment({ repo: source.repo, token: TOKEN, allowMutation: true }));
      assert.deepEqual(requests, ['GET']);
    });
  }
});

test('omitted project env uses metadata lookup, preserving the existing production database binding', async t => {
  const source = sourceFixture(t);
  const requests: { method: string; path: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    if (method === 'GET' && url.pathname === `/v9/projects/${PROJECT.id}`) return json(PROJECT);
    if (method === 'GET' && url.pathname === `/v10/projects/${PROJECT.id}/env`) {
      assert.equal(url.searchParams.get('decrypt'), 'false');
      assert.equal(url.searchParams.get('teamId'), PROJECT.accountId);
      return json({ envs: [DATABASE_BINDING] });
    }
    if (method === 'POST' && url.pathname === '/v2/files') return json({});
    if (method === 'POST' && url.pathname === '/v13/deployments') return json({ id: 'dpl_existing_env', url: 'greentaxi-offline.vercel.app' });
    throw new Error(`Unexpected operation: ${method} ${url.pathname}`);
  });
  await updateExistingDeployment({ repo: source.repo, token: TOKEN, allowMutation: true });
  assert.deepEqual(requests.slice(0, 2), [
    { method: 'GET', path: `/v9/projects/${PROJECT.id}` },
    { method: 'GET', path: `/v10/projects/${PROJECT.id}/env` },
  ]);
});

test('absent or preview-only database binding stops before source upload', async t => {
  const source = sourceFixture(t);
  for (const env of [[], [{ key: 'DATABASE_URL', target: ['preview'] }], [{ key: 'OTHER_URL', target: ['production'] }]]) {
    await t.test(JSON.stringify(env), async child => {
      const requests: string[] = [];
      child.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init?.method ?? 'GET');
        return json({ ...PROJECT, env });
      });
      await assert.rejects(updateExistingDeployment({ repo: source.repo, token: TOKEN, allowMutation: true }), /no production DATABASE_URL binding/);
      assert.deepEqual(requests, ['GET']);
    });
  }
});

test('failed source upload cannot submit a deployment', async t => {
  const source = sourceFixture(t);
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return path === `/v9/projects/${PROJECT.id}` ? json({ ...PROJECT, env: [DATABASE_BINDING] }) : json({}, 500);
  });
  await assert.rejects(updateExistingDeployment({ repo: source.repo, token: TOKEN, allowMutation: true }), /HTTP 500/);
  assert.ok(paths.includes('/v2/files'));
  assert.ok(!paths.includes('/v13/deployments'));
});
