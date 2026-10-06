import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inspectNeon, prepareNeonConnection } from './neon.mjs';
import { deploy, deploymentStatus, inspectAccounts, preparePlan } from './vercel.mjs';

const DEFAULT_RESULT_PATH = '/workspace/.greentaxi-tools/deployment/result.json';
const DEFAULT_WAIT_MS = 5 * 60 * 1000;
const EXPECTED_TIMES = ['06:00', '07:00', '08:00', '08:30', '09:00', '09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00'];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value);

export class DeploymentError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}

function publicUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
    if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(parsed.hostname) || !parsed.hostname.includes('.')) return null;
    if (/^(?:localhost|\d+(?:\.\d+){3})$/i.test(parsed.hostname) || /\.(?:localhost|local|internal)$/i.test(parsed.hostname)) return null;
    if (parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch { return null; }
}

async function readMarker(path) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new DeploymentError('DEPLOYMENT_MARKER_INVALID');
  }
  const url = publicUrl(value?.url);
  if (!url || !/^[a-f\d]{40,64}$/.test(value?.sourceSHA ?? '') || !identifier(value?.projectIds?.neon) || !identifier(value?.projectIds?.vercel)) {
    throw new DeploymentError('DEPLOYMENT_MARKER_INVALID');
  }
  // Read and return only these nonsecret fields, even if another tool added fields.
  return { url, sourceSHA: value.sourceSHA, projectIds: { neon: value.projectIds.neon, vercel: value.projectIds.vercel } };
}

async function writeMarker(path, result) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

function deploymentUrls(status, deployment) {
  const rawAliases = [status.alias, status.aliases, status.automaticAliases].flatMap(value => Array.isArray(value) ? value : []);
  const aliases = rawAliases.map(value => typeof value === 'string' ? value : value?.alias ?? value?.domain);
  // A production alias is usually public while a unique deployment URL can be protected.
  const candidates = [...aliases, status.url, deployment.url].map(publicUrl).filter(Boolean);
  return [...new Set(candidates)];
}

function futureTbilisiDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp + 24 * 60 * 60 * 1000));
  const part = kind => parts.find(value => value.type === kind).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

async function verifyPublic(url, fetchImpl, now) {
  async function json(path) {
    let response;
    try {
      response = await fetchImpl(url + path, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
    } catch { throw new DeploymentError('PUBLIC_API_UNREACHABLE'); }
    if (response.status === 401 || response.status === 403 || response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new DeploymentError('PUBLIC_DEPLOYMENT_PROTECTED', response.status);
    }
    if (!response.ok) { await response.body?.cancel(); throw new DeploymentError('PUBLIC_API_HTTP_ERROR', response.status); }
    try { return await response.json(); }
    catch { throw new DeploymentError('PUBLIC_API_INVALID_JSON'); }
  }
  const session = await json('/api/auth/session');
  if (!session || typeof session.needsSetup !== 'boolean' || session.user !== null) throw new DeploymentError('PUBLIC_AUTH_CONTRACT_INVALID');
  const date = futureTbilisiDate(now());
  for (const direction of ['gori-tbilisi', 'tbilisi-gori']) {
    const result = await json(`/api/public/slots?direction=${direction}&date=${date}`);
    const actual = result?.slots?.map(slot => slot.time);
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(EXPECTED_TIMES) || result.slots.some(slot => slot.active !== true)) {
      throw new DeploymentError('PUBLIC_SCHEDULE_INVALID');
    }
  }
  return { needsSetup: session.needsSetup };
}

