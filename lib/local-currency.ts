// Local-currency conversion for USD costs.
// Rates are fetched at runtime and cached in memory (revision + fetchedAt),
// mirroring the models.dev pricing catalog pattern: stale-but-usable data is
// preferred over failing, and any error falls back to plain USD display.

const RATES_ENDPOINT = "https://open.er-api.com/v6/latest/USD";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type ExchangeRateSnapshot = {
  rates: Record<string, number>;
  fetchedAt: number;
};

let cachedSnapshot: ExchangeRateSnapshot | null = null;
let inFlightRequest: Promise<ExchangeRateSnapshot | null> | null = null;

async function requestRates(): Promise<ExchangeRateSnapshot | null> {
  try {
    const response = await fetch(RATES_ENDPOINT, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      result?: string;
      rates?: Record<string, number>;
    };
    if (payload.result !== "success" || !payload.rates) return null;
    return { rates: payload.rates, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

async function loadRates(): Promise<ExchangeRateSnapshot | null> {
  if (cachedSnapshot && Date.now() - cachedSnapshot.fetchedAt < REFRESH_INTERVAL_MS) {
    return cachedSnapshot;
  }
  if (!inFlightRequest) {
    inFlightRequest = requestRates().then((snapshot) => {
      if (snapshot) cachedSnapshot = snapshot;
      inFlightRequest = null;
      return snapshot ?? cachedSnapshot;
    });
  }
  return inFlightRequest;
}

export type LocalCurrency = {
  locale: string;
  currency: string;
};

// Region -> currency for common locales; anything unmapped stays in USD.
const REGION_CURRENCIES: Record<string, string> = {
  US: "USD",
  IN: "INR",
  GB: "GBP",
  CA: "CAD",
  AU: "AUD",
  NZ: "NZD",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  BE: "EUR",
  AT: "EUR",
  PT: "EUR",
  IE: "EUR",
  FI: "EUR",
  GR: "EUR",
  SK: "EUR",
  SI: "EUR",
  HR: "EUR",
  EE: "EUR",
  LV: "EUR",
  LT: "EUR",
  LU: "EUR",
  CY: "EUR",
  MT: "EUR",
  JP: "JPY",
  KR: "KRW",
  CN: "CNY",
  HK: "HKD",
  TW: "TWD",
  SG: "SGD",
  MY: "MYR",
  TH: "THB",
  ID: "IDR",
  PH: "PHP",
  VN: "VND",
  PK: "PKR",
  BD: "BDT",
  LK: "LKR",
  NP: "NPR",
  BR: "BRL",
  MX: "MXN",
  AR: "ARS",
  CL: "CLP",
  CO: "COP",
  PE: "PEN",
  UY: "UYU",
  ZA: "ZAR",
  NG: "NGN",
  KE: "KES",
  EG: "EGP",
  MA: "MAD",
  AE: "AED",
  SA: "SAR",
  QA: "QAR",
  IL: "ILS",
  TR: "TRY",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  PL: "PLN",
  CZ: "CZK",
  HU: "HUF",
  RO: "RON",
  BG: "BGN",
  UA: "UAH",
  RU: "RUB",
  IS: "ISK",
};

function regionForLocale(tag: string): string | null {
  const explicit = /[-_]([A-Za-z]{2})(?:[-_.@]|$)/.exec(tag);
  if (explicit) return explicit[1].toUpperCase();
  try {
    // Bare language tags ("en", "de") resolve their likely region when maximized.
    return new Intl.Locale(tag).maximize().region ?? null;
  } catch {
    return null;
  }
}

export function localCurrency(): LocalCurrency {
  let tag = "en-US";
  try {
    tag = Intl.NumberFormat().resolvedOptions().locale || tag;
  } catch {
    // Fall through with the default tag.
  }
  const region = regionForLocale(tag);
  const currency = region ? REGION_CURRENCIES[region] : undefined;
  return { locale: tag, currency: currency ?? "USD" };
}

export function formatLocalMoney(valueUsd: number, info: LocalCurrency, rate: number): string {
  const amount = valueUsd * rate;
  return new Intl.NumberFormat(info.locale, {
    style: "currency",
    currency: info.currency,
    minimumFractionDigits: amount >= 100 ? 0 : 2,
    maximumFractionDigits: amount >= 100 ? 0 : 2,
  }).format(amount);
}

// Resolves the USD -> local-currency rate for this browser, or null when the
// local currency is USD or no rate is available (offline, bad response, etc.).
export async function usdToLocalRate(currency: string): Promise<number | null> {
  if (currency === "USD") return null;
  const snapshot = await loadRates();
  const rate = snapshot?.rates[currency];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}
