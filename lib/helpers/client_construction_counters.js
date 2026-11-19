/*
 * Client construction counters.
 *
 * The Client ID Metadata Document hit path resolves a client on every request
 * carrying a Client Identifier URL. Caching the fetched document alone does not
 * keep that path cheap when the client itself (metadata validation and key
 * store assembly) is rebuilt per request. These counters make the construction
 * cost of a fixed batch of repeated requests observable per client source:
 *
 * - full.metadataDocument: complete constructions of clients resolved from a
 *   Client ID Metadata Document, i.e. the ones that run schema validation and
 *   assemble the asymmetric/symmetric key stores.
 * - instances.metadataDocument: per-request instantiations served from a
 *   construction prepared for the current metadata document version.
 * - full.static: complete constructions of clients registered through the
 *   `clients` configuration option (the control group).
 * - documentFetches: outbound Client ID Metadata Document fetches.
 *
 * Counters are scoped per provider and monotonic for its lifetime. No external
 * dependencies, so readings reproduce identically in the test environment.
 */
const counters = new WeakMap();

function countersFor(provider) {
  let entry = counters.get(provider);
  if (!entry) {
    entry = {
      full: { metadataDocument: 0, static: 0 },
      instances: { metadataDocument: 0 },
      documentFetches: 0,
    };
    counters.set(provider, entry);
  }
  return entry;
}

export function recordClientConstruction(provider, source) {
  countersFor(provider).full[source] += 1;
}

export function recordClientInstance(provider, source) {
  countersFor(provider).instances[source] += 1;
}

export function recordMetadataDocumentFetch(provider) {
  countersFor(provider).documentFetches += 1;
}

export function clientConstructionCounters(provider) {
  const { full, instances, documentFetches } = countersFor(provider);
  return { full: { ...full }, instances: { ...instances }, documentFetches };
}
