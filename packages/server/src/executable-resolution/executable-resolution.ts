import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { execCommand } from "../utils/spawn.js";
import which from "which";
import { windowsExecutableResolution } from "./windows.js";

const PROBE_TIMEOUT_MS = 2000;

// findExecutable runs `which -a` plus `<candidate> --version` for every call. Provider
// availability checks and forge (gh/glab/tea) calls hit it many times a minute, and each
// spawn forks the whole daemon (a 1 GB parent makes fork the dominant kernel cost). Results
// are cached per (name, PATH): a found path for 5 minutes, a miss for 1 minute so a CLI
// installed while the daemon runs is still picked up quickly. A PATH change is a different
// key, and a cached path that no longer exists on disk is re-resolved.
export const EXECUTABLE_CACHE_HIT_TTL_MS = 5 * 60_000;
export const EXECUTABLE_CACHE_MISS_TTL_MS = 60_000;
const EXECUTABLE_CACHE_MAX_ENTRIES = 256;

interface ExecutableCacheEntry {
  result: Promise<string | null>;
  expiresAtMs: number;
}

const executableCache = new Map<string, ExecutableCacheEntry>();

export function clearExecutableResolutionCache(): void {
  executableCache.clear();
}

function executableCacheKey(name: string, env?: ProcessEnvRecord): string {
  const windows = process.platform === "win32";
  return JSON.stringify([
    process.platform,
    name,
    env?.PATH ?? process.env.PATH ?? null,
    windows ? (env?.PATHEXT ?? process.env.PATHEXT ?? null) : null,
    windows ? (process.env.LOCALAPPDATA ?? null) : null,
  ]);
}

function readCachedExecutable(key: string): Promise<string | null> | null {
  const entry = executableCache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAtMs <= Date.now()) {
    executableCache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheExecutableLookup(
  key: string,
  resolveExecutable: () => Promise<string | null>,
): Promise<string | null> {
  // In flight: concurrent callers share the lookup. Settled: the TTL depends on the outcome.
  const entry: ExecutableCacheEntry = {
    result: Promise.resolve(null),
    expiresAtMs: Number.POSITIVE_INFINITY,
  };
  executableCache.delete(key);
  executableCache.set(key, entry);
  while (executableCache.size > EXECUTABLE_CACHE_MAX_ENTRIES) {
    const oldest = executableCache.keys().next().value;
    if (oldest === undefined) break;
    executableCache.delete(oldest);
  }
  entry.result = (async () => {
    try {
      const found = await resolveExecutable();
      entry.expiresAtMs =
        Date.now() + (found ? EXECUTABLE_CACHE_HIT_TTL_MS : EXECUTABLE_CACHE_MISS_TTL_MS);
      return found;
    } catch (error) {
      // A failed lookup is not evidence of anything; never cache it.
      if (executableCache.get(key) === entry) executableCache.delete(key);
      throw error;
    }
  })();
  return entry.result;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string, env?: ProcessEnvRecord): Promise<string[]> {
  if (process.platform !== "win32" && existsSync("/usr/bin/which")) {
    return enumerateCandidatesViaSystemWhich(name, env);
  }
  return enumerateCandidatesViaLibrary(name, env);
}

async function enumerateCandidatesViaSystemWhich(
  name: string,
  env?: ProcessEnvRecord,
): Promise<string[]> {
  try {
    const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
      baseEnv: env,
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch (error) {
    // which exits 1 for a missing command. A failed lookup is not evidence of absence.
    if (error instanceof Error && "code" in error && error.code === 1) return [];
    throw error;
  }
}

async function enumerateCandidatesViaLibrary(
  name: string,
  env?: ProcessEnvRecord,
): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await which(name, { all: true, path: env?.PATH, pathExt: env?.PATHEXT });
  } catch (error) {
    // `which` throws ENOENT when the command is absent from PATH.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

export async function probeExecutable(
  executablePath: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const { probeTimeoutMs: timeoutMs = PROBE_TIMEOUT_MS, env } =
    typeof options === "number" ? { probeTimeoutMs: options } : options;
  try {
    await execCommand(executablePath, ["--version"], {
      baseEnv: env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (error) {
    return classifyProbeError(error);
  }
}

function classifyProbeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  if (err.killed) {
    return true;
  }
  if (typeof err.code === "number") {
    return true;
  }
  if (
    err.code === "ENOENT" ||
    err.code === "EACCES" ||
    err.code === "ENOEXEC" ||
    err.code === "UNKNOWN"
  ) {
    return false;
  }
  return false;
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (process.platform === "win32") {
    return windowsExecutableResolution.exists(executablePath, { exists });
  }
  return exists(executablePath) ? executablePath : null;
}

// PATH lookup that never runs the candidate, unlike findExecutable which probes
// each one with `--version`. A terminal spawn path cannot afford that probe: it
// would execute the profile command once before the terminal even opens.
// `path` overrides the PATH to search, so a caller can resolve against the
// environment its child process will actually get rather than the daemon's own.
export async function findExecutableWithoutProbing(
  name: string,
  options: { path?: string; cwd: string },
): Promise<string | null> {
  if (!name) {
    return null;
  }
  const path =
    options.path === undefined
      ? undefined
      : options.path
          .split(delimiter)
          .map((entry) => resolve(options.cwd, entry))
          .join(delimiter);
  const candidates = await enumerateCandidatesViaLibrary(name, { PATH: path });
  return candidates[0] ?? null;
}

export interface ExecutableResolutionOptions {
  probeTimeoutMs?: number;
  env?: ProcessEnvRecord;
}

export async function findExecutable(
  name: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const { probeTimeoutMs = PROBE_TIMEOUT_MS, env } =
    typeof options === "number" ? { probeTimeoutMs: options } : options;
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  const key = executableCacheKey(trimmed, env);
  const cached = readCachedExecutable(key);
  if (cached) {
    const found = await cached.catch(() => undefined);
    if (found === null || (found !== undefined && existsSync(found))) {
      return found;
    }
    if (found !== undefined && executableCache.get(key)?.result === cached) {
      executableCache.delete(key);
    }
  }
  return cacheExecutableLookup(key, () => resolveExecutableUncached(trimmed, probeTimeoutMs, env));
}

async function resolveExecutableUncached(
  trimmed: string,
  probeTimeoutMs: number,
  env: ProcessEnvRecord | undefined,
): Promise<string | null> {
  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: (command) => enumerateCandidates(command, env),
      probeExecutable: (command, timeout) =>
        probeExecutable(command, { probeTimeoutMs: timeout, env }),
      exists: existsSync,
      probeTimeoutMs,
    });
  }

  if (hasPathSeparator(trimmed)) {
    return (await probeExecutable(trimmed, { probeTimeoutMs, env })) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed, env);
  for (const candidate of candidates) {
    if (await probeExecutable(candidate, { probeTimeoutMs, env })) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
