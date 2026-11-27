import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, LABEL } from "./decide.mjs";

const SHA = "a".repeat(40);
const SELF = "Merge on green";

const pr = (over = {}) => ({
  number: 7,
  state: "open",
  draft: false,
  labels: [{ name: LABEL }],
  base: { ref: "main" },
  head: { sha: SHA },
  ...over,
});
const run = (id, name, conclusion, over = {}) => ({
  id,
  name,
  workflow_id: name.length,
  head_sha: SHA,
  status: conclusion ? "completed" : "in_progress",
  conclusion: conclusion ?? null,
  ...over,
});
const check = (id, name, conclusion, over = {}) => ({
  id,
  name,
  status: conclusion ? "completed" : "queued",
  conclusion: conclusion ?? null,
  ...over,
});
const writer = { login: "owner", type: "User", permission: "write" };
const greenRuns = [run(1, "CI", "success"), run(2, "PR title", "success")];
const greenChecks = [check(1, "Check", "success"), check(2, "Test", "success"), check(3, "pr-title / pr-title", "success")];
const input = (over = {}) => ({
  pr: pr(),
  sha: SHA,
  defaultBranch: "main",
  workflowRuns: greenRuns,
  checkRuns: greenChecks,
  required: ["Check", "Test", "pr-title / pr-title"],
  self: SELF,
  labeler: writer,
  ...over,
});

test("merges when every run and check is green and the required ones succeeded", () => {
  assert.equal(decide(input()).action, "merge");
});

test("skips a pull request that is not labelled, is a draft, closed or a release", () => {
  assert.equal(decide(input({ pr: pr({ labels: [] }) })).action, "skip");
  assert.equal(decide(input({ pr: pr({ draft: true }) })).action, "skip");
  assert.equal(decide(input({ pr: pr({ state: "closed" }) })).action, "skip");
  const release = pr({ labels: [{ name: LABEL }, { name: "autorelease: pending" }] });
  assert.match(decide(input({ pr: release })).reason, /by hand/);
});

test("skips a pull request into another branch, or whose head moved past the event's commit", () => {
  assert.equal(decide(input({ pr: pr({ base: { ref: "next" } }) })).action, "skip");
  assert.equal(decide(input({ pr: pr({ head: { sha: "b".repeat(40) } }) })).action, "skip");
});

test("never merges with no required checks named", () => {
  assert.equal(decide(input({ required: [] })).action, "skip");
});

test("waits while a workflow run or a check run is still going", () => {
  assert.equal(decide(input({ workflowRuns: [...greenRuns, run(3, "Spec")] })).action, "wait");
  assert.equal(decide(input({ checkRuns: [...greenChecks, check(4, "Console")] })).action, "wait");
});

test("waits while a required check has not appeared", () => {
  const { action, reason } = decide(input({ required: ["Check", "Test", "Web"] }));
  assert.equal(action, "wait");
  assert.match(reason, /Web/);
});

test("is red when any run or check failed, even one that is not required", () => {
  assert.deepEqual(decide(input({ checkRuns: [...greenChecks, check(4, "Lint workflows", "failure")] })), {
    action: "red",
    reason: "Lint workflows failure",
  });
  assert.equal(decide(input({ workflowRuns: [...greenRuns, run(3, "Spec", "cancelled")] })).action, "red");
  assert.equal(decide(input({ checkRuns: [check(1, "Check", "success"), check(2, "Test", "skipped")] })).action, "wait");
});

test("a later run of the same workflow or check supersedes an earlier cancelled one", () => {
  const rerun = [run(1, "CI", "success"), run(2, "PR title", "cancelled"), run(5, "PR title", "success")];
  assert.equal(decide(input({ workflowRuns: rerun })).action, "merge");
  const rechecked = [...greenChecks, check(9, "Test", "failure"), check(10, "Test", "success")];
  assert.equal(decide(input({ checkRuns: rechecked })).action, "merge");
});

test("leaves out its own run and check, which are still going while it decides", () => {
  const runs = [...greenRuns, run(9, SELF)];
  const checks = [...greenChecks, check(9, `merge / ${SELF}`), check(10, SELF)];
  assert.equal(decide(input({ workflowRuns: runs, checkRuns: checks })).action, "merge");
});

test("ignores workflow runs of another commit", () => {
  const other = run(4, "Spec", "failure", { head_sha: "c".repeat(40) });
  assert.equal(decide(input({ workflowRuns: [...greenRuns, other] })).action, "merge");
});

test("waits on a required check that concluded skipped or neutral: required needs success", () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const checks = [check(1, "Check", "success"), check(2, "Test", conclusion), greenChecks[2]];
    const { action, reason } = decide(input({ checkRuns: checks }));
    assert.equal(action, "wait", conclusion);
    assert.match(reason, /Test/);
  }
});

test("merges past a check that is not required and was skipped or neutral", () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const checks = [...greenChecks, check(4, "Publish", conclusion)];
    assert.equal(decide(input({ checkRuns: checks })).action, "merge", conclusion);
  }
});

