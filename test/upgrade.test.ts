import { describe, it, expect } from "vitest";
import { upgrade } from "../src/upgrade.js";

/**
 * Mock command runner for testing.
 * Records each command that was executed and returns predefined results.
 */
type CommandRunner = (cmd: string) => Promise<{
  exitCode: number;
  output: string;
  durationMs: number;
}>;

/**
 * Helper to create a mock command runner with predefined responses.
 */
function createMockRunner(
  responses: Record<
    string,
    { exitCode: number; output: string; durationMs?: number }
  >
): CommandRunner {
  return async (cmd: string) => {
    const response = responses[cmd];
    if (!response) {
      throw new Error(`Unexpected command: ${cmd}`);
    }
    return {
      exitCode: response.exitCode,
      output: response.output,
      durationMs: response.durationMs ?? 100,
    };
  };
}

describe("upgrade", () => {
  describe("clean upgrade path", () => {
    it("completes full upgrade sequence when all steps succeed", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": {
          exitCode: 0,
          output: "abc123",
          durationMs: 50,
        },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
          durationMs: 100,
        },
        "git pull origin main": {
          exitCode: 0,
          output: "Updating abc123..def456\nFast-forward",
          durationMs: 2000,
        },
        "git diff --name-only HEAD@{1} HEAD -- package.json": {
          exitCode: 0,
          output: "package.json",
          durationMs: 50,
        },
        "npm install": {
          exitCode: 0,
          output: "added 5 packages",
          durationMs: 5000,
        },
        "npm run build": {
          exitCode: 0,
          output: "Build successful",
          durationMs: 3000,
        },
        "npm test": { exitCode: 0, output: "All tests passed", durationMs: 4000 },
      });

      // Add second set of commands for after-pull SHA/version
      let afterPullCalled = false;
      const runnerWithAfter = async (cmd: string) => {
        if (cmd === "git rev-parse HEAD" && afterPullCalled) {
          return { exitCode: 0, output: "def456", durationMs: 50 };
        }
        if (cmd === "npm list --depth=0 --json" && afterPullCalled) {
          return {
            exitCode: 0,
            output: JSON.stringify({ version: "0.1.1" }),
            durationMs: 100,
          };
        }
        if (cmd === "git pull origin main") {
          afterPullCalled = true;
        }
        return runner(cmd);
      };

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runnerWithAfter,
        restart: false,
      });

      expect(result.status).toBe("ok");
      expect(result.before.sha).toBe("abc123");
      expect(result.before.version).toBe("0.1.0");
      expect(result.after?.sha).toBe("def456");
      expect(result.after?.version).toBe("0.1.1");
      expect(result.steps).toHaveLength(5);
      expect(result.steps[0].name).toBe("check repo clean");
      expect(result.steps[1].name).toBe("git pull");
      expect(result.steps[2].name).toBe("npm install");
      expect(result.steps[3].name).toBe("build");
      expect(result.steps[4].name).toBe("test");
      expect(result.steps.every((s) => s.exitCode === 0)).toBe(true);
    });

    it("skips npm install if package.json unchanged", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
        "git pull origin main": {
          exitCode: 0,
          output: "Updating abc123..def456",
        },
        "git diff --name-only HEAD@{1} HEAD -- package.json": {
          exitCode: 0,
          output: "",
        },
        "npm run build": { exitCode: 0, output: "Build successful" },
        "npm test": { exitCode: 0, output: "All tests passed" },
      });

      let afterPullCalled = false;
      const runnerWithAfter = async (cmd: string) => {
        if (cmd === "git rev-parse HEAD" && afterPullCalled) {
          return { exitCode: 0, output: "def456", durationMs: 50 };
        }
        if (cmd === "npm list --depth=0 --json" && afterPullCalled) {
          return {
            exitCode: 0,
            output: JSON.stringify({ version: "0.1.0" }),
            durationMs: 100,
          };
        }
        if (cmd === "git pull origin main") {
          afterPullCalled = true;
        }
        return runner(cmd);
      };

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runnerWithAfter,
        restart: false,
      });

      expect(result.status).toBe("ok");
      const stepNames = result.steps.map((s) => s.name);
      expect(stepNames).not.toContain("npm install");
      expect(stepNames).toContain("build");
      expect(stepNames).toContain("test");
    });
  });

  describe("skip conditions", () => {
    it("skips upgrade if repo has uncommitted changes", async () => {
      const runner = createMockRunner({
        "git status --porcelain": {
          exitCode: 0,
          output: "M src/upgrade.ts\n",
        },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
      });

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runner,
        restart: false,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toContain("uncommitted changes");
      expect(result.before.sha).toBe("abc123");
      expect(result.after).toBeUndefined();
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].name).toBe("check repo clean");
    });

    it("skips upgrade if already up to date", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
        "git pull origin main": {
          exitCode: 0,
          output: "Already up to date.",
        },
      });

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runner,
        restart: false,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toContain("Already up to date");
      expect(result.before.sha).toBe("abc123");
      expect(result.after).toBeUndefined();
      expect(result.steps).toHaveLength(2);
    });
  });

  describe("error handling", () => {
    it("fails upgrade if git pull fails", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
        "git pull origin main": {
          exitCode: 1,
          output: "fatal: unable to access repository",
        },
      });

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runner,
        restart: false,
      });

      expect(result.status).toBe("error");
      expect(result.reason).toContain("git pull failed");
      expect(result.steps).toHaveLength(2);
      expect(result.steps[1].exitCode).toBe(1);
    });

    it("reverts and rebuilds if build fails after pull", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
        "git pull origin main": { exitCode: 0, output: "Updated files" },
        "git diff --name-only HEAD@{1} HEAD -- package.json": {
          exitCode: 0,
          output: "",
        },
        "npm run build": { exitCode: 1, output: "Build error: syntax error" },
        "git reset --hard HEAD~1": { exitCode: 0, output: "HEAD is now at abc123" },
      });

      let buildAttempts = 0;
      const runnerWithRetry = async (cmd: string) => {
        if (cmd === "npm run build") {
          buildAttempts++;
          if (buildAttempts === 1) {
            return { exitCode: 1, output: "Build error: syntax error", durationMs: 100 };
          } else {
            return { exitCode: 0, output: "Build successful", durationMs: 100 };
          }
        }
        return runner(cmd);
      };

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runnerWithRetry,
        restart: false,
      });

      expect(result.status).toBe("error");
      expect(result.reason).toContain("Build failed");
      expect(result.steps.some((s) => s.name === "rollback")).toBe(true);
      expect(result.steps.some((s) => s.name === "rebuild after rollback")).toBe(
        true
      );
      expect(buildAttempts).toBe(2);
    });

    it("reverts and rebuilds if tests fail after pull", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
        "git pull origin main": { exitCode: 0, output: "Updated files" },
        "git diff --name-only HEAD@{1} HEAD -- package.json": {
          exitCode: 0,
          output: "",
        },
        "npm run build": { exitCode: 0, output: "Build successful" },
        "npm test": { exitCode: 1, output: "Test failed: assertion error" },
        "git reset --hard HEAD~1": { exitCode: 0, output: "HEAD is now at abc123" },
      });

      let testAttempts = 0;
      const runnerWithRetry = async (cmd: string) => {
        if (cmd === "npm test") {
          testAttempts++;
          if (testAttempts === 1) {
            return {
              exitCode: 1,
              output: "Test failed: assertion error",
              durationMs: 100,
            };
          }
        }
        return runner(cmd);
      };

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runnerWithRetry,
        restart: false,
      });

      expect(result.status).toBe("error");
      expect(result.reason).toContain("Tests failed");
      expect(result.steps.some((s) => s.name === "rollback")).toBe(true);
      expect(result.steps.some((s) => s.name === "rebuild after rollback")).toBe(
        true
      );
    });
  });

  describe("step logging", () => {
    it("captures command output (last 2000 chars)", async () => {
      const longOutput = "x".repeat(3000);
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
        "git pull origin main": { exitCode: 0, output: longOutput },
        "git diff --name-only HEAD@{1} HEAD -- package.json": {
          exitCode: 0,
          output: "",
        },
        "npm run build": { exitCode: 0, output: "Build successful" },
        "npm test": { exitCode: 0, output: "Tests passed" },
      });

      let afterPullCalled = false;
      const runnerWithAfter = async (cmd: string) => {
        if (cmd === "git rev-parse HEAD" && afterPullCalled) {
          return { exitCode: 0, output: "def456", durationMs: 50 };
        }
        if (cmd === "npm list --depth=0 --json" && afterPullCalled) {
          return {
            exitCode: 0,
            output: JSON.stringify({ version: "0.1.0" }),
            durationMs: 100,
          };
        }
        if (cmd === "git pull origin main") {
          afterPullCalled = true;
        }
        return runner(cmd);
      };

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runnerWithAfter,
        restart: false,
      });

      const pullStep = result.steps.find((s) => s.name === "git pull");
      expect(pullStep).toBeDefined();
      if (pullStep && pullStep.output) {
        expect(pullStep.output.length).toBeLessThanOrEqual(2000);
        expect(pullStep.output).toBe("x".repeat(2000));
      }
    });

    it("records duration for each step", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "", durationMs: 50 },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123", durationMs: 30 },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
          durationMs: 100,
        },
        "git pull origin main": {
          exitCode: 0,
          output: "Updated",
          durationMs: 2000,
        },
        "git diff --name-only HEAD@{1} HEAD -- package.json": {
          exitCode: 0,
          output: "",
          durationMs: 40,
        },
        "npm run build": {
          exitCode: 0,
          output: "Built",
          durationMs: 3000,
        },
        "npm test": { exitCode: 0, output: "Passed", durationMs: 4000 },
      });

      let afterPullCalled = false;
      const runnerWithAfter = async (cmd: string) => {
        if (cmd === "git rev-parse HEAD" && afterPullCalled) {
          return { exitCode: 0, output: "def456", durationMs: 30 };
        }
        if (cmd === "npm list --depth=0 --json" && afterPullCalled) {
          return {
            exitCode: 0,
            output: JSON.stringify({ version: "0.1.0" }),
            durationMs: 100,
          };
        }
        if (cmd === "git pull origin main") {
          afterPullCalled = true;
        }
        return runner(cmd);
      };

      const result = await upgrade({
        repoDir: "/test/repo",
        runCommand: runnerWithAfter,
        restart: false,
      });

      expect(result.steps.every((s) => s.durationMs > 0)).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("default options", () => {
    it("uses process.cwd() as default repoDir", async () => {
      const runner = createMockRunner({
        "git status --porcelain": { exitCode: 0, output: "" },
        "git rev-parse HEAD": { exitCode: 0, output: "abc123" },
        "npm list --depth=0 --json": {
          exitCode: 0,
          output: JSON.stringify({ version: "0.1.0" }),
        },
        "git pull origin main": { exitCode: 0, output: "Already up to date." },
      });

      const result = await upgrade({ runCommand: runner, restart: false });

      expect(result.status).toBe("skipped");
    });
  });
});