async function waitReady(deployment, token, providers, options) {
  const deadline = options.now() + options.maxWaitMs;
  let previous;
  while (options.now() < deadline) {
    const remaining = deadline - options.now();
    // The helper has a bounded HTTP request. This deadline also bounds the polling loop.
    let timer;
    const request = providers.deploymentStatus({ deploymentId: deployment.deploymentId, token, teamId: deployment.teamId });
    let status;
    try {
      status = await Promise.race([request, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeploymentError('DEPLOYMENT_READY_TIMEOUT')), Math.min(remaining, 60_000));
      })]);
    } finally { clearTimeout(timer); }
    const state = String(status?.readyState ?? status?.status ?? 'UNKNOWN').toUpperCase();
    if (state !== previous) { options.log(`Vercel deployment state: ${['READY', 'QUEUED', 'INITIALIZING', 'BUILDING', 'ERROR', 'CANCELED', 'CANCELLED'].includes(state) ? state : 'UNKNOWN'}.`); previous = state; }
    if (['ERROR', 'CANCELED', 'CANCELLED'].includes(state)) throw new DeploymentError('VERCEL_DEPLOYMENT_FAILED');
    if (state === 'READY') return status;
    await options.sleep(Math.min(3_000, Math.max(0, deadline - options.now())));
  }
  throw new DeploymentError('DEPLOYMENT_READY_TIMEOUT');
}

/**
 * Run during setup, where the selected environment makes Secrets available. Imports and
 * the default plan perform no network requests. The dependency parameter supports
 * offline validation without real provider calls.
 */
export async function runSetupDeployment({
  deployRequested = false, env = process.env, repo = env.GREENTAXI_REPO ?? '/workspace/greentaxi',
  resultPath = DEFAULT_RESULT_PATH, now = Date.now, sleep: wait = sleep,
  maxWaitMs = DEFAULT_WAIT_MS, fetchImpl = fetch, log = console.log,
} = {}, providers = { inspectNeon, prepareNeonConnection, inspectAccounts, preparePlan, deploy, deploymentStatus }) {
  const plan = providers.preparePlan(repo);
  if (!/^[a-f\d]{40,64}$/.test(plan?.sourceCommit ?? '')) throw new DeploymentError('SOURCE_COMMIT_INVALID');
  const marker = await readMarker(resultPath);
  if (!deployRequested) {
    const output = { mode: 'plan', sourceSHA: plan.sourceCommit, projectName: 'greentaxi', sourceFiles: plan.sourceFiles,
      secretNames: ['NEON_API_KEY', 'VERCEL_TOKEN', 'ADMIN_SETUP_TOKEN'], resultPath,
      alreadyDeployed: marker?.sourceSHA === plan.sourceCommit, ...(marker?.sourceSHA === plan.sourceCommit ? { url: marker.url } : {}) };
    log(JSON.stringify(output, null, 2));
    return output;
  }
  const required = ['NEON_API_KEY', 'VERCEL_TOKEN', 'ADMIN_SETUP_TOKEN'];
  for (const name of required) if (typeof env[name] !== 'string' || !env[name].trim()) throw new DeploymentError(`MISSING_${name}`);
  if (marker?.sourceSHA === plan.sourceCommit) {
    log(`Already deployed from this source: ${marker.url}. No provider calls made.`);
    return { skipped: true, ...marker };
  }
  // Read both accounts before creating resources. Do not emit provider responses,
  // credentials, connection strings, or deployment objects containing setup tokens.
  log('Checking deployment accounts.');
  const accounts = await providers.inspectAccounts({ token: env.VERCEL_TOKEN, requestedTeamId: env.VERCEL_TEAM_ID });
  if (accounts.needsTeamSelection) throw new DeploymentError('VERCEL_TEAM_SELECTION_REQUIRED');
  await providers.inspectNeon(env.NEON_API_KEY);
  log('Preparing the free Neon PostgreSQL project.');
  const connection = await providers.prepareNeonConnection(env.NEON_API_KEY, {
    orgId: env.NEON_ORG_ID, databaseName: env.NEON_DATABASE_NAME, allowCreate: true,
  });
  if (!identifier(connection?.projectId) || typeof connection.databaseUrl !== 'string') throw new DeploymentError('NEON_CONNECTION_INVALID');
  log('Deploying the committed main source to Vercel production.');
  const deployment = await providers.deploy({ repo, token: env.VERCEL_TOKEN, databaseUrl: connection.databaseUrl,
    requestedTeamId: env.VERCEL_TEAM_ID ?? accounts.selectedTeamId, allowMutation: true, adminSetupToken: env.ADMIN_SETUP_TOKEN });
  if (!identifier(deployment?.projectId) || !identifier(deployment?.deploymentId) || deployment.sourceCommit !== plan.sourceCommit) {
    throw new DeploymentError('VERCEL_DEPLOYMENT_RESPONSE_INVALID');
  }
  const status = await waitReady(deployment, env.VERCEL_TOKEN, providers, { now, sleep: wait, maxWaitMs: Math.min(maxWaitMs, DEFAULT_WAIT_MS), log });
  const urls = deploymentUrls(status, deployment);
  if (!urls.length) throw new DeploymentError('PRODUCTION_URL_MISSING');
  let accepted;
  let verification;
  let lastError;
  for (const url of urls) {
    try { verification = await verifyPublic(url, fetchImpl, now); accepted = url; break; }
    catch (error) { lastError = error; }
  }
  if (!accepted) throw lastError ?? new DeploymentError('PUBLIC_API_VERIFICATION_FAILED');
  const result = { url: accepted, projectIds: { neon: connection.projectId, vercel: deployment.projectId }, sourceSHA: plan.sourceCommit };
  await writeMarker(resultPath, result);
  log(`GreenTaxi is ready: ${accepted}`);
  if (verification.needsSetup) log(`Open ${accepted}/admin and create your employee login and password using the ADMIN_SETUP_TOKEN you saved securely. No employee account was created automatically.`);
  else log(`Open ${accepted}/admin and sign in with the existing employee account.`);
  return result;
}

