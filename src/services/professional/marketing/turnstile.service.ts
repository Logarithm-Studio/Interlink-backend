import { AppError, BadRequestError } from "../../../utils/errors";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_MAX_LENGTH = 2048;
const VERIFY_TIMEOUT_MS = 5000;

export interface MarketingTurnstileConfig {
  enabled: boolean;
  misconfigured: boolean;
  siteKey: string | null;
  secretKey: string | null;
}

export function getMarketingTurnstileConfig(
  env: Record<string, string | undefined> = process.env,
): MarketingTurnstileConfig {
  const siteKey = env.MARKETING_TURNSTILE_SITE_KEY?.trim() || null;
  const secretKey = env.MARKETING_TURNSTILE_SECRET_KEY?.trim() || null;
  const enabled = Boolean(siteKey && secretKey);
  return { enabled, misconfigured: Boolean(siteKey || secretKey) && !enabled, siteKey, secretKey };
}

/** Validate the optional hosted-form challenge. The visitor IP and form data are not sent to Cloudflare. */
export async function validateMarketingTurnstile(
  token: string | undefined,
  expectedHostname: string,
  config: MarketingTurnstileConfig = getMarketingTurnstileConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (config.misconfigured) throw new AppError("Lead form verification is temporarily unavailable.", 503);
  if (!config.enabled) return;
  if (!config.secretKey || !token?.trim() || token.length > TOKEN_MAX_LENGTH) {
    throw new BadRequestError("Complete the anti-spam verification and try again.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.secretKey, response: token }),
      signal: controller.signal,
    });
    if (!response.ok) throw new AppError("Lead form verification is temporarily unavailable.", 503);
    const result = await response.json() as { success?: unknown; hostname?: unknown };
    if (result.success !== true || typeof result.hostname !== "string" ||
        result.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      throw new BadRequestError("Anti-spam verification expired or failed. Please try again.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Lead form verification is temporarily unavailable.", 503);
  } finally {
    clearTimeout(timeoutId);
  }
}
