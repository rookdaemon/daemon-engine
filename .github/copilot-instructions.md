# Copilot Instructions for Daemon Engine

## Repository Overview

**Daemon Engine** is an agent-oriented runtime designed to be maintained by its own inhabitants (AI agents). It's a self-upgradeable system where agents can read, understand, modify, test, build, and deploy their own runtime without human intervention. The core philosophy: an agent must be able to understand and maintain its own platform.

**Key Design Principles:**
- Small codebase (~15 lib files, ~8 tools) that fits in a single context window
- Self-diagnosable with clear error messages
- Compatible with OpenClaw workspace format (SOUL.md, MEMORY.md, etc.)
- Fork-first ecosystem model (every agent runs its own fork)
- Standard engineering practices for reliable agent-written code

## Project Information

- **Languages:** TypeScript (strict mode, ES2022 target)
- **Module System:** ES modules (type: "module" in package.json)
- **Runtime:** Node.js v20.20.0+
- **Package Manager:** npm 10.8.2+
- **Test Framework:** Vitest 4.0.18
- **Type System:** TypeScript 5.9.3+ with strict mode
- **Code Quality:** ESLint with TypeScript rules
- **Project Size:** Minimal - approximately 23 test files covering all functionality

## Build, Test, and Lint Commands

All commands must be run from the repository root directory.

### Build
```bash
npm run build
```
- **What it does:** Compiles TypeScript to JavaScript using `tsc`
- **Output:** Compiled files in `dist/` directory
- **Preconditions:** Node modules installed (`npm install`)
- **Postconditions:** `dist/` directory contains compiled .js files
- **Duration:** ~1-5 seconds

### Test
```bash
npm test
```
- **What it does:** Runs all tests with Vitest
- **Test Coverage:** 4 test files (exec.test.ts, read.test.ts, write.test.ts, workspace.test.ts) with 23+ tests
- **Preconditions:** Code must be buildable (tests may import source files)
- **Postconditions:** All tests pass (exit code 0)
- **Duration:** ~1-2 seconds

### Type Check and Lint
```bash
npm run check
```
- **What it does:** Runs TypeScript type checking (twice with different configs) + ESLint
- **Command breakdown:** `tsc --noEmit && tsc --noEmit -p tsconfig.check.json && eslint src/ test/`
- **Preconditions:** Node modules installed
- **Postconditions:** No type errors, no lint errors (exit code 0)
- **Duration:** ~3-5 seconds

### Full Validation Workflow
Run in this order before finalizing changes:
```bash
npm run build && npm run check && npm test
```

## Repository Structure

```
daemon-engine/
├── src/                    # Source code (TypeScript)
│   ├── agent.ts            # Core LLM call loop & tool interface
│   ├── workspace.ts        # Reads personality files (SOUL.md, MEMORY.md, etc)
│   └── tools/              # Tool implementations
│       ├── read.ts         # File read/directory listing
│       ├── write.ts        # File write/create
│       └── exec.ts         # Shell command execution
├── test/                   # Tests (mirrors src/ structure)
│   ├── exec.test.ts
│   ├── read.test.ts
│   ├── write.test.ts
│   └── workspace.test.ts
├── dist/                   # Compiled JavaScript output (gitignored)
├── node_modules/           # Dependencies (gitignored)
├── package.json            # Project config and scripts
├── package-lock.json       # Dependency lock file
├── tsconfig.json           # Main TypeScript config
├── tsconfig.check.json     # Additional type checking config
├── eslint.config.js        # ESLint configuration
├── DESIGN.md               # Comprehensive design document
└── .gitignore              # Git ignore rules
```

## Key Configuration Files

- **package.json:** Project metadata, scripts, and dependencies (devDependencies only)
- **tsconfig.json:** TypeScript compiler options (strict mode, ES2022, NodeNext modules)
- **tsconfig.check.json:** Additional stricter type checking configuration
- **eslint.config.js:** Code linting rules for TypeScript
- **DESIGN.md:** Complete design philosophy and architecture documentation

## Architecture Highlights

- **Core Loop:** Message → Router → Workspace → Agent → Tools → Session → Channel
- **No Production Dependencies:** Only devDependencies (TypeScript, Vitest, ESLint, types)
- **ES Modules:** Pure ESM project, no CommonJS
- **Test-First Approach:** Tests mirror source structure in `test/` directory
- **Workspace Files:** Compatible with OpenClaw format (SOUL.md, AGENTS.md, USER.md, MEMORY.md, etc.)

## CI/CD and Workflows

**No GitHub Actions workflows are currently configured.** All validation must be done locally:

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Check types and lint: `npm run check`
4. Run tests: `npm test`

## Dependencies and Constraints

### Zero Production Dependencies
This is intentional for minimal surface area. All dependencies are devDependencies:
- TypeScript compiler and type definitions
- Vitest for testing
- ESLint for code quality

### Node.js Version
- Requires Node.js 20.20.0 or higher
- Uses ES2022 features
- Pure ES modules (no CommonJS)

### File System Conventions
- Source files use `.ts` extension
- Test files use `.test.ts` suffix
- Compiled output goes to `dist/` (automatically created during build)

## Common Issues and Workarounds

### Issue: Module Resolution Errors
- **Cause:** TypeScript strict module resolution with NodeNext
- **Solution:** Always use explicit file extensions in imports (`.js` for compiled output)
- **Example:** `import { foo } from './bar.js'` not `import { foo } from './bar'`

### Issue: ESM Import Errors
- **Cause:** Project uses pure ES modules
- **Solution:** No `require()` statements; use `import` and `export` only

### Issue: Tests Failing After Code Changes
- **Cause:** Tests are comprehensive and validate actual tool behavior
- **Solution:** Review test expectations; tests use real file system operations (not mocked)

## Making Changes

1. **Edit source files** in `src/` (TypeScript)
2. **Add/update tests** in `test/` to mirror changes
3. **Run checks** early and often:
   ```bash
   npm run build && npm run check && npm test
   ```
4. **Review DESIGN.md** for architectural decisions and constraints
5. **Keep it minimal:** Every file must earn its place

## Testing Approach

- **Framework:** Vitest with standard matchers
- **Style:** Test-first methodology
- **Coverage:** Tests validate actual behavior (file I/O, shell execution, workspace parsing)
- **No Mocks:** Tests use real implementations for validation
- **Run specific test file:** `npx vitest run test/filename.test.ts`

## Critical Notes

- **Strict TypeScript:** All code must pass strict type checking
- **Small Codebase:** Aim to keep the entire project understandable in one context window
- **Self-Maintainable:** Changes should be clear enough for an agent to understand and modify
- **Fork-Friendly:** Design decisions support independent evolution of forks
