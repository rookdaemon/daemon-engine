import { describe, it, expect, beforeEach } from "vitest";
import { ObservabilityCollector } from "../src/observability.js";

describe("ObservabilityCollector", () => {
  let collector: ObservabilityCollector;

  beforeEach(() => {
    collector = new ObservabilityCollector(100); // Small max for testing
  });

  describe("log collection", () => {
    it("collects info logs", () => {
      collector.info("test", "test message");
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("info");
      expect(logs[0].category).toBe("test");
      expect(logs[0].message).toBe("test message");
      expect(logs[0].timestamp).toBeDefined();
    });

    it("collects error logs", () => {
      collector.error("test", "error message");
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("error");
      expect(logs[0].category).toBe("test");
      expect(logs[0].message).toBe("error message");
    });

    it("collects warning logs", () => {
      collector.warning("test", "warning message");
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("warning");
      expect(logs[0].category).toBe("test");
      expect(logs[0].message).toBe("warning message");
    });

    it("includes structured data", () => {
      collector.info("test", "test message", { key: "value", count: 42 });
      
      const logs = collector.getLogs(10);
      expect(logs[0].data).toEqual({ key: "value", count: 42 });
    });
  });

  describe("circular buffer", () => {
    it("maintains max log limit", () => {
      const smallCollector = new ObservabilityCollector(5);
      
      for (let i = 0; i < 10; i++) {
        smallCollector.info("test", `message ${i}`);
      }
      
      const logs = smallCollector.getAllLogs();
      expect(logs).toHaveLength(5);
      // Should have the last 5 messages
      expect(logs[0].message).toBe("message 5");
      expect(logs[4].message).toBe("message 9");
    });
  });

  describe("workspace file load logging", () => {
    it("logs successful workspace file loads", () => {
      collector.logWorkspaceLoad({
        file: "SOUL.md",
        bytes: 1024,
        success: true,
      });
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("info");
      expect(logs[0].category).toBe("workspace");
      expect(logs[0].message).toContain("SOUL.md");
      expect(logs[0].message).toContain("1024 bytes");
      expect(logs[0].data?.success).toBe(true);
    });

    it("logs failed workspace file loads", () => {
      collector.logWorkspaceLoad({
        file: "MISSING.md",
        bytes: 0,
        success: false,
        error: "File not found",
      });
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("info");
      expect(logs[0].data?.success).toBe(false);
      expect(logs[0].data?.error).toBe("File not found");
    });
  });

  describe("tool invocation logging", () => {
    it("logs successful tool invocations", () => {
      collector.logToolInvocation({
        name: "read",
        success: true,
        durationMs: 123,
      });
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("info");
      expect(logs[0].category).toBe("tool");
      expect(logs[0].message).toContain("read");
      expect(logs[0].message).toContain("successfully");
      expect(logs[0].data?.durationMs).toBe(123);
    });

    it("logs failed tool invocations", () => {
      collector.logToolInvocation({
        name: "write",
        success: false,
        durationMs: 50,
        error: "Permission denied",
      });
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("error");
      expect(logs[0].category).toBe("tool");
      expect(logs[0].message).toContain("write");
      expect(logs[0].message).toContain("failed");
      expect(logs[0].data?.error).toBe("Permission denied");
    });
  });

  describe("model API call logging", () => {
    it("logs model API calls", () => {
      collector.logModelApiCall({
        model: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        costUsd: 0.001,
        durationMs: 1500,
        sessionId: "test-session",
      });
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("info");
      expect(logs[0].category).toBe("model");
      expect(logs[0].message).toContain("claude-sonnet-4");
      expect(logs[0].message).toContain("1500ms");
      expect(logs[0].message).toContain("$0.0010");
      expect(logs[0].data?.inputTokens).toBe(100);
      expect(logs[0].data?.outputTokens).toBe(50);
      expect(logs[0].data?.sessionId).toBe("test-session");
    });
  });

  describe("getLogs", () => {
    it("returns last N logs", () => {
      for (let i = 0; i < 10; i++) {
        collector.info("test", `message ${i}`);
      }
      
      const logs = collector.getLogs(5);
      expect(logs).toHaveLength(5);
      expect(logs[0].message).toBe("message 5");
      expect(logs[4].message).toBe("message 9");
    });

    it("returns all logs if limit exceeds count", () => {
      for (let i = 0; i < 3; i++) {
        collector.info("test", `message ${i}`);
      }
      
      const logs = collector.getLogs(10);
      expect(logs).toHaveLength(3);
    });
  });

  describe("clearLogs", () => {
    it("clears all logs", () => {
      collector.info("test", "message 1");
      collector.info("test", "message 2");
      
      expect(collector.getAllLogs()).toHaveLength(2);
      
      collector.clearLogs();
      
      expect(collector.getAllLogs()).toHaveLength(0);
    });
  });
});
