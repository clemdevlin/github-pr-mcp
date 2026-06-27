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
} from "./github";

interface Env {
  GITHUB_TOKEN: string;
  ALLOWED_REPOS: string;
}

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

  server.tool(
    "list_repo_files",
    "Lists every file path in a repository at a given branch (defaults to the repo's default branch). Use this to see the project structure before reading or editing files.",
    {
      ...repoArgs,
      ref: z.string().optional().describe("Branch or commit SHA. Defaults to the default branch."),
    },
    async ({ owner, repo, ref }) => {
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const files = await listRepoFiles(octokit, owner, repo, ref);
      return {
        content: [{ type: "text", text: files.join("\n") }],
      };
    },
  );

  server.tool(
    "read_file",
    "Reads the full text content of a single file from a repository at a given ref.",
    {
      ...repoArgs,
      path: z.string().describe("File path relative to repo root, e.g. 'src/index.ts'"),
      ref: z.string().optional().describe("Branch or commit SHA. Defaults to the default branch."),
    },
    async ({ owner, repo, path, ref }) => {
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const text = await readFile(octokit, owner, repo, path, ref);
      return {
        content: [{ type: "text", text }],
      };
    },
  );

  server.tool(
    "create_branch",
    "Creates a new branch in a repository, branching off an existing base branch (defaults to the repo's default branch). Use this before committing changes for a PR.",
    {
      ...repoArgs,
      newBranch: z.string().describe("Name of the new branch to create, e.g. 'feat/add-cache-layer'"),
      fromBranch: z.string().optional().describe("Branch to base the new branch on. Defaults to the default branch."),
    },
    async ({ owner, repo, newBranch, fromBranch }) => {
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const result = await createBranch(octokit, owner, repo, newBranch, fromBranch);
      return {
        content: [{ type: "text", text: `Created branch "${result.branch}" from ${result.baseSha}` }],
      };
    },
  );

  server.tool(
    "commit_files",
    "Commits one or more file changes (full new content per file) to an existing branch as a single atomic commit. Creates files that don't exist yet, overwrites files that do.",
    {
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
    async ({ owner, repo, branch, message, files }) => {
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const result = await commitFiles(octokit, owner, repo, branch, files, message);
      return {
        content: [{ type: "text", text: `Committed ${files.length} file(s) as ${result.commitSha}` }],
      };
    },
  );

  server.tool(
    "create_pull_request",
    "Opens a pull request from a head branch into a base branch.",
    {
      ...repoArgs,
      title: z.string().describe("PR title"),
      head: z.string().describe("Branch containing the changes (the branch you committed to)"),
      base: z.string().describe("Branch to merge into, e.g. 'main'"),
      body: z.string().optional().describe("PR description (markdown supported)"),
    },
    async ({ owner, repo, title, head, base, body }) => {
      assertRepoAllowed(owner, repo, env.ALLOWED_REPOS);
      const pr = await createPullRequest(octokit, owner, repo, title, head, base, body);
      return {
        content: [{ type: "text", text: `Opened PR #${pr.number}: ${pr.url}` }],
      };
    },
  );

  server.tool(
    "list_open_pull_requests",
    "Lists currently open pull requests for a repository.",
    repoArgs,
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

  return server;
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const server = createServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
