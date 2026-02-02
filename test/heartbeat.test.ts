import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startHeartbeat } from "../src/heartbeat.js";

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fires callback at the specified interval", async () => {
    const onBeat = vi.fn().mockResolvedValue(undefined);
    const { stop } = startHeartbeat({
      intervalMs: 1000,
      prompt: "TEST",
      onBeat,
    });

    // Initially, callback should not have been called
    expect(onBeat).not.toHaveBeenCalled();

    // Advance time by 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(1);
    expect(onBeat).toHaveBeenCalledWith("TEST");

    // Advance another 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(2);

    // Advance another 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(3);

    stop();
  });

  it("uses default interval of 120000ms (2 minutes)", async () => {
    const onBeat = vi.fn().mockResolvedValue(undefined);
    const { stop } = startHeartbeat({
      intervalMs: 120000,
      prompt: "HEARTBEAT",
      onBeat,
    });

    expect(onBeat).not.toHaveBeenCalled();

    // Advance time by 119999ms (just before interval)
    await vi.advanceTimersByTimeAsync(119999);
    expect(onBeat).not.toHaveBeenCalled();

    // Advance by 1ms more to trigger
    await vi.advanceTimersByTimeAsync(1);
    expect(onBeat).toHaveBeenCalledTimes(1);

    stop();
  });

  it("uses default prompt 'HEARTBEAT'", async () => {
    const onBeat = vi.fn().mockResolvedValue(undefined);
    const { stop } = startHeartbeat({
      intervalMs: 1000,
      prompt: "HEARTBEAT",
      onBeat,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledWith("HEARTBEAT");

    stop();
  });

  it("skips beat if previous one is still running", async () => {
    let resolveCallback: (() => void) | undefined;
    const onBeat = vi.fn().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        resolveCallback = resolve;
      });
    });

    const { stop } = startHeartbeat({
      intervalMs: 1000,
      prompt: "TEST",
      onBeat,
    });

    // First beat starts
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(1);

    // Second interval triggers while first is still running
    await vi.advanceTimersByTimeAsync(1000);
    // Should still be 1 call, not 2 (overlap prevented)
    expect(onBeat).toHaveBeenCalledTimes(1);

    // Resolve the first callback
    if (resolveCallback) {
      resolveCallback();
    }
    // Wait for the promise to resolve
    await Promise.resolve();

    // Third interval triggers, now that first is complete
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stop() cancels the interval timer", async () => {
    const onBeat = vi.fn().mockResolvedValue(undefined);
    const { stop } = startHeartbeat({
      intervalMs: 1000,
      prompt: "TEST",
      onBeat,
    });

    // First beat
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(1);

    // Stop the heartbeat
    stop();

    // Advance time - should not trigger more beats
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10000);
    expect(onBeat).toHaveBeenCalledTimes(1);
  });

  it("passes the provided prompt to the callback", async () => {
    const onBeat = vi.fn().mockResolvedValue(undefined);
    const customPrompt = "Custom heartbeat prompt";

    const { stop } = startHeartbeat({
      intervalMs: 500,
      prompt: customPrompt,
      onBeat,
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(onBeat).toHaveBeenCalledWith(customPrompt);

    await vi.advanceTimersByTimeAsync(500);
    expect(onBeat).toHaveBeenCalledWith(customPrompt);

    stop();
  });

  it("handles callback errors gracefully and continues running", async () => {
    const onBeat = vi
      .fn()
      .mockRejectedValueOnce(new Error("First beat failed"))
      .mockResolvedValue(undefined);

    const { stop } = startHeartbeat({
      intervalMs: 1000,
      prompt: "TEST",
      onBeat,
    });

    // First beat (will fail)
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(1);

    // Second beat (should still run despite previous failure)
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBeat).toHaveBeenCalledTimes(2);

    stop();
  });
});
