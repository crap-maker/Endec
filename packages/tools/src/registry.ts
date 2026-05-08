import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NormalizedToolResultPayload, RuntimeToolDefinition } from "@endec/domain";

export type ToolExecutionContext = {
  cwd: string;
  arguments: unknown;
};

export type ToolExecutionOutput = {
  normalizedPayload: NormalizedToolResultPayload;
  metadata?: Record<string, unknown>;
};

export type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: RuntimeToolDefinition["inputSchema"];
  hiddenByDefault: boolean;
  execute?: (context: ToolExecutionContext) => Promise<ToolExecutionOutput>;
};

export type StaticToolRegistry = {
  cwd: string;
  listAll(): RegisteredTool[];
  get(name: string): RegisteredTool | undefined;
};

type ExactTextEdit = {
  oldText: string;
  newText: string;
};

export class ToolExecutionFailure extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ToolExecutionFailure";
    this.code = code;
    this.details = details;
  }
}

const READ_TOOL: RegisteredTool = {
  name: "read",
  description: "Read a text file from disk.",
  hiddenByDefault: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" }
    },
    required: ["path"]
  },
  async execute(context) {
    const args = asObject(context.arguments);
    const filePath = await requireSafeWorkspaceReadFilePath(context.cwd, requireString(args, "path"));
    const offset = optionalNonNegativeInteger(args, "offset") ?? 0;
    const limit = optionalNonNegativeInteger(args, "limit");
    const content = await readFile(filePath, "utf8");
    const sliced = limit === undefined ? content.slice(offset) : content.slice(offset, offset + limit);

    return {
      normalizedPayload: {
        contentType: "text",
        value: sliced
      }
    };
  }
};

const GLOB_TOOL: RegisteredTool = {
  name: "glob",
  description: "List files matching a glob pattern.",
  hiddenByDefault: false,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      cwd: { type: "string" },
      limit: { type: "number" }
    },
    required: ["pattern"]
  },
  async execute(context) {
    const args = asObject(context.arguments);
    const cwd = await requireSafeWorkspaceReadPath(context.cwd, optionalString(args, "cwd") ?? context.cwd);
    const pattern = requireString(args, "pattern").replaceAll("\\", "/");
    const limit = optionalPositiveInteger(args, "limit");
    const files = await listFiles(cwd);
    const matches = files
      .filter((file) => matchesGlob(pattern, file))
      .slice(0, limit ?? Number.MAX_SAFE_INTEGER);

    return {
      normalizedPayload: {
        contentType: "json",
        value: {
          matches
        }
      }
    };
  }
};

const GREP_TOOL: RegisteredTool = {
  name: "grep",
  description: "Search text files for a pattern.",
  hiddenByDefault: false,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      limit: { type: "number" }
    },
    required: ["pattern"]
  },
  async execute(context) {
    const args = asObject(context.arguments);
    const pattern = requireString(args, "pattern");
    const targetPath = await requireSafeWorkspaceReadPath(context.cwd, optionalString(args, "path") ?? context.cwd);
    const globPattern = optionalString(args, "glob");
    const limit = optionalPositiveInteger(args, "limit") ?? Number.MAX_SAFE_INTEGER;
    const targetStat = await stat(targetPath);
    const rootDir = targetStat.isDirectory() ? targetPath : resolve(targetPath, "..");
    const candidateFiles = targetStat.isDirectory()
      ? await listFiles(targetPath)
      : [basename(targetPath).replaceAll("\\", "/")];
    const matches = [] as Array<{ path: string; lineNumber: number; line: string }>;

    for (const relativePath of candidateFiles) {
      if (globPattern && !matchesGlob(globPattern.replaceAll("\\", "/"), relativePath)) {
        continue;
      }

      const absolutePath = targetStat.isDirectory() ? join(targetPath, relativePath) : targetPath;
      await ensureNoHardLinkEscapeOnWorkspaceReadPath(context.cwd, absolutePath, toWorkspaceRelativePath(context.cwd, absolutePath));
      const content = await readFile(absolutePath, "utf8");
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!line.includes(pattern)) {
          continue;
        }

        matches.push({
          path: normalizeRelativePath(relative(rootDir, absolutePath) || basename(absolutePath)),
          lineNumber: index + 1,
          line
        });

        if (matches.length >= limit) {
          return {
            normalizedPayload: {
              contentType: "json",
              value: {
                matches
              }
            }
          };
        }
      }
    }

    return {
      normalizedPayload: {
        contentType: "json",
        value: {
          matches
        }
      }
    };
  }
};

