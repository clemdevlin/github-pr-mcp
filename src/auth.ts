/**
 * Browser-facing routes: the consent page, the GitHub sign-in round trip, and
 * the callback. Built on the OAuth provider's consent and upstream helpers.
 * See node_modules/@cloudflare/workers-oauth-provider/docs/upstream-sign-in.md.
 */
import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { Octokit } from "@octokit/rest";
import type { Env, Props } from "./types";

const GITHUB_SCOPES = "repo read:user";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope
    .map((scope) => `<div>${escapeHtml(scope)}</div>`)
    .join("");
  const loopbackWarning = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize ${name}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 540px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">
  <h1>Allow ${name} to use GitHub PR MCP?</h1>
  <p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
  ${loopbackWarning}
  <p>Next you will sign in with GitHub. The app will be able to read and write repositories your GitHub account can access, within the limits of the scopes below:</p>
  <div>${scopes}</div>
  <form method="post" style="margin-top: 2rem">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <button name="decision" value="approve" style="padding: .6rem 1.2rem">Continue to GitHub</button>
    <button name="decision" value="deny" style="padding: .6rem 1.2rem">Deny</button>
  </form>
</body>
</html>`;
}

function htmlResponse(body: string, headers: Headers, status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
}

function plainError(message: string, status = 400): Response {
  return new Response(escapeHtml(message), {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function githubAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", GITHUB_SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function exchangeGithubCode(env: Env, code: string, verifier: string, redirectUri: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error_description ?? data.error ?? "unknown error"}`);
  }
  return data.access_token;
}

export async function handleAuthRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;

  try {
    // Step 1: the MCP client sent the user here. Show the consent page.
    if (request.method === "GET" && url.pathname === "/authorize") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return htmlResponse(consentPage(details, consent.handle), consent.headers);
    }

    // Step 2: the user answered the consent page.
    if (request.method === "POST" && url.pathname === "/authorize") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");

      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        denied.headers.set("Location", denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const approved = await oauth.approveConsent(request, handle);
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const redirectUri = new URL("/callback", url.origin).href;
      const upstream = await oauth.beginUpstream(approved.request, {
        data: { verifier },
        headers: approved.headers,
      });
      const location = githubAuthorizeUrl({
        clientId: env.GITHUB_CLIENT_ID,
        redirectUri,
        state: upstream.state,
        codeChallenge: await s256(verifier),
      });
      upstream.headers.set("Location", location);
      return new Response(null, { status: 302, headers: upstream.headers });
    }

    // Step 3: GitHub sent the user back. Finish the MCP authorization.
    if (request.method === "GET" && url.pathname === "/callback") {
      const resumed = await oauth.finishUpstream<{ verifier: string }>(request);

      if (url.searchParams.get("error")) {
        resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
        return new Response(null, { status: 302, headers: resumed.headers });
      }

      const code = url.searchParams.get("code");
      if (!code) return plainError("Missing authorization code from GitHub.");

      const githubToken = await exchangeGithubCode(
        env,
        code,
        resumed.data.verifier,
        new URL("/callback", url.origin).href,
      );
      const { data: user } = await new Octokit({ auth: githubToken }).users.getAuthenticated();

      const props: Props = {
        userId: String(user.id),
        login: user.login,
        githubToken,
      };

      const { redirectTo } = await oauth.completeAuthorization({
        request: resumed.request,
        userId: String(user.id),
        metadata: { label: user.name ?? user.login },
        scope: resumed.request.scope,
        props,
      });
      resumed.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: resumed.headers });
    }

    return plainError("Not found", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return plainError(error.description, 400);
    }
    if (error instanceof CimdFetchError) {
      return plainError("This app could not be verified.", 400);
    }
    console.error("auth route error:", error);
    return plainError("Internal server error", 500);
  }
}
