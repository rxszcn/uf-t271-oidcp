import { WEB_URI } from '../consts/client_attributes.js';
import addClient from './add_client.js';
import als from './als.js';
import { recordMetadataDocumentFetch } from './client_construction_counters.js';
import { boolean } from './configuration_result.js';
import { InvalidClient, InvalidClientMetadata, OIDCProviderError } from './errors.js';
import fetchBodyCheck from './fetch_body_check.js';
import fetchRequest from './fetch_request.js';
import LRU from './lru.js';
import instance from './weak_cache.js';

const FORBIDDEN_AUTH_METHODS = new Set([
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
]);

function hasForbiddenRawUrlCodePoint(input) {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code <= 0x20 || code === 0x5c || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const cache = new WeakMap();
const pending = new WeakMap();

function getCache(provider) {
  let entries = cache.get(provider);
  if (!entries) {
    entries = new LRU({ maxSize: 100 });
    cache.set(provider, entries);
  }
  return entries;
}

function getPending(provider) {
  let requests = pending.get(provider);
  if (!requests) {
    requests = new Map();
    pending.set(provider, requests);
  }
  return requests;
}

export function isValidClientIdUrl(id) {
  if (
    !/^https:\/\//iu.test(id)
    || hasForbiddenRawUrlCodePoint(id)
  ) {
    return false;
  }

  const url = URL.parse(id);

  if (!url) {
    return false;
  }

  // MUST have an "https" scheme
  if (url.protocol !== 'https:') {
    return false;
  }

  const afterScheme = id.slice('https://'.length);
  const authorityEnd = afterScheme.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (!authority) {
    return false;
  }

  // MUST NOT contain single-dot or double-dot path segments
  // URL.parse normalizes dot segments and treats an absent path and "/" equivalently.
  const pathStart = afterScheme.search(/[/?#]/u);
  const rawPath = pathStart !== -1 && afterScheme[pathStart] === '/'
    ? afterScheme.slice(pathStart).split('?')[0].split('#')[0]
    : '/';

  // MUST contain a path component other than "/".
  if (rawPath === '/') {
    return false;
  }

  const rawSegments = rawPath.split('/');
  if (rawSegments.some((seg) => {
    const dotNormalized = seg.replace(/%2e/giu, '.');
    return dotNormalized === '.' || dotNormalized === '..';
  })) {
    return false;
  }

  // MUST NOT contain a fragment component
  if (id.includes('#')) {
    return false;
  }

  // MUST NOT contain a username or password
  if (authority.includes('@')) {
    return false;
  }

  return true;
}

function parseCacheDuration(response, { min, max }) {
  let duration;

  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    const maxAgeMatch = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
    if (maxAgeMatch) {
      duration = parseInt(maxAgeMatch[1], 10);
    }
  }

  if (duration === undefined) {
    const expires = response.headers.get('expires');
    if (expires) {
      const expiresDate = Date.parse(expires);
      if (!Number.isNaN(expiresDate)) {
        duration = Math.floor((expiresDate - Date.now()) / 1000);
      }
    }
  }

  if (duration === undefined) {
    duration = min;
  }

  return Math.max(min, Math.min(max, duration));
}

async function fetchMetadataDocument(provider, id, cacheDuration) {
  recordMetadataDocumentFetch(provider);

  let response;
  try {
    response = await fetchRequest(provider, id, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      redirect: 'manual',
    });
  } catch (cause) {
    throw new InvalidClient('client_id metadata document fetch failed', { cause });
  }

  if (response.status !== 200) {
    throw new InvalidClient('client_id metadata document fetch failed', `unexpected response status ${response.status}`, { cause: response });
  }

  let bodyText;
  try {
    bodyText = (await fetchBodyCheck(provider, 'client_id metadata document', response)).toString();
  } catch (cause) {
    throw new InvalidClient('client_id metadata document fetch failed', { cause });
  }

  let properties;
  try {
    properties = JSON.parse(bodyText);
  } catch (cause) {
    throw new InvalidClient('client_id metadata document fetch failed', { cause });
  }

  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new InvalidClientMetadata('client_id metadata document is not a JSON object');
  }

  // client_id property MUST match the URL via simple string comparison
  if (properties.client_id !== id) {
    throw new InvalidClientMetadata('client_id metadata document client_id does not match the expected value');
  }

  // Neither authentication property may declare a shared-secret method.
  if (
    FORBIDDEN_AUTH_METHODS.has(properties.token_endpoint_auth_method)
    || (Array.isArray(properties.token_endpoint_auth_methods_supported)
      && properties.token_endpoint_auth_methods_supported.some((method) => FORBIDDEN_AUTH_METHODS.has(method)))
  ) {
    throw new InvalidClientMetadata('client_id metadata document must not use shared-secret token endpoint authentication methods');
  }

  // client_secret and client_secret_expires_at MUST NOT be present
  if ('client_secret' in properties || 'client_secret_expires_at' in properties) {
    throw new InvalidClientMetadata('client_id metadata document must not contain client_secret or client_secret_expires_at');
  }

  // URI properties MUST be absolute URIs using the https: scheme
  for (const prop of WEB_URI) {
    if (prop in properties) {
      const uri = URL.parse(properties[prop]);
      if (!uri || uri.protocol !== 'https:') {
        throw new InvalidClientMetadata(`client_id metadata document ${prop} must be an https: URL`);
      }
    }
  }

  return {
    properties,
    maxAge: parseCacheDuration(response, cacheDuration) * 1000,
  };
}

