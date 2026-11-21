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
const check = (id, name, conclusion) => ({
  id,
  name,
  status: conclusion ? "completed" : "queued",
  conclusion: conclusion ?? null,
});
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
