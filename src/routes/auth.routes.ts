import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { google } from "googleapis";
import { authMiddleware } from "../middleware/auth";
import { storeTokens, getTokens } from "../services/auth.service";
import { createWatchChannel } from "../services/calendar/googleWatch.service";
import { getCalendarSyncQueue } from "../queues/queues";
import { JobType } from "../jobs/schemas/envelope";
import { AuthenticatedRequest } from "../types";
import { BadRequestError, UnauthorizedError } from "../utils/errors";
import { oauthRateLimit, authRateLimit } from "../middleware/rateLimit";
import {
  createOAuthState,
  consumeOAuthState,
} from "../services/oauth-state.service";
import { getSupabase } from "../config/supabase";
import {
  sendEmailVerificationCode,
  verifyEmailVerificationCode,
  validateVerificationToken,
} from "../services/emailVerification.service";

const router = Router();

// Requires read/write for Calendar and Gmail draft creation. Users must
// re-consent after scope changes to obtain tokens with the new scopes.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];

const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  "http://localhost:5000/api/v1/auth/callback/google";

const GOOGLE_OAUTH_SUCCESS_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_SUCCESS_REDIRECT_URI;
const GOOGLE_OAUTH_ERROR_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_ERROR_REDIRECT_URI;

/**
 * Build a Google OAuth2 client for the consent/callback flow.
 */
function getGoogleOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
}

function withQueryParams(
  baseUrl: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function sanitizeRedirectUri(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const parsed = new URL(input);
    const protocol = parsed.protocol;

    const isLocalHttp =
      protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");

    const isHttps = protocol === "https:";

    // Custom app links like interlinkapp://oauth/google/success
    const isCustomScheme =
      protocol !== "http:" && protocol !== "https:" && protocol.endsWith(":");

    if (!isHttps && !isLocalHttp && !isCustomScheme) {
      return undefined;
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function getCallbackErrorCode(err: unknown): string {
  if (err instanceof UnauthorizedError) {
    return "invalid_oauth_state";
  }
  if (err instanceof BadRequestError) {
    return "invalid_oauth_callback";
  }
  return "oauth_callback_failed";
}

function buildGoogleAuthUrl(stateToken: string): string {
  const oauth2Client = getGoogleOAuth2Client();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state: stateToken,
  });
}

// ─── Validation schemas for signup/login ────────────────────────────

const SignupSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  verificationToken: z.string().min(1, "Verification token is required"),
  fullName: z.string().min(1).optional(),
  contactNo: z.string().min(1).optional(),
  companyName: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
});

const LoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

const SendVerificationCodeSchema = z.object({
  email: z.string().email("Invalid email address"),
});

const VerifyVerificationCodeSchema = z.object({
  email: z.string().email("Invalid email address"),
  code: z.string().regex(/^\d{4}$/, "Verification code must be 4 digits"),
});

