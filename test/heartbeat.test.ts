import { describe, it, expect, vi, beforeEach } from "vitest";
import { startHeartbeat, stopHeartbeat } from "../src/heartbeat.js";
import type { HeartbeatConfig } from "../src/config.js";

describe("heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("starts and stops heartbeat", () => {
    const config: HeartbeatConfig = {
      enabled: true,
      intervalSeconds: 1,
    };

    const callback = vi.fn();
    const handle = startHeartbeat(config, callback);

    expect(handle).toBeDefined();

    // Fast-forward time
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);

    stopHeartbeat(handle);
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2); // Should not increase

    vi.useRealTimers();
  });

  it("does not start if disabled", () => {
    const config: HeartbeatConfig = {
      enabled: false,
      intervalSeconds: 1,
    };

    const callback = vi.fn();
    const handle = startHeartbeat(config, callback);

    expect(handle).toBeNull();

    vi.advanceTimersByTime(10000);
    expect(callback).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
