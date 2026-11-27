// Whether a pull request labelled for merge-on-green may be squash-merged now.
//
// The free organisation enforces no required checks on private repositories, so GitHub's own
// auto-merge would merge before CI has run. This decides from what ran on the pull request's head
// commit instead: every workflow run and check run finished and green, and every check the caller
// names as required present and successful. It also refuses a label added by someone who may not
// write to the repository, and, when the caller asks, waits for a head that contains the base's tip.

export const LABEL = "automerge";

/** Conclusions that do not block a merge. A required check needs `success` all the same. */
const GREEN = new Set(["success", "skipped", "neutral"]);

/** The collaborator permissions that may ask for a merge; `maintain` reads as `write`. */
const MAY_MERGE = new Set(["admin", "write"]);

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

/** The workflow's file name, from a run's `path` (`.github/workflows/ci.yml`, with or without `@ref`). */
const fileOf = (run) => run.path?.split("@")[0].split("/").pop();

/**
 * The latest check run of each name in each workflow. Two workflows may name a job alike, and one's
 * later success says nothing about the other's check, so a check run is matched to its workflow by
 * its check suite; one that no workflow run owns is grouped by the app that reported it.
 */
function latestChecks(checkRuns, workflowRuns) {
  const bySuite = new Map(workflowRuns.map((run) => [run.check_suite_id, run]));
  const owned = checkRuns.map((check) => {
    const run = check.check_suite?.id === undefined ? undefined : bySuite.get(check.check_suite.id);
    return { ...check, workflow: run && fileOf(run), owner: run ? `workflow ${run.workflow_id}` : `app ${check.app?.id}` };
  });
  return latestBy(owned, (check) => `${check.owner}: ${check.name}`);
}

/**
 * What the workflow runs alone say of `sha`: `red` when the latest run of a workflow failed, `wait`
 * while one is unfinished, or null when every one listed finished green. It never says merge: a
 * caller uses it to hold back a head early, and `decide` still judges any head it lets through.
 */
export function runsVerdict(workflowRuns, sha, self) {
  const runs = latestBy(
    workflowRuns.filter((run) => run.name !== self && run.head_sha === sha),
    (run) => run.workflow_id,
  );
  const red = runs.find((run) => run.status === "completed" && !GREEN.has(run.conclusion));
  if (red) return { action: "red", reason: `${red.name} ${red.conclusion}` };
  const running = runs.filter((run) => run.status !== "completed");
  if (running.length > 0) return { action: "wait", reason: `still running: ${running.map((run) => run.name).join(", ")}` };
  return null;
}

/** Why the label does not count, or null when whoever added it may ask for a merge. */
function refusal(labeler, allowedBots) {
  if (!labeler) return `no record of who added ${LABEL}; remove the label and add it again`;
  if (labeler.unknown) return `${labeler.unknown}; remove the label and add it again`;
  const { login, type, permission } = labeler;
  if (type !== "User") {
    const listed = allowedBots.some((bot) => bot.toLowerCase() === login.toLowerCase());
    return listed ? null : `${LABEL} was added by ${login}, a ${type.toLowerCase()} not listed in allowed-bots`;
  }
  if (MAY_MERGE.has(permission)) return null;
  return `${LABEL} was added by ${login}, whose permission here is ${permission}, not write`;
}

/**
 * @param {object} input
 * @param {object} input.pr The pull request, as the REST API returns it.
 * @param {string} input.sha The head commit the event was for.
 * @param {string} input.defaultBranch The repository's default branch.
 * @param {object[]} input.workflowRuns Workflow runs for `sha` (`/actions/runs?head_sha=`).
 * @param {object[]} input.checkRuns Check runs for `sha` (`/commits/{sha}/check-runs`).
 * @param {(string | { check: string, workflow: string })[]} input.required Checks that must have
 *   succeeded: a check run name, or a name in one workflow file (`ci.yml`).
 * @param {string} input.self This workflow's name; its own run and check runs are left out.
 * @param {{ login: string, type: string, permission?: string } | { unknown: string } | null} input.labeler
 *   Who last added the label, and for a user their permission on the repository; null when no event
 *   says, `unknown` why it cannot be told.
 * @param {string[]} [input.allowedBots] Logins (`name[bot]`) of the bots whose label counts.
 * @param {boolean} [input.requireUpToDate] Wait unless the head contains the base branch's tip.
 * @param {{ sha: string, behindBy: number }} [input.base] The base branch's tip and how many of its
 *   commits the head lacks; read only when requireUpToDate.
 * @returns {{ action: "merge" | "wait" | "skip" | "red" | "refused", reason: string }}
 */
export function decide(input) {
  const { pr, sha, defaultBranch, workflowRuns, checkRuns, required, self } = input;
  const { labeler, allowedBots = [], requireUpToDate = false, base } = input;
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
  const refused = refusal(labeler, allowedBots);
  if (refused) return { action: "refused", reason: refused };

  const runs = latestBy(
    workflowRuns.filter((run) => run.name !== self && run.head_sha === sha),
    (run) => run.workflow_id,
  );
  const checks = latestChecks(
    checkRuns.filter((check) => check.name !== self && !check.name.endsWith(` / ${self}`)),
    workflowRuns,
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
  // Every check the entry matches must have succeeded, so a name two workflows share is met by both.
  const missing = required.flatMap((entry) => {
    const { check: name, workflow } = typeof entry === "string" ? { check: entry } : entry;
    const matches = checks.filter((c) => c.name === name && (!workflow || c.workflow === workflow));
    if (matches.length > 0 && matches.every((c) => c.conclusion === "success")) return [];
    return [workflow ? `${name} (${workflow})` : name];
  });
  if (missing.length > 0) return { action: "wait", reason: `required checks not yet green: ${missing.join(", ")}` };
  if (requireUpToDate && base?.behindBy !== 0) {
    const tip = base ? `${defaultBranch} at ${base.sha.slice(0, 7)}` : `the tip of ${defaultBranch}`;
    return { action: "wait", reason: `${sha.slice(0, 7)} does not contain ${tip}; update the branch` };
  }
  return { action: "merge", reason: `every check on ${sha.slice(0, 7)} is green` };
}