export function safeFailure(error) {
  if (error instanceof DeploymentError) return { code: error.code, ...(error.status ? { status: error.status } : {}) };
  if (Number.isInteger(error?.status)) return { code: 'PROVIDER_API_ERROR', status: error.status };
  // Known helper selection errors are safe to map, but their raw messages are never logged.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/multiple.*vercel teams/i.test(message)) return { code: 'VERCEL_TEAM_SELECTION_REQUIRED' };
  if (/organization|orgId/i.test(message)) return { code: 'NEON_ORGANIZATION_SELECTION_REQUIRED' };
  if (/provisioning.*pending|operation.*pending/i.test(message)) return { code: 'NEON_PROVISIONING_PENDING' };
  if (/PostgreSQL 17/i.test(message)) return { code: 'NEON_POSTGRES_VERSION_MISMATCH' };
  if (/main branch|git|tree entry/i.test(message)) return { code: 'SOURCE_PREFLIGHT_FAILED' };
  return { code: 'DEPLOYMENT_FAILED' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(value => !['--deploy', '--help'].includes(value))) {
    console.error('Use --deploy to authorize setup-phase deployment, or run without arguments for an offline plan.');
    process.exitCode = 1;
  } else if (args.includes('--help')) {
    console.log('Default: offline deployment plan. --deploy: read accounts, provision Neon and deploy Vercel using NEON_API_KEY, VERCEL_TOKEN and ADMIN_SETUP_TOKEN from setup-phase Secrets. Never pass secrets as command-line arguments.');
  } else {
    runSetupDeployment({ deployRequested: args.includes('--deploy') }).catch(error => {
      const failure = safeFailure(error);
      console.error(`Deployment stopped: ${failure.code}${failure.status ? ` (HTTP ${failure.status})` : ''}. No secret values were logged.`);
      if (failure.code === 'PUBLIC_DEPLOYMENT_PROTECTED') console.error('The production URL requires Vercel authentication. Review protection for this project’s production deployment; preview/team protection was not changed.');
      if (failure.code === 'DEPLOYMENT_READY_TIMEOUT') console.error('Check the existing Vercel deployment status before retrying; no duplicate deployment was submitted automatically.');
      if (failure.code.startsWith('MISSING_')) console.error('Save the named key in Codex environment Secrets and run this command during setup, where those Secrets are available.');
      process.exitCode = 1;
    });
  }
}
