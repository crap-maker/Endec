import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createActToolExposure, createReadonlyToolExposure } from "./presets.ts";
import { executeToolBatch } from "./execute-batch.ts";
import { createStaticToolRegistry } from "./registry.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function createTempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "endec-tools-"));
  tempDirs.add(dir);
  return dir;
}

function createArtifactPolicy(spillThreshold = 2000) {
  return {
    async spillIfNeeded(input: {
      turnId: string;
      sessionId: string;
      kind: "runtime_output" | "tool_result";
      mimeType?: string;
      content: string;
    }) {
      if (input.content.length <= spillThreshold) {
        return {
          kind: "inline" as const,
          content: input.content
        };
      }

      return {
        kind: "artifact" as const,
        ref: {
          artifactId: `artifact:${input.turnId}`,
          sessionId: input.sessionId,
          turnId: input.turnId,
          kind: input.kind,
          storageKey: `artifacts/${input.turnId}.txt`,
          mimeType: input.mimeType,
          byteLength: input.content.length,
          createdAt: "2026-04-11T00:00:00.000Z"
        },
        preview: {
          artifactId: `artifact:${input.turnId}`,
          ref: {
            artifactId: `artifact:${input.turnId}`,
            sessionId: input.sessionId,
            turnId: input.turnId,
            kind: input.kind,
            storageKey: `artifacts/${input.turnId}.txt`,
            mimeType: input.mimeType,
            byteLength: input.content.length,
            createdAt: "2026-04-11T00:00:00.000Z"
          },
          previewText: input.content.slice(0, 24),
          truncated: true,
          byteLength: input.content.length,
          sourceRange: {
            offset: 0,
            length: Math.min(24, input.content.length)
          }
        }
      };
    }
  };
}

function createActRegistry(workspace: string) {
  const registry = createStaticToolRegistry({ cwd: workspace });
  return {
    registry,
    exposure: createActToolExposure(registry)
  };
}

