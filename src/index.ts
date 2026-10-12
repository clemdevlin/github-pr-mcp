import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { handleAuthRoutes } from "./auth";
import { createServer } from "./mcp-server";
import type { Env, Props } from "./types";

/**
 * Handles MCP requests. OAuthProvider only calls this after a valid token,
 * and passes the grant's props (including the user's GitHub token) as ctx.props.
 */
const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }) {
    const server = createServer(env, ctx.props);
    return createMcpHandler(server)(request, env, ctx);
  },
};

/**
 * Built per request so the resource URL matches the origin the request came
 * in on. This keeps the OAuth audience correct without hard-coding a subdomain.
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const origin = new URL(request.url).origin;
    const provider = new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: mcpApiHandler as any,
      defaultHandler: {
        fetch: (req: Request, e: Env) => handleAuthRoutes(req, e),
      } as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["mcp:access"],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      },
    });
    return provider.fetch(request, env, ctx);
  },
};
