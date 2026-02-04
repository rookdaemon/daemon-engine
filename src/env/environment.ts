/**
 * environment.ts — Abstraction for all side-effectful environment operations.
 *
 * This module centralizes filesystem, subprocess, time, process, OS, path, and HTTP server
 * operations behind interfaces so the runtime can be implemented with platform-specific
 * behavior and tests can mock everything without touching the real machine.
 */

import type { Dirent } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ChildProcess } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export interface FsOps {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
  writeFileAppend(path: string, data: string, encoding: "utf-8"): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  readdir(path: string, opts?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]>;
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  access(path: string): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface ProcessOps {
  platform(): NodeJS.Platform;
  env(key: string): string | undefined;
  on(signal: NodeJS.Signals, handler: () => void): void;
  exit(code: number): never;
  setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(id: NodeJS.Timeout): void;
}

export interface OsOps {
  homedir(): string;
  tmpdir(): string;
}

export interface PathOps {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(path: string): string;

  /**
   * Convert arbitrary identifiers (session keys, hook names, etc.) to a filename-safe form.
   * Must be safe on Windows (no `:` or other reserved characters).
   */
  safeId(id: string): string;
}

export interface SubprocessOps {
  execFile(
    command: string,
    args: readonly string[],
    opts: { cwd?: string; timeout?: number; maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }>;

  spawn(
    command: string,
    args: readonly string[],
    opts: { cwd?: string; stdio: ["pipe", "pipe", "pipe"] }
  ): ChildProcess;
}

export interface ShellOps {
  /**
   * Execute a shell script string using the platform shell.
   * This is intentionally “stringly typed” and should be used sparingly.
   */
  run(script: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
}

export interface HttpOps {
  createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  ): Server;
}

export interface Environment {
  fs: FsOps;
  clock: Clock;
  process: ProcessOps;
  os: OsOps;
  path: PathOps;
  subprocess: SubprocessOps;
  shell: ShellOps;
  http: HttpOps;
}

export function safeIdDefault(id: string): string {
  // Windows reserved characters: < > : " / \ | ? * plus control chars.
  // Also normalize whitespace to underscores.
  return id
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_");
}

export class BashShell implements ShellOps {
  constructor(private readonly subprocess: SubprocessOps) {}

  async run(script: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
    return await this.subprocess.execFile("bash", ["-lc", script], {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}

export class PowerShellShell implements ShellOps {
  constructor(private readonly subprocess: SubprocessOps) {}

  async run(script: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
    return await this.subprocess.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}

/**
 * Default Node.js environment implementation.
 */
export function createNodeEnvironment(): Environment {
  const execFileAsync = promisify(execFile);

  const subprocess: SubprocessOps = {
    execFile: async (command, args, opts) => {
      const { stdout, stderr } = await execFileAsync(command, args as string[], {
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
    spawn: (command, args, opts) => spawn(command, args as string[], opts),
  };

  const pathOps: PathOps = {
    join: (...parts) => path.join(...parts),
    resolve: (...parts) => path.resolve(...parts),
    dirname: (p) => path.dirname(p),
    safeId: safeIdDefault,
  };

  const processOps: ProcessOps = {
    platform: () => process.platform,
    env: (key) => process.env[key],
    on: (signal, handler) => process.on(signal, handler),
    exit: (code) => process.exit(code),
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (id) => clearTimeout(id),
  };

  const env: Environment = {
    fs: {
      readFile: (p, encoding) => fsPromises.readFile(p, encoding),
      writeFile: (p, data, encoding) => fsPromises.writeFile(p, data, encoding).then(() => undefined),
      writeFileAppend: (p, data, encoding) =>
        fsPromises.writeFile(p, data, { encoding, flag: "a" }).then(() => undefined),
      mkdir: (p, opts) => fsPromises.mkdir(p, opts).then(() => undefined),
      readdir: async (p, opts) => {
        if (opts?.withFileTypes) {
          return await fsPromises.readdir(p, { withFileTypes: true });
        }
        return await fsPromises.readdir(p);
      },
      rm: (p, opts) => fsPromises.rm(p, opts).then(() => undefined),
      stat: (p) => fsPromises.stat(p),
      access: (p) => fsPromises.access(p).then(() => undefined),
    },
    clock: { now: () => Date.now() },
    process: processOps,
    os: { homedir: () => os.homedir(), tmpdir: () => os.tmpdir() },
    path: pathOps,
    subprocess,
    shell: process.platform === "win32" ? new PowerShellShell(subprocess) : new BashShell(subprocess),
    http: { createServer: (handler) => http.createServer((req, res) => void handler(req, res)) },
  };

  return env;
}
