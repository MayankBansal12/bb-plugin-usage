import { Models, type ProviderMap } from "@opencode-ai/models";
import { pricingRevision, setPricingCatalog, type CatalogProvider } from "./pricing";

type Database = { prepare: (sql: string) => unknown };

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

type CatalogRow = { revision?: string; fetchedAt?: string; data?: string };

function readRow(db: Database) {
  const statement = db.prepare("SELECT revision, fetched_at fetchedAt, data FROM pricing_catalog WHERE id=1") as {
    get: (...args: unknown[]) => CatalogRow | undefined;
  };
  return statement.get();
}

function saveRow(db: Database, revision: string, fetchedAt: string, data: string) {
  const statement = db.prepare(`INSERT INTO pricing_catalog (id, revision, fetched_at, data) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, fetched_at=excluded.fetched_at, data=excluded.data`) as {
    run: (...args: unknown[]) => unknown;
  };
  statement.run(revision, fetchedAt, data);
}

function parseCatalog(raw: string) {
  try {
    const providers = JSON.parse(raw) as ProviderMap;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
    return providers as unknown as Record<string, CatalogProvider>;
  } catch {
    return null;
  }
}

function activate(raw: string, revision: string | undefined) {
  if (!revision) return false;
  const providers = parseCatalog(raw);
  if (!providers) return false;
  setPricingCatalog(providers, revision);
  return true;
}

export function activateCachedCatalog(db: Database): string {
  const cached = readRow(db);
  if (cached?.data && activate(cached.data, cached.revision)) return cached.revision!;
  return pricingRevision();
}

export async function refreshCatalog(db: Database, fetchImpl?: typeof globalThis.fetch): Promise<string> {
  const cached = readRow(db);
  if (cached?.fetchedAt && cached.data && cached.revision) {
    const age = Date.now() - Date.parse(cached.fetchedAt);
    if (Number.isFinite(age) && age < REFRESH_INTERVAL_MS && parseCatalog(cached.data)) {
      return cached.revision;
    }
  }

  try {
    const providers = await Models.make({ fetch: fetchImpl }).providers({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const fetchedAt = new Date().toISOString();
    const data = JSON.stringify(providers);
    const revision = cached?.data === data && cached.revision ? cached.revision : `models.dev@${fetchedAt}`;
    try {
      saveRow(db, revision, fetchedAt, data);
    } catch {
      // Caching is best-effort; the in-memory catalog still activates.
    }
    return revision;
  } catch {
    return cached?.revision ?? pricingRevision();
  }
}
