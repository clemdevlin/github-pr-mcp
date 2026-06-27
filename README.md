# github-pr-mcp

A small, personal remote MCP server that gives an LLM client (Claude on claude.ai,
in this case) scoped GitHub read/write access — list files, read files, create
branches, commit files, open PRs — **without ever putting your GitHub token in
chat or in any client config.**

The token lives as an encrypted secret on Cloudflare's side. The server is
**authless** (no login required to call it), so the only thing standing between
"anyone with the URL" and your repos is:

1. The URL itself isn't public anywhere (don't commit it to a public repo, don't
   paste it into a chat that gets shared).
2. `ALLOWED_REPOS` in `wrangler.jsonc` — every tool call checks the target repo
   against this allowlist and refuses anything not explicitly listed.
3. Scope your GitHub PAT tightly (ideally a fine-grained PAT limited to just the
   repos you list in `ALLOWED_REPOS`, with only Contents + Pull requests
   read/write permissions).

If you want this to be more bulletproof later, Cloudflare Access / OAuth can be
layered on top — see the "Going further" section at the bottom. For one person
using this against their own repos, the above is a reasonable bar.

## What's here

```
src/
  github.ts   - all the actual GitHub API logic (Octokit), repo-allowlist guard
  index.ts    - MCP tool definitions, wires tools to github.ts
wrangler.jsonc - Worker config + ALLOWED_REPOS
package.json
tsconfig.json
```

Tools exposed: `list_repo_files`, `read_file`, `create_branch`, `commit_files`,
`create_pull_request`, `list_open_pull_requests`.

## 1. Create a scoped GitHub token

Go to **github.com/settings/personal-access-tokens/new** (fine-grained PAT, not
classic):

- **Repository access**: "Only select repositories" → pick the repos you want
  this server to touch (e.g. `file-router`).
- **Permissions**: Repository permissions →
  - Contents: Read and write
  - Pull requests: Read and write
  - Metadata: Read-only (required, auto-selected)
- Set an expiration you're comfortable with (90 days is reasonable; you'll
  rotate it via `wrangler secret put` when it expires, no redeploy needed).
- Copy the token — you won't see it again.

## 2. Install dependencies

```powershell
cd github-pr-mcp
npm install
```

## 3. Set ALLOWED_REPOS

Edit `wrangler.jsonc`, update the `vars.ALLOWED_REPOS` value to a comma-separated
list of `owner/repo` you want this server allowed to touch:

```jsonc
"vars": {
  "ALLOWED_REPOS": "clemdevlin/file-router,clemdevlin/uploadkit"
}
```

## 4. Test locally first

```powershell
npm run dev
```

In a separate terminal:

```powershell
npx @modelcontextprotocol/inspector@latest
```

The inspector opens in your browser. For local testing it needs your token —
create a `.env` file in the project root with:

```
GITHUB_TOKEN=ghp_your_token_here
```

`wrangler dev` reads `.env` automatically for local runs. Point the inspector at
`http://localhost:8787/mcp`, hit **Connect**, then **List Tools** — you should
see all six tools. Try `list_repo_files` against one of your allowlisted repos
to confirm it actually talks to GitHub.

## 5. Set the real secret and deploy

The token never goes in `wrangler.jsonc` or any committed file — only as an
encrypted Cloudflare secret:

```powershell
npx wrangler login
npm run secret:put-token
# paste your PAT when prompted
npm run deploy
```

Wrangler will print your live URL, something like:

```
https://github-pr-mcp.<your-subdomain>.workers.dev/mcp
```

That `/mcp` URL is what you'll give to claude.ai.

## 6. Connect it in claude.ai

1. Go to **Settings → Connectors → Add custom connector**.
2. Paste in the Worker URL from step 5.
3. Leave the OAuth Client ID/Secret fields blank (this server doesn't require
   them) and save.
4. In any chat, enable it via the tools/"+" menu, and Claude should be able to
   search for and call the six tools above.

## Rotating or revoking access

- **Rotate the token**: generate a new fine-grained PAT, run
  `npm run secret:put-token` again with the new value. No redeploy needed.
- **Revoke everything immediately**: delete the PAT on GitHub, or run
  `npx wrangler delete` to tear down the Worker entirely.
- **Change which repos are reachable**: edit `ALLOWED_REPOS` in
  `wrangler.jsonc`, then `npm run deploy`.

## Going further (optional)

If you ever want real per-request authentication instead of "obscure URL +
repo allowlist," Cloudflare's `remote-mcp-github-oauth` template wraps this
same pattern in a GitHub OAuth login flow, so the *connector itself* requires
you to sign in before any tool call goes through. That needs a registered
GitHub OAuth App and a KV namespace for token storage — more moving parts,
not necessary unless this server's reach grows beyond "tools I personally use
against my own repos."
