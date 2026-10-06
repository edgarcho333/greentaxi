// Prepared from the verified official @neondatabase/api-client 2.7.3 OpenAPI.
// Importing this module makes no requests. It never writes credentials or DSNs to disk.
import { pathToFileURL } from 'node:url';

const API = 'https://console.neon.tech/api/v2';
const identifier = (value) => encodeURIComponent(String(value));
const freePlan = (value) => ['free', 'free_v2', 'free_v3'].includes(String(value).toLowerCase());

export class NeonRequestError extends Error {
  constructor(status, operation) {
    super(`Neon request ${operation} failed (${status}).`);
    this.status = status;
  }
}

async function request(key, path, { method = 'GET', body } = {}) {
  if (!key || !String(key).trim()) throw new Error('Neon API key is unavailable in this process.');
  let response;
  try {
    response = await fetch(API + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // No credential-bearing headers, request bodies or fetch exception causes are exposed.
    throw new NeonRequestError('network', `${method} ${path.split('?')[0]}`);
  }
  if (!response.ok) throw new NeonRequestError(response.status, `${method} ${path.split('?')[0]}`);
  try { return await response.json(); }
  catch { throw new NeonRequestError('invalid-json', `${method} ${path.split('?')[0]}`); }
}

async function pages(key, path, field, query = {}) {
  const values = [];
  let cursor;
  do {
    const parameters = new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) });
    const page = await request(key, `${path}?${parameters}`);
    values.push(...(page[field] ?? []));
    const next = page.pagination?.cursor;
    if (next === cursor) break;
    cursor = next;
  } while (cursor);
  return values;
}

export async function inspectNeon(key) {
  const [auth, organizationsResult] = await Promise.all([
    request(key, '/auth'), request(key, '/users/me/organizations'),
  ]);
  const organizations = organizationsResult.organizations ?? [];
  const scopes = await Promise.all(organizations.map(async (organization) => ({
    organization,
    projects: await pages(key, '/projects', 'projects', { org_id: organization.id, search: 'greentaxi', limit: '400' }),
  })));
  return {
    authMethod: auth.auth_method,
    // Deliberately exclude auth_data, user names, emails, hosts, keys and any connection strings.
    organizations: scopes.map(({ organization, projects }) => ({
      id: organization.id, plan: organization.plan, managedBy: organization.managed_by,
      projects: projects.filter((project) => project.name?.toLowerCase() === 'greentaxi').map((project) => ({
        id: project.id, name: project.name, regionId: project.region_id, pgVersion: project.pg_version,
      })),
    })),
  };
}

