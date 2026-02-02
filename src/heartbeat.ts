/**
 * heartbeat.ts — Periodic task scheduling.
 *
 * Provides a simple interval-based heartbeat for periodic tasks
 * like checking for updates or running maintenance tasks.
 */

import type { HeartbeatConfig } from "./config.js";

/** Heartbeat handle for stopping. */
export type HeartbeatHandle = NodeJS.Timeout | null;

/**
 * Start a heartbeat interval.
 *
 * Calls the callback function at the configured interval.
 * Returns null if heartbeat is disabled.
 *
 * @param config - Heartbeat configuration.
 * @param callback - Function to call on each heartbeat.
 * @returns Handle for stopping the heartbeat, or null if disabled.
 */
export function startHeartbeat(
  config: HeartbeatConfig,
  callback: () => void
): HeartbeatHandle {
  if (!config.enabled) {
    return null;
  }

  const intervalMs = config.intervalSeconds * 1000;
  const handle = setInterval(callback, intervalMs);

  return handle;
}

/**
 * Stop a running heartbeat.
 *
 * @param handle - The heartbeat handle to stop.
 */
export function stopHeartbeat(handle: HeartbeatHandle): void {
  if (handle) {
    clearInterval(handle);
  }
}
