import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllowedRepos, parseRepoSlug, setAllowedRepos } from "./allowlist";
import {
  assertRepoAllowed,
  createBranch,
  commitFiles,
  createOctokit,
  createPullRequest,
  getPullRequest,
  listOpenPullRequests,
  listRepoFiles,
  mergePullRequest,
  readFile,
} from "./github";
import type { Env, Props } from "./types";

// Caps how much diff text comes back per file so one huge generated file
// (lockfiles, bundles) can't blow out the response.
const MAX_PATCH_CHARS = 4000;

/**
 * Builds the MCP server for one request. The caller's own GitHub token comes
 * from the OAuth grant (props), so every GitHub call runs as that user.
 * A fresh server per request is required by the MCP SDK (see the note in the
 * original code): instances must not be shared across requests.
 */
export function createServer(env: Env, props: Props): McpServer {
  const server = new McpServer({
    name: "github-pr-mcp",
    version: "2.0.0",
  });

  const octokit = createOctokit(props.githubToken);

  // Applies the user's personal allowlist, if they've set one.
  const guard = async (owner: string, repo: string) => {
    assertRepoAllowed(owner, repo, await getAllowedRepos(env.OAUTH_KV, props.userId));
  };

  const repoArgs = {
    owner: z.string().describe("Repository owner, e.g. 'clemdevlin'"),
    repo: z.string().describe("Repository name, e.g. 'file-router'"),
  };

  server.registerTool(
    "get_allowed_repos",
    {
      description:
        "Shows the repos this user has restricted access to. If none are set, any repo the user's GitHub account can access is usable.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const allowed = await getAllowedRepos(env.OAUTH_KV, props.userId);
      const text =
        allowed === null
          ? "No restriction set: every repo your GitHub account can access is usable."
          : `Allowed repos:\n${allowed.join("\n")}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "set_allowed_repos",
    {
      description:
        "Replaces this user's allowed repos with the given owner/repo list. Only these repos can be used by the other tools. Pass an empty list to remove the restriction so every repo the GitHub account can access is usable again. GitHub still enforces the user's own permissions either way.",
      inputSchema: {
        repos: z
          .array(z.string())
          .describe("Repos as 'owner/repo' strings, e.g. ['clemdevlin/file-router']. Empty list clears the restriction."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ repos }) => {
      const validated = repos.map(parseRepoSlug);
      const saved = await setAllowedRepos(env.OAUTH_KV, props.userId, validated);
      const text =
        saved === null
          ? "Restriction removed: every repo your GitHub account can access is usable."
          : `Allowed repos set to:\n${saved.join("\n")}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "list_repo_files",
    {
      description:
        "Lists every file path in a repository at a given branch (defaults to the repo's default branch). Use this to see the project structure before reading or editing files.",
      inputSchema: {
        ...repoArgs,
        ref: z.string().optional().describe("Branch or commit SHA. Defaults to the default branch."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, repo, ref }) => {
      await guard(owner, repo);
      const files = await listRepoFiles(octokit, owner, repo, ref);
      return { content: [{ type: "text", text: files.join("\n") }] };
    },
  );

  server.registerTool(
    "read_file",
    {
      description: "Reads the full text content of a single file from a repository at a given ref.",
      inputSchema: {
        ...repoArgs,
        path: z.string().describe("File path relative to repo root, e.g. 'src/index.ts'"),
        ref: z.string().optional().describe("Branch or commit SHA. Defaults to the default branch."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, repo, path, ref }) => {
      await guard(owner, repo);
      const text = await readFile(octokit, owner, repo, path, ref);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "create_branch",
    {
      description:
        "Creates a new branch in a repository, branching off an existing base branch (defaults to the repo's default branch). Use this before committing changes for a PR.",
      inputSchema: {
        ...repoArgs,
        newBranch: z.string().describe("Name of the new branch to create, e.g. 'feat/add-cache-layer'"),
        fromBranch: z
          .string()
          .optional()
          .describe("Branch to base the new branch on. Defaults to the default branch."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, newBranch, fromBranch }) => {
      await guard(owner, repo);
      const result = await createBranch(octokit, owner, repo, newBranch, fromBranch);
      return {
        content: [{ type: "text", text: `Created branch "${result.branch}" from ${result.baseSha}` }],
      };
    },
  );

  server.registerTool(
    "commit_files",
    {
      description:
        "Commits one or more file changes (full new content per file) to an existing branch as a single atomic commit. Creates files that don't exist yet, overwrites files that do.",
      inputSchema: {
        ...repoArgs,
        branch: z.string().describe("Branch to commit to. Must already exist (use create_branch first)."),
        message: z.string().describe("Commit message"),
        files: z
          .array(
            z.object({
              path: z.string().describe("File path relative to repo root"),
              content: z.string().describe("Full new content of the file"),
            }),
          )
          .min(1)
          .describe("Files to create or overwrite in this commit"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, branch, message, files }) => {
      await guard(owner, repo);
      const result = await commitFiles(octokit, owner, repo, branch, files, message);
      return {
        content: [{ type: "text", text: `Committed ${files.length} file(s) as ${result.commitSha}` }],
      };
    },
  );

  server.registerTool(
    "create_pull_request",
    {
      description: "Opens a pull request from a head branch into a base branch.",
      inputSchema: {
        ...repoArgs,
        title: z.string().describe("PR title"),
        head: z.string().describe("Branch containing the changes (the branch you committed to)"),
        base: z.string().describe("Branch to merge into, e.g. 'main'"),
        body: z.string().optional().describe("PR description (markdown supported)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, title, head, base, body }) => {
      await guard(owner, repo);
      const pr = await createPullRequest(octokit, owner, repo, title, head, base, body);
      return { content: [{ type: "text", text: `Opened PR #${pr.number}: ${pr.url}` }] };
    },
  );

  server.registerTool(
    "list_open_pull_requests",
    {
      description: "Lists currently open pull requests for a repository.",
      inputSchema: repoArgs,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, repo }) => {
      await guard(owner, repo);
      const prs = await listOpenPullRequests(octokit, owner, repo);
      const text =
        prs.length === 0
          ? "No open pull requests."
          : prs.map((pr) => `#${pr.number} [${pr.head}] ${pr.title} - ${pr.url}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "get_pull_request",
    {
      description:
        "Fetches a pull request's metadata (title, body, state, mergeability) and the per-file diff, so it can be reviewed before merging.",
      inputSchema: {
        ...repoArgs,
        pullNumber: z.number().int().describe("Pull request number"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, repo, pullNumber }) => {
      await guard(owner, repo);
      const pr = await getPullRequest(octokit, owner, repo, pullNumber);

      const filesText = pr.files
        .map((f) => {
          const patch = f.patch
            ? f.patch.length > MAX_PATCH_CHARS
              ? f.patch.slice(0, MAX_PATCH_CHARS) + `\n... (truncated, ${f.patch.length - MAX_PATCH_CHARS} more chars)`
              : f.patch
            : "(no text diff - binary file or diff too large for GitHub to generate)";
          return `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${patch}`;
        })
        .join("\n\n");

      const summary = [
        `PR #${pr.number}: ${pr.title}`,
        `${pr.head} -> ${pr.base} | state: ${pr.state} | mergeable: ${pr.mergeable ?? "unknown"} (${pr.mergeableState})`,
        pr.url,
        "",
        pr.body || "(no description)",
        "",
        filesText,
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    },
  );

  server.registerTool(
    "merge_pull_request",
    {
      description:
        "Merges a pull request. Returns whether the merge succeeded rather than throwing when GitHub reports the PR isn't mergeable yet (e.g. failing checks or conflicts), so that case can be handled instead of surfacing as a crash.",
      inputSchema: {
        ...repoArgs,
        pullNumber: z.number().int().describe("Pull request number to merge"),
        mergeMethod: z
          .enum(["merge", "squash", "rebase"])
          .optional()
          .describe("Merge strategy. Defaults to 'merge' (a merge commit)."),
        commitTitle: z.string().optional().describe("Optional custom title for the merge commit"),
        commitMessage: z.string().optional().describe("Optional custom message for the merge commit"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ owner, repo, pullNumber, mergeMethod, commitTitle, commitMessage }) => {
      await guard(owner, repo);
      const result = await mergePullRequest(
        octokit,
        owner,
        repo,
        pullNumber,
        mergeMethod,
        commitTitle,
        commitMessage,
      );
      return {
        content: [
          {
            type: "text",
            text: result.merged
              ? `Merged PR #${pullNumber} as ${result.sha}`
              : `Not merged: ${result.message}`,
          },
        ],
        isError: !result.merged,
      };
    },
  );

  return server;
}
