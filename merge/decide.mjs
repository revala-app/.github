// Whether a pull request labelled for merge-on-green may be squash-merged now.
//
// The free organisation enforces no required checks on private repositories, so GitHub's own
// auto-merge would merge before CI has run. This decides from what ran on the pull request's head
// commit instead: every workflow run and check run finished and green, and every check the caller
// names as required present and successful.

export const LABEL = "automerge";

/** Conclusions that do not block a merge. */
const GREEN = new Set(["success", "skipped", "neutral"]);

/**
 * The latest of each group: a workflow re-run by a later event (an edited title, a new label) or a
 * check run re-run supersedes the earlier one, which may have been cancelled by its concurrency group.
 */
function latestBy(items, key) {
  const latest = new Map();
  for (const item of items) {
    const k = key(item);
    const seen = latest.get(k);
    if (!seen || item.id > seen.id) latest.set(k, item);
  }
  return [...latest.values()];
}

/**
 * @param {object} input
 * @param {object} input.pr The pull request, as the REST API returns it.
 * @param {string} input.sha The head commit the event was for.
 * @param {string} input.defaultBranch The repository's default branch.
 * @param {object[]} input.workflowRuns Workflow runs for `sha` (`/actions/runs?head_sha=`).
 * @param {object[]} input.checkRuns Check runs for `sha` (`/commits/{sha}/check-runs`).
 * @param {string[]} input.required Check run names that must have succeeded.
 * @param {string} input.self This workflow's name; its own run and check runs are left out.
 * @returns {{ action: "merge" | "wait" | "skip" | "red", reason: string }}
 */
export function decide({ pr, sha, defaultBranch, workflowRuns, checkRuns, required, self }) {
  const labels = pr.labels.map((label) => label.name);
  if (pr.state !== "open") return { action: "skip", reason: `#${pr.number} is ${pr.state}` };
  if (!labels.includes(LABEL)) return { action: "skip", reason: `#${pr.number} is not labelled ${LABEL}` };
  if (pr.draft) return { action: "skip", reason: `#${pr.number} is a draft` };
  if (labels.some((name) => name.startsWith("autorelease"))) {
    return { action: "skip", reason: `#${pr.number} is a release pull request; merge it by hand` };
  }
  if (pr.base.ref !== defaultBranch) {
    return { action: "skip", reason: `#${pr.number} targets ${pr.base.ref}, not ${defaultBranch}` };
  }
  if (pr.head.sha !== sha) return { action: "skip", reason: `#${pr.number} has moved on from ${sha}` };
  if (required.length === 0) return { action: "skip", reason: "no required checks given" };

  const runs = latestBy(
    workflowRuns.filter((run) => run.name !== self && run.head_sha === sha),
    (run) => run.workflow_id,
  );
  const checks = latestBy(
    checkRuns.filter((check) => check.name !== self && !check.name.endsWith(` / ${self}`)),
    (check) => check.name,
  );

  for (const item of [...runs, ...checks]) {
    if (item.status === "completed" && !GREEN.has(item.conclusion)) {
      return { action: "red", reason: `${item.name} ${item.conclusion}` };
    }
  }
  const running = [...runs, ...checks].filter((item) => item.status !== "completed");
  if (running.length > 0) {
    return { action: "wait", reason: `still running: ${running.map((item) => item.name).join(", ")}` };
  }
  const missing = required.filter((name) => !checks.some((c) => c.name === name && c.conclusion === "success"));
  if (missing.length > 0) return { action: "wait", reason: `required checks not yet green: ${missing.join(", ")}` };
  return { action: "merge", reason: `every check on ${sha.slice(0, 7)} is green` };
}
