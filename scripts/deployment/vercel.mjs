import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const API = 'https://api.vercel.com';
const EXISTING_PROJECT = Object.freeze({
  id: 'prj_R9ghX1USsX04IwvFRJYN4vY8U1tK',
  teamId: 'team_4zZUxLEnbWP7KnDSrjuOlQnp',
  name: 'greentaxi',
});
const PROJECT_SETTINGS = Object.freeze({
  framework: 'vite',
  installCommand: 'npm ci',
  buildCommand: 'npm run build',
  outputDirectory: 'dist',
  rootDirectory: null,
  nodeVersion: '24.x',
  serverlessFunctionRegion: 'fra1',
});

export class ApiFailure extends Error {
  constructor(method, path, status) {
    super(`Vercel ${method} ${path.split('?')[0]} returned HTTP ${status}.`);
    this.status = status;
  }
}

export function sourceFromMain(repo = '/workspace/greentaxi') {
  const git = args => execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  let commit;
  try { commit = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}']).toString().trim(); }
  catch { commit = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']).toString().trim(); }
  const records = git(['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean);
  const files = records.map(record => {
    const [metadata, file] = record.split('\t');
    const [mode, type, object] = metadata.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Source contains an unsupported Git tree entry.');
    const data = git(['cat-file', 'blob', object]);
    return { file, sha: createHash('sha1').update(data).digest('hex'), size: data.length, data };
  });
  const names = new Set(files.map(file => file.file));
  for (const required of ['package.json', 'package-lock.json', 'vercel.json', 'api/index.ts', 'server/index.ts', 'server/database.ts', 'server/migrations/002_rate_limits.postgres.sql']) {
    if (!names.has(required)) throw new Error(`Main branch is missing ${required}.`);
  }
  const packageJson = JSON.parse(files.find(file => file.file === 'package.json').data.toString());
  if (packageJson.engines?.node !== '24.x') throw new Error('Main branch must pin Node24 before deployment.');
  return { commit, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
}

export function preparePlan(repo) {
  const source = sourceFromMain(repo);
  return {
    sourceRef: 'main',
    sourceCommit: source.commit,
    sourceFiles: source.files.length,
    sourceBytes: source.totalBytes,
    projectName: 'greentaxi',
    projectSettings: PROJECT_SETTINGS,
    runtimeSecretNames: ['DATABASE_URL', 'ADMIN_SETUP_TOKEN'],
    api: API,
    endpoints: [
      'GET /v2/user', 'GET /v2/teams', 'GET /v9/projects/greentaxi',
      'POST /v11/projects', 'POST /v10/projects/{id}/env?upsert=true',
      'POST /v2/files', 'POST /v13/deployments', 'GET /v13/deployments/{id}',
    ],
  };
}

export function prepareExistingUpdatePlan(repo) {
  const source = sourceFromMain(repo);
  return {
    mode: 'update-existing',
    sourceRef: 'main', sourceCommit: source.commit,
    sourceFiles: source.files.length, sourceBytes: source.totalBytes,
    projectId: EXISTING_PROJECT.id, teamId: EXISTING_PROJECT.teamId,
    projectName: EXISTING_PROJECT.name, target: 'production',
    runtimeConfiguration: 'inherit existing project settings and production environment',
    api: API,
    endpoints: [
      `GET /v9/projects/${EXISTING_PROJECT.id}`,
      `GET /v10/projects/${EXISTING_PROJECT.id}/env (only if project metadata omits env)`,
      'POST /v2/files', 'POST /v13/deployments', 'GET /v13/deployments/{id}',
    ],
  };
}

export function vercelClient({ token = process.env.VERCEL_TOKEN, teamId, allowMutation = false } = {}) {
  if (!token?.trim()) throw new Error('VERCEL_TOKEN is missing from this running environment.');
  return async function request(method, path, { json, binary, headers = {}, query = {}, scoped = true } = {}) {
    if (method !== 'GET' && !allowMutation) throw new Error('Remote mutations are disabled for this client.');
    const url = new URL(path, API);
    if (scoped && teamId) url.searchParams.set('teamId', teamId);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        ...(binary !== undefined ? { body: binary } : {}),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error(`Vercel ${method} ${path.split('?')[0]} could not connect.`);
    }
    if (!response.ok) {
      // Never print response bodies: API errors can echo submitted secret values.
      await response.body?.cancel();
      throw new ApiFailure(method, path, response.status);
    }
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  };
}

export async function inspectAccounts({ token, requestedTeamId = process.env.VERCEL_TEAM_ID } = {}) {
  const request = vercelClient({ token });
  const userResult = await request('GET', '/v2/user', { scoped: false }).catch(error => {
    if (error instanceof ApiFailure && error.status === 403) return {};
    throw error;
  });
  const teams = [];
  let until;
  do {
    const result = await request('GET', '/v2/teams', { scoped: false, query: { limit: 100, ...(until ? { until } : {}) } });
    teams.push(...(result.teams || []));
    until = result.pagination?.next;
  } while (until);
  if (requestedTeamId && !teams.some(team => team.id === requestedTeamId)) throw new Error('VERCEL_TEAM_ID is not accessible to this token.');
  const selected = requestedTeamId ? teams.find(team => team.id === requestedTeamId) : teams.length === 1 ? teams[0] : undefined;
  return {
    user: userResult.user ? { id: userResult.user.id, username: userResult.user.username } : null,
    teams: teams.map(team => ({ id: team.id, slug: team.slug, name: team.name })),
    selectedTeamId: selected?.id || null,
    needsTeamSelection: !selected && teams.length > 1,
  };
}

export function deploymentBody(source, projectId) {
  return {
    name: 'greentaxi', project: projectId, target: 'production',
    projectSettings: PROJECT_SETTINGS,
    files: source.files.map(({ file, sha, size }) => ({ file, sha, size })),
    meta: { sourceRepository: 'edgarcho333/greentaxi', sourceRef: 'main', sourceCommit: source.commit },
  };
}

async function uploadSource(request, source) {
  // Upload committed main byte-for-byte, sharing duplicate contents by digest.
  const uniqueFiles = [...new Map(source.files.map(file => [file.sha, file])).values()];
  for (let offset = 0; offset < uniqueFiles.length; offset += 4) {
    await Promise.all(uniqueFiles.slice(offset, offset + 4).map(file => request('POST', '/v2/files', {
      binary: file.data,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'x-vercel-digest': file.sha, 'x-now-digest': file.sha, 'x-now-size': String(file.size) },
    })));
  }
}

/** Update only the established production project; never provision or edit its environment. */
export async function updateExistingDeployment({
  repo, token = process.env.VERCEL_TOKEN, allowMutation = false, expectedCommit,
} = {}) {
  if (!allowMutation) throw new Error('Deployment requires an explicit allowMutation:true call.');
  const source = sourceFromMain(repo);
  if (expectedCommit !== undefined && source.commit !== expectedCommit) throw new Error('Main branch differs from the reviewed source commit.');
  const request = vercelClient({ token, teamId: EXISTING_PROJECT.teamId, allowMutation: true });
  const project = await request('GET', `/v9/projects/${EXISTING_PROJECT.id}`);
  if (project.id !== EXISTING_PROJECT.id || project.accountId !== EXISTING_PROJECT.teamId || project.name !== EXISTING_PROJECT.name) {
    throw new Error('Existing Vercel project identity does not match the configured production project.');
  }
  const environment = Array.isArray(project.env) ? project.env : (await request('GET', `/v10/projects/${project.id}/env`, { query: { decrypt: 'false' } })).envs;
  const hasDatabaseBinding = Array.isArray(environment) && environment.some(item => item.key === 'DATABASE_URL' && (item.target === 'production' || Array.isArray(item.target) && item.target.includes('production')));
  if (!hasDatabaseBinding) throw new Error('Existing Vercel project has no production DATABASE_URL binding.');
  await uploadSource(request, source);
  // Omitting env/build.env/projectSettings preserves the established production
  // configuration, including DATABASE_URL and the existing Neon integration.
  const { projectSettings: _initialSettings, ...body } = deploymentBody(source, project.id);
  const deployment = await request('POST', '/v13/deployments', {
    query: { skipAutoDetectionConfirmation: '1' }, json: body,
  });
  return {
    projectId: project.id, deploymentId: deployment.id, url: deployment.url,
    teamId: EXISTING_PROJECT.teamId, sourceCommit: source.commit,
  };
}

export async function deploy({ repo, token = process.env.VERCEL_TOKEN, databaseUrl = process.env.DATABASE_URL, requestedTeamId, allowMutation = false, adminSetupToken } = {}) {
  if (!allowMutation) throw new Error('Deployment requires an explicit allowMutation:true call.');
  if (!adminSetupToken?.trim()) throw new Error('ADMIN_SETUP_TOKEN is required for the owner to create the first employee.');
  if (!databaseUrl?.trim()) throw new Error('DATABASE_URL is missing. Create the Neon project first.');
  let protocol;
  try { protocol = new URL(databaseUrl).protocol; } catch { throw new Error('DATABASE_URL is invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(protocol)) throw new Error('DATABASE_URL must be PostgreSQL.');
  const accounts = await inspectAccounts({ token, requestedTeamId });
  if (accounts.needsTeamSelection) throw new Error('Multiple Vercel teams are available. Set VERCEL_TEAM_ID first.');
  const request = vercelClient({ token, teamId: accounts.selectedTeamId, allowMutation: true });
  const source = sourceFromMain(repo);
  let project;
  try { project = await request('GET', '/v9/projects/greentaxi'); }
  catch (error) {
    if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
    const { nodeVersion: _nodeVersion, ...projectSettings } = PROJECT_SETTINGS;
    project = await request('POST', '/v11/projects', { json: { name: 'greentaxi', ...projectSettings } });
  }
  const unrelatedDeployment = project.latestDeployments?.some(item => item.meta?.sourceRepository !== 'edgarcho333/greentaxi');
  const linked = project.gitRepository;
  const linkedToSource = linked?.repo === 'edgarcho333/greentaxi' || (linked?.repo === 'greentaxi' && linked?.org === 'edgarcho333');
  if (unrelatedDeployment && !linkedToSource) {
    throw new Error('Existing greentaxi project has unrelated deployments. Select the intended project before changing it.');
  }
  const setupToken = adminSetupToken;
  await request('POST', `/v10/projects/${encodeURIComponent(project.id)}/env`, {
    query: { upsert: 'true' },
    json: [
      { key: 'DATABASE_URL', value: databaseUrl, type: 'sensitive', target: ['production'] },
      { key: 'ADMIN_SETUP_TOKEN', value: setupToken, type: 'sensitive', target: ['production'] },
    ],
  });
  await uploadSource(request, source);
  const deployment = await request('POST', '/v13/deployments', {
    query: { skipAutoDetectionConfirmation: '1' }, json: deploymentBody(source, project.id),
  });
  // SECRET RETURN VALUE: keep this object in memory. Do not log/serialize it.
  // The caller can use adminSetupToken to initialize the first employee account.
  return { projectId: project.id, deploymentId: deployment.id, url: deployment.url, teamId: accounts.selectedTeamId, sourceCommit: source.commit, adminSetupToken: setupToken };
}

export async function deploymentStatus({ deploymentId, token, teamId }) {
  return vercelClient({ token, teamId })('GET', `/v13/deployments/${encodeURIComponent(deploymentId)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(value => !['--inspect', '--plan-update-existing', '--update-existing', '--help'].includes(value))) {
      throw new Error('Unsupported deployment arguments.');
    }
    if (args.includes('--help')) {
      console.log('Default: offline initial-setup plan. --plan-update-existing: offline plan for the existing production project. --update-existing: authorize production deployment of committed main without project/env/admin setup. Use node --use-env-proxy when the environment supplies an HTTPS proxy. Never pass secrets as arguments.');
    } else if (args.includes('--inspect')) console.log(JSON.stringify(await inspectAccounts(), null, 2));
    else if (args.includes('--plan-update-existing')) console.log(JSON.stringify(prepareExistingUpdatePlan(process.env.GREENTAXI_REPO), null, 2));
    else if (args.includes('--update-existing')) console.log(JSON.stringify(await updateExistingDeployment({ repo: process.env.GREENTAXI_REPO, allowMutation: true }), null, 2));
    else console.log(JSON.stringify(preparePlan(process.env.GREENTAXI_REPO), null, 2));
  } catch {
    console.error('Vercel preparation failed. Check injected credentials, account scope, network access and main-branch source. No secret values were logged.');
    process.exitCode = 1;
  }
}
