# github-pr-mcp

A remote MCP server that gives an LLM client (such as Claude on claude.ai) GitHub
read/write access through **each user's own GitHub account**.

- Anyone can connect. Each person signs in with GitHub and the server uses their
  token, so they can only reach repos their own account can access.
- No shared GitHub token is stored on the server. Tokens live inside encrypted
  OAuth grants managed by `@cloudflare/workers-oauth-provider`.
- Each user can optionally restrict the tools to a list of repos they choose.

## Tools

| Tool | What it does |
| --- | --- |
| `get_allowed_repos` | Shows the user's repo restriction, if any |
| `set_allowed_repos` | Sets the user's allowed repos (an empty list removes the restriction) |
| `list_repo_files` | Lists file paths in a repo at a branch or commit |
| `read_file` | Reads one file |
| `create_branch` | Creates a branch from an existing branch |
| `commit_files` | Commits one or more files to a branch as one commit |
| `create_pull_request` | Opens a PR |
| `list_open_pull_requests` | Lists open PRs |
| `get_pull_request` | Shows PR details and per-file diffs |
| `merge_pull_request` | Merges a PR (merge, squash, or rebase) |

## How access works

1. The user adds the server URL as a custom connector in claude.ai.
2. The client sends them to a consent page on this server. They approve it.
3. They sign in with GitHub and grant the `repo` and `read:user` scopes.
4. Every tool call runs with their GitHub token. GitHub decides what they can
   touch.
5. If the user has set an allowlist, the tools also refuse any repo not on it.

The `repo` scope covers every repo the user can access, including private
ones. GitHub OAuth Apps can't limit that to chosen repos. If you need
per-repo control enforced by GitHub, use a GitHub App instead.

## Setup (for the person deploying this server)

### 1. Register a GitHub OAuth App

Go to **github.com/settings/developers → OAuth Apps → New OAuth App**.

- **Homepage URL**: `https://github-pr-mcp.<your-subdomain>.workers.dev`
- **Authorization callback URL**: `https://github-pr-mcp.<your-subdomain>.workers.dev/callback`

Copy the **Client ID** and generate a **Client secret**.

### 2. Install dependencies

```bash
npm install
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Paste the returned `id` into `wrangler.jsonc` in place of
`<replace-with-OAUTH_KV-namespace-id>`.

### 4. Set the secrets and deploy

```bash
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npm run deploy
```

The MCP endpoint is `https://github-pr-mcp.<your-subdomain>.workers.dev/mcp`.

### 5. Connect it in claude.ai

1. Go to **Settings → Connectors → Add custom connector**.
2. Paste the `/mcp` URL and save.
3. Enable the connector in a chat. You'll be asked to approve access and sign in
   with GitHub.

## Local development

Create `.dev.vars` from `.dev.vars.example`, filling in your OAuth App's
credentials, and then run:

```bash
npm run dev
```

The local URL is `http://localhost:8787/mcp`. Note that the GitHub OAuth App's
callback must include the local URL (`http://localhost:8787/callback`) for
sign-in to work locally. You can add it as a second callback URL, or use a
separate OAuth App for development.

## Managing access

- **Restrict repos for yourself**: ask the assistant to call `set_allowed_repos`,
  for example with `["owner/repo"]`. Call it with `[]` to remove the restriction.
- **Revoke this server's access**: remove the app under GitHub **Settings →
  Applications → Authorized OAuth Apps**.
- **Rotate the OAuth secret**: generate a new client secret on GitHub, then run
  `npx wrangler secret put GITHUB_CLIENT_SECRET`. No redeploy is needed.

## Project layout

```
src/
  index.ts        OAuth provider setup and the MCP endpoint
  auth.ts         Consent page, GitHub sign-in, and callback
  mcp-server.ts   MCP tool definitions (one server per request)
  github.ts       GitHub API calls and the allowlist check
  allowlist.ts    Per-user repo allowlists stored in KV
  types.ts        Shared types
wrangler.jsonc    Worker config and KV binding
```
