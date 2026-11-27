#!/usr/bin/env node
// Squash-merges each open pull request labelled `automerge` whose head commit is SHA once every
// check on it is green (decide.mjs), then deletes its branch. Run by merge-on-green.yml. Check runs
// and workflow runs are the whole gate: legacy commit statuses are not read.
//
//   REPO=owner/name SHA=<head sha> [PR=<number>] REQUIRED='["Check","Test"]' SELF="Merge on green" \
//   READ_TOKEN=<token reading actions, checks and pull requests> MERGE_TOKEN=<token writing contents> \
//   [ALLOWED_BOTS='["name[bot]"]'] [REQUIRE_UP_TO_DATE=true] \
//   [EVENT_ACTION=<action> EVENT_LABEL=<label> RUN_ATTEMPT=<n> SENDER_LOGIN=<login> \
//    SENDER_TYPE=<User|Bot>, the pull request event that named PR] \
//   node merge-on-green.mjs
//
// Waiting is not failing: a pull request whose checks still run, or which is not labelled, exits 0,
// and the next finished workflow run looks again. A red check exits 0 too, and says which, as does a
// label added by someone who may not ask for a merge; a merge
// GitHub refuses (a conflict, a head that moved) fails the run so the owner hears of it. Nothing is
// retried here: the next event is the retry. A head behind its base waits for someone to update the
// branch: this never does.

import { decide, LABEL } from "./decide.mjs";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 5;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function request(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function get(token, path) {
  const { status, data } = await request(token, "GET", path);
  if (status !== 200) throw new Error(`GET ${path}: HTTP ${status} ${data?.message ?? ""}`.trim());
  return data;
}

/**
 * Every item of a paginated list, whose page is the list itself or holds it under `key`; past
 * MAX_PAGES it throws, or returns null with `{ partial: true }`.
 */
async function all(token, path, key, { partial = false } = {}) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await get(token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const found = key ? data[key] : data;
    items.push(...found);
    if (found.length < 100) return items;
  }
  if (partial) return null;
  throw new Error(`${path}: more than ${MAX_PAGES * 100} items`);
}

/** A branch name as it goes in a path: encoded, its slashes kept. */
const refPath = (name) => encodeURIComponent(name).replaceAll("%2F", "/");

/** The actor of the last `labeled` event for the label, from the pull request's events. */
async function lastLabelActor(token, repo, number) {
  const events = await all(token, `/repos/${repo}/issues/${number}/events`, undefined, { partial: true });
  // Oldest first, so a list cut short would name an earlier labeler as the last.
  if (!events) return { unknown: `#${number} has too many events to tell who added ${LABEL}` };
  const added = events.filter((e) => e.event === "labeled" && e.label?.name === LABEL).sort((a, b) => a.id - b.id);
  return added.at(-1)?.actor ?? null;
}

/**
 * Who added the label, with a user's permission on the repository; null when nothing says. `sender`
 * is the actor of the `labeled` event this run is for: the events list may not show it yet, and a
 * pull request already green gets no later run to look again.
 */
async function labelerOf(token, repo, number, sender) {
  const actor = sender ?? (await lastLabelActor(token, repo, number));
  if (!actor || actor.unknown) return actor;
  const { login, type } = actor;
  // A bot is no collaborator: the caller's list is what vouches for it.
  if (type !== "User") return { login, type };
  const path = `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`;
  const { status, data } = await request(token, "GET", path);
  if (status === 404) return { login, type, permission: "none" };
  if (status !== 200) throw new Error(`GET ${path}: HTTP ${status} ${data?.message ?? ""}`.trim());
  return { login, type, permission: data.permission };
}

