import { pathToFileURL } from 'node:url';

const PROJECT = Object.freeze({
  vercelId: 'prj_R9ghX1USsX04IwvFRJYN4vY8U1tK',
  vercelTeam: 'team_4zZUxLEnbWP7KnDSrjuOlQnp',
  neonId: 'still-thunder-13359416',
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => typeof value === 'string' && value.trim().length > 0;

// Inspect transport errors without returning their text: proxy URLs and echoed
// credentials may appear in messages, nested causes, and AggregateErrors.
export function classifyTransportFailure(error) {
  const pending = [error];
  const seen = new Set();
  let timeout = false;
  for (let count = 0; pending.length && count < 32; count++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const message = typeof current.message === 'string' ? current.message : '';
    if (/\bproxy\b[^\n]*\b403\b|\b403\b[^\n]*\bproxy\b/i.test(message)) return 'network_blocked';
    timeout ||= current.name === 'TimeoutError' || current.code === 'UND_ERR_CONNECT_TIMEOUT';
    pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return timeout ? 'timeout' : 'connection_failed';
}

function validSession(data) {
  return object(data) && data.user === null && typeof data.needsSetup === 'boolean'
    && (data.requiresSetupToken === undefined || typeof data.requiresSetupToken === 'boolean');
}

function validConfig(data) {
  return object(data) && typeof data.didubeName === 'string' && typeof data.didubeAddress === 'string'
    && Array.isArray(data.stops) && data.stops.every(stop => object(stop)
      && Number.isInteger(stop.id) && stop.id > 0 && typeof stop.name === 'string'
      && typeof stop.address === 'string' && typeof stop.active === 'boolean');
}

/** Read-only preflight for established resources; never creates admins or data. */
export async function checkConnections({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const bindings = {
    VERCEL_TOKEN: present(env.VERCEL_TOKEN),
    NEON_API_KEY: present(env.NEON_API_KEY),
    ADMIN_SETUP_TOKEN: present(env.ADMIN_SETUP_TOKEN),
  };
  const specs = [
    {
      id: 'vercel_project', binding: 'VERCEL_TOKEN',
      url: `https://api.vercel.com/v9/projects/${PROJECT.vercelId}?teamId=${PROJECT.vercelTeam}`,
      validate: data => object(data) && data.id === PROJECT.vercelId
        && data.accountId === PROJECT.vercelTeam && data.name === 'greentaxi',
    },
    {
      id: 'neon_project', binding: 'NEON_API_KEY',
      url: `https://console.neon.tech/api/v2/projects/${PROJECT.neonId}`,
      validate: data => object(data) && object(data.project) && data.project.id === PROJECT.neonId,
    },
    { id: 'public_session', url: 'https://green-taxi.ge/api/auth/session', validate: validSession },
    { id: 'public_config', url: 'https://green-taxi.ge/api/public/config', validate: validConfig },
    {
      id: 'admin_unauthenticated', url: 'https://green-taxi.ge/api/admin/bookings', expectedStatus: 401,
      validate: data => object(data) && typeof data.error === 'string' && data.code === 'UNAUTHORIZED',
    },
  ];
  const checks = await Promise.all(specs.map(async spec => {
    if (spec.binding && !bindings[spec.binding]) {
      return { id: spec.id, ok: false, result: 'missing_binding', binding: spec.binding, requestSent: false };
    }
    let response;
    try {
      response = await fetchImpl(spec.url, {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', ...(spec.binding ? { Authorization: `Bearer ${env[spec.binding]}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { id: spec.id, ok: false, result: classifyTransportFailure(error), requestSent: true };
    }
    const httpStatus = response.status;
    if (httpStatus !== (spec.expectedStatus ?? 200)) {
      await response.body?.cancel().catch(() => {});
      return { id: spec.id, ok: false, result: 'unexpected_http_status', httpStatus, requestSent: true };
    }
    let data;
    try { data = await response.json(); }
    catch { return { id: spec.id, ok: false, result: 'invalid_json', httpStatus, requestSent: true }; }
    if (!spec.validate(data)) {
      return { id: spec.id, ok: false, result: 'unexpected_payload', httpStatus, requestSent: true };
    }
    if (spec.id === 'public_session' && data.needsSetup) {
      return { id: spec.id, ok: false, result: 'existing_admin_missing', httpStatus, requestSent: true };
    }
    return { id: spec.id, ok: true, result: 'verified', httpStatus, requestSent: true };
  }));
  return { ok: checks.every(check => check.ok), bindings, adminSetupTokenRequired: false, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.execArgv.includes('--use-env-proxy')) {
    process.stderr.write('Run: node --use-env-proxy scripts/deployment/check-connections.mjs\n');
    process.exitCode = 2;
  } else {
    try {
      const report = await checkConnections();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    } catch {
      // Do not serialize unexpected errors or request/response objects.
      process.stderr.write('Connection checks could not complete. No credentials or response bodies are printed.\n');
      process.exitCode = 1;
    }
  }
}
