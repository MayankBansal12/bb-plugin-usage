import { z } from "zod";
import { clampPercent } from "./provider-limits";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export type OpenCodeGoLimitWindow = {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};

const goWindowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().min(0),
  resetsAt: z.string().nullish(),
});

const goUsageSchema = z.object({
  usage: z.object({
    rolling: goWindowSchema.optional(),
    weekly: goWindowSchema.optional(),
    monthly: goWindowSchema.optional(),
  }),
});

const GO_WINDOWS = [
  { key: "rolling", label: "Rolling (5h)" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
] as const;

export function openCodeGoUsageCommand() {
  return [
    `auth_path="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"`,
    `if ! command -v curl >/dev/null 2>&1; then printf '%s\\n' '__BB_USAGE_ERROR__:curl is required to collect OpenCode Go limits.'; exit 127; fi`,
    `bb_usage_go_key=''`,
    `if command -v jq >/dev/null 2>&1; then bb_usage_go_key=$(jq -r '."opencode-go" | select(.type == "api") | (.key // .api_key // empty)' "$auth_path" 2>/dev/null)`,
    `elif command -v node >/dev/null 2>&1; then bb_usage_go_key=$(node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{};const e=d?.["opencode-go"];process.stdout.write(String(e?.type==="api"?(e.key??e.api_key??""):""))' "$auth_path" 2>/dev/null)`,
    `else printf '%s\\n' '__BB_USAGE_ERROR__:jq or Node.js is required to read the OpenCode Go credential.'; exit 127`,
    `fi`,
    `if [ -z "$bb_usage_go_key" ]; then printf '%s\\n' '__BB_USAGE_ERROR__:no-opencode-go-credential'; exit 1; fi`,
    `bb_usage_go_body=$(mktemp)`,
    `trap 'rm -f "$bb_usage_go_body"' EXIT`,
    `trap 'exit 130' HUP INT TERM`,
    `bb_usage_go_http=$(printf 'Authorization: Bearer %s\\n' "$bb_usage_go_key" | curl -sS -m 20 -H @- -o "$bb_usage_go_body" -w '%{http_code}' '${OPENCODE_GO_USAGE_URL}')`,
    `bb_usage_go_status=$?`,
    `if [ "$bb_usage_go_status" -ne 0 ]; then printf '%s\\n' '__BB_USAGE_ERROR__:OpenCode Go usage request failed.'; exit "$bb_usage_go_status"; fi`,
    `if [ "$bb_usage_go_http" = 403 ]; then printf '%s\\n' '__BB_USAGE_ERROR__:no-opencode-go-plan'; exit 1; fi`,
    `if [ "$bb_usage_go_http" != 200 ]; then printf '%s\\n' "__BB_USAGE_ERROR__:OpenCode Go usage request returned HTTP $bb_usage_go_http."; exit 1; fi`,
    `printf '%s\\n' '__BB_USAGE_BEGIN__'`,
    `cat "$bb_usage_go_body"`,
    `printf '\\n%s\\n' '__BB_USAGE_END__:0'`,
  ].join("; ");
}

export function parseOpenCodeGoUsage(json: string): OpenCodeGoLimitWindow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("OpenCode Go usage response was not valid JSON.");
  }
  const parsed = goUsageSchema.safeParse(payload);
  if (!parsed.success) throw new Error("OpenCode Go usage response had an unexpected shape.");
  return GO_WINDOWS.flatMap(({ key, label }) => {
    const window = parsed.data.usage[key];
    if (!window) return [];
    const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    return [{
      label,
      usedPercent: clampPercent(window.percent),
      resetsAt: Number.isFinite(resetsAtMs) ? window.resetsAt! : null,
    }];
  });
}
