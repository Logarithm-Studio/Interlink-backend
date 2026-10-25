/** Keep hosted worker callbacks on their deployment, even with a stale local tunnel setting. */
export function resolveWorkerOrigin(env: Record<string, string | undefined>): string | undefined {
  const deployment = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined;
  const production = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined;
  const base = env.VERCEL_ENV === "production"
    ? production || env.API_BASE_URL || deployment
    : env.VERCEL_ENV === "preview"
      ? deployment || env.API_BASE_URL
      : env.API_BASE_URL || deployment;
  if (!base) return undefined;
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("Worker origin must be an absolute HTTP(S) URL."); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Worker origin must be HTTPS without credentials, path, query or fragment (local HTTP is allowed).");
  }
  return url.origin;
}
