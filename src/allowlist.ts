/**
 * Per-user repo allowlists, stored in the OAUTH_KV namespace.
 *
 * - No entry (null): the user has not set a restriction, so any repo their
 *   GitHub account can access is usable. GitHub still enforces access itself.
 * - An entry: only the listed owner/repo slugs are usable, even if GitHub
 *   would allow more.
 */

const SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REPOS = 200;

function key(userId: string): string {
  return `app:repo-allowlist:${userId}`;
}

export function parseRepoSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!SLUG_PATTERN.test(trimmed)) {
    throw new Error(`"${slug}" is not a valid owner/repo slug.`);
  }
  return trimmed;
}

export async function getAllowedRepos(kv: KVNamespace, userId: string): Promise<string[] | null> {
  const raw = await kv.get(key(userId));
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as string[]) : null;
}

/** Sets the user's allowlist. An empty array removes the restriction entirely. */
export async function setAllowedRepos(
  kv: KVNamespace,
  userId: string,
  repos: string[],
): Promise<string[] | null> {
  if (repos.length === 0) {
    await kv.delete(key(userId));
    return null;
  }
  if (repos.length > MAX_REPOS) {
    throw new Error(`An allowlist can have at most ${MAX_REPOS} repos.`);
  }
  const normalized = Array.from(new Set(repos.map(parseRepoSlug)));
  await kv.put(key(userId), JSON.stringify(normalized));
  return normalized;
}