// Three workflows whose job is `Check`, as revala-ops had: each its own check suite.
const sharedRuns = ["ci.yml", "backup-worker.yml", "monitor-worker.yml"].map((file, i) =>
  run(i + 1, file, "success", { workflow_id: i + 1, check_suite_id: 100 + i, path: `.github/workflows/${file}` }),
);
const inSuite = (id, conclusion, suite) => check(id, "Check", conclusion, { check_suite: { id: suite } });
const shared = (checkRuns, required) => decide(input({ workflowRuns: sharedRuns, checkRuns, required }));

test("one workflow's later success does not hide another's failed check of the same name", () => {
  const { action, reason } = shared([inSuite(1, "failure", 100), inSuite(2, "success", 101)], ["Check"]);
  assert.deepEqual({ action, reason }, { action: "red", reason: "Check failure" });
});

test("a plain required name needs every workflow's check of that name to have succeeded", () => {
  assert.equal(shared([inSuite(1, "skipped", 100), inSuite(2, "success", 101)], ["Check"]).action, "wait");
  assert.equal(shared([inSuite(1, "success", 100), inSuite(2, "success", 101)], ["Check"]).action, "merge");
});

test("a required check naming its workflow is not met by another workflow's check", () => {
  const required = [{ check: "Check", workflow: "ci.yml" }];
  const { action, reason } = shared([inSuite(2, "success", 101)], required);
  assert.equal(action, "wait");
  assert.match(reason, /Check \(ci\.yml\)/);
  assert.equal(shared([inSuite(1, "success", 100), inSuite(2, "skipped", 101)], required).action, "merge");
});

test("refuses a label from a user without write access, or from nobody on record", () => {
  for (const permission of ["read", "none"]) {
    const { action, reason } = decide(input({ labeler: { login: "guest", type: "User", permission } }));
    assert.equal(action, "refused", permission);
    assert.match(reason, /guest/);
  }
  assert.equal(decide(input({ labeler: null })).action, "refused");
  assert.equal(decide(input({ labeler: { ...writer, permission: "admin" } })).action, "merge");
});

test("refuses a bot's label unless the caller lists the bot", () => {
  const labeler = { login: "helper[bot]", type: "Bot" };
  assert.equal(decide(input({ labeler })).action, "refused");
  assert.equal(decide(input({ labeler, allowedBots: ["other[bot]"] })).action, "refused");
  assert.equal(decide(input({ labeler, allowedBots: ["helper[bot]"] })).action, "merge");
});

test("when asked, waits for a head that contains the base tip, naming the base commit", () => {
  const base = { sha: "d".repeat(40), behindBy: 2 };
  const { action, reason } = decide(input({ requireUpToDate: true, base }));
  assert.equal(action, "wait");
  assert.match(reason, /main at ddddddd/);
  assert.equal(decide(input({ requireUpToDate: true, base: { ...base, behindBy: 0 } })).action, "merge");
  assert.equal(decide(input({ requireUpToDate: true })).action, "wait");
  assert.equal(decide(input({ base })).action, "merge", "off by default");
});

test("refuses, saying why, when who added the label cannot be told", () => {
  const { action, reason } = decide(input({ labeler: { unknown: "#7 has too many events" } }));
  assert.equal(action, "refused");
  assert.match(reason, /too many events/);
});

test("matches a listed bot whatever the case of its login", () => {
  const labeler = { login: "Helper[bot]", type: "Bot" };
  assert.equal(decide(input({ labeler, allowedBots: ["helper[BOT]"] })).action, "merge");
});

test("waits when the comparison does not say how far behind the head is", () => {
  assert.equal(decide(input({ requireUpToDate: true, base: { sha: "d".repeat(40) } })).action, "wait");
});

test("a re-run in a second check suite of one workflow supersedes its cancelled check", () => {
  const ci = (id, suite, conclusion) =>
    run(id, "CI", conclusion, { workflow_id: 1, check_suite_id: suite, path: ".github/workflows/ci.yml" });
  const workflowRuns = [ci(1, 100, "cancelled"), ci(2, 101, "success")];
  const checkRuns = [inSuite(1, "cancelled", 100), inSuite(2, "success", 101)];
  const required = [{ check: "Check", workflow: "ci.yml" }];
  assert.equal(decide(input({ workflowRuns, checkRuns, required })).action, "merge");
});

test("a required entry naming its workflow waits when no listed run owns the check's suite", () => {
  const required = [{ check: "Check", workflow: "ci.yml" }];
  assert.equal(shared([inSuite(1, "success", 999)], required).action, "wait");
});

test("reads a workflow's file name from a path carrying @ref", () => {
  const workflowRuns = [{ ...sharedRuns[0], path: ".github/workflows/ci.yml@refs/heads/main" }];
  const required = [{ check: "Check", workflow: "ci.yml" }];
  const checkRuns = [inSuite(1, "success", 100)];
  assert.equal(decide(input({ workflowRuns, checkRuns, required })).action, "merge");
});
