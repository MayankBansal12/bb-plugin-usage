import { z } from "zod";
import type { ProviderLimitWindow } from "./provider-limits";

// Contract: xai-org/grok-build, xai-grok-shell/src/extensions/billing.rs.
// Kept self-contained because this function also runs on the enrolled host.
export function normalizeGrokBilling(payload: unknown): ProviderLimitWindow[] {
  const data = payload as { config?: Record<string, any> | null };
  if (!data || !Object.prototype.hasOwnProperty.call(data, "config")) throw new Error("Grok billing response had an unexpected shape.");
  if (data.config === null) return [];
  const c = data.config;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Grok billing response had an unexpected shape.");
  const cents = (value: any): number | null => {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Grok billing response contained invalid credits.");
    const n = value.val === undefined ? 0 : typeof value.val === "string" && /^\d+$/.test(value.val) ? Number(value.val) : value.val;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Grok billing response contained invalid credits.");
    return n;
  };
  const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const limit = cents(c.monthlyLimit);
  const used = cents(c.used) ?? 0;
  const percent = c.creditUsagePercent ?? (limit && limit > 0 ? used / limit * 100 : null);
  const windows: ProviderLimitWindow[] = [];
  if (percent !== null) {
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) throw new Error("Grok billing response contained an invalid usage percentage.");
    const period = c.currentPeriod?.type;
    const label = period === "USAGE_PERIOD_TYPE_WEEKLY" ? "Weekly" : period === "USAGE_PERIOD_TYPE_MONTHLY" || (!c.currentPeriod && limit !== null) ? "Monthly" : "Current period";
    windows.push({ label: `${label}${c.isUnifiedBillingUser === true ? " (shared credits)" : " credits"}`, usedPercent: Math.min(100, percent), resetsAt: date(c.currentPeriod?.end ?? c.billingPeriodEnd) });
  }
  const cap = cents(c.onDemandCap);
  if (cap !== null && cap > 0) {
    const spent = cents(c.onDemandUsed) ?? Math.max(0, used - (limit ?? 0));
    windows.push({ label: "On-demand", usedPercent: Math.min(100, spent / cap * 100), resetsAt: date(c.billingPeriodEnd), cost: { usedUsdCents: spent, limitUsdCents: cap } });
  }
  if (!windows.length) throw new Error("Grok billing response contained no limit windows.");
  return windows;
}

export const grokLimitSnapshotSchema = z.object({
  accountIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  windows: z.array(z.object({
    label: z.string().max(100), usedPercent: z.number().min(0).max(100), resetsAt: z.string().nullable(),
    cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).optional(),
  })).max(2),
});

export function grokLimitsCommand() {
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const normalize = ${normalizeGrokBilling.toString()};
(async () => {
  const authPath = process.env.GROK_AUTH_PATH || path.join(process.env.GROK_HOME || path.join(require('node:os').homedir(), '.grok'), 'auth.json');
  let store;
  try { store = JSON.parse(fs.readFileSync(authPath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') { console.log('__BB_USAGE_ERROR__:no-grok-credential'); return; } throw new Error('Grok auth file could not be read or was invalid JSON.'); }
  // Only first-party production scopes: never forward third-party IdP credentials.
  const auth = store['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'] || store['https://accounts.x.ai/sign-in'];
  if (!auth || auth.auth_mode === 'api_key') { console.log('__BB_USAGE_ERROR__:no-grok-credential'); return; }
  if (typeof auth.key !== 'string' || !auth.key || typeof auth.user_id !== 'string' || !auth.user_id) throw new Error('Grok login credential is invalid. Run grok login.');
  let response;
  try { response = await fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
    headers: { Authorization: 'Bearer ' + auth.key, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-userid': auth.user_id },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  }); } catch { throw new Error('Grok billing request failed.'); }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Grok login expired or billing access denied. Run grok login and refresh.' : 'Grok billing request returned HTTP ' + response.status + '.');
  let body = ''; const reader = response.body.getReader();
  while (true) { const part = await reader.read(); if (part.done) break; body += Buffer.from(part.value).toString('utf8'); if (body.length > 262144) { await reader.cancel(); throw new Error('Grok billing response was too large.'); } }
  let payload; try { payload = JSON.parse(body); } catch { throw new Error('Grok billing response was not valid JSON.'); }
  const windows = normalize(payload);
  if (!windows.length) { console.log('__BB_USAGE_ERROR__:no-grok-plan'); return; }
  const accountIdentity = crypto.createHash('sha256').update(JSON.stringify([auth.user_id, auth.team_id || null, auth.principal_id || null])).digest('hex');
  console.log('__BB_USAGE_BEGIN__');
  console.log(JSON.stringify({ accountIdentity, windows }));
  console.log('__BB_USAGE_END__:0');
})().catch(e => { console.log('__BB_USAGE_ERROR__:' + e.message); process.exitCode = 1; });`;
  return `set +x; if ! command -v node >/dev/null 2>&1; then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to collect Grok limits.'; exit 127; fi; node -e '${script.replace(/'/g, `'\\''`)}'`;
}
