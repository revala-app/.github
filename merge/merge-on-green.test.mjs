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
const BASE = "b".repeat(40);
const labeled = (login, type = "User", id = 1) => ({ id, event: "labeled", label: { name: "automerge" }, actor: { login, type } });

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
      const failing = Object.entries(state.fail ?? {}).find(([part]) => path.includes(part));
      if (failing) return send(failing[1], { message: "refused by the fake" });
      if (req.method === "GET" && path === `/repos/${REPO}`) return send(200, { default_branch: "main" });
      const events = req.url.match(new RegExp(`^/repos/${REPO}/issues/\\d+/events\\?per_page=100&page=(\\d+)$`));
      if (req.method === "GET" && events) {
        const from = (Number(events[1]) - 1) * 100;
        return send(200, (state.events ?? [labeled("owner")]).slice(from, from + 100));
      }
      const permission = path.match(new RegExp(`^/repos/${REPO}/collaborators/(.+)/permission$`));
      if (req.method === "GET" && permission) {
        const level = (state.permissions ?? { owner: "admin" })[permission[1]];
        return level ? send(200, { permission: level }) : send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && path === `/repos/${REPO}/git/ref/heads/main`) return send(200, { object: { sha: BASE } });
      if (req.method === "GET" && new RegExp(`^/repos/${REPO}/compare/${BASE}\\.\\.\\.[0-9a-f]{40}\\?per_page=1$`).test(path)) {
        return send(200, state.comparison ?? { behind_by: state.behindBy ?? 0 });
      }
      if (req.method === "GET" && path === `/repos/${REPO}/pulls?state=open`) {
        return send(200, state.pulls.filter((pr) => pr.state === "open"));
      }
      const one = path.match(new RegExp(`^/repos/${REPO}/pulls/(\\d+)$`));
      if (req.method === "GET" && one) {
        const found = (state.after ?? state.pulls).find((pr) => pr.number === Number(one[1]));
        return found ? send(200, found) : send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && path === `/repos/${REPO}/actions/runs?event=pull_request&per_page=100`) {
        return send(200, { workflow_runs: state.recent ?? [] });
      }
      // What ran on a head: `heads[sha]`, or for SHA the state's own runs and checks.
      const ran = (sha) => state.heads?.[sha] ?? (sha === SHA ? state : { runs: [], checks: [] });
      const runs = path.match(new RegExp(`^/repos/${REPO}/actions/runs\\?head_sha=([0-9a-f]{40})$`));
      if (req.method === "GET" && runs) return send(200, { workflow_runs: ran(runs[1]).runs });
      const checks = path.match(new RegExp(`^/repos/${REPO}/commits/([0-9a-f]{40})/check-runs$`));
      if (req.method === "GET" && checks) return send(200, { check_runs: ran(checks[1]).checks });
      if (req.method === "PUT" && /\/pulls\/\d+\/merge$/.test(path)) return send(...(state.merge ?? [200, { sha: "m".repeat(40) }]));
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

/** Runs the script against `state` over the green defaults; says whether it merged. */
async function attempt(state, env) {
  const api = await serve({ pulls: [pull()], ...green, ...state });
  const { code, out } = await run(api.url, env);
  api.close();
  return { code, out, requests: api.requests, merged: api.requests.some((r) => r.method === "PUT") };
}