const WRITE_TOOL: RegisteredTool = {
  name: "write",
  description: "Write a file to disk.",
  hiddenByDefault: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" }
    },
    required: ["path", "content"]
  },
  async execute(context) {
    const args = asObject(context.arguments);
    const filePath = await requireSafeWorkspaceWritePath(context.cwd, requireString(args, "path"));
    const content = requireString(args, "content", { allowEmpty: true });
    const relativePath = toWorkspaceRelativePath(context.cwd, filePath);
    let created = false;

    try {
      const targetStat = await stat(filePath);
      if (!targetStat.isFile()) {
        throw new ToolExecutionFailure("invalid_path", `Write target ${relativePath} must be a file path.`);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        created = true;
      } else {
        throw error;
      }
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");

    return {
      normalizedPayload: {
        contentType: "json",
        value: {
          path: relativePath,
          created,
          bytesWritten: Buffer.byteLength(content, "utf8")
        }
      },
      metadata: {
        path: relativePath,
        created,
        bytesWritten: Buffer.byteLength(content, "utf8")
      }
    };
  }
};

const EDIT_TOOL: RegisteredTool = {
  name: "edit",
  description: "Edit an existing file.",
  hiddenByDefault: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" }
          },
          required: ["oldText", "newText"]
        }
      }
    },
    required: ["path", "edits"]
  },
  async execute(context) {
    const args = asObject(context.arguments);
    const filePath = await requireSafeWorkspaceWritePath(context.cwd, requireString(args, "path"));
    const relativePath = toWorkspaceRelativePath(context.cwd, filePath);
    const edits = requireExactTextEdits(args, "edits");
    const originalContent = await readFile(filePath, "utf8").catch((error) => {
      if (isNodeError(error, "ENOENT")) {
        throw new ToolExecutionFailure("file_not_found", `Edit target ${relativePath} does not exist.`);
      }
      throw error;
    });
    const matches = edits
      .map((edit, index) => {
        const positions = findExactMatchPositions(originalContent, edit.oldText);
        if (positions.length === 0) {
          throw new ToolExecutionFailure(
            "edit_missing_match",
            `Edit ${index + 1} oldText must match exactly once in the original file.`
          );
        }
        if (positions.length > 1) {
          throw new ToolExecutionFailure(
            "edit_non_unique_match",
            `Edit ${index + 1} oldText must match exactly once in the original file.`
          );
        }

        const start = positions[0] ?? 0;
        return {
          index,
          start,
          end: start + edit.oldText.length,
          oldText: edit.oldText,
          newText: edit.newText
        };
      })
      .sort((left, right) => left.start - right.start || left.end - right.end);

    for (let index = 1; index < matches.length; index += 1) {
      const previous = matches[index - 1];
      const current = matches[index];
      if (!previous || !current) {
        continue;
      }
      if (previous.end >= current.start) {
        throw new ToolExecutionFailure(
          "edit_conflict",
          `Edits ${previous.index + 1} and ${current.index + 1} overlap or touch in the original file.`
        );
      }
    }

    let updatedContent = "";
    let cursor = 0;
    for (const match of matches) {
      updatedContent += originalContent.slice(cursor, match.start);
      updatedContent += match.newText;
      cursor = match.end;
    }
    updatedContent += originalContent.slice(cursor);

    await writeFile(filePath, updatedContent, "utf8");

    return {
      normalizedPayload: {
        contentType: "json",
        value: {
          path: relativePath,
          editsApplied: edits.length,
          bytesWritten: Buffer.byteLength(updatedContent, "utf8")
        }
      },
      metadata: {
        path: relativePath,
        editsApplied: edits.length,
        bytesWritten: Buffer.byteLength(updatedContent, "utf8")
      }
    };
  }
};

