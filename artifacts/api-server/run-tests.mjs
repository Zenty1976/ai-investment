/**
 * Test runner for api-server
 *
 * Compiles each test file with esbuild (same bundler used for production) and
 * runs them with Node's built-in test runner (`node --test`).
 *
 * Usage:  node run-tests.mjs
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

globalThis.require = createRequire(import.meta.url);

const __dir = fileURLToPath(new URL(".", import.meta.url));
const testsDir = resolve(__dir, "src/lib/__tests__");

// Collect all test files
function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

const testFiles = walk(testsDir);
if (testFiles.length === 0) {
  console.log("No test files found.");
  process.exit(0);
}

// Create temp directories: one for compiled output, one as cwd for the test process.
// The analysis-repository uses process.cwd()/data, so setting cwd to a fresh temp
// directory ensures every test run starts with an empty repository.
const outDir  = mkdtempSync(join(tmpdir(), "api-server-tests-"));
const testCwd = mkdtempSync(join(tmpdir(), "api-server-testcwd-"));

try {
  // Pre-create the data/ directory so analysis-repository doesn't fail to write
  mkdirSync(join(testCwd, "data"), { recursive: true });

  await build({
    entryPoints: testFiles,
    platform:    "node",
    bundle:      true,
    format:      "esm",
    outdir:      outDir,
    outExtension: { ".js": ".mjs" },
    logLevel:    "warning",
    sourcemap:   "inline",
    // All deps are bundled; only keep node: builtins external
    external: ["node:*"],
  });

  const outFiles = testFiles.map(f => join(outDir, basename(f).replace(/\.ts$/, ".mjs")));

  console.log(`\nRunning ${outFiles.length} test file(s)…\n`);

  const result = spawnSync(
    process.execPath,
    ["--test", ...outFiles],
    {
      stdio: "inherit",
      // Setting cwd to a fresh temp dir means the analysis-repository writes to
      // testCwd/data, completely isolated from the development repository.json
      cwd: testCwd,
      env: { ...process.env, NODE_ENV: "test" },
    }
  );

  process.exit(result.status ?? 1);
} finally {
  rmSync(outDir,  { recursive: true, force: true });
  rmSync(testCwd, { recursive: true, force: true });
}