test("judges whoever added the label last, from the pull request's events", async () => {
  const events = [labeled("owner", "User", 1), labeled("guest", "User", 2)];
  const refused = await attempt({ events, permissions: { owner: "admin", guest: "read" } });
  assert.equal(refused.code, 0, refused.out);
  assert.equal(refused.merged, false);
  assert.match(refused.out, /::warning::#7 is not merged: automerge was added by guest/);
  assert.equal((await attempt({ events: [labeled("stranger")] })).merged, false);
  assert.equal((await attempt({ events: [] })).merged, false);
});

test("merges a listed bot's label and no other bot's, without asking its permission", async () => {
  const events = [labeled("helper[bot]", "Bot")];
  assert.equal((await attempt({ events })).merged, false);
  const listed = await attempt({ events }, { ALLOWED_BOTS: '["helper[bot]"]' });
  assert.equal(listed.merged, true, listed.out);
  assert.ok(!listed.requests.some((r) => r.path.includes("/collaborators/")));
});

test("reads the base only when REQUIRE_UP_TO_DATE, and then merges no head that is behind it", async () => {
  const off = await attempt({ behindBy: 3 });
  assert.equal(off.merged, true, off.out);
  assert.ok(!off.requests.some((r) => r.path.includes("/compare/")));
  const behind = await attempt({ behindBy: 3 }, { REQUIRE_UP_TO_DATE: "true" });
  assert.equal(behind.code, 0, behind.out);
  assert.equal(behind.merged, false);
  assert.match(behind.out, /does not contain main at bbbbbbb/);
  assert.ok(behind.requests.every((r) => r.method === "GET"), "the branch is not updated");
  assert.equal((await attempt({}, { REQUIRE_UP_TO_DATE: "true" })).merged, true);
});

test("reads no legacy commit status: check runs and workflow runs are the gate", async () => {
  const { requests, merged } = await attempt({});
  assert.equal(merged, true);
  assert.ok(!requests.some((r) => /\/status(es)?(\/|\?|$)/.test(r.path)));
});

test("takes a required entry naming its workflow, and refuses a malformed input", async () => {
  const runs = [{ ...green.runs[0], check_suite_id: 5, path: ".github/workflows/ci.yml" }];
  const checks = [{ ...green.checks[0], check_suite: { id: 5 } }];
  const named = (workflow) => ({ REQUIRED: JSON.stringify([{ check: "Check", workflow }]) });
  assert.equal((await attempt({ runs, checks }, named("ci.yml"))).merged, true);
  assert.equal((await attempt({ runs, checks }, named("backup-worker.yml"))).merged, false);
  for (const env of [
    { REQUIRED: '[{"check":"Check"}]' },
    { REQUIRED: '[{"check":"Check","workflow":".github/workflows/ci.yml"}]' },
    { ALLOWED_BOTS: '"helper[bot]"' },
    { REQUIRE_UP_TO_DATE: "yes" },
  ]) {
    assert.equal((await run("http://127.0.0.1:9", env)).code, 1, JSON.stringify(env));
  }
});

test("merges nothing, and fails the run, when a read the gate needs fails", async () => {
  const upToDate = { REQUIRE_UP_TO_DATE: "true" };
  for (const part of ["/issues/7/events", "/collaborators/", "/git/ref/", "/compare/"]) {
    for (const status of [403, 500]) {
      const { code, out, merged } = await attempt({ fail: { [part]: status } }, upToDate);
      assert.equal(code, 1, `${part} ${status}: ${out}`);
      assert.equal(merged, false, `${part} ${status}`);
      assert.match(out, new RegExp(`::error::#7 .*HTTP ${status}`));
    }
  }
});

test("waits when the comparison carries no behind_by", async () => {
  const { code, out, merged } = await attempt({ comparison: {} }, { REQUIRE_UP_TO_DATE: "true" });
  assert.equal(code, 0, out);
  assert.equal(merged, false);
});

test("refuses a label whose last event has no actor", async () => {
  const events = [labeled("owner", "User", 1), { ...labeled("gone", "User", 2), actor: null }];
  const { code, out, merged } = await attempt({ events });
  assert.equal(code, 0, out);
  assert.equal(merged, false);
  assert.match(out, /no record/);
});

/** `count` events that are not the label's. */
const noise = (count) => Array.from({ length: count }, (_, i) => ({ id: 1000 + i, event: "subscribed" }));

test("finds the last labeler past the first page of events, in id order whatever the list's", async () => {
  const permissions = { owner: "admin", guest: "read" };
  const paged = await attempt({ events: [labeled("owner", "User", 1), ...noise(150), labeled("guest", "User", 5000)], permissions });
  assert.equal(paged.merged, false);
  assert.match(paged.out, /added by guest/);
  const unordered = await attempt({ events: [labeled("guest", "User", 2), labeled("owner", "User", 1)], permissions });
  assert.match(unordered.out, /added by guest/);
});

test("refuses, without failing the run, a pull request with more events than it reads", async () => {
  const { code, out, merged } = await attempt({ events: [labeled("owner"), ...noise(500)] });
  assert.equal(code, 0, out);
  assert.equal(merged, false);
  assert.match(out, /too many events/);
});

/** The env of a run for the pull request event that named #7, sent by `login`. */
const event = (login, type = "User", extra = {}) => ({
  PR: "7",
  EVENT_ACTION: "labeled",
  EVENT_LABEL: "automerge",
  RUN_ATTEMPT: "1",
  SENDER_LOGIN: login,
  SENDER_TYPE: type,
  ...extra,
});

test("judges the `labeled` event by its sender, even before the events list shows the label", async () => {
  const lagging = await attempt({ events: [] }, event("owner"));
  assert.equal(lagging.merged, true, lagging.out);
  assert.ok(!lagging.requests.some((r) => r.path.includes("/events")));
  assert.equal((await attempt({ permissions: { guest: "read" } }, event("guest"))).merged, false);
  assert.equal((await attempt({}, event("helper[bot]", "Bot"))).merged, false);
});

test("reads the events instead of the sender unless this run is the label being added", async () => {
  // A triage user's label, which the events show; the sender is someone who could merge.
  const state = { events: [labeled("guest")], permissions: { owner: "admin", guest: "read" } };
  const others = [
    { EVENT_ACTION: "unlabeled" },
    { EVENT_ACTION: "synchronize" },
    { EVENT_ACTION: "" },
    { EVENT_LABEL: "documentation" },
    { RUN_ATTEMPT: "2" },
    // A workflow_run names no pull request.
    { PR: "" },
  ];
  for (const extra of others) {
    const { merged, out } = await attempt(state, event("owner", "User", extra));
    assert.equal(merged, false, JSON.stringify(extra));
    assert.match(out, /added by guest/, JSON.stringify(extra));
  }
});

test("judges the second pull request of a commit after the first one's read fails", async () => {
  const pulls = [pull(), pull({ number: 8 })];
  const { code, out, requests } = await attempt({ pulls, fail: { "/issues/7/events": 500 } });
  assert.equal(code, 1, out);
  const merges = requests.filter((r) => r.method === "PUT").map((r) => r.path);
  assert.deepEqual(merges, [`/repos/${REPO}/pulls/8/merge`]);
});

/** What ran on `sha`: CI and Check, finished with `conclusion` (or still running for null). */
const ranOn = (sha, conclusion = "success") => ({
  runs: [{ id: 1, name: "CI", workflow_id: 1, head_sha: sha, status: conclusion ? "completed" : "in_progress", conclusion }],
  checks: [{ id: 1, name: "Check", status: conclusion ? "completed" : "in_progress", conclusion }],
});
const at = (number, sha, over = {}) => pull({ number, head: { sha, ref: `branch-${number}`, repo: { full_name: REPO } }, ...over });

test("after a finished run, judges every labelled pull request at its own head, whichever commit the run was for", async () => {
  const [green7, green8, busy, bare, red, closed] = ["1", "2", "3", "4", "5", "6"].map((c) => c.repeat(40));
  const pulls = [
    at(7, green7),
    at(8, green8),
    at(9, busy),
    at(10, bare, { labels: [] }),
    at(11, red),
    at(12, closed, { state: "closed" }),
  ];
  const heads = { [green7]: ranOn(green7), [green8]: ranOn(green8), [busy]: ranOn(busy, null), [red]: ranOn(red, "failure") };
  // The run that finished was on a commit none of them has as its head.
  const { code, out, requests } = await attempt({ pulls, heads }, { SHA: "c".repeat(40) });
  assert.equal(code, 0, out);
  const merges = requests.filter((r) => r.method === "PUT").map((r) => [r.path, r.body.sha]);
  assert.deepEqual(merges, [
    [`/repos/${REPO}/pulls/7/merge`, green7],
    [`/repos/${REPO}/pulls/8/merge`, green8],
  ]);
  assert.match(out, /#9 wait: still running: CI, Check/);
  assert.match(out, /#11 red: CI failure/);
  // An unlabelled or closed pull request costs no read of its runs.
  for (const sha of [bare, closed]) assert.ok(!requests.some((r) => r.path.includes(sha)), sha);
});

test("after a finished run with no labelled pull request open, reads the list and nothing else", async () => {
  const pulls = [at(7, "1".repeat(40), { labels: [] }), at(8, "2".repeat(40), { labels: [{ name: "documentation" }] })];
  const { code, out, requests } = await attempt({ pulls });
  assert.equal(code, 0, out);
  assert.match(out, /No open pull request is labelled automerge/);
  assert.deepEqual(
    requests.map((r) => r.path),
    [`/repos/${REPO}`, `/repos/${REPO}/pulls?state=open`],
  );
});

test("a label event judges its own pull request alone, at the event's commit", async () => {
  const other = "2".repeat(40);
  const pulls = [pull(), at(8, other)];
  const { merged, requests, out } = await attempt({ pulls, heads: { [other]: ranOn(other) } }, event("owner"));
  assert.equal(merged, true, out);
  assert.ok(!requests.some((r) => r.path.startsWith(`/repos/${REPO}/pulls?`)));
  assert.deepEqual(requests.filter((r) => r.method === "PUT").map((r) => r.path), [`/repos/${REPO}/pulls/7/merge`]);
});

test("a label event's head that has moved on is not merged, though its new head is green", async () => {
  const moved = "2".repeat(40);
  const { merged, out } = await attempt({ pulls: [at(7, moved)], heads: { [moved]: ranOn(moved) } }, event("owner"));
  assert.equal(merged, false);
  assert.match(out, /has moved on/);
});

test("takes a merge refused because another run merged that head as done, and no other refusal", async () => {
  const refused = { merge: [405, { message: "Pull Request is not mergeable" }] };
  const landed = await attempt({ ...refused, after: [pull({ state: "closed", merged: true, merge_commit_sha: "m".repeat(40) })] });
  assert.equal(landed.code, 0, landed.out);
  assert.match(landed.out, /#7 was merged by another run/);
  const elsewhere = await attempt({ ...refused, after: [pull({ merged: true, head: { sha: "2".repeat(40), ref: "x", repo: { full_name: REPO } } })] });
  assert.equal(elsewhere.code, 1, elsewhere.out);
  assert.match(elsewhere.out, /::error::#7 could not be merged: HTTP 405/);
});

test("fails a refused merge only in a run of the pull request's own; a sweep another head started warns", async () => {
  const refused = { merge: [405, { message: "Pull Request is not mergeable" }] };
  // Its own: a workflow run on its head finished, or its label was added.
  for (const env of [{}, event("owner")]) {
    const own = await attempt(refused, env);
    assert.equal(own.code, 1, own.out);
    assert.match(own.out, /::error::#7 could not be merged: HTTP 405 Pull Request is not mergeable/);
  }
  // Another pull request's run finished: #7 is refused again (a warning); #8, refused at its own head, the
  // commit the finished run was for, is an error. Both are tried.
  const other = "2".repeat(40);
  const both = await attempt({ ...refused, pulls: [pull(), at(8, other)], heads: { [other]: ranOn(other) } }, { SHA: other });
  assert.equal(both.code, 1, both.out);
  assert.match(both.out, new RegExp(`::warning::#7 could not be merged again at ${SHA}: HTTP 405`));
  assert.doesNotMatch(both.out, /::error::#7/);
  assert.match(both.out, /::error::#8 could not be merged/);
  assert.equal(both.requests.filter((r) => r.method === "PUT").length, 2);
  // With only #7 labelled, a sweep another head started exits 0.
  const alone = await attempt(refused, { SHA: other });
  assert.equal(alone.code, 0, alone.out);
  assert.match(alone.out, /::warning::#7 could not be merged again/);
});

test("holds back a labelled head the latest runs show running or red, with no read of its own", async () => {
  const [busy, red, quiet, green] = ["1", "2", "3", "4"].map((c) => c.repeat(40));
  const pulls = [at(7, busy), at(8, red), at(9, quiet), at(10, green)];
  // The repository's latest runs: #7's still running, #8's failed after an earlier success, #10's green.
  const recent = [
    { id: 3, name: "CI", workflow_id: 1, head_sha: busy, status: "in_progress", conclusion: null },
    { id: 5, name: "CI", workflow_id: 1, head_sha: red, status: "completed", conclusion: "failure" },
    { id: 4, name: "CI", workflow_id: 1, head_sha: red, status: "completed", conclusion: "success" },
    { id: 6, name: "CI", workflow_id: 1, head_sha: green, status: "completed", conclusion: "success" },
    { id: 7, name: "Merge on green", workflow_id: 9, head_sha: green, status: "in_progress", conclusion: null },
  ];
  // What each head's own reads would say, if made: all green, so only the early read holds #7 and #8.
  const heads = Object.fromEntries([busy, red, quiet, green].map((sha) => [sha, ranOn(sha)]));
  const { code, out, requests } = await attempt({ pulls, heads, recent });
  assert.equal(code, 0, out);
  assert.match(out, /#7 wait: still running: CI/);
  assert.match(out, /#8 red: CI failure/);
  assert.match(out, /::warning::#8 is not merged: CI failure/);
  for (const sha of [busy, red]) assert.ok(!requests.some((r) => r.path.includes(sha)), sha);
  // A head missing from the latest runs, or green in them, is judged in full and merged.
  const merges = requests.filter((r) => r.method === "PUT").map((r) => r.path);
  assert.deepEqual(merges, [`/repos/${REPO}/pulls/9/merge`, `/repos/${REPO}/pulls/10/merge`]);
});

test("a label event's run does not read the repository's latest runs", async () => {
  const { merged, requests, out } = await attempt({}, event("owner"));
  assert.equal(merged, true, out);
  assert.ok(!requests.some((r) => r.path.includes("event=pull_request")));
});
