// Runs find-node-version.sh as the setup action does: under bash, with GITHUB_WORKSPACE,
// WORKING_DIRECTORY and GITHUB_OUTPUT set, on a temporary repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "find-node-version.sh");

/**
 * Runs the script in a temporary workspace holding `files` (path → content), from `workingDirectory`.
 * `relativeWorkspace` passes GITHUB_WORKSPACE as `repo`, run from the temporary root; `env(root)` adds variables.
 */
function run(t, files, workingDirectory, { env = () => ({}), relativeWorkspace = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "find-node-version-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "repo");
  mkdirSync(workspace);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const output = join(root, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      ...env(root),
      GITHUB_WORKSPACE: relativeWorkspace ? "repo" : workspace,
      WORKING_DIRECTORY: workingDirectory,
      GITHUB_OUTPUT: output,
    },
  });
  return { ...result, output: readFileSync(output, "utf8") };
}

test("names the root .node-version for the default working directory", (t) => {
  const result = run(t, { "repo/.node-version": "26\n" }, ".");
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output, "node-version-file=.node-version\n");
});

test("treats an empty working directory as the root", (t) => {
  const result = run(t, { "repo/.node-version": "26\n" }, "");
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output, "node-version-file=.node-version\n");
});

test("ignores a CDPATH that would make cd print the directory it resolves", (t) => {
  // With CDPATH naming the temporary root, a `cd repo` found through it prints the directory, which a
  // `$(cd … && pwd -P)` would capture alongside pwd's own line.
  const result = run(t, { "repo/.node-version": "26\n", "repo/workers/backup/.node-version": "24\n" }, "workers/backup", {
    env: (root) => ({ CDPATH: root }),
    relativeWorkspace: true,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output, "node-version-file=workers/backup/.node-version\n");
});

test("prefers a .node-version in the working directory", (t) => {
  const result = run(t, { "repo/.node-version": "26\n", "repo/workers/backup/.node-version": "24\n" }, "workers/backup");
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output, "node-version-file=workers/backup/.node-version\n");
});

test("falls back to the nearest .node-version above the working directory", (t) => {
  const result = run(t, { "repo/.node-version": "26\n", "repo/workers/backup/package.json": "{}" }, "workers/backup");
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output, "node-version-file=.node-version\n");
});

test("never looks above the workspace", (t) => {
  const result = run(t, { ".node-version": "26\n", "repo/workers/backup/package.json": "{}" }, "workers/backup");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::no \.node-version in workers\/backup/);
  assert.equal(result.output, "");
});

test("fails for a working directory outside the workspace or missing", (t) => {
  const outside = run(t, { ".node-version": "26\n", "repo/.node-version": "26\n" }, "..");
  assert.equal(outside.status, 1);
  assert.match(outside.stdout, /outside the repository/);
  const missing = run(t, { "repo/.node-version": "26\n" }, "workers/none");
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /does not exist/);
});
