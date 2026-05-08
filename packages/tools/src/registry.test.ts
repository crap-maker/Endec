import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createActToolExposure,
  createOwnerPrivateSelfAwarenessToolExposure,
  createReadonlyToolExposure
} from "./presets.ts";
import { createStaticToolRegistry, type RegisteredTool } from "./registry.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function createTempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "endec-tools-registry-"));
  tempDirs.add(dir);
  return dir;
}

function createSelfAwarenessTool(name: string): RegisteredTool {
  return {
    name,
    description: `${name} helper`,
    hiddenByDefault: false,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      }
    }
  };
}

describe("tool registry exposure", () => {
  it("exposes provider-visible readonly schemas and hides the rest", () => {
    const registry = createStaticToolRegistry();
    const exposure = createReadonlyToolExposure(registry);

    expect(exposure.exposureSource).toBe("policy");
    expect(exposure.exposedTools.map((tool) => tool.name)).toEqual(["read", "glob", "grep"]);
    expect(exposure.hiddenToolNames).toEqual(expect.arrayContaining(["write", "edit", "bash"]));
    expect(exposure.exposedTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "read",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["path"]
          })
        }),
        expect.objectContaining({
          name: "glob",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["pattern"]
          })
        }),
        expect.objectContaining({
          name: "grep",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["pattern"]
          })
        })
      ])
    );
  });

  it("adds write, edit, and bash to the act-mode canonical tool exposure", () => {
    const registry = createStaticToolRegistry();
    const exposure = createActToolExposure(registry);

    expect(exposure.exposedTools.map((tool) => tool.name)).toEqual(["read", "glob", "grep", "write", "edit", "bash"]);
    expect(exposure.hiddenToolNames).toEqual([]);
    expect(exposure.exposedTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "write",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["path", "content"]
          })
        }),
        expect.objectContaining({
          name: "edit",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["path", "edits"]
          })
        }),
        expect.objectContaining({
          name: "bash",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["command"]
          })
        })
      ])
    );
  });

  it("exposes bounded owner-private self-awareness tools without workspace mutation by default", () => {
    const registry = createStaticToolRegistry({
      additionalTools: [
        createSelfAwarenessTool("inspect_source"),
        createSelfAwarenessTool("inspect_build"),
        createSelfAwarenessTool("inspect_docs"),
        createSelfAwarenessTool("inspect_config")
      ]
    });
    const exposure = createOwnerPrivateSelfAwarenessToolExposure(registry);

    expect(exposure.exposedTools.map((tool) => tool.name)).toEqual([
      "inspect_source",
      "inspect_build",
      "inspect_docs",
      "inspect_config"
    ]);
    expect(exposure.hiddenToolNames).toEqual(expect.arrayContaining([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "bash"
    ]));
  });

  it("adds write, edit, and bash only for explicit owner-requested self-modification", () => {
    const registry = createStaticToolRegistry({
      additionalTools: [
        createSelfAwarenessTool("inspect_source"),
        createSelfAwarenessTool("inspect_build"),
        createSelfAwarenessTool("inspect_docs"),
        createSelfAwarenessTool("inspect_config")
      ]
    });
    const exposure = createOwnerPrivateSelfAwarenessToolExposure(registry, {
      allowWorkspaceMutation: true
    });

    expect(exposure.exposedTools.map((tool) => tool.name)).toEqual([
      "write",
      "edit",
      "bash",
      "inspect_source",
      "inspect_build",
      "inspect_docs",
      "inspect_config"
    ]);
    expect(exposure.hiddenToolNames).toEqual(expect.arrayContaining(["read", "glob", "grep"]));
  });
});

