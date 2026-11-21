#!/usr/bin/env node
// Squash-merges each open pull request labelled `automerge` whose head commit is SHA once every
// check on it is green (decide.mjs), then deletes its branch. Run by merge-on-green.yml.
//
//   REPO=owner/name SHA=<head sha> [PR=<number>] REQUIRED='["Check","Test"]' SELF="Merge on green" \
//   READ_TOKEN=<token reading actions, checks and pull requests> MERGE_TOKEN=<token writing contents> \
//   node merge-on-green.mjs
//
// Waiting is not failing: a pull request whose checks still run, or which is not labelled, exits 0,
// and the next finished workflow run looks again. A red check exits 0 too, and says which; a merge
// GitHub refuses (a conflict, a head that moved) fails the run so the owner hears of it. Nothing is
// retried here: the next event is the retry.

import { decide } from "./decide.mjs";

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

/** Every item of a paginated list whose page holds its items under `key`. */
async function all(token, path, key) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await get(token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...data[key]);
    if (data[key].length < 100) return items;
  }
  throw new Error(`${path}: more than ${MAX_PAGES * 100} items`);
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
  if (!Array.isArray(required) || !required.every((name) => typeof name === "string")) {
    throw new Error("REQUIRED must be a JSON array of check names");
  }

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

  let failed = false;
  for (const pr of prs) {
    const { action, reason } = decide({ pr, sha, defaultBranch, workflowRuns, checkRuns, required, self });
    console.log(`#${pr.number} ${action}: ${reason}`);
    if (action === "red") console.log(`::warning::#${pr.number} is not merged: ${reason}.`);
    if (action !== "merge") continue;

    const merged = await request(mergeToken, "PUT", `/repos/${repo}/pulls/${pr.number}/merge`, {
      merge_method: "squash",
      sha,
      commit_title: `${pr.title} (#${pr.number})`,
    });
    if (merged.status !== 200) {
      console.log(`::error::#${pr.number} could not be merged: HTTP ${merged.status} ${merged.data?.message ?? ""}`);
      failed = true;
      continue;
    }
    console.log(`#${pr.number} merged as ${merged.data.sha}.`);
    if (pr.head.repo?.full_name === repo) {
      const ref = encodeURIComponent(pr.head.ref).replaceAll("%2F", "/");
      const deleted = await request(mergeToken, "DELETE", `/repos/${repo}/git/refs/heads/${ref}`);
      // 422: the branch is already gone.
      if (deleted.status !== 204 && deleted.status !== 422) {
        console.log(`::warning::#${pr.number}'s branch ${pr.head.ref} was not deleted: HTTP ${deleted.status}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

await main();