// ─── POST /api/v1/auth/email/send-code ──────────────────────────────────────
router.post(
  "/email/send-code",
  authRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SendVerificationCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((i) => i.message).join(", "),
        );
      }

      const { email } = parsed.data;
      const { expiresAt } = await sendEmailVerificationCode(email);

      res.status(200).json({
        message: "Verification code sent",
        email,
        expiresAt,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/auth/email/verify-code ────────────────────────────────────
router.post(
  "/email/verify-code",
  authRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = VerifyVerificationCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((i) => i.message).join(", "),
        );
      }

      const { email, code } = parsed.data;
      const verificationResult = await verifyEmailVerificationCode(email, code);

      if (!verificationResult.verified || !verificationResult.verificationToken) {
        throw new UnauthorizedError(
          verificationResult.reason === "code_expired"
            ? "Verification code has expired. Request a new one."
            : verificationResult.reason === "too_many_attempts"
              ? "Too many attempts. Request a new code."
              : "Invalid verification code",
        );
      }

      res.status(200).json({
        message: "Email verified",
        verificationToken: verificationResult.verificationToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/auth/signup ───────────────────────────────────────
// Register a new user. Proxies to Supabase Auth internally so clients
// never need to know the Supabase URL or anon key.
router.post(
  "/signup",
  authRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SignupSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((i) => i.message).join(", "),
        );
      }

      const {
        email,
        password,
        verificationToken,
        fullName,
        contactNo,
        companyName,
        address,
      } = parsed.data;

      if (!validateVerificationToken(verificationToken, email, "signup")) {
        throw new UnauthorizedError(
          "Email verification token is invalid or expired",
        );
      }

      const supabase = getSupabase();

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            fullName,
            contactNo,
            companyName,
            address,
          },
        },
      });

      if (error) {
        // Treat duplicate signup as idempotent so connection tests and retries
        // with the same email don't fail with a generic 400.
        if (error.message.toLowerCase().includes("already registered")) {
          res.status(200).json({
            message: "Account already exists. Please login.",
            user: { email },
            accountExists: true,
          });
          return;
        }
        throw new BadRequestError(error.message);
      }

      res.status(201).json({
        message: "User registered successfully",
        user: {
          id: data.user?.id,
          email: data.user?.email,
        },
        // If email confirmation is enabled, session will be null until confirmed.
        session: data.session
          ? {
              accessToken: data.session.access_token,
              refreshToken: data.session.refresh_token,
              expiresIn: data.session.expires_in,
              expiresAt: data.session.expires_at,
              tokenType: "bearer",
            }
          : null,
        confirmationRequired: !data.session,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/auth/login ────────────────────────────────────────
// Sign in with email + password. Returns a JWT for use in all other endpoints.
router.post(
  "/login",
  authRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((i) => i.message).join(", "),
        );
      }

      const { email, password } = parsed.data;
      const supabase = getSupabase();

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        throw new UnauthorizedError(error.message);
      }

      res.status(200).json({
        message: "Login successful",
        user: {
          id: data.user.id,
          email: data.user.email,
        },
        session: {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresIn: data.session.expires_in,
          expiresAt: data.session.expires_at,
          tokenType: "bearer",
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/auth/refresh-token ────────────────────────────────
// Exchange a refresh token for a new access token.
router.post(
  "/refresh-token",
  authRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RefreshTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((i) => i.message).join(", "),
        );
      }

      const { refreshToken } = parsed.data;
      const supabase = getSupabase();

      const { data, error } = await supabase.auth.refreshSession({
        refresh_token: refreshToken,
      });

      if (error || !data.session) {
        throw new UnauthorizedError(
          error?.message ?? "Failed to refresh session",
        );
      }

      res.status(200).json({
        message: "Token refreshed",
        session: {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresIn: data.session.expires_in,
          expiresAt: data.session.expires_at,
          tokenType: "bearer",
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/auth/google/start ────────────────────────────────
// Mobile-friendly endpoint. Returns the Google OAuth URL as JSON so Android
// can open it in a Custom Tab/browser.
router.get(
  "/google/start",
  oauthRateLimit,
  authMiddleware as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const successRedirectUri = sanitizeRedirectUri(
        req.query.successRedirectUri as string | undefined,
      );
      const errorRedirectUri = sanitizeRedirectUri(
        req.query.errorRedirectUri as string | undefined,
      );

      const stateToken = await createOAuthState(user.id, "google", {
        successRedirectUri,
        errorRedirectUri,
      });

      res.status(200).json({
        provider: "google",
        authUrl: buildGoogleAuthUrl(stateToken),
        stateTtlSeconds: 600,
        successRedirectUri,
        errorRedirectUri,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/auth/google ────────────────────────────────────────
// Authenticated redirect to Google's OAuth consent screen.
// The caller must present a valid Supabase JWT in the Authorization header.
// A random opaque state token is generated and stored in Redis (10 min TTL).
// The OAuth `state` parameter carries only this opaque token — no JWT in URL.
router.get(
  "/google",
  oauthRateLimit,
  authMiddleware as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const stateToken = await createOAuthState(user.id, "google");
      const authUrl = buildGoogleAuthUrl(stateToken);
      res.redirect(authUrl);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/auth/callback/google ───────────────────────────────
// Google redirects here. Exchanges the code for tokens and stores them.
// The `state` param is the opaque token from createOAuthState(); it is
// consumed atomically (single-use) and never contains a bearer credential.
router.get(
  "/callback/google",
  oauthRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    let callbackErrorRedirectUri = GOOGLE_OAUTH_ERROR_REDIRECT_URI;

    try {
      const code = req.query.code as string;
      const stateToken = req.query.state as string;

      if (!code || !stateToken) {
        throw new BadRequestError("Missing code or state from Google callback");
      }

      // Consume the state token — fails if expired, replayed, or forged.
      const statePayload = await consumeOAuthState(stateToken);
      if (!statePayload) {
        throw new UnauthorizedError(
          "Invalid, expired, or already-used OAuth state token",
        );
      }

      const userId = statePayload.userId;
      const successRedirectUri =
        statePayload.successRedirectUri ?? GOOGLE_OAUTH_SUCCESS_REDIRECT_URI;
      const errorRedirectUri =
        statePayload.errorRedirectUri ?? GOOGLE_OAUTH_ERROR_REDIRECT_URI;
      callbackErrorRedirectUri = errorRedirectUri;

      // Exchange the authorization code for tokens
      const oauth2Client = getGoogleOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.access_token || !tokens.refresh_token) {
        throw new BadRequestError(
          "Google did not return required tokens. Try re-authorizing with prompt=consent.",
        );
      }

      const expiresAt = tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : new Date(Date.now() + 3600 * 1000);

      await storeTokens(userId, "google", {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
      });

      // Trigger the first import immediately after account connection.
      const initialSyncJobId = `google-sync-initial|${userId}|${Date.now()}`;
      await getCalendarSyncQueue().add(
        JobType.GOOGLE_SYNC,
        {
          jobType: JobType.GOOGLE_SYNC,
          requestId: randomUUID(),
          idempotencyKey: initialSyncJobId,
          userId,
          payload: {},
        },
        {
          jobId: initialSyncJobId,
          attempts: 8,
          backoff: { type: "calendar_exp" as "exponential", delay: 30_000 },
        },
      );

      let watchChannelCreated = false;
      if (process.env.GOOGLE_WEBHOOK_URL) {
        try {
          await createWatchChannel(userId, "primary");
          watchChannelCreated = true;
        } catch (watchErr) {
          console.warn(
            `[auth/google callback] watch channel setup failed for user ${userId}: ${String(watchErr)}`,
          );
        }
      }

      const successPayload = {
        message: "Google Calendar connected successfully",
        provider: "google",
        initialSyncTriggered: true,
        watchChannelCreated,
      };

      if (successRedirectUri) {
        return res.redirect(
          302,
          withQueryParams(successRedirectUri, {
            provider: "google",
            status: "success",
          }),
        );
      }

      res.status(200).json(successPayload);
    } catch (err) {
      if (callbackErrorRedirectUri) {
        return res.redirect(
          302,
          withQueryParams(callbackErrorRedirectUri, {
            provider: "google",
            status: "error",
            code: getCallbackErrorCode(err),
          }),
        );
      }
      next(err);
    }
  },
);

// ─── GET /api/v1/auth/me ────────────────────────────────────────────
// Returns the current user's info and connected accounts.
router.get(
  "/me",
  authMiddleware as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const googleAccount = await getTokens(user.id, "google");

      res.json({
        user: {
          id: user.id,
          email: user.email,
        },
        connectedAccounts: {
          google: googleAccount
            ? {
                connected: true,
                expiresAt: googleAccount.expiresAt,
                reauthRequired: googleAccount.reauthRequired ?? false,
              }
            : { connected: false, expiresAt: null, reauthRequired: false },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
