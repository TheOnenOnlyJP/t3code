/**
 * GrokSkills — advertise Grok CLI skills to the `$` / `/` pickers.
 *
 * Claude scans the filesystem; Codex calls `skills/list`. Grok's own catalog
 * already includes user, bundled, plugin, and vendor-compat skills plus
 * collision-qualified names (`user:teach`). `grok inspect --json` is that
 * catalog; the picker only needs the snapshot arrays filled.
 *
 * Discovery is best-effort: a failed or timed-out inspect never marks the
 * provider unhealthy. Skills and slash commands stay empty instead.
 *
 * @module provider/Drivers/GrokSkills
 */
import type {
  GrokSettings,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { nonEmptyTrimmed, spawnAndCollect } from "../providerSnapshot.ts";

export const GROK_INSPECT_TIMEOUT_MS = 4_000;

export type GrokInspectCatalog = {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

export const EMPTY_GROK_INSPECT_CATALOG: GrokInspectCatalog = {
  skills: [],
  slashCommands: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function grokSkillScope(source: Record<string, unknown>): string | undefined {
  const type = nonEmptyTrimmed(typeof source.type === "string" ? source.type : undefined);
  if (type === "user" || type === "personal") {
    return "user";
  }
  if (type === "project" || type === "local" || type === "repo") {
    return "project";
  }
  if (type === "bundled" || type === "server") {
    return "system";
  }
  if (type === "plugin") {
    return (
      nonEmptyTrimmed(typeof source.plugin_name === "string" ? source.plugin_name : undefined) ??
      "plugin"
    );
  }
  if (type === "config") {
    return "user";
  }
  return type;
}

function parseGrokInspectSkill(value: unknown): ServerProviderSkill | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const source = isRecord(value.source) ? value.source : undefined;
  const path = nonEmptyTrimmed(typeof source?.path === "string" ? source.path : undefined);
  const reportedName = nonEmptyTrimmed(typeof value.name === "string" ? value.name : undefined);
  const invocableAs = nonEmptyTrimmed(
    typeof value.invocableAs === "string" ? value.invocableAs : undefined,
  );
  const name = invocableAs ?? reportedName;
  if (!path || !name) {
    return undefined;
  }

  const description = nonEmptyTrimmed(
    typeof value.description === "string" ? value.description : undefined,
  );
  const scope = source ? grokSkillScope(source) : undefined;
  const enabled = value.userInvocable !== false;
  const skill: ServerProviderSkill = {
    name,
    path,
    enabled,
    ...(description ? { description } : {}),
    ...(scope ? { scope } : {}),
    ...(reportedName && reportedName !== name ? { displayName: reportedName } : {}),
  };
  return skill;
}

export function parseGrokInspectCatalog(value: unknown): GrokInspectCatalog {
  if (!isRecord(value) || !Array.isArray(value.skills)) {
    return EMPTY_GROK_INSPECT_CATALOG;
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of value.skills) {
    const skill = parseGrokInspectSkill(entry);
    if (!skill) {
      continue;
    }
    skillsByName.set(skill.name.toLowerCase(), skill);
  }

  const skills = [...skillsByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const slashCommands: ServerProviderSlashCommand[] = [];
  const slashCommandNames = new Set<string>();
  for (const skill of skills) {
    if (!skill.enabled) {
      continue;
    }
    const key = skill.name.toLowerCase();
    if (slashCommandNames.has(key)) {
      continue;
    }
    slashCommandNames.add(key);
    slashCommands.push({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    });
  }

  return { skills, slashCommands };
}

export function parseGrokInspectCatalogJson(stdout: string): GrokInspectCatalog {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return EMPTY_GROK_INSPECT_CATALOG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return EMPTY_GROK_INSPECT_CATALOG;
  }
  return parseGrokInspectCatalog(parsed);
}

const runGrokInspectCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Load Grok's advertised skill catalog. Never fails: inspect errors, timeouts,
 * and malformed JSON all become an empty catalog.
 */
export const discoverGrokInspectCatalog = Effect.fn("discoverGrokInspectCatalog")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<GrokInspectCatalog, never, ChildProcessSpawner.ChildProcessSpawner> {
  const inspectResult = yield* runGrokInspectCommand(grokSettings, environment, cwd).pipe(
    Effect.timeoutOption(GROK_INSPECT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(inspectResult)) {
    yield* Effect.logWarning("Grok skill inspect failed.", {
      errorTag: inspectResult.failure._tag,
    });
    return EMPTY_GROK_INSPECT_CATALOG;
  }

  if (Option.isNone(inspectResult.success)) {
    yield* Effect.logWarning(`Grok skill inspect timed out after ${GROK_INSPECT_TIMEOUT_MS}ms.`);
    return EMPTY_GROK_INSPECT_CATALOG;
  }

  const output = inspectResult.success.value;
  if (output.code !== 0) {
    yield* Effect.logWarning("Grok skill inspect exited with a non-zero status.", {
      exitCode: output.code,
      stdoutLength: output.stdout.length,
      stderrLength: output.stderr.length,
    });
    return EMPTY_GROK_INSPECT_CATALOG;
  }

  return parseGrokInspectCatalogJson(output.stdout);
});