// Completes metadata validation and key store assembly once per metadata
// document version. `Client.instantiate` then serves every request that hits
// the cached entry without repeating the schema work, while still producing a
// distinct client per request for request-scoped processing and `allowClient`.
async function prepareClient(provider, properties) {
  const client = await addClient(provider, properties, { cimd: true });
  Object.defineProperty(client, 'clientIdMetadataDocument', { value: true });
  return provider.Client.prepare(client);
}

async function assertClientAllowed(feature, ctx, client) {
  if (!boolean(
    await feature.allowClient(ctx, client),
    'features.clientIdMetadataDocument.allowClient',
  )) {
    throw new InvalidClient('client is not allowed');
  }
}

function instantiateClient(provider, entry) {
  return provider.Client.instantiate(entry.prepared);
}

async function resolveCachedClient(provider, feature, ctx, entry) {
  const client = instantiateClient(provider, entry);
  await assertClientAllowed(feature, ctx, client);
  return client;
}

async function resolveClient(provider, id) {
  const {
    features: { clientIdMetadataDocument: feature },
  } = instance(provider).configuration;

  const ctx = als.getStore();

  // Avoid confusing the client identity with the authorization server's identity.
  if (id === provider.issuer) {
    throw new InvalidClient('client_id must not equal the authorization server issuer');
  }

  const entries = getCache(provider);

  let entry = entries.get(id);
  if (entry) {
    return resolveCachedClient(provider, feature, ctx, entry);
  }

  if (!boolean(
    await feature.allowFetch(ctx, id),
    'features.clientIdMetadataDocument.allowFetch',
  )) {
    throw new InvalidClient('client_id metadata document fetch not allowed');
  }

  // Another request may have populated the cache while allowFetch was pending.
  entry = entries.get(id);
  if (entry) {
    return resolveCachedClient(provider, feature, ctx, entry);
  }

  // Concurrent first requests share one fetch and one full construction.
  const requests = getPending(provider);
  let request = requests.get(id);
  if (!request) {
    request = (async () => {
      const fetched = await fetchMetadataDocument(provider, id, feature.cacheDuration);
      const resolved = { prepared: await prepareClient(provider, fetched.properties) };
      if (!entries.has(id)) {
        entries.set(id, resolved, { maxAge: fetched.maxAge });
      }
      return resolved;
    })();
    requests.set(id, request);
  }

  let resolved;
  try {
    resolved = await request;
  } finally {
    if (requests.get(id) === request) {
      requests.delete(id);
    }
  }

  const client = instantiateClient(provider, resolved);
  await assertClientAllowed(feature, ctx, client);

  return client;
}

export async function resolveClientByMetadataDocument(provider, id) {
  try {
    return await resolveClient(provider, id);
  } catch (cause) {
    const error = cause instanceof InvalidClientMetadata
      ? new InvalidClient(cause.error_description, { cause })
      : cause;

    // Discovery failures must never redirect, even if the error handler's
    // subsequent client lookup succeeds.
    if (error instanceof OIDCProviderError) {
      error.allow_redirect = false;
    }

    throw error;
  }
}
