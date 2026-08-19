// @effect-diagnostics nodeBuiltinImport:off -- These tests create and inspect an isolated persisted state file.
// @effect-diagnostics globalDate:off -- Fixed wall-clock values exercise cooldown expiry deterministically.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";

import {
  classifyClaudeOAuthFailure,
  createClaudeOAuthPool,
  fingerprintClaudeOAuthToken,
} from "./ClaudeOAuthPool.ts";

function withTempState(run: (stateFile: string) => Promise<void> | void): Promise<void> {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-oauth-"));
  return Promise.resolve(run(NodePath.join(directory, "state.json"))).finally(() => {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
}

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

describe("ClaudeOAuthPool", () => {
  it("classifies structured, synthetic, and terminal usage-limit frames", () => {
    const structured = classifyClaudeOAuthFailure({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1_785_805_200,
      },
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "session-1",
    });
    expect(structured).toEqual({
      kind: "exhausted",
      reason: "five_hour",
      resetsAt: "2026-08-04T01:00:00.000Z",
      synthetic: false,
    });

    const synthetic = classifyClaudeOAuthFailure({
      type: "assistant",
      error: "rate_limit",
      message: {
        id: "msg-limit",
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Claude usage limit reached|1785805200" }],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: "assistant-limit-1",
      session_id: "session-1",
    } as unknown as SDKMessage);
    expect(synthetic?.kind).toBe("exhausted");
    expect(synthetic?.synthetic).toBe(true);

    const terminal = classifyClaudeOAuthFailure({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "usage limit reached|1785805200",
    } as SDKMessage);
    expect(terminal?.kind).toBe("exhausted");
    expect(terminal?.reason).toBe("http_429");
  });

  it("probes in order, skips an exhausted account, and persists no token material", async () => {
    await withTempState(async (stateFile) => {
      const seen: Array<string> = [];
      const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
        const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
        seen.push(token);
        return token === "primary-token"
          ? response(429, { "anthropic-ratelimit-unified-reset": "3881520000" })
          : response(200);
      };
      const pool = createClaudeOAuthPool({
        environment: {
          T3_CLAUDE_CODE_OAUTH_TOKEN: "primary-token",
          T3_CLAUDE_CODE_OAUTH_LABEL: "work",
          T3_CLAUDE_CODE_OAUTH_TOKEN_2: "backup-token",
          T3_CLAUDE_CODE_OAUTH_LABEL_2: "personal",
        },
        stateFile,
        fetchImpl,
      });

      const selected = await pool.pick({ model: "claude-opus-5" });
      expect(selected.account?.label).toBe("personal");
      expect(seen).toEqual(["primary-token", "backup-token"]);
      expect(pool.snapshot("claude-opus-5")[0]?.benched).toBe(true);

      const persisted = NodeFS.readFileSync(stateFile, "utf8");
      expect(persisted).not.toContain("primary-token");
      expect(persisted).not.toContain("backup-token");
      expect(persisted).toContain(fingerprintClaudeOAuthToken("primary-token"));

      const reloadedProbes: Array<string> = [];
      const reloaded = createClaudeOAuthPool({
        environment: {
          T3_CLAUDE_CODE_OAUTH_TOKEN: "primary-token",
          T3_CLAUDE_CODE_OAUTH_LABEL: "work",
          T3_CLAUDE_CODE_OAUTH_TOKEN_2: "backup-token",
          T3_CLAUDE_CODE_OAUTH_LABEL_2: "personal",
        },
        stateFile,
        fetchImpl: async (_url, init) => {
          reloadedProbes.push(
            new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "",
          );
          return response(200);
        },
      });

      expect((await reloaded.pick({ model: "claude-opus-5" })).account?.label).toBe("personal");
      expect(reloadedProbes).toEqual([]);
    });
  });

  it("keeps Opus-only exhaustion from benching the same account for Sonnet", async () => {
    const fetchImpl = async (): Promise<Response> => response(200);
    const pool = createClaudeOAuthPool({
      environment: {
        T3_CLAUDE_CODE_OAUTH_TOKEN: "primary-token",
        T3_CLAUDE_CODE_OAUTH_TOKEN_2: "backup-token",
      },
      fetchImpl,
    });
    const primary = (await pool.pick({ model: "claude-opus-5" })).account;
    expect(primary).toBeDefined();
    if (!primary) return;

    pool.markExhausted(primary, {
      model: "claude-opus-5",
      reason: "seven_day_opus",
      resetsAt: "2093-01-01T00:00:00.000Z",
    });

    expect((await pool.pick({ model: "claude-opus-5" })).account?.id).toBe("slot2");
    expect((await pool.pick({ model: "claude-sonnet-5" })).account?.id).toBe("primary");
  });

  it("keeps a newer cooldown over a stale success and releases it after reset", async () => {
    let now = Date.parse("2026-08-19T12:00:00.000Z");
    const pool = createClaudeOAuthPool({
      environment: {
        T3_CLAUDE_CODE_OAUTH_TOKEN: "primary-token",
        T3_CLAUDE_CODE_OAUTH_TOKEN_2: "backup-token",
      },
      fetchImpl: async () => response(200),
      now: () => now,
    });
    const primary = (await pool.pick({ model: "claude-opus-5" })).account;
    expect(primary).toBeDefined();
    if (!primary) return;

    pool.markExhausted(primary, {
      model: "claude-opus-5",
      reason: "http_429",
      resetsAt: "2026-08-19T12:01:00.000Z",
    });
    pool.markHealthy(primary, "claude-opus-5");

    expect(pool.snapshot("claude-opus-5")[0]?.benched).toBe(true);
    expect((await pool.pick({ model: "claude-opus-5" })).account?.id).toBe("slot2");

    now = Date.parse("2026-08-19T12:01:01.000Z");
    expect((await pool.pick({ model: "claude-opus-5" })).account?.id).toBe("primary");
  });

  it("passes only the selected account to the Claude child environment", async () => {
    const environment = {
      T3_CLAUDE_CODE_OAUTH_TOKEN: "primary-token",
      T3_CLAUDE_CODE_OAUTH_TOKEN_2: "backup-token",
      T3_CLAUDE_CODE_OAUTH_LABEL_2: "backup",
      CLAUDE_CODE_OAUTH_TOKEN: "host-token",
      CLAUDE_CODE_OAUTH_TOKEN_2: "legacy-backup",
      ANTHROPIC_API_KEY: "stale-api-key",
      SAFE_VALUE: "kept",
    };
    const pool = createClaudeOAuthPool({ environment });
    const selected = (await pool.pick({ model: undefined })).account;
    expect(selected).toBeDefined();
    const child = pool.environmentFor(environment, selected);

    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
    expect(child.CLAUDE_CODE_OAUTH_TOKEN_2).toBeUndefined();
    expect(child.T3_CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(child.T3_CLAUDE_CODE_OAUTH_TOKEN_2).toBeUndefined();
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.SAFE_VALUE).toBe("kept");
  });
});
