import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertRepoAllowed,
  createOctokit,
  listRepoFiles,
  readFile,
  createBranch,
  commitFiles,
  createPullRequest,
  listOpenPullRequests,
  getPullRequest,
  mergePullRequest,
} from "./github";

interface Env {
  GITHUB_TOKEN: string;
  ALLOWED_REPOS: string;
}

// Caps how much diff text comes back per file so one huge generated file
// (lockfiles, bundles) can't blow out the response.
const MAX_PATCH_CHARS = 4000;

// MCP SDK 1.26+ forbids reusing a server/transport instance across requests
// (it throws to prevent cross-client response leakage), so build a fresh
// McpServer per request instead of declaring it at module scope.
function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "github-pr-mcp",
    version: "1.0.0",
  });

  const octokit = createOctokit(env.GITHUB_TOKEN);

  const repoArgs = {
    owner: z.string().describe("Repository owner, e.g. 'clemdevlin'"),
    repo: z.string().describe("Repository name, e.g. 'file-router'"),
  };

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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const files = await listRepoFiles(octokit, owner, repo, ref);
      return {
        content: [{ type: "text", text: files.join("\n") }],
      };
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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const text = await readFile(octokit, owner, repo, path, ref);
      return {
        content: [{ type: "text", text }],
      };
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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const pr = await createPullRequest(octokit, owner, repo, title, head, base, body);
      return {
        content: [{ type: "text", text: `Opened PR #${pr.number}: ${pr.url}` }],
      };
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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const prs = await listOpenPullRequests(octokit, owner, repo);
      const text =
        prs.length === 0
          ? "No open pull requests."
          : prs.map((pr) => `#${pr.number} [${pr.head}] ${pr.title} - ${pr.url}`).join("\n");
      return {
        content: [{ type: "text", text }],
      };
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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
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

      return {
        content: [{ type: "text", text: summary }],
      };
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
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
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

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const server = createServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
