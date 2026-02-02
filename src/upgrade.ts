/**
 * upgrade.ts — Self-upgrade module for daemon-engine.
 *
 * Implements the self-upgrade protocol: pull updates, test them, deploy atomically,
 * and roll back on failure. No human intervention needed for routine updates.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** A single step in the upgrade sequence. */
export interface UpgradeStep {
  name: string;
  command: string;
  durationMs: number;
  exitCode: number | null;
  output?: string; // last 2000 chars of stdout+stderr
}

/** The result of an upgrade attempt. */
export interface UpgradeResult {
  status: "ok" | "error" | "skipped";
  reason?: string; // why it failed or was skipped
  before: { sha: string; version: string };
  after?: { sha: string; version: string };
  steps: UpgradeStep[];
  durationMs: number;
}

/**
 * Command runner function type.
 * Takes a command string and returns exit code, output, and duration.
 */
export type CommandRunner = (cmd: string) => Promise<{
  exitCode: number;
  output: string;
  durationMs: number;
}>;

/**
 * Create default command runner that executes commands in a specific directory.
 */
function createDefaultCommandRunner(cwd: string): CommandRunner {
  return async (cmd: string) => {
    const startTime = Date.now();
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });
      const durationMs = Date.now() - startTime;
      return {
        exitCode: 0,
        output: stdout + stderr,
        durationMs,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const execError = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: execError.code ?? 1,
        output: (execError.stdout ?? "") + (execError.stderr ?? ""),
        durationMs,
      };
    }
  };
}

/**
 * Truncate output to last N characters.
 */
function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }
  return output.slice(-maxChars);
}

/**
 * Run a command and record it as an upgrade step.
 */
async function runStep(
  name: string,
  command: string,
  runner: CommandRunner
): Promise<UpgradeStep> {
  const result = await runner(command);
  return {
    name,
    command,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    output: truncateOutput(result.output, 2000),
  };
}

/**
 * Get current git SHA.
 */
async function getCurrentSha(runner: CommandRunner): Promise<string> {
  const result = await runner("git rev-parse HEAD");
  return result.output.trim();
}

/**
 * Get current package version.
 */
async function getCurrentVersion(runner: CommandRunner): Promise<string> {
  const result = await runner("npm list --depth=0 --json");
  try {
    const data = JSON.parse(result.output);
    return data.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Main upgrade function.
 *
 * Runs the full upgrade sequence:
 * 1. Check repo is clean
 * 2. git pull origin main
 * 3. npm install (if package.json changed)
 * 4. npm run build
 * 5. npm test
 * 6. If tests fail → rollback, rebuild, log error
 * 7. If tests pass → restart process (if restart option is true)
 *
 * @param options - Configuration options
 * @param options.repoDir - Repository directory (default: process.cwd())
 * @param options.runCommand - Command runner for testing (default: uses child_process)
 * @param options.restart - Whether to restart on success (default: true)
 * @returns Upgrade result with status and step logs
 */
export async function upgrade(options?: {
  repoDir?: string;
  runCommand?: CommandRunner;
  restart?: boolean;
}): Promise<UpgradeResult> {
  const repoDir = options?.repoDir ?? process.cwd();
  const runner = options?.runCommand ?? createDefaultCommandRunner(repoDir);
  const restart = options?.restart ?? true;

  const steps: UpgradeStep[] = [];
  const startTime = Date.now();

  // Capture before state
  const beforeSha = await getCurrentSha(runner);
  const beforeVersion = await getCurrentVersion(runner);

  // Step 1: Check repo is clean
  const cleanCheck = await runStep(
    "check repo clean",
    "git status --porcelain",
    runner
  );
  steps.push(cleanCheck);

  if (cleanCheck.output && cleanCheck.output.trim() !== "") {
    return {
      status: "skipped",
      reason: "Repository has uncommitted changes",
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 2: git pull
  const pullStep = await runStep("git pull", "git pull origin main", runner);
  steps.push(pullStep);

  if (pullStep.exitCode !== 0) {
    return {
      status: "error",
      reason: "git pull failed",
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  // Check if already up to date
  if (pullStep.output?.includes("Already up to date")) {
    return {
      status: "skipped",
      reason: "Already up to date",
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 3: Check if package.json changed, run npm install if so
  const packageJsonCheck = await runStep(
    "check package.json",
    "git diff --name-only HEAD@{1} HEAD -- package.json",
    runner
  );

  if (packageJsonCheck.output && packageJsonCheck.output.trim() !== "") {
    const installStep = await runStep("npm install", "npm install", runner);
    steps.push(installStep);

    if (installStep.exitCode !== 0) {
      // Rollback
      const rollbackStep = await runStep(
        "rollback",
        "git reset --hard HEAD~1",
        runner
      );
      steps.push(rollbackStep);

      return {
        status: "error",
        reason: "npm install failed",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Step 4: Build
  const buildStep = await runStep("build", "npm run build", runner);
  steps.push(buildStep);

  if (buildStep.exitCode !== 0) {
    // Rollback
    const rollbackStep = await runStep(
      "rollback",
      "git reset --hard HEAD~1",
      runner
    );
    steps.push(rollbackStep);

    // Rebuild old version
    const rebuildStep = await runStep(
      "rebuild after rollback",
      "npm run build",
      runner
    );
    steps.push(rebuildStep);

    return {
      status: "error",
      reason: "Build failed after pull, reverted to previous version",
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 5: Test
  const testStep = await runStep("test", "npm test", runner);
  steps.push(testStep);

  if (testStep.exitCode !== 0) {
    // Rollback
    const rollbackStep = await runStep(
      "rollback",
      "git reset --hard HEAD~1",
      runner
    );
    steps.push(rollbackStep);

    // Rebuild old version
    const rebuildStep = await runStep(
      "rebuild after rollback",
      "npm run build",
      runner
    );
    steps.push(rebuildStep);

    return {
      status: "error",
      reason: "Tests failed after pull, reverted to previous version",
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startTime,
    };
  }

  // Capture after state
  const captureAfterStep = await runStep(
    "capture after state",
    "echo 'Capturing after state'",
    runner
  );
  steps.push(captureAfterStep);

  const afterSha = await getCurrentSha(runner);
  const afterVersion = await getCurrentVersion(runner);

  // Success!
  const result: UpgradeResult = {
    status: "ok",
    before: { sha: beforeSha, version: beforeVersion },
    after: { sha: afterSha, version: afterVersion },
    steps,
    durationMs: Date.now() - startTime,
  };

  // Step 6: Restart if requested
  if (restart) {
    process.exit(0);
  }

  return result;
}
