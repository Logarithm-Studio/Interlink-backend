export function resolveMarketingPublicBase(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const configured = explicit || (vercel ? `https://${vercel.replace(/^https?:\/\//i, "")}` : env.API_BASE_URL?.trim());
  if (!configured) return null;
  try {
    const base = new URL(configured);
    if (!(["https:", "http:"].includes(base.protocol)) || base.username || base.password) return null;
    if (base.protocol !== "https:" && env.NODE_ENV === "production") return null;
    return base.origin;
  } catch { return null; }
}

export function buildMarketingActivationTrackedUrl(base: string, token: string): string {
  return new URL(`/api/v1/marketing/activation-visit/${encodeURIComponent(token)}`, base).toString();
}

/** Accept only plain web destinations saved by the marketer; this route never redirects from request input. */
export function safeActivationRedirectTarget(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    if (!(["https:", "http:"].includes(target.protocol)) || target.username || target.password) return null;
    return target.toString();
  } catch { return null; }
}