async function waitOperations(key, projectId, operations, timeoutMs = 50_000) {
  const pending = new Map(operations.filter((operation) => !['finished', 'skipped'].includes(operation.status))
    .map((operation) => [operation.id, operation.status]));
  const until = Date.now() + timeoutMs;
  while (pending.size && Date.now() < until) {
    const results = await Promise.all([...pending.keys()].map(async (id) => {
      const result = await request(key, `/projects/${identifier(projectId)}/operations/${identifier(id)}`);
      return result.operation;
    }));
    for (const operation of results) {
      if (!operation) throw new Error('Neon operation response is incomplete.');
      if (['failed', 'error', 'cancelled'].includes(operation.status)) {
        throw new Error(`Neon project operation did not finish successfully (${operation.status}).`);
      }
      if (['finished', 'skipped'].includes(operation.status)) pending.delete(operation.id);
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (pending.size) throw new Error('Neon project provisioning is still pending; query operation status before continuing.');
}

export async function prepareNeonConnection(key, {
  orgId, allowCreate = false, databaseName, regionId = 'aws-eu-central-1',
} = {}) {
  // ROOT MUST FIRST VERIFY ACCESS AND AUTHORIZE THE CREATE STEP. No implicit creation.
  const inspection = await inspectNeon(key);
  let scope;
  if (orgId) {
    scope = inspection.organizations.find((organization) => organization.id === orgId);
    if (!scope) throw new Error('Selected Neon organization is not available to this key.');
  } else {
    const withProject = inspection.organizations.filter((organization) => organization.projects.length);
    if (withProject.length === 1) scope = withProject[0];
    else if (withProject.length > 1) throw new Error('Multiple organizations contain greentaxi; select orgId explicitly.');
    else {
      const freeOrganizations = inspection.organizations.filter((organization) => freePlan(organization.plan));
      if (freeOrganizations.length !== 1) throw new Error('Select a single existing free Neon organization explicitly.');
      scope = freeOrganizations[0];
    }
  }
  if (scope.projects.length > 1) throw new Error('Multiple greentaxi projects exist in selected organization; resolve explicitly.');
  let project = scope.projects[0];
  let created = false;
  if (!project) {
    if (!allowCreate) throw new Error('No greentaxi project exists; allowCreate is false.');
    if (!freePlan(scope.plan)) throw new Error('Creating a project on a paid or unknown plan is outside this free-project operation.');
    const regions = (await request(key, `/regions?${new URLSearchParams({ org_id: scope.id })}`)).regions ?? [];
    if (!regions.some((region) => region.region_id === regionId)) throw new Error('Selected European Neon region is unavailable to this organization.');
    // Intentionally no billing changes, paid plan upgrades or custom autoscaling overrides.
    // POST is never automatically retried: after a timeout, list projects before any retry.
    const result = await request(key, '/projects', {
      method: 'POST', body: { project: { name: 'greentaxi', org_id: scope.id, pg_version: 17, region_id: regionId } },
    });
    project = { id: result.project?.id, name: result.project?.name, pgVersion: result.project?.pg_version,
      regionId: result.project?.region_id };
    if (!project.id) throw new Error('Neon creation response has no project ID; list projects before retrying.');
    // result includes passwords and connection_uris; they remain in process memory and are never logged.
    await waitOperations(key, project.id, result.operations ?? []);
    created = true;
  }
  if (project.pgVersion !== 17) throw new Error('Existing greentaxi project is not PostgreSQL 17; do not silently upgrade it.');
  const branches = await pages(key, `/projects/${identifier(project.id)}/branches`, 'branches', { limit: '100' });
  const branch = branches.find((candidate) => candidate.default);
  if (!branch) throw new Error('Project default branch was not found.');
  const result = await request(key, `/projects/${identifier(project.id)}/branches/${identifier(branch.id)}/databases`);
  const databases = (result.databases ?? []).filter((database) => !['postgres', 'template0', 'template1'].includes(database.name));
  let database;
  if (databaseName) database = databases.find((candidate) => candidate.name === databaseName);
  else database = databases.find((candidate) => candidate.name === 'greentaxi')
    ?? databases.find((candidate) => candidate.name === 'neondb')
    ?? (databases.length === 1 ? databases[0] : undefined);
  if (!database?.owner_name) throw new Error('Select an existing application database explicitly.');
  const parameters = new URLSearchParams({ branch_id: branch.id, database_name: database.name,
    role_name: database.owner_name, pooled: 'true' });
  const connection = await request(key, `/projects/${identifier(project.id)}/connection_uri?${parameters}`);
  const uri = new URL(connection.uri);
  if (!['postgres:', 'postgresql:'].includes(uri.protocol) || !uri.hostname.endsWith('.neon.tech')
      || !uri.hostname.split('.')[0].endsWith('-pooler')) {
    throw new Error('Neon did not return an expected pooled PostgreSQL URI.');
  }
  // Preserve supplied TLS parameters; normalize sslmode=require without disabling driver verification.
  uri.searchParams.set('sslmode', 'require');
  const output = { projectId: project.id, orgId: scope.id, branchId: branch.id,
    databaseName: database.name, roleName: database.owner_name, regionId: project.regionId, created };
  // Avoid leaking a secret through casual console.log or JSON.stringify of the returned object.
  Object.defineProperty(output, 'databaseUrl', { value: uri.toString(), enumerable: false });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'inspect') {
    console.log('Prepared Neon helper. Only CLI mode: inspect (read-only). Provisioning requires imported function and explicit allowCreate.');
  } else {
    try {
      const key = process.env.NEON_API_KEY ?? process.env.NEON_API_TOKEN;
      console.log(JSON.stringify(await inspectNeon(key)));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
