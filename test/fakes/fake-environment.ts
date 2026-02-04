import type { Environment } from "../../src/env/environment.js";
import { createNodeEnvironment } from "../../src/env/environment.js";

export function createFakeEnvironment(overrides?: Partial<Environment>): Environment {
  const nodeEnv = createNodeEnvironment();
  return {
    ...nodeEnv,
    ...overrides,
    fs: { ...nodeEnv.fs, ...(overrides?.fs ?? {}) },
    clock: { ...nodeEnv.clock, ...(overrides?.clock ?? {}) },
    process: { ...nodeEnv.process, ...(overrides?.process ?? {}) },
    os: { ...nodeEnv.os, ...(overrides?.os ?? {}) },
    path: { ...nodeEnv.path, ...(overrides?.path ?? {}) },
    subprocess: { ...nodeEnv.subprocess, ...(overrides?.subprocess ?? {}) },
    shell: overrides?.shell ?? nodeEnv.shell,
    http: { ...nodeEnv.http, ...(overrides?.http ?? {}) },
  };
}