const BASH_TOOL: RegisteredTool = {
  name: "bash",
  description: "Execute a shell command within the current workspace.",
  hiddenByDefault: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutSeconds: { type: "number" }
    },
    required: ["command"]
  },
  async execute(context) {
    const args = asObject(context.arguments);
    const command = requireString(args, "command");
    const timeoutSeconds = optionalPositiveInteger(args, "timeoutSeconds");
    const result = await executeBashCommand({
      cwd: context.cwd,
      command,
      timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined
    });

    return {
      normalizedPayload: {
        contentType: "json",
        value: {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        }
      },
      metadata: {
        command,
        exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8")
      }
    };
  }
};

const HIDDEN_TOOLS: RegisteredTool[] = [
  WRITE_TOOL,
  EDIT_TOOL,
  BASH_TOOL
];

export function createStaticToolRegistry(options?: { cwd?: string; additionalTools?: RegisteredTool[] }): StaticToolRegistry {
  const cwd = resolve(options?.cwd ?? process.cwd());
  const tools = [READ_TOOL, GLOB_TOOL, GREP_TOOL, ...HIDDEN_TOOLS, ...(options?.additionalTools ?? [])];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    cwd,
    listAll() {
      return tools.slice();
    },
    get(name) {
      return byName.get(name);
    }
  };
}

export function toRuntimeToolDefinition(tool: RegisteredTool): RuntimeToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    metadata: {
      hiddenByDefault: tool.hiddenByDefault
    }
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolExecutionFailure("invalid_arguments", "Tool arguments must be an object.");
  }

  return value as Record<string, unknown>;
}

function requireString(input: Record<string, unknown>, key: string, options?: { allowEmpty?: boolean }) {
  const value = input[key];
  if (typeof value !== "string" || (!options?.allowEmpty && value.length === 0)) {
    const qualifier = options?.allowEmpty ? "a string" : "a non-empty string";
    throw new ToolExecutionFailure("invalid_arguments", `Tool argument ${key} must be ${qualifier}.`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionFailure("invalid_arguments", `Tool argument ${key} must be a string when provided.`);
  }
  return value;
}

function optionalNonNegativeInteger(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ToolExecutionFailure("invalid_arguments", `Tool argument ${key} must be a non-negative integer when provided.`);
  }
  return value as number;
}

function optionalPositiveInteger(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ToolExecutionFailure("invalid_arguments", `Tool argument ${key} must be a positive integer when provided.`);
  }
  return value as number;
}

