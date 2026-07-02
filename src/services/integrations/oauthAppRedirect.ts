/**
 * Deep link the browser is sent to after a backend-mediated OAuth exchange
 * completes. Used by providers that require an https redirect_uri (GitHub,
 * Notion, Jira) and therefore cannot redirect straight to the app's custom
 * scheme — the provider redirects to our https callback, we exchange the code,
 * then bounce the browser back into the app via this URL.
 */
export function appRedirect(
  provider: string,
  status: "success" | "error",
  detail?: string,
): string {
  const base = `interlinkapp://oauth/${provider}`;
  const params = new URLSearchParams({ provider, status, ...(detail ? { detail } : {}) });
  return `${base}?${params}`;
}
