import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  clearExecutableResolutionCache,
  EXECUTABLE_CACHE_HIT_TTL_MS,
  EXECUTABLE_CACHE_MISS_TTL_MS,
  executableExists,
  findExecutable,
} from "./executable-resolution.js";
import { windowsExecutableResolution } from "./windows.js";
import { isPlatform } from "../test-utils/platform.js";

const originalEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-executable-test-"));
  tempDirs.push(dir);
  return dir;
}

function prependPath(...dirs: string[]): void {
  process.env.PATH = [...dirs, originalEnv.PATH].filter(Boolean).join(path.delimiter);
}

function writeExecutable(filePath: string, content: string): string {
  writeFileSync(filePath, content);
  if (!isPlatform("win32")) {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeBrokenAbsoluteFixture(dir: string): string {
  const filePath = isPlatform("win32") ? path.join(dir, "broken.exe") : path.join(dir, "broken");
  writeFileSync(filePath, "not executable");
  if (!isPlatform("win32")) {
    chmodSync(filePath, 0o644);
  }
  return filePath;
}

function expectWindowsPathsEqual(actual: string | null, expected: string): void {
  expect(actual?.toLowerCase()).toBe(expected.toLowerCase());
}

afterEach(() => {
  vi.useRealTimers();
  clearExecutableResolutionCache();
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findExecutable", () => {
  test.runIf(isPlatform("linux"))(
    "propagates a failed lookup process instead of reporting a missing executable",
    async () => {
      await expect(findExecutable("x".repeat(1024 * 1024))).rejects.toMatchObject({
        code: "E2BIG",
      });
    },
  );

  describe.skipIf(isPlatform("win32"))("POSIX", () => {
    test("finds an extensionless executable and skips an earlier non-executable candidate", async () => {
      const executableDir = makeTempDir();
      const nonExecutableDir = makeTempDir();
      const executable = writeExecutable(path.join(executableDir, "foo"), "#!/bin/sh\necho 0.1\n");
      const nonExecutable = path.join(nonExecutableDir, "foo");
      writeFileSync(nonExecutable, "#!/bin/sh\necho broken\n");
      chmodSync(nonExecutable, 0o644);
      prependPath(nonExecutableDir, executableDir);

      await expect(findExecutable("foo")).resolves.toBe(executable);
    });
  });

  describe.skipIf(isPlatform("win32"))("cache", () => {
    // Each `--version` probe appends a line, so the log counts uncached resolutions.
    function writeCountingExecutable(dir: string, name: string): { path: string; log: string } {
      const log = path.join(dir, `${name}.probes`);
      const file = writeExecutable(
        path.join(dir, name),
        `#!/bin/sh\necho probe >> "${log}"\necho 1.0\n`,
      );
      return { path: file, log };
    }

    function probeCount(log: string): number {
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
    }

    test("a repeated lookup is served from the cache without spawning", async () => {
      const dir = makeTempDir();
      const tool = writeCountingExecutable(dir, "paseo-cache-hit");
      prependPath(dir);

      await expect(findExecutable("paseo-cache-hit")).resolves.toBe(tool.path);
      await expect(findExecutable("paseo-cache-hit")).resolves.toBe(tool.path);
      await Promise.all([findExecutable("paseo-cache-hit"), findExecutable("paseo-cache-hit")]);

      expect(probeCount(tool.log)).toBe(1);
    });

    test("a PATH change misses the cache, and the old PATH still hits", async () => {
      const first = makeTempDir();
      const second = makeTempDir();
      const a = writeCountingExecutable(first, "paseo-cache-path");
      const b = writeCountingExecutable(second, "paseo-cache-path");

      prependPath(first);
      await expect(findExecutable("paseo-cache-path")).resolves.toBe(a.path);
      prependPath(second);
      await expect(findExecutable("paseo-cache-path")).resolves.toBe(b.path);
      await expect(
        findExecutable("paseo-cache-path", { env: { PATH: process.env.PATH } }),
      ).resolves.toBe(b.path);
      prependPath(first);
      await expect(findExecutable("paseo-cache-path")).resolves.toBe(a.path);

      expect(probeCount(a.log)).toBe(1);
      expect(probeCount(b.log)).toBe(1);
    });

    test("a found path expires after the hit TTL", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const dir = makeTempDir();
      const tool = writeCountingExecutable(dir, "paseo-cache-ttl");
      prependPath(dir);

      await findExecutable("paseo-cache-ttl");
      vi.advanceTimersByTime(EXECUTABLE_CACHE_HIT_TTL_MS - 1000);
      await findExecutable("paseo-cache-ttl");
      expect(probeCount(tool.log)).toBe(1);
      vi.advanceTimersByTime(2000);
      await findExecutable("paseo-cache-ttl");
      expect(probeCount(tool.log)).toBe(2);
    });

    test("a miss is cached briefly, then a newly installed CLI is found", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const dir = makeTempDir();
      prependPath(dir);

      await expect(findExecutable("paseo-cache-late")).resolves.toBeNull();
      const tool = writeCountingExecutable(dir, "paseo-cache-late");
      await expect(findExecutable("paseo-cache-late")).resolves.toBeNull();
      vi.advanceTimersByTime(EXECUTABLE_CACHE_MISS_TTL_MS + 1);
      await expect(findExecutable("paseo-cache-late")).resolves.toBe(tool.path);
    });

    test("a cached path that was deleted is resolved again", async () => {
      const first = makeTempDir();
      const second = makeTempDir();
      const a = writeCountingExecutable(first, "paseo-cache-gone");
      const b = writeCountingExecutable(second, "paseo-cache-gone");
      prependPath(first, second);

      await expect(findExecutable("paseo-cache-gone")).resolves.toBe(a.path);
      rmSync(a.path);
      await expect(findExecutable("paseo-cache-gone")).resolves.toBe(b.path);
      expect(probeCount(b.log)).toBe(1);
    });
  });

  describe.runIf(isPlatform("win32"))("Windows", () => {
    test("returns a working .cmd when an invalid .exe candidate appears first", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = [".EXE", ".CMD"].join(path.delimiter);
      const brokenExe = path.join(dir, "foo.exe");
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      writeFileSync(brokenExe, "");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });

    test("returns null when the only candidate is a broken .exe", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".EXE";
      writeFileSync(path.join(dir, "foo.exe"), "");
      prependPath(dir);

      await expect(findExecutable("foo")).resolves.toBeNull();
    });

    test("returns a .cmd when it is the only candidate", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".CMD";
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });

    test("finds a .cmd for an extensionless absolute path", async () => {
      const dir = makeTempDir();
      const command = path.join(dir, "codex");
      const cmd = writeExecutable(`${command}.cmd`, "@echo off\r\necho 0.1\r\n");

      expectWindowsPathsEqual(await findExecutable(command), cmd);
    });

    test("does not probe fabricated absolute path extensions that do not exist", async () => {
      const dir = makeTempDir();
      const command = path.join(dir, "missing-command");

      await expect(findExecutable(command)).resolves.toBeNull();
    });

    test("finds a winget portable executable outside PATH", async () => {
      const originalLocalAppData = process.env.LOCALAPPDATA;
      const localAppData = makeTempDir();
      const packageDir = path.join(
        localAppData,
        "Microsoft",
        "WinGet",
        "Packages",
        "Anthropic.ClaudeCode_abc",
      );
      mkdirSync(packageDir, { recursive: true });
      const claude = path.join(packageDir, "claude.exe");
      copyFileSync(process.execPath, claude);
      process.env.LOCALAPPDATA = localAppData;
      process.env.PATH = makeTempDir();
      try {
        expectWindowsPathsEqual(await findExecutable("claude"), claude);
      } finally {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    });
  });

  test("returns an invokable absolute path", async () => {
    await expect(findExecutable(process.execPath)).resolves.toBe(process.execPath);
  });

  test("returns null for an absolute path that cannot spawn", async () => {
    const dir = makeTempDir();
    const fixture = writeBrokenAbsoluteFixture(dir);

    await expect(findExecutable(fixture)).resolves.toBeNull();
  });

  test("returns null when the command is not on PATH", async () => {
    const dir = makeTempDir();
    prependPath(dir);

    await expect(findExecutable("paseo-definitely-missing-command")).resolves.toBeNull();
  });

  test("Windows resolution skips literal path candidates that do not exist", async () => {
    const probeExecutable = vi.fn(async () => true);

    await expect(
      windowsExecutableResolution.find("C:\\tools\\missing-command", {
        enumeratePathCandidates: async () => [],
        probeExecutable,
        exists: () => false,
        probeTimeoutMs: 100,
      }),
    ).resolves.toBeNull();
    expect(probeExecutable).not.toHaveBeenCalled();
  });
});

describe("executableExists", () => {
  test("returns the path when it already exists", () => {
    const exists = (candidate: string) => candidate === "/usr/local/bin/codex";

    expect(executableExists("/usr/local/bin/codex", exists)).toBe("/usr/local/bin/codex");
  });

  test("on Windows, falls back to .exe, then .cmd for extensionless paths", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    try {
      const exists = (candidate: string) => candidate === "C:\\tools\\codex.cmd";

      expect(executableExists("C:\\tools\\codex", exists)).toBe("C:\\tools\\codex.cmd");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  test("on Windows, ignores PowerShell scripts for extensionless paths", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    try {
      const exists = (candidate: string) => candidate === "C:\\tools\\codex.ps1";

      expect(executableExists("C:\\tools\\codex", exists)).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  test("returns null when no matching path exists", () => {
    expect(executableExists("/missing/codex", () => false)).toBeNull();
  });
});