/** The base branch's tip now, and how many of its commits `sha` lacks. */
async function baseOf(token, repo, branch, sha) {
  const { object } = await get(token, `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
  const { behind_by: behindBy } = await get(token, `/repos/${repo}/compare/${object.sha}...${sha}?per_page=1`);
  return { sha: object.sha, behindBy };
}

/** A required entry: a check run name, or `{ check, workflow }` naming the workflow file too. */
function isRequired(entry) {
  if (typeof entry === "string") return true;
  if (entry === null || typeof entry !== "object") return false;
  const { check, workflow, ...rest } = entry;
  return typeof check === "string" && /^[^/@]+\.ya?ml$/.test(workflow) && Object.keys(rest).length === 0;
}

async function main() {
  const repo = env("REPO");
  const sha = env("SHA");
  const self = env("SELF");
  const readToken = env("READ_TOKEN");
  const mergeToken = env("MERGE_TOKEN");
  const required = JSON.parse(env("REQUIRED"));
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`REPO must be owner/name, got ${repo}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`SHA must be a full commit SHA, got ${sha}`);
  if (!Array.isArray(required) || !required.every(isRequired)) {
    throw new Error('REQUIRED must be a JSON array of check names or {"check": name, "workflow": "file.yml"}');
  }
  const allowedBots = JSON.parse(process.env.ALLOWED_BOTS || "[]");
  if (!Array.isArray(allowedBots) || !allowedBots.every((bot) => typeof bot === "string")) {
    throw new Error("ALLOWED_BOTS must be a JSON array of bot logins");
  }
  const upToDate = process.env.REQUIRE_UP_TO_DATE || "false";
  if (upToDate !== "true" && upToDate !== "false") throw new Error(`REQUIRE_UP_TO_DATE must be true or false, got ${upToDate}`);
  const requireUpToDate = upToDate === "true";
  // The sender added the label only on the first run of the `labeled` event for it: on `unlabeled` it
  // removed it, and a re-run is late. It speaks for the event's own pull request alone.
  const { PR, EVENT_ACTION, EVENT_LABEL, RUN_ATTEMPT, SENDER_LOGIN } = process.env;
  const sender = PR && EVENT_ACTION === "labeled" && EVENT_LABEL === LABEL && RUN_ATTEMPT === "1" && SENDER_LOGIN
    ? { login: SENDER_LOGIN, type: env("SENDER_TYPE") }
    : undefined;

  const { default_branch: defaultBranch } = await get(readToken, `/repos/${repo}`);
  const prs = process.env.PR
    ? [await get(readToken, `/repos/${repo}/pulls/${Number(process.env.PR)}`)]
    : (await get(readToken, `/repos/${repo}/commits/${sha}/pulls`)).filter((pr) => pr.state === "open");
  if (prs.length === 0) {
    console.log(`No open pull request has ${sha} as its head.`);
    return;
  }
  const workflowRuns = await all(readToken, `/repos/${repo}/actions/runs?head_sha=${sha}`, "workflow_runs");
  const checkRuns = await all(readToken, `/repos/${repo}/commits/${sha}/check-runs`, "check_runs");

  /** Judges one pull request and merges it if it may be; false when GitHub refused the merge. */
  async function settle(pr) {
    const labelled = pr.state === "open" && pr.labels.some((label) => label.name === LABEL);
    const labeler = labelled ? await labelerOf(readToken, repo, pr.number, sender) : null;
    // Read last, so the base is as fresh as it can be when the merge follows.
    const base = labelled && requireUpToDate ? await baseOf(readToken, repo, defaultBranch, sha) : undefined;
    const { action, reason } = decide({
      pr, sha, defaultBranch, workflowRuns, checkRuns, required, self,
      labeler, allowedBots, requireUpToDate, base,
    });
    console.log(`#${pr.number} ${action}: ${reason}`);
    if (action === "red" || action === "refused") console.log(`::warning::#${pr.number} is not merged: ${reason}.`);
    if (action !== "merge") return true;

    const merged = await request(mergeToken, "PUT", `/repos/${repo}/pulls/${pr.number}/merge`, {
      merge_method: "squash",
      sha,
      commit_title: `${pr.title} (#${pr.number})`,
    });
    if (merged.status !== 200) {
      console.log(`::error::#${pr.number} could not be merged: HTTP ${merged.status} ${merged.data?.message ?? ""}`);
      return false;
    }
    console.log(`#${pr.number} merged as ${merged.data.sha}.`);
    if (pr.head.repo?.full_name === repo) {
      const deleted = await request(mergeToken, "DELETE", `/repos/${repo}/git/refs/heads/${refPath(pr.head.ref)}`);
      // 422: the branch is already gone.
      if (deleted.status !== 204 && deleted.status !== 422) {
        console.log(`::warning::#${pr.number}'s branch ${pr.head.ref} was not deleted: HTTP ${deleted.status}`);
      }
    }
    return true;
  }

  let failed = false;
  for (const pr of prs) {
    // A failed read or write stops that pull request only; the run still fails.
    try {
      if (!(await settle(pr))) failed = true;
    } catch (error) {
      console.log(`::error::#${pr.number} was not judged to the end: ${error.message}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

await main();