async function executeBashCommand(input: {
  cwd: string;
  command: string;
  timeoutMs?: number;
}) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn("bash", ["-lc", input.command], {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      callback();
    };

    const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
    const timeoutHandle = typeof timeoutMs === "number"
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish(() => rejectPromise(new ToolExecutionFailure(
            "bash_timeout",
            `bash command timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
            { command: input.command, timeoutMs }
          )));
        }, timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(() => rejectPromise(new ToolExecutionFailure(
        "bash_spawn_failed",
        `Failed to start bash: ${error.message}`,
        { command: input.command }
      )));
    });
    child.on("close", (code, signal) => {
      finish(() => resolvePromise({
        exitCode: typeof code === "number" ? code : signal ? 1 : 0,
        stdout,
        stderr: signal ? `${stderr}${stderr.length > 0 ? "\n" : ""}terminated by signal ${signal}` : stderr
      }));
    });
  });
}

function requireExactTextEdits(input: Record<string, unknown>, key: string): ExactTextEdit[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolExecutionFailure("invalid_arguments", `Tool argument ${key} must be a non-empty array.`);
  }

  return value.map((item, index) => {
    const edit = asObject(item);
    try {
      return {
        oldText: requireString(edit, "oldText"),
        newText: requireString(edit, "newText", { allowEmpty: true })
      };
    } catch (error) {
      if (error instanceof ToolExecutionFailure) {
        throw new ToolExecutionFailure(error.code, `Tool argument ${key}[${index}] is invalid: ${error.message}`);
      }
      throw error;
    }
  });
}

function resolveInputPath(cwd: string, inputPath: string) {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
}

function requireWorkspacePath(cwd: string, inputPath: string) {
  const resolvedPath = resolveInputPath(cwd, inputPath);
  const relativePath = relative(cwd, resolvedPath);
  const insideWorkspace = relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));

  if (!insideWorkspace) {
    throw new ToolExecutionFailure(
      "workspace_violation",
      `Path ${inputPath} must stay within the workspace rooted at ${cwd}.`
    );
  }

  return resolvedPath;
}

async function requireSafeWorkspaceReadPath(cwd: string, inputPath: string) {
  const resolvedPath = requireWorkspacePath(cwd, inputPath);
  await ensureNoSymlinkOnWorkspacePath(cwd, resolvedPath, inputPath);
  return resolvedPath;
}

async function requireSafeWorkspaceReadFilePath(cwd: string, inputPath: string) {
  const resolvedPath = await requireSafeWorkspaceReadPath(cwd, inputPath);
  await ensureNoHardLinkEscapeOnWorkspaceReadPath(cwd, resolvedPath, inputPath);
  return resolvedPath;
}

async function requireSafeWorkspaceWritePath(cwd: string, inputPath: string) {
  const resolvedPath = requireWorkspacePath(cwd, inputPath);
  await ensureNoSymlinkOnWorkspacePath(cwd, resolvedPath, inputPath);
  await ensureNoHardLinkEscapeOnWorkspaceWritePath(cwd, resolvedPath, inputPath);
  return resolvedPath;
}

async function ensureNoSymlinkOnWorkspacePath(cwd: string, resolvedPath: string, inputPath: string) {
  const relativePath = relative(cwd, resolvedPath);
  const segments = normalizeRelativePath(relativePath)
    .split("/")
    .filter((segment) => segment.length > 0);
  let currentPath = cwd;

  for (const segment of segments) {
    currentPath = join(currentPath, segment);

    try {
      const entry = await lstat(currentPath);
      if (entry.isSymbolicLink()) {
        throw new ToolExecutionFailure(
          "workspace_violation",
          `Path ${inputPath} must stay within the workspace rooted at ${cwd}; tool paths cannot traverse a symbolic link.`
        );
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  }
}

async function ensureNoHardLinkEscapeOnWorkspaceReadPath(cwd: string, resolvedPath: string, inputPath: string) {
  try {
    const entry = await lstat(resolvedPath);
    if (entry.isFile() && entry.nlink > 1) {
      throw new ToolExecutionFailure(
        "workspace_violation",
        `Path ${inputPath} must stay within the workspace rooted at ${cwd}; readonly tool paths cannot target an existing file with multiple hard links.`
      );
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function ensureNoHardLinkEscapeOnWorkspaceWritePath(cwd: string, resolvedPath: string, inputPath: string) {
  try {
    const entry = await lstat(resolvedPath);
    if (entry.isFile() && entry.nlink > 1) {
      throw new ToolExecutionFailure(
        "workspace_violation",
        `Path ${inputPath} must stay within the workspace rooted at ${cwd}; writable tool paths cannot target an existing file with multiple hard links.`
      );
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

function toWorkspaceRelativePath(cwd: string, filePath: string) {
  const relativePath = normalizeRelativePath(relative(cwd, filePath));
  return relativePath.length > 0 ? relativePath : basename(filePath);
}

function findExactMatchPositions(content: string, needle: string) {
  const matches: number[] = [];
  let fromIndex = 0;

  while (fromIndex <= content.length - needle.length) {
    const nextIndex = content.indexOf(needle, fromIndex);
    if (nextIndex === -1) {
      break;
    }
    matches.push(nextIndex);
    fromIndex = nextIndex + 1;
  }

  return matches;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function listFiles(rootDir: string) {
  const discovered: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }

      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      discovered.push(normalizeRelativePath(relative(rootDir, absolutePath)));
    }
  }

  return discovered.sort((left, right) => left.localeCompare(right));
}

function matchesGlob(pattern: string, relativePath: string) {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedPath = normalizeRelativePath(relativePath);
  const tokenized = normalizedPattern
    .replace(/\*\*\//g, "__GLOBSTAR_DIR__")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "__STAR__")
    .replace(/\?/g, "__QUESTION__");
  const escaped = tokenized.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  const regex = escaped
    .replace(/__GLOBSTAR_DIR__/g, "(?:.*/)?")
    .replace(/__GLOBSTAR__/g, ".*")
    .replace(/__STAR__/g, "[^/]*")
    .replace(/__QUESTION__/g, "[^/]");

  return new RegExp(`^${regex}$`).test(normalizedPath);
}

function normalizeRelativePath(path: string) {
  return path.split(sep).join("/");
}
