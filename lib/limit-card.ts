import { maskEmailAddresses, type UnifiedProviderLimit } from "./provider-limits";

export type LimitCardNotice = {
  // One short line; the card already names the provider.
  title: string;
  // Visible with the details closed so cached values never pass as fresh.
  stale: { label: string; at: string | null; partial?: true } | null;
  // Full masked diagnostics, one entry per failing source.
  details: string[];
};

export type LimitStatusTag = { label: string; tone: "danger" | "muted" };

const AUTH_ERROR = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid_grant|refresh_token|not (?:signed|logged) in|sign in again|log in again/i;

function relativeAge(at: string, now: number) {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function limitAccountLabel(limit: UnifiedProviderLimit) {
  const email = limit.accountEmail?.trim() ?? "";
  const label = limit.poolAccount?.label.trim() ?? "";
  if (!email) return maskEmailAddresses(label);
  if (!label || label.toLowerCase() === email.toLowerCase()) return maskEmailAddresses(email);
  // Default pool labels can already contain the email plus a machine name.
  if (label.toLowerCase().includes(email.toLowerCase())) return maskEmailAddresses(label);
  return `${maskEmailAddresses(email)} · ${maskEmailAddresses(label)}`;
}

export function limitCardNotice(limit: UnifiedProviderLimit, now = Date.now(), requestFailed = false): LimitCardNotice | null {
  const error = limit.error ?? (requestFailed ? "Couldn’t refresh usage limits." : null);
  if (!error) return null;
  const failedMachines = limit.poolAccount
    ? []
    : limit.machines.filter((machine) => machine.status === "error" || machine.error);
  const partial = !requestFailed && limit.status === "ok";
  const details = failedMachines.length > 1 || (partial && failedMachines.length > 0)
    ? failedMachines.map((machine) => `${machine.machineName}: ${machine.error ?? error}`)
    : [error];
  // Names stay in the details so the summary is one line however many fail.
  const machines = !partial || failedMachines.length === 0 ? null
    : failedMachines.length === 1 ? failedMachines[0]!.machineName : `${failedMachines.length} machines`;
  const title = requestFailed ? "Couldn’t refresh limits" : AUTH_ERROR.test(error)
    ? `Authentication failed${limit.poolAccount ? " in Account Pooler" : machines ? ` on ${machines}` : ""}`
    : limit.poolAccount
      ? "Account Pooler couldn’t refresh"
      : partial
        ? `Couldn’t refresh ${machines ?? "some sources"}`
        : limit.windows.length > 0 ? "Couldn’t refresh limits" : "Couldn’t load limits";
  const updatedAt = limit.lastUpdatedAt && Number.isFinite(Date.parse(limit.lastUpdatedAt)) ? limit.lastUpdatedAt : null;
  const age = updatedAt ? relativeAge(updatedAt, now) : null;
  const hasLocalValues = !requestFailed && Boolean(limit.poolAccount) && limit.machines.some((machine) => machine.status === "ok" && machine.windows.length > 0);
  const stale = (requestFailed || limit.status === "error") && limit.windows.length > 0
    ? hasLocalValues
      ? { label: "Some sources could not refresh", at: null, partial: true as const }
      : { label: age ? `Showing values from ${age}` : "Showing last reported values", at: updatedAt }
    : null;
  if (hasLocalValues && updatedAt) details.push(`Account Pooler last updated ${new Date(updatedAt).toLocaleString()}`);
  return { title: maskEmailAddresses(title), stale, details: details.map(maskEmailAddresses) };
}

export function limitStatusTag(limit: UnifiedProviderLimit): LimitStatusTag | null {
  const status = limit.poolAccount?.status;
  if (!status || status === "ready") return null;
  // The error notice already says this; a second "Error" tag is noise.
  if (status === "error") return limit.error ? null : { label: "Error", tone: "danger" };
  if (status === "exhausted") return { label: "Limit reached", tone: "danger" };
  return { label: status.charAt(0).toUpperCase() + status.slice(1), tone: "muted" };
}