describe("readonly tool path safety", () => {
  it("rejects read paths outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "secret.txt");
    await writeFile(outsideTarget, "outside secret", "utf8");
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("read")?.execute?.({
        cwd: workspace,
        arguments: {
          path: outsideTarget
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation"
    });
  });

  it("rejects glob cwd values outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    await writeFile(join(outsideDir, "secret.txt"), "outside secret", "utf8");
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("glob")?.execute?.({
        cwd: workspace,
        arguments: {
          pattern: "**/*.txt",
          cwd: outsideDir
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation"
    });
  });

  it("rejects grep file paths outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "secret.txt");
    await writeFile(outsideTarget, "outside secret", "utf8");
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("grep")?.execute?.({
        cwd: workspace,
        arguments: {
          pattern: "secret",
          path: outsideTarget
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation"
    });
  });

  it("rejects grep directory paths outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    await writeFile(join(outsideDir, "secret.txt"), "outside secret", "utf8");
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("grep")?.execute?.({
        cwd: workspace,
        arguments: {
          pattern: "secret",
          path: outsideDir
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation"
    });
  });

  it("rejects read through a workspace symlink that points outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-read.txt");
    await writeFile(outsideTarget, "outside secret", "utf8");
    await symlink(outsideTarget, join(workspace, "link.txt"));
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("read")?.execute?.({
        cwd: workspace,
        arguments: {
          path: "link.txt"
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation",
      message: expect.stringContaining("symbolic link")
    });
  });

  it("rejects glob through a workspace symlinked directory that points outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    await writeFile(join(outsideDir, "outside-read.txt"), "outside secret", "utf8");
    await symlink(outsideDir, join(workspace, "linked-dir"));
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("glob")?.execute?.({
        cwd: workspace,
        arguments: {
          pattern: "**/*.txt",
          cwd: "linked-dir"
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation",
      message: expect.stringContaining("symbolic link")
    });
  });

  it("rejects grep through a workspace hard link that aliases an outside file", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-grep.txt");
    await writeFile(outsideTarget, "outside secret", "utf8");
    await link(outsideTarget, join(workspace, "hardlink.txt"));
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("grep")?.execute?.({
        cwd: workspace,
        arguments: {
          pattern: "secret",
          path: "hardlink.txt"
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation"
    });
  });

  it("still allows readonly access to files inside the workspace", async () => {
    const workspace = await createTempWorkspace();
    await writeFile(join(workspace, "notes.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(join(workspace, "nested.txt"), "beta\ngamma\n", "utf8");
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("read")?.execute?.({
        cwd: workspace,
        arguments: {
          path: "notes.txt"
        }
      })
    ).resolves.toMatchObject({
      normalizedPayload: {
        contentType: "text",
        value: "alpha\nbeta\n"
      }
    });
    await expect(
      registry.get("glob")?.execute?.({
        cwd: workspace,
        arguments: {
          pattern: "**/*.txt"
        }
      })
    ).resolves.toMatchObject({
      normalizedPayload: {
        contentType: "json",
        value: {
          matches: ["nested.txt", "notes.txt"]
        }
      }
    });
    await expect(
      registry.get("grep")?.execute?.({
        cwd: workspace,
        arguments: {
          pattern: "beta",
          path: workspace
        }
      })
    ).resolves.toMatchObject({
      normalizedPayload: {
        contentType: "json",
        value: {
          matches: [
            { path: "nested.txt", lineNumber: 1, line: "beta" },
            { path: "notes.txt", lineNumber: 2, line: "beta" }
          ]
        }
      }
    });
  });
});

describe("writable tool path safety", () => {
  it("rejects write through a workspace hard link that aliases an outside file", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-write.txt");
    await writeFile(outsideTarget, "outside before", "utf8");
    await link(outsideTarget, join(workspace, "hardlink.txt"));
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("write")?.execute?.({
        cwd: workspace,
        arguments: {
          path: "hardlink.txt",
          content: "outside after"
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation"
    });
    expect(await readFile(outsideTarget, "utf8")).toBe("outside before");
  });

  it("rejects edit through a workspace hard link that aliases an outside file", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-edit.txt");
    await writeFile(outsideTarget, "before edit", "utf8");
    await link(outsideTarget, join(workspace, "hardlink.txt"));
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("edit")?.execute?.({
        cwd: workspace,
        arguments: {
          path: "hardlink.txt",
          edits: [{ oldText: "before", newText: "after" }]
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation"
    });
    expect(await readFile(outsideTarget, "utf8")).toBe("before edit");
  });

  it("rejects write through a workspace symlink that points outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-write.txt");
    await writeFile(outsideTarget, "outside before", "utf8");
    await symlink(outsideTarget, join(workspace, "link.txt"));
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("write")?.execute?.({
        cwd: workspace,
        arguments: {
          path: "link.txt",
          content: "outside after"
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation",
      message: expect.stringContaining("symbolic link")
    });
    expect(await readFile(outsideTarget, "utf8")).toBe("outside before");
  });

  it("rejects edit through a workspace symlink that points outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-edit.txt");
    await writeFile(outsideTarget, "before edit", "utf8");
    await symlink(outsideTarget, join(workspace, "link.txt"));
    const registry = createStaticToolRegistry({ cwd: workspace });

    await expect(
      registry.get("edit")?.execute?.({
        cwd: workspace,
        arguments: {
          path: "link.txt",
          edits: [{ oldText: "before", newText: "after" }]
        }
      })
    ).rejects.toMatchObject({
      code: "workspace_violation",
      message: expect.stringContaining("symbolic link")
    });
    expect(await readFile(outsideTarget, "utf8")).toBe("before edit");
  });
});
