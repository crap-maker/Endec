export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function isCliUsageError(error: unknown): error is { message: string } {
  if (error instanceof CliUsageError) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (
    "name" in error &&
    error.name === "CliUsageError" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function parseCommandArgs(
  args: string[],
  input: {
    stringOptions?: string[];
    booleanOptions?: string[];
  }
) {
  const stringOptions = new Set(input.stringOptions ?? []);
  const booleanOptions = new Set(input.booleanOptions ?? []);
  const options = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (booleanOptions.has(token)) {
      options.set(token, true);
      continue;
    }

    if (!stringOptions.has(token)) {
      throw new CliUsageError(`unknown option: ${token}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`missing value for ${token}`);
    }

    options.set(token, value);
    index += 1;
  }

  return { options, positionals };
}

export function readRequiredOption(options: Map<string, string | boolean>, key: string) {
  const value = options.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(`missing required option: ${key}`);
  }
  return value;
}

export function readOptionalOption(options: Map<string, string | boolean>, key: string) {
  const value = options.get(key);
  return typeof value === "string" ? value : undefined;
}

export function readBooleanOption(options: Map<string, string | boolean>, key: string) {
  return options.get(key) === true;
}

export function readOptionalPositiveIntOption(options: Map<string, string | boolean>, key: string) {
  const value = readOptionalOption(options, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`invalid positive integer for ${key}: ${value}`);
  }

  return parsed;
}
