// Runs merge-on-green.mjs as merge-on-green.yml does, as a process, against a fake GitHub API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SHA = "a".repeat(40);
const REPO = "revala-app/example";

const pull = (over = {}) => ({
  number: 7,
  title: "fix(api): keep the price",
  state: "open",
  draft: false,
  labels: [{ name: "automerge" }],
  base: { ref: "main" },
  head: { sha: SHA, ref: "fix(api)/price", repo: { full_name: REPO } },
  ...over,
});

/** A fake API answering the reads from `state`, recording every request; `merge` is the merge's answer. */
async function serve(state) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = req.url.replace(/[?&]per_page=100&page=\d+/, "").replace(/\?$/, "");
      requests.push({ method: req.method, path, auth: req.headers.authorization, body: body && JSON.parse(body) });
      const send = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (req.method === "GET" && path === `/repos/${REPO}`) return send(200, { default_branch: "main" });
      if (req.method === "GET" && path === `/repos/${REPO}/commits/${SHA}/pulls`) return send(200, state.pulls);
      if (req.method === "GET" && path === `/repos/${REPO}/pulls/7`) return send(200, state.pulls[0]);
      if (req.method === "GET" && path === `/repos/${REPO}/actions/runs?head_sha=${SHA}`) {
        return send(200, { workflow_runs: state.runs });
      }
      if (req.method === "GET" && path === `/repos/${REPO}/commits/${SHA}/check-runs`) {
        return send(200, { check_runs: state.checks });
      }
      if (req.method === "PUT" && path === `/repos/${REPO}/pulls/7/merge`) return send(...(state.merge ?? [200, { sha: "m".repeat(40) }]));
      if (req.method === "DELETE") return send(204, null);
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

function run(url, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, "merge-on-green.mjs")], {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: url,
        REPO,
        SHA,
        SELF: "Merge on green",
        REQUIRED: JSON.stringify(["Check"]),
        READ_TOKEN: "read",
        MERGE_TOKEN: "write",
        ...extra,
      },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const green = {
  runs: [{ id: 1, name: "CI", workflow_id: 1, head_sha: SHA, status: "completed", conclusion: "success" }],
  checks: [{ id: 1, name: "Check", status: "completed", conclusion: "success" }],
};

test("squash-merges a green labelled pull request with the merge token, at its head, and deletes its branch", async () => {
  const api = await serve({ pulls: [pull()], ...green });
  const { code, out } = await run(api.url);
  api.close();
  assert.equal(code, 0, out);
  const merge = api.requests.find((r) => r.method === "PUT");
  assert.deepEqual(merge.body, { merge_method: "squash", sha: SHA, commit_title: "fix(api): keep the price (#7)" });
  assert.equal(merge.auth, "Bearer write");
  assert.ok(api.requests.filter((r) => r.method === "GET").every((r) => r.auth === "Bearer read"));
  assert.ok(api.requests.some((r) => r.method === "DELETE" && r.path === `/repos/${REPO}/git/refs/heads/fix(api)/price`));
});

test("reads the one pull request a label event names", async () => {
  const api = await serve({ pulls: [pull()], ...green });
  const { code } = await run(api.url, { PR: "7" });
  api.close();
  assert.equal(code, 0);
  assert.ok(api.requests.some((r) => r.path === `/repos/${REPO}/pulls/7`));
  assert.ok(api.requests.some((r) => r.method === "PUT"));
});

test("writes nothing while a check runs or after one failed", async () => {
  for (const conclusion of [null, "failure"]) {
    const checks = [...green.checks, { id: 2, name: "Test", status: conclusion ? "completed" : "in_progress", conclusion }];
    const api = await serve({ pulls: [pull()], runs: green.runs, checks });
    const { code, out } = await run(api.url);
    api.close();
    assert.equal(code, 0, out);
    assert.ok(api.requests.every((r) => r.method === "GET"), out);
  }
});

test("leaves a fork's branch alone after merging its pull request", async () => {
  const api = await serve({ pulls: [pull({ head: { sha: SHA, ref: "x", repo: { full_name: "someone/fork" } } })], ...green });
  await run(api.url);
  api.close();
  assert.ok(!api.requests.some((r) => r.method === "DELETE"));
});

test("fails the run when GitHub refuses the merge", async () => {
  const api = await serve({ pulls: [pull()], ...green, merge: [405, { message: "Pull Request is not mergeable" }] });
  const { code, out } = await run(api.url);
  api.close();
  assert.equal(code, 1);
  assert.match(out, /not mergeable/);
  assert.ok(!api.requests.some((r) => r.method === "DELETE"));
});

test("refuses input that is not a full SHA or a list of names", async () => {
  assert.equal((await run("http://127.0.0.1:9", { SHA: "abc" })).code, 1);
  assert.equal((await run("http://127.0.0.1:9", { REQUIRED: '"Check"' })).code, 1);
});
