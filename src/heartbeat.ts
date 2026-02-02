/**
 * heartbeat.ts — Periodic heartbeat loop for daemon maintenance tasks.
 *
 * Provides a simple interval-based heartbeat that fires a callback at
 * regular intervals. Prevents overlapping beats if the callback takes
 * longer than the interval to complete.
 */

/**
 * Configuration options for the heartbeat.
 */
export interface HeartbeatOptions {
  /** Interval between heartbeats in milliseconds. Default: 120000 (2 minutes). */
  intervalMs: number;

  /** The prompt to pass to the callback. Default: 'HEARTBEAT'. */
  prompt: string;

  /** Callback function invoked on each heartbeat. */
  onBeat: (prompt: string) => Promise<void>;
}

/**
 * Start a heartbeat loop.
 *
 * Fires the `onBeat` callback at the specified interval. If a previous
 * callback is still running when the next interval fires, that beat is
 * skipped to prevent overlap.
 *
 * @param options - Heartbeat configuration.
 * @returns An object with a `stop()` function to cancel the heartbeat.
 */
export function startHeartbeat(options: HeartbeatOptions): { stop: () => void } {
  const { intervalMs, prompt, onBeat } = options;
  let isRunning = false;

  const intervalId = setInterval(async () => {
    // Skip this beat if the previous one is still running
    if (isRunning) {
      return;
    }

    isRunning = true;
    try {
      await onBeat(prompt);
    } catch {
      // Errors are silently caught to prevent the heartbeat from stopping
    } finally {
      isRunning = false;
    }
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(intervalId);
    },
  };
}
