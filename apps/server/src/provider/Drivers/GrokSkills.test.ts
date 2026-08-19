import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { GrokSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  discoverGrokInspectCatalog,
  parseGrokInspectCatalog,
  parseGrokInspectCatalogJson,
} from "./GrokSkills.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const INSPECT_FIXTURE = {
  skills: [
    {
      name: "rpi",
      description: "Research, plan, implement.",
      source: { type: "user", path: "/home/me/.claude/skills/rpi/SKILL.md" },
      userInvocable: true,
    },
    {
      name: "teach",
      description: "Explain the work.",
      source: {
        type: "plugin",
        plugin_name: "pstack",
        path: "/home/me/.grok/plugins/pstack/skills/teach/SKILL.md",
      },
      userInvocable: true,
      collidesWith: "teach",
      invocableAs: "pstack:teach",
    },
    {
      name: "pdf",
      description: "Read and write PDFs.",
      source: { type: "bundled", path: "/home/me/.grok/bundled/skills/pdf/SKILL.md" },
      userInvocable: false,
    },
    {
      name: "broken",
      description: "Missing a path.",
      source: { type: "user" },
      userInvocable: true,
    },
  ],
};

describe("parseGrokInspectCatalog", () => {
  it("maps Grok inspect skills into picker rows and slash commands", () => {
    const catalog = parseGrokInspectCatalog(INSPECT_FIXTURE);

    expect(catalog.skills).toEqual([
      {
        name: "pdf",
        path: "/home/me/.grok/bundled/skills/pdf/SKILL.md",
        enabled: false,
        description: "Read and write PDFs.",
        scope: "system",
      },
      {
        name: "pstack:teach",
        path: "/home/me/.grok/plugins/pstack/skills/teach/SKILL.md",
        enabled: true,
        description: "Explain the work.",
        scope: "pstack",
        displayName: "teach",
      },
      {
        name: "rpi",
        path: "/home/me/.claude/skills/rpi/SKILL.md",
        enabled: true,
        description: "Research, plan, implement.",
        scope: "user",
      },
    ]);
    expect(catalog.slashCommands).toEqual([
      { name: "pstack:teach", description: "Explain the work." },
      { name: "rpi", description: "Research, plan, implement." },
    ]);
  });

  it("returns an empty catalog for malformed inspect output", () => {
    expect(parseGrokInspectCatalog(null)).toEqual({ skills: [], slashCommands: [] });
    expect(parseGrokInspectCatalog({ skills: "nope" })).toEqual({
      skills: [],
      slashCommands: [],
    });
    expect(parseGrokInspectCatalogJson("not-json")).toEqual({
      skills: [],
      slashCommands: [],
    });
    expect(parseGrokInspectCatalogJson("")).toEqual({ skills: [], slashCommands: [] });
    expect(
      parseGrokInspectCatalogJson(JSON.stringify(INSPECT_FIXTURE)).skills.map((s) => s.name),
    ).toEqual(["pdf", "pstack:teach", "rpi"]);
  });
});

it.layer(NodeServices.layer)("discoverGrokInspectCatalog", (it) => {
  it.effect("reads skills from grok inspect --json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-inspect-" });
      const grokPath = path.join(dir, "grok");
      const fixturePath = path.join(dir, "inspect.json");
      yield* fs.writeFileString(fixturePath, JSON.stringify(INSPECT_FIXTURE));
      yield* fs.writeFileString(
        grokPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then',
          `  cat "${fixturePath}"`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(grokPath, 0o755);

      const catalog = yield* discoverGrokInspectCatalog(
        decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
      );

      expect(catalog.skills.map((skill) => skill.name)).toEqual(["pdf", "pstack:teach", "rpi"]);
      expect(catalog.slashCommands.map((command) => command.name)).toEqual(["pstack:teach", "rpi"]);
    }),
  );

  it.effect("returns an empty catalog when inspect fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-inspect-fail-" });
      const grokPath = path.join(dir, "grok");
      yield* fs.writeFileString(grokPath, ["#!/bin/sh", "exit 2", ""].join("\n"));
      yield* fs.chmod(grokPath, 0o755);

      const catalog = yield* discoverGrokInspectCatalog(
        decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
      );

      expect(catalog).toEqual({ skills: [], slashCommands: [] });
    }),
  );
});
