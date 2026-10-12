import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** KV namespace used by the OAuth library and for per-user repo allowlists. */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider; used to complete authorizations. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** GitHub OAuth App client ID (from github.com/settings/developers). */
  GITHUB_CLIENT_ID: string;
  /** GitHub OAuth App client secret. Set with `wrangler secret put`. */
  GITHUB_CLIENT_SECRET: string;
}

/**
 * Stored encrypted inside each grant by the OAuth library and exposed to the
 * MCP handler as ctx.props. Never sent to the client.
 */
export interface Props extends Record<string, unknown> {
  /** GitHub numeric user ID as a string. Stable, used as the grant's userId. */
  userId: string;
  /** GitHub login, for display. */
  login: string;
  /** The user's own GitHub OAuth access token. */
  githubToken: string;
}