describe("executeToolBatch", () => {
  it("executes read, glob, and grep successfully", async () => {
    const workspace = await createTempWorkspace();
    await mkdir(join(workspace, "nested"), { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(join(workspace, "nested", "other.txt"), "beta\ngamma\n", "utf8");

    const registry = createStaticToolRegistry({ cwd: workspace });
    const exposure = createReadonlyToolExposure(registry);
    const batch = await executeToolBatch({
      batchId: "batch_success_001",
      turnId: "turn_success_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_read_001",
          toolName: "read",
          arguments: { path: join(workspace, "notes.txt") }
        },
        {
          toolCallId: "tool_call_glob_001",
          toolName: "glob",
          arguments: { pattern: "**/*.txt", cwd: workspace }
        },
        {
          toolCallId: "tool_call_grep_001",
          toolName: "grep",
          arguments: { pattern: "beta", path: workspace }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(batch.permissionDecisions.map((decision) => decision.behavior)).toEqual(["allow", "allow", "allow"]);
    expect(batch.executionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "read",
          state: "executed",
          normalizedPayload: {
            contentType: "text",
            value: "alpha\nbeta\n"
          }
        }),
        expect.objectContaining({
          toolName: "glob",
          state: "executed",
          normalizedPayload: {
            contentType: "json",
            value: {
              matches: ["nested/other.txt", "notes.txt"]
            }
          }
        }),
        expect.objectContaining({
          toolName: "grep",
          state: "executed",
          normalizedPayload: {
            contentType: "json",
            value: {
              matches: [
                { path: "nested/other.txt", lineNumber: 1, line: "beta" },
                { path: "notes.txt", lineNumber: 2, line: "beta" }
              ]
            }
          }
        })
      ])
    );
  });

  it("returns standardized error results for execution failures", async () => {
    const workspace = await createTempWorkspace();
    const registry = createStaticToolRegistry({ cwd: workspace });
    const exposure = createReadonlyToolExposure(registry);
    const batch = await executeToolBatch({
      batchId: "batch_error_001",
      turnId: "turn_error_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_read_missing_001",
          toolName: "read",
          arguments: { path: "missing.txt" }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(batch.permissionDecisions).toEqual([
      expect.objectContaining({ behavior: "allow", reasonCode: "tool_auto_allowed" })
    ]);
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "read",
        state: "error",
        error: expect.objectContaining({
          code: "tool_execution_failed"
        })
      })
    ]);
  });

  it("returns standardized workspace violation errors for readonly access outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "secret.txt");
    await writeFile(outsideTarget, "outside secret", "utf8");
    const registry = createStaticToolRegistry({ cwd: workspace });
    const exposure = createReadonlyToolExposure(registry);
    const batch = await executeToolBatch({
      batchId: "batch_readonly_outside_001",
      turnId: "turn_readonly_outside_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_read_outside_001",
          toolName: "read",
          arguments: { path: outsideTarget }
        },
        {
          toolCallId: "tool_call_glob_outside_001",
          toolName: "glob",
          arguments: { pattern: "**/*.txt", cwd: outsideDir }
        },
        {
          toolCallId: "tool_call_grep_outside_001",
          toolName: "grep",
          arguments: { pattern: "secret", path: outsideDir }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(batch.permissionDecisions.map((decision) => decision.behavior)).toEqual(["allow", "allow", "allow"]);
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "read",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation"
        })
      }),
      expect.objectContaining({
        toolName: "glob",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation"
        })
      }),
      expect.objectContaining({
        toolName: "grep",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation"
        })
      })
    ]);
  });

  it("spills large tool results instead of inlining them", async () => {
    const workspace = await createTempWorkspace();
    const content = "spill-me\n".repeat(20);
    await writeFile(join(workspace, "large.txt"), content, "utf8");

    const registry = createStaticToolRegistry({ cwd: workspace });
    const exposure = createReadonlyToolExposure(registry);
    const batch = await executeToolBatch({
      batchId: "batch_spill_001",
      turnId: "turn_spill_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_read_large_001",
          toolName: "read",
          arguments: { path: join(workspace, "large.txt") }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy(32)
    });

    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "read",
        state: "spilled",
        normalizedPayload: {
          contentType: "text",
          value: content.slice(0, 24)
        },
        artifactRef: expect.objectContaining({ artifactId: "artifact:turn_spill_001" }),
        preview: expect.objectContaining({ previewText: content.slice(0, 24) })
      })
    ]);
  });

  it("blocks remote git push behind an approval-required decision before execution", async () => {
    const workspace = await createTempWorkspace();
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_bash_ask_001",
      turnId: "turn_bash_ask_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_bash_ask_001",
          toolName: "bash",
          arguments: {
            command: "git push origin HEAD"
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(batch.permissionDecisions).toEqual([
      expect.objectContaining({
        decisionId: "tool_call_bash_ask_001",
        behavior: "ask",
        reasonCode: "bash_action_requires_approval"
      })
    ]);
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_bash_ask_001",
        toolName: "bash",
        state: "ask",
        permissionDecision: expect.objectContaining({
          behavior: "ask"
        })
      })
    ]);
  });

  it("stops the batch at the first approval-required bash boundary and leaves the unexecuted suffix untouched", async () => {
    const workspace = await createTempWorkspace();
    const target = join(workspace, "ask-boundary.txt");
    await writeFile(target, "seed\n", "utf8");
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_ask_boundary_001",
      turnId: "turn_ask_boundary_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_before_001",
          toolName: "edit",
          arguments: {
            path: "ask-boundary.txt",
            edits: [
              {
                oldText: "seed",
                newText: "seed +1"
              }
            ]
          }
        },
        {
          toolCallId: "tool_call_bash_001",
          toolName: "bash",
          arguments: {
            command: "git push origin HEAD"
          }
        },
        {
          toolCallId: "tool_call_edit_after_001",
          toolName: "edit",
          arguments: {
            path: "ask-boundary.txt",
            edits: [
              {
                oldText: "\n",
                newText: " +2\n"
              }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(target, "utf8")).toBe("seed +1\n");
    expect(batch.permissionDecisions).toEqual([
      expect.objectContaining({
        decisionId: "tool_call_edit_before_001",
        behavior: "allow"
      }),
      expect.objectContaining({
        decisionId: "tool_call_bash_001",
        behavior: "ask",
        reasonCode: "bash_action_requires_approval"
      })
    ]);
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_edit_before_001",
        toolName: "edit",
        state: "executed"
      }),
      expect.objectContaining({
        toolCallId: "tool_call_bash_001",
        toolName: "bash",
        state: "ask",
        permissionDecision: expect.objectContaining({
          behavior: "ask"
        })
      })
    ]);
  });

  it("executes an approved bash call once and returns structured output", async () => {
    const workspace = await createTempWorkspace();
    const { registry, exposure } = createActRegistry(workspace);
    await writeFile(join(workspace, "command-target.txt"), "bash phase 1", "utf8");

    const batch = await executeToolBatch({
      batchId: "batch_bash_allow_001",
      turnId: "turn_bash_allow_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_bash_allow_001",
          toolName: "bash",
          arguments: {
            command: "cat command-target.txt"
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy(),
      permissionContext: {
        approvedDecisionIds: ["tool_call_bash_allow_001"],
        approverId: "operator_001"
      }
    });

    expect(batch.permissionDecisions).toEqual([
      expect.objectContaining({
        decisionId: "tool_call_bash_allow_001",
        behavior: "allow",
        reasonCode: "tool_approved_once",
        approverId: "operator_001"
      })
    ]);
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_bash_allow_001",
        toolName: "bash",
        state: "executed",
        normalizedPayload: {
          contentType: "json",
          value: {
            command: "cat command-target.txt",
            exitCode: 0,
            stdout: "bash phase 1",
            stderr: ""
          }
        }
      })
    ]);
  });

  it("creates parent directories and overwrites files with the write tool", async () => {
    const workspace = await createTempWorkspace();
    const { registry, exposure } = createActRegistry(workspace);

    const created = await executeToolBatch({
      batchId: "batch_write_create_001",
      turnId: "turn_write_create_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_write_create_001",
          toolName: "write",
          arguments: {
            path: "nested/note.txt",
            content: "first version"
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(join(workspace, "nested", "note.txt"), "utf8")).toBe("first version");
    expect(created.executionResults).toEqual([
      expect.objectContaining({
        toolName: "write",
        state: "executed",
        normalizedPayload: {
          contentType: "json",
          value: {
            path: "nested/note.txt",
            created: true,
            bytesWritten: 13
          }
        }
      })
    ]);

    const overwritten = await executeToolBatch({
      batchId: "batch_write_overwrite_001",
      turnId: "turn_write_overwrite_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_write_overwrite_001",
          toolName: "write",
          arguments: {
            path: "nested/note.txt",
            content: "second version"
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(join(workspace, "nested", "note.txt"), "utf8")).toBe("second version");
    expect(overwritten.executionResults).toEqual([
      expect.objectContaining({
        toolName: "write",
        state: "executed",
        normalizedPayload: {
          contentType: "json",
          value: {
            path: "nested/note.txt",
            created: false,
            bytesWritten: 14
          }
        }
      })
    ]);
  });

  it("rejects writes outside the workspace with a standardized error result", async () => {
    const workspace = await createTempWorkspace();
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_write_outside_001",
      turnId: "turn_write_outside_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_write_outside_001",
          toolName: "write",
          arguments: {
            path: "../outside.txt",
            content: "should fail"
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "write",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation",
          message: expect.stringContaining("workspace")
        })
      })
    ]);
  });

  it("rejects write hard-link escapes with a standardized error result and leaves the outside target unchanged", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-write.txt");
    await writeFile(outsideTarget, "outside before", "utf8");
    await link(outsideTarget, join(workspace, "hardlink.txt"));
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_write_hardlink_001",
      turnId: "turn_write_hardlink_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_write_hardlink_001",
          toolName: "write",
          arguments: {
            path: "hardlink.txt",
            content: "outside after"
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(outsideTarget, "utf8")).toBe("outside before");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "write",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation",
          message: expect.stringContaining("workspace")
        })
      })
    ]);
  });

  it("rejects write symlink escapes with a standardized error result and leaves the outside target unchanged", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-write.txt");
    await writeFile(outsideTarget, "outside before", "utf8");
    await symlink(outsideTarget, join(workspace, "link.txt"));
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_write_symlink_001",
      turnId: "turn_write_symlink_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_write_symlink_001",
          toolName: "write",
          arguments: {
            path: "link.txt",
            content: "outside after"
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(outsideTarget, "utf8")).toBe("outside before");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "write",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation",
          message: expect.stringContaining("symbolic link")
        })
      })
    ]);
  });

  it("applies multi-edit exact replacements against the original file", async () => {
    const workspace = await createTempWorkspace();
    const target = join(workspace, "editable.txt");
    await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_edit_success_001",
      turnId: "turn_edit_success_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_success_001",
          toolName: "edit",
          arguments: {
            path: "editable.txt",
            edits: [
              { oldText: "alpha", newText: "ALPHA" },
              { oldText: "gamma", newText: "GAMMA" }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(target, "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "edit",
        state: "executed",
        normalizedPayload: {
          contentType: "json",
          value: {
            path: "editable.txt",
            editsApplied: 2,
            bytesWritten: 17
          }
        }
      })
    ]);
  });

  it("fails the whole edit batch when a later edit only matches intermediate content", async () => {
    const workspace = await createTempWorkspace();
    const target = join(workspace, "intermediate.txt");
    await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_edit_intermediate_001",
      turnId: "turn_edit_intermediate_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_intermediate_001",
          toolName: "edit",
          arguments: {
            path: "intermediate.txt",
            edits: [
              { oldText: "alpha", newText: "ALPHA" },
              { oldText: "ALPHA\nbeta", newText: "ALPHA+BETA" }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(target, "utf8")).toBe("alpha\nbeta\ngamma\n");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "edit",
        state: "error",
        error: expect.objectContaining({
          code: "edit_missing_match",
          message: expect.stringContaining("exactly once")
        })
      })
    ]);
  });

  it("rejects non-unique exact replacements without partially writing the file", async () => {
    const workspace = await createTempWorkspace();
    const target = join(workspace, "duplicate.txt");
    await writeFile(target, "dup\ndup\n", "utf8");
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_edit_duplicate_001",
      turnId: "turn_edit_duplicate_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_duplicate_001",
          toolName: "edit",
          arguments: {
            path: "duplicate.txt",
            edits: [
              { oldText: "dup", newText: "unique" }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(target, "utf8")).toBe("dup\ndup\n");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "edit",
        state: "error",
        error: expect.objectContaining({
          code: "edit_non_unique_match",
          message: expect.stringContaining("exactly once")
        })
      })
    ]);
  });

  it("rejects touching edit ranges so the file is never partially rewritten", async () => {
    const workspace = await createTempWorkspace();
    const target = join(workspace, "touching.txt");
    await writeFile(target, "abcd", "utf8");
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_edit_touching_001",
      turnId: "turn_edit_touching_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_touching_001",
          toolName: "edit",
          arguments: {
            path: "touching.txt",
            edits: [
              { oldText: "ab", newText: "xy" },
              { oldText: "cd", newText: "zz" }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(target, "utf8")).toBe("abcd");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "edit",
        state: "error",
        error: expect.objectContaining({
          code: "edit_conflict",
          message: expect.stringContaining("overlap or touch")
        })
      })
    ]);
  });

  it("rejects edit paths outside the workspace", async () => {
    const workspace = await createTempWorkspace();
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_edit_outside_001",
      turnId: "turn_edit_outside_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_outside_001",
          toolName: "edit",
          arguments: {
            path: "../escape.txt",
            edits: [
              { oldText: "nope", newText: "still nope" }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "edit",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation",
          message: expect.stringContaining("workspace")
        })
      })
    ]);
  });

  it("rejects edit hard-link escapes with a standardized error result and leaves the outside target unchanged", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-edit.txt");
    await writeFile(outsideTarget, "before edit", "utf8");
    await link(outsideTarget, join(workspace, "hardlink.txt"));
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_edit_hardlink_001",
      turnId: "turn_edit_hardlink_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_hardlink_001",
          toolName: "edit",
          arguments: {
            path: "hardlink.txt",
            edits: [
              { oldText: "before", newText: "after" }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(outsideTarget, "utf8")).toBe("before edit");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "edit",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation",
          message: expect.stringContaining("workspace")
        })
      })
    ]);
  });

  it("rejects edit symlink escapes with a standardized error result and leaves the outside target unchanged", async () => {
    const workspace = await createTempWorkspace();
    const outsideDir = await createTempWorkspace();
    const outsideTarget = join(outsideDir, "outside-edit.txt");
    await writeFile(outsideTarget, "before edit", "utf8");
    await symlink(outsideTarget, join(workspace, "link.txt"));
    const { registry, exposure } = createActRegistry(workspace);

    const batch = await executeToolBatch({
      batchId: "batch_edit_symlink_001",
      turnId: "turn_edit_symlink_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      requestedToolCalls: [
        {
          toolCallId: "tool_call_edit_symlink_001",
          toolName: "edit",
          arguments: {
            path: "link.txt",
            edits: [
              { oldText: "before", newText: "after" }
            ]
          }
        }
      ],
      exposure,
      registry,
      artifacts: createArtifactPolicy()
    });

    expect(await readFile(outsideTarget, "utf8")).toBe("before edit");
    expect(batch.executionResults).toEqual([
      expect.objectContaining({
        toolName: "edit",
        state: "error",
        error: expect.objectContaining({
          code: "workspace_violation",
          message: expect.stringContaining("symbolic link")
        })
      })
    ]);
  });
});
