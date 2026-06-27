import { Octokit } from "@octokit/rest";

export interface FileChange {
  /** Path relative to repo root, e.g. "src/router.ts" */
  path: string;
  /** New full content of the file (UTF-8 text) */
  content: string;
}

export class RepoNotAllowedError extends Error {
  constructor(repoSlug: string) {
    super(
      `Repo "${repoSlug}" is not in ALLOWED_REPOS. Add it to wrangler.jsonc and redeploy if this is intentional.`,
    );
    this.name = "RepoNotAllowedError";
  }
}

/** Throws if owner/repo isn't explicitly allowlisted via the ALLOWED_REPOS env var. */
export function assertRepoAllowed(
  owner: string,
  repo: string,
  allowedReposCsv: string,
): void {
  const slug = `${owner}/${repo}`;
  const allowed = allowedReposCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(slug)) {
    throw new RepoNotAllowedError(slug);
  }
}

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

/** Returns a flat list of file paths in the repo at the given ref (default branch if omitted). */
export async function listRepoFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<string[]> {
  const repoInfo = await octokit.repos.get({ owner, repo });
  const branch = ref ?? repoInfo.data.default_branch;

  const branchInfo = await octokit.repos.getBranch({ owner, repo, branch });
  const treeSha = branchInfo.data.commit.sha;

  const tree = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "true",
  });

  return tree.data.tree
    .filter((entry) => entry.type === "blob" && entry.path)
    .map((entry) => entry.path as string);
}

/** Reads a single file's text content at a given ref (default branch if omitted). */
export async function readFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  const response = await octokit.repos.getContent({ owner, repo, path, ref });

  if (Array.isArray(response.data) || response.data.type !== "file") {
    throw new Error(`"${path}" is not a file (it's a directory or symlink).`);
  }
  if (!response.data.content) {
    throw new Error(`"${path}" has no content (might be too large for the Contents API).`);
  }

  return Buffer.from(response.data.content, "base64").toString("utf-8");
}

/** Creates a new branch from the tip of an existing base branch (defaults to the repo's default branch). */
export async function createBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  newBranch: string,
  fromBranch?: string,
): Promise<{ branch: string; baseSha: string }> {
  const repoInfo = await octokit.repos.get({ owner, repo });
  const base = fromBranch ?? repoInfo.data.default_branch;

  const baseRef = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  const baseSha = baseRef.data.object.sha;

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${newBranch}`,
    sha: baseSha,
  });

  return { branch: newBranch, baseSha };
}

/**
 * Commits one or more file changes to a branch as a single atomic commit,
 * using the low-level Git Data API (blobs -> tree -> commit -> ref update)
 * rather than the Contents API, so multiple files land in one commit instead of one-per-file.
 */
export async function commitFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  files: FileChange[],
  message: string,
): Promise<{ commitSha: string }> {
  if (files.length === 0) {
    throw new Error("commitFiles called with an empty file list.");
  }

  const branchRef = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const parentCommitSha = branchRef.data.object.sha;

  const parentCommit = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: parentCommitSha,
  });
  const baseTreeSha = parentCommit.data.tree.sha;

  const blobs = await Promise.all(
    files.map(async (file) => {
      const blob = await octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content, "utf-8").toString("base64"),
        encoding: "base64",
      });
      return { path: file.path, sha: blob.data.sha };
    }),
  );

  const newTree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: blobs.map((b) => ({
      path: b.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: b.sha,
    })),
  });

  const newCommit = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.data.sha,
    parents: [parentCommitSha],
  });

  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.data.sha,
  });

  return { commitSha: newCommit.data.sha };
}

export async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string,
): Promise<{ number: number; url: string }> {
  const pr = await octokit.pulls.create({
    owner,
    repo,
    title,
    head,
    base,
    body,
  });

  return { number: pr.data.number, url: pr.data.html_url };
}

export async function listOpenPullRequests(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<{ number: number; title: string; head: string; url: string }[]> {
  const prs = await octokit.pulls.list({ owner, repo, state: "open" });
  return prs.data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    head: pr.head.ref,
    url: pr.html_url,
  }));
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff for this file. Undefined for binary files or files GitHub didn't generate a patch for. */
  patch?: string;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  head: string;
  base: string;
  mergeable: boolean | null;
  mergeableState: string;
  files: PullRequestFile[];
}

/** Fetches PR metadata plus the per-file diff, so a PR can be reviewed before merging. */
export async function getPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDetails> {
  const pr = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  const files = await octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber });

  return {
    number: pr.data.number,
    title: pr.data.title,
    body: pr.data.body ?? "",
    state: pr.data.state,
    url: pr.data.html_url,
    head: pr.data.head.ref,
    base: pr.data.base.ref,
    mergeable: pr.data.mergeable,
    mergeableState: pr.data.mergeable_state ?? "unknown",
    files: files.data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** Merges a pull request. Surfaces GitHub's "not mergeable yet" responses as a normal result rather than throwing, since that's an expected outcome (e.g. failing checks, conflicts) rather than a bug. */
export async function mergePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: MergeMethod = "merge",
  commitTitle?: string,
  commitMessage?: string,
): Promise<{ merged: boolean; sha?: string; message: string }> {
  try {
    const result = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: mergeMethod,
      commit_title: commitTitle,
      commit_message: commitMessage,
    });
    return { merged: result.data.merged, sha: result.data.sha, message: result.data.message };
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 405 || e.status === 409) {
      // Not mergeable (failing checks, conflicts, etc.) or merge conflict - expected, not a crash.
      return { merged: false, message: e.message ?? "Pull request is not currently mergeable." };
    }
    throw err;
  }
}
