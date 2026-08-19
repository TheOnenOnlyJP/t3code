// @effect-diagnostics nodeBuiltinImport:off -- This driver is the Node process boundary for its private cooldown file.
// @effect-diagnostics globalDate:off -- Time is injected for selection tests and persisted as interoperable ISO strings.
/**
 * Server-local Claude OAuth account pool.
 *
 * T3's Claude adapter owns long-lived SDK queries, so account failover has to
 * happen at that adapter boundary. Tokens are supplied only through the
 * server's environment and are never persisted; the state file contains
 * fingerprints and cooldown verdicts only.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const TOKEN_PREFIX = "T3_CLAUDE_CODE_OAUTH_TOKEN";
const LABEL_PREFIX = "T3_CLAUDE_CODE_OAUTH_LABEL";
const MAX_SLOTS = 9;
const PROBE_TTL_MS = 5 * 60 * 1000;
const BLIND_COOLDOWN_MS = 15 * 60 * 1000;
const INVALID_RECHECK_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8_000;
const HEALTH_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA = "oauth-2025-04-20";

const OAuthVerdict = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("healthy"),
    checkedAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("exhausted"),
    checkedAt: Schema.String,
    reason: Schema.String,
    resetsAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("invalid"),
    checkedAt: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    checkedAt: Schema.String,
    reason: Schema.String,
  }),
]);
type OAuthVerdict = typeof OAuthVerdict.Type;

interface OAuthAccountState {
  label: string;
  scopes: Record<string, OAuthVerdict>;
}

interface MutableOAuthState {
  version: 1;
  accounts: Record<string, OAuthAccountState>;
}

const OAuthState = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Record(
    Schema.String,
    Schema.Struct({
      label: Schema.String,
      scopes: Schema.Record(Schema.String, OAuthVerdict),
    }),
  ),
});
const decodeOAuthState = Schema.decodeUnknownExit(OAuthState);

type ClaudeOAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClaudeOAuthAccount {
  readonly id: string;
  readonly label: string;
  readonly tokenKey: string;
  readonly token: string;
  readonly fingerprint: string;
}

export type ClaudeOAuthFailure =
  | {
      readonly kind: "exhausted";
      readonly reason: string;
      readonly resetsAt?: string;
      readonly synthetic: boolean;
    }
  | {
      readonly kind: "invalid";
      readonly reason: string;
      readonly synthetic: boolean;
    };

export interface ClaudeOAuthPickResult {
  readonly account: ClaudeOAuthAccount | undefined;
  readonly lastResort: boolean;
  readonly earliestReset: string | undefined;
}

export interface ClaudeOAuthPoolSnapshot {
  readonly id: string;
  readonly label: string;
  readonly tokenKey: string;
  readonly fingerprint: string;
  readonly verdict: OAuthVerdict | undefined;
  readonly benched: boolean;
}

export interface ClaudeOAuthPool {
  readonly size: number;
  readonly pick: (input: {
    readonly model: string | undefined;
    readonly exclude?: ReadonlySet<string>;
  }) => Promise<ClaudeOAuthPickResult>;
  readonly markExhausted: (
    account: ClaudeOAuthAccount,
    input: {
      readonly model: string | undefined;
      readonly reason: string;
      readonly resetsAt?: string;
    },
  ) => void;
  readonly markInvalid: (account: ClaudeOAuthAccount, reason: string) => void;
  readonly markHealthy: (account: ClaudeOAuthAccount, model: string | undefined) => void;
  readonly environmentFor: (
    baseEnvironment: NodeJS.ProcessEnv,
    account: ClaudeOAuthAccount | undefined,
  ) => NodeJS.ProcessEnv;
  readonly earliestReset: (model: string | undefined) => string | undefined;
  readonly snapshot: (model: string | undefined) => ReadonlyArray<ClaudeOAuthPoolSnapshot>;
}

type ProbeVerdict =
  | { readonly kind: "healthy" }
  | { readonly kind: "exhausted"; readonly reason: string; readonly resetsAt?: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export const CLAUDE_OAUTH_CONTINUATION_PROMPT = [
  "The previous Claude OAuth account reached its usage limit during this same turn.",
  "Continue from the existing session transcript at the exact point it stopped.",
  "Do not repeat completed tool calls, completed work, or text already shown to the user.",
  "Finish the original request.",
].join(" ");

export function fingerprintClaudeOAuthToken(token: string): string {
  return NodeCrypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function slotKey(prefix: string, slot: number): string {
  return slot === 1 ? prefix : `${prefix}_${slot}`;
}

function loadAccounts(environment: NodeJS.ProcessEnv): ReadonlyArray<ClaudeOAuthAccount> {
  const accounts: Array<ClaudeOAuthAccount> = [];
  const seen = new Set<string>();

  for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
    const tokenKey = slotKey(TOKEN_PREFIX, slot);
    const token = environment[tokenKey]?.trim();
    if (!token) continue;

    const fingerprint = fingerprintClaudeOAuthToken(token);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const id = slot === 1 ? "primary" : `slot${slot}`;
    const label = environment[slotKey(LABEL_PREFIX, slot)]?.trim() || id;
    accounts.push({ id, label, tokenKey, token, fingerprint });
  }

  return accounts;
}

function emptyState(): MutableOAuthState {
  return { version: 1, accounts: {} };
}

function readState(stateFile: string | undefined): MutableOAuthState {
  if (!stateFile) return emptyState();
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(stateFile, "utf8"));
    const decoded = decodeOAuthState(parsed);
    if (Exit.isFailure(decoded)) return emptyState();
    return {
      version: 1,
      accounts: Object.fromEntries(
        Object.entries(decoded.value.accounts).map(([fingerprint, account]) => [
          fingerprint,
          { label: account.label, scopes: { ...account.scopes } },
        ]),
      ),
    };
  } catch {
    return emptyState();
  }
}

function writeState(stateFile: string | undefined, state: MutableOAuthState): void {
  if (!stateFile) return;
  try {
    NodeFS.mkdirSync(NodePath.dirname(stateFile), { recursive: true });
    const temporaryPath = `${stateFile}.tmp`;
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    NodeFS.renameSync(temporaryPath, stateFile);
  } catch {
    // Cooldown persistence is an optimization. A read-only/full disk must not
    // prevent Claude from running; the next rejected request will rebuild it.
  }
}

function modelScope(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  return normalized ? `model:${normalized}` : undefined;
}

function familyScope(model: string | undefined): string | undefined {
  const normalized = model?.toLowerCase() ?? "";
  if (normalized.includes("opus")) return "family:opus";
  if (normalized.includes("sonnet")) return "family:sonnet";
  if (normalized.includes("haiku")) return "family:haiku";
  return undefined;
}

function failureScope(reason: string, model: string | undefined): string {
  switch (reason) {
    case "five_hour":
    case "seven_day":
    case "overage":
      return "all";
    case "seven_day_opus":
      return "family:opus";
    case "seven_day_sonnet":
      return "family:sonnet";
    default:
      return modelScope(model) ?? "all";
  }
}

function applicableScopes(model: string | undefined): ReadonlyArray<string> {
  return ["invalid", "all", familyScope(model), modelScope(model)].filter(
    (scope): scope is string => scope !== undefined,
  );
}

function epochToIso(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value > 1e12 ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

function parseResetHint(text: string): string | undefined {
  const epoch = /\|\s*(\d{10,13})\b/.exec(text);
  if (epoch) {
    const reset = epochToIso(Number(epoch[1]));
    if (reset) return reset;
  }

  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.exec(text);
  if (!iso) return undefined;
  const value = iso[1];
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function assistantText(message: Extract<SDKMessage, { readonly type: "assistant" }>): string {
  const content = message.message.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join(" ");
}

export function classifyClaudeOAuthFailure(message: SDKMessage): ClaudeOAuthFailure | undefined {
  if (message.type === "rate_limit_event") {
    const info = message.rate_limit_info;
    if (info.status !== "rejected") return undefined;
    const resetsAt = epochToIso(info.resetsAt);
    return {
      kind: "exhausted",
      reason: info.rateLimitType ?? "rate_limit_event",
      ...(resetsAt ? { resetsAt } : {}),
      synthetic: false,
    };
  }

  if (message.type === "assistant" && message.error === "rate_limit") {
    const text = assistantText(message);
    const resetsAt = parseResetHint(text);
    return {
      kind: "exhausted",
      reason: "rate_limit",
      ...(resetsAt ? { resetsAt } : {}),
      synthetic: true,
    };
  }

  if (
    message.type === "assistant" &&
    (message.error === "authentication_failed" || message.error === "oauth_org_not_allowed")
  ) {
    return {
      kind: "invalid",
      reason: message.error,
      synthetic: true,
    };
  }

  if (
    message.type === "result" &&
    "api_error_status" in message &&
    message.api_error_status === 429
  ) {
    const resetsAt = parseResetHint(message.result);
    return {
      kind: "exhausted",
      reason: "http_429",
      ...(resetsAt ? { resetsAt } : {}),
      synthetic: false,
    };
  }

  return undefined;
}

function resetFromHeaders(headers: Headers): string | undefined {
  const unified = headers.get("anthropic-ratelimit-unified-reset");
  const unifiedReset = unified ? epochToIso(Number(unified)) : undefined;
  if (unifiedReset) return unifiedReset;

  const iso =
    headers.get("anthropic-ratelimit-unified-status-reset") ?? headers.get("x-ratelimit-reset");
  if (iso) {
    const milliseconds = Date.parse(iso);
    if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
  }

  const retryAfter = Number(headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? new Date(Date.now() + retryAfter * 1000).toISOString()
    : undefined;
}

async function probeAccount(input: {
  readonly account: ClaudeOAuthAccount;
  readonly model: string | undefined;
  readonly fetchImpl: ClaudeOAuthFetch;
}): Promise<ProbeVerdict> {
  if (!input.model) return { kind: "unknown", reason: "model_unresolved" };

  try {
    const response = await input.fetchImpl(HEALTH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.account.token}`,
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": "2023-06-01",
        "user-agent": "t3-code-claude-oauth-pool",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1,
        system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }],
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return { kind: "invalid", reason: `http_${response.status}` };
    }
    if (response.status === 429) {
      const resetsAt = resetFromHeaders(response.headers);
      return {
        kind: "exhausted",
        reason: "http_429",
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
    if (response.ok) return { kind: "healthy" };
    return { kind: "unknown", reason: `http_${response.status}` };
  } catch (cause) {
    return {
      kind: "unknown",
      reason: cause instanceof Error ? cause.name : "probe_failed",
    };
  }
}

export function createClaudeOAuthPool(
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly stateFile?: string;
    readonly fetchImpl?: ClaudeOAuthFetch;
    readonly now?: () => number;
    readonly onDiagnostic?: (message: string, attributes: Record<string, string>) => void;
    readonly probeTtlMs?: number;
  } = {},
): ClaudeOAuthPool {
  const environment = input.environment ?? process.env;
  const accounts = loadAccounts(environment);
  const state = readState(input.stateFile);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const probeTtlMs = input.probeTtlMs ?? PROBE_TTL_MS;

  const accountState = (account: ClaudeOAuthAccount): OAuthAccountState => {
    const existing = state.accounts[account.fingerprint];
    if (existing) return existing;
    const created: OAuthAccountState = { label: account.label, scopes: {} };
    state.accounts[account.fingerprint] = created;
    return created;
  };

  const persist = () => writeState(input.stateFile, state);
  const setVerdict = (account: ClaudeOAuthAccount, scope: string, verdict: OAuthVerdict) => {
    const record = accountState(account);
    record.label = account.label;
    record.scopes[scope] = verdict;
    persist();
  };

  const currentVerdict = (
    account: ClaudeOAuthAccount,
    model: string | undefined,
  ): OAuthVerdict | undefined => {
    const scopes = accountState(account).scopes;
    const exact = modelScope(model);
    for (const scope of applicableScopes(model)) {
      const verdict = scopes[scope];
      if (verdict?.kind === "invalid") {
        const checkedAt = Date.parse(verdict.checkedAt);
        if (Number.isFinite(checkedAt) && now() - checkedAt < INVALID_RECHECK_MS) return verdict;
      }
      if (verdict?.kind === "exhausted" && now() < Date.parse(verdict.resetsAt)) return verdict;
      if (scope === exact && (verdict?.kind === "healthy" || verdict?.kind === "unknown")) {
        return verdict;
      }
    }
    return undefined;
  };

  const isBenched = (account: ClaudeOAuthAccount, model: string | undefined): boolean => {
    const verdict = currentVerdict(account, model);
    return verdict?.kind === "invalid" || verdict?.kind === "exhausted";
  };

  const needsProbe = (account: ClaudeOAuthAccount, model: string | undefined): boolean => {
    const exact = modelScope(model);
    if (!exact) return false;
    const verdict = accountState(account).scopes[exact];
    if (!verdict) return true;
    const checkedAt = Date.parse(verdict.checkedAt);
    return !Number.isFinite(checkedAt) || now() - checkedAt > probeTtlMs;
  };

  const markHealthy = (account: ClaudeOAuthAccount, model: string | undefined) => {
    const exact = modelScope(model);
    if (!exact) return;
    const activeVerdict = currentVerdict(account, model);
    // A concurrent query can finish successfully after another query has
    // already discovered the account limit. Do not let that stale success
    // clear the newer cooldown.
    if (activeVerdict?.kind === "exhausted" || activeVerdict?.kind === "invalid") return;
    setVerdict(account, exact, {
      kind: "healthy",
      checkedAt: new Date(now()).toISOString(),
    });
  };

  const markExhausted: ClaudeOAuthPool["markExhausted"] = (account, detail) => {
    const scope = failureScope(detail.reason, detail.model);
    setVerdict(account, scope, {
      kind: "exhausted",
      checkedAt: new Date(now()).toISOString(),
      reason: detail.reason,
      resetsAt: detail.resetsAt ?? new Date(now() + BLIND_COOLDOWN_MS).toISOString(),
    });
    input.onDiagnostic?.("Claude OAuth account benched", {
      label: account.label,
      fingerprint: account.fingerprint,
      reason: detail.reason,
      scope,
    });
  };

  const markInvalid = (account: ClaudeOAuthAccount, reason: string) => {
    setVerdict(account, "invalid", {
      kind: "invalid",
      checkedAt: new Date(now()).toISOString(),
      reason,
    });
    input.onDiagnostic?.("Claude OAuth account rejected", {
      label: account.label,
      fingerprint: account.fingerprint,
      reason,
    });
  };

  const earliestReset = (model: string | undefined): string | undefined => {
    const resets = accounts.flatMap((account) =>
      applicableScopes(model).flatMap((scope) => {
        const verdict = accountState(account).scopes[scope];
        if (verdict?.kind !== "exhausted") return [];
        const milliseconds = Date.parse(verdict.resetsAt);
        return Number.isFinite(milliseconds) && milliseconds > now() ? [milliseconds] : [];
      }),
    );
    return resets.length > 0 ? new Date(Math.min(...resets)).toISOString() : undefined;
  };

  const pick: ClaudeOAuthPool["pick"] = async ({ model, exclude = new Set() }) => {
    const candidates = accounts.filter((account) => !exclude.has(account.fingerprint));
    if (candidates.length === 0) {
      return { account: undefined, lastResort: false, earliestReset: earliestReset(model) };
    }

    for (const account of candidates) {
      if (isBenched(account, model)) continue;
      if (needsProbe(account, model)) {
        const verdict = await probeAccount({ account, model, fetchImpl });
        if (verdict.kind === "healthy") {
          markHealthy(account, model);
        } else if (verdict.kind === "exhausted") {
          markExhausted(account, {
            model,
            reason: verdict.reason,
            ...(verdict.resetsAt ? { resetsAt: verdict.resetsAt } : {}),
          });
          continue;
        } else if (verdict.kind === "invalid") {
          markInvalid(account, verdict.reason);
          continue;
        } else {
          const exact = modelScope(model);
          if (exact) {
            setVerdict(account, exact, {
              kind: "unknown",
              checkedAt: new Date(now()).toISOString(),
              reason: verdict.reason,
            });
          }
        }
      }
      return { account, lastResort: false, earliestReset: undefined };
    }

    const [firstCandidate, ...remainingCandidates] = candidates;
    if (!firstCandidate) {
      return { account: undefined, lastResort: false, earliestReset: earliestReset(model) };
    }
    const fallback = remainingCandidates.reduce((selected, account) => {
      const selectedReset = currentVerdict(selected, model);
      const accountReset = currentVerdict(account, model);
      const selectedAt =
        selectedReset?.kind === "exhausted"
          ? Date.parse(selectedReset.resetsAt)
          : Number.POSITIVE_INFINITY;
      const accountAt =
        accountReset?.kind === "exhausted"
          ? Date.parse(accountReset.resetsAt)
          : Number.POSITIVE_INFINITY;
      return accountAt < selectedAt ? account : selected;
    }, firstCandidate);

    return {
      account: fallback,
      lastResort: true,
      earliestReset: earliestReset(model),
    };
  };

  const environmentFor: ClaudeOAuthPool["environmentFor"] = (baseEnvironment, account) => {
    if (accounts.length === 0) return baseEnvironment;
    const next = { ...baseEnvironment };
    for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
      delete next[slotKey(TOKEN_PREFIX, slot)];
      delete next[slotKey(LABEL_PREFIX, slot)];
      if (slot > 1) delete next[slotKey("CLAUDE_CODE_OAUTH_TOKEN", slot)];
    }
    delete next.ANTHROPIC_API_KEY;
    delete next.ANTHROPIC_AUTH_TOKEN;
    if (account) next.CLAUDE_CODE_OAUTH_TOKEN = account.token;
    else delete next.CLAUDE_CODE_OAUTH_TOKEN;
    return next;
  };

  return {
    size: accounts.length,
    pick,
    markExhausted,
    markInvalid,
    markHealthy,
    environmentFor,
    earliestReset,
    snapshot: (model) =>
      accounts.map((account) => ({
        id: account.id,
        label: account.label,
        tokenKey: account.tokenKey,
        fingerprint: account.fingerprint,
        verdict: currentVerdict(account, model),
        benched: isBenched(account, model),
      })),
  };
}
