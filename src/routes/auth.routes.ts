import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { google } from "googleapis";
import { authMiddleware } from "../middleware/auth";
import { storeTokens, getTokens, deleteTokens } from "../services/auth.service";
import {
  createWatchChannel,
  stopAllWatchChannelsForUser,
} from "../services/calendar/googleWatch.service";
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

const GOOGLE_OAUTH_SUCCESS_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_SUCCESS_REDIRECT_URI;
const GOOGLE_OAUTH_ERROR_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_ERROR_REDIRECT_URI;

function normalizeAbsoluteHttpsOrLocalhostUri(input: string): string | undefined {
  try {
    const parsed = new URL(input.trim());
    const protocol = parsed.protocol;

    const isLocalHttp =
      protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    const isHttps = protocol === "https:";

    if (!isHttps && !isLocalHttp) {
      return undefined;
    }

    // Guard against accidental duplicate path separators in env values.
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function getGoogleRedirectUri(): string {
  const rawRedirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();

  if (!rawRedirectUri) {
    throw new Error(
      "GOOGLE_REDIRECT_URI must be set (for mobile dev use your public HTTPS callback URL).",
    );
  }

  const redirectUri = normalizeAbsoluteHttpsOrLocalhostUri(rawRedirectUri);
  if (!redirectUri) {
    throw new Error(
      "GOOGLE_REDIRECT_URI must be a valid HTTPS URL (or http://localhost for local dev).",
    );
  }

  if (redirectUri !== rawRedirectUri) {
    console.warn(
      `GOOGLE_REDIRECT_URI normalized from "${rawRedirectUri}" to "${redirectUri}". Update your environment variable to the normalized value to avoid OAuth mismatches.`,
    );
  }

  return redirectUri;
}

/**
 * Build a Google OAuth2 client for the consent/callback flow.
 */
function getGoogleOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getGoogleRedirectUri(),
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildSessionPayload(session: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
}) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    expiresAt: session.expires_at,
    tokenType: "bearer",
  };
}

function buildSignupUserMetadata(payload: {
  fullName?: string;
  contactNo?: string;
  companyName?: string;
  address?: string;
}): Record<string, string> {
  const metadata: Record<string, string> = {};

  if (payload.fullName) {
    metadata.fullName = payload.fullName;
  }
  if (payload.contactNo) {
    metadata.contactNo = payload.contactNo;
  }
  if (payload.companyName) {
    metadata.companyName = payload.companyName;
  }
  if (payload.address) {
    metadata.address = payload.address;
  }

  return metadata;
}

async function findSupabaseUserIdByEmail(
  supabase: ReturnType<typeof getSupabase>,
  email: string,
): Promise<string | null> {
  const normalizedEmail = normalizeEmail(email);
  const perPage = 200;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw error;
    }

    const matchedUser = data.users.find(
      (user) => normalizeEmail(user.email ?? "") === normalizedEmail,
    );

    if (matchedUser) {
      return matchedUser.id;
    }

    if (data.users.length < perPage) {
      break;
    }
  }

  return null;
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

      const normalizedEmail = normalizeEmail(email);
      const userMetadata = buildSignupUserMetadata({
        fullName,
        contactNo,
        companyName,
        address,
      });

      if (!validateVerificationToken(verificationToken, normalizedEmail, "signup")) {
        throw new UnauthorizedError(
          "Email verification token is invalid or expired",
        );
      }

      const supabase = getSupabase();

      const createResult = await supabase.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: userMetadata,
      });

      const alreadyRegistered =
        createResult.error?.message.toLowerCase().includes("already registered") ??
        false;

      if (createResult.error && !alreadyRegistered) {
        throw new BadRequestError(createResult.error.message);
      }

      let accountExists = false;
      let signInResult = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
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

      if (alreadyRegistered && signInResult.error) {
        accountExists = true;

        const isUnconfirmedError = signInResult.error.message
          .toLowerCase()
          .includes("email not confirmed");

        if (isUnconfirmedError) {
          const userId = await findSupabaseUserIdByEmail(supabase, normalizedEmail);

          if (userId) {
            const updateResult = await supabase.auth.admin.updateUserById(userId, {
              email_confirm: true,
              password,
              user_metadata: userMetadata,
            });

            if (updateResult.error) {
              throw new BadRequestError(updateResult.error.message);
            }

            signInResult = await supabase.auth.signInWithPassword({
              email: normalizedEmail,
              password,
            });
          }
        }
      }

      if (signInResult.error || !signInResult.data.user || !signInResult.data.session) {
        if (alreadyRegistered) {
          throw new UnauthorizedError(
            "Account already exists. Please log in with your existing password.",
          );
        }

        throw new UnauthorizedError(
          signInResult.error?.message ??
            "Account created but automatic login failed. Please try logging in.",
        );
      }

      // Persist profile + seed preset templates so settings is fully populated
      // the moment the user lands after signup. Best-effort: failures here
      // should not block the signup response (middleware upsert will backfill).
      try {
        await query(
          `INSERT INTO users (id, email, full_name, contact_no, company_name, address)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE
               SET email        = EXCLUDED.email,
                   full_name    = COALESCE(EXCLUDED.full_name, users.full_name),
                   contact_no   = COALESCE(EXCLUDED.contact_no, users.contact_no),
                   company_name = COALESCE(EXCLUDED.company_name, users.company_name),
                   address      = COALESCE(EXCLUDED.address, users.address),
                   updated_at   = NOW()`,
          [
            signInResult.data.user.id,
            normalizedEmail,
            fullName ?? null,
            contactNo ?? null,
            companyName ?? null,
            address ?? null,
          ],
        );
        await ensurePresetTemplates(signInResult.data.user.id);
      } catch (persistErr) {
        console.warn(
          "[auth/signup] profile/template seed failed:",
          persistErr instanceof Error ? persistErr.message : persistErr,
        );
      }

      res.status(accountExists ? 200 : 201).json({
        message: accountExists
          ? "Account already exists. Signed in successfully."
          : "User registered successfully",
        user: {
          id: signInResult.data.user.id,
          email: signInResult.data.user.email,
        },
        session: buildSessionPayload(signInResult.data.session),
        confirmationRequired: false,
        accountExists,
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

      const normalizedEmail = normalizeEmail(parsed.data.email);
      const { password } = parsed.data;
      const supabase = getSupabase();

      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
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
        session: buildSessionPayload(data.session),
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
        redirectUri: getGoogleRedirectUri(),
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

      let watchChannelCreated = false;
      let watchChannelId: string | undefined;
      let watchCalendarId: string | undefined;
      if (process.env.GOOGLE_WEBHOOK_URL) {
        try {
          const watch = await createWatchChannel(userId, "primary");
          watchChannelCreated = true;
          watchChannelId = watch.channelId;
          watchCalendarId = watch.calendarId;
        } catch (watchErr) {
          console.warn(
            `[auth/google callback] watch channel setup failed for user ${userId}: ${String(watchErr)}`,
          );
        }
      }

      // Trigger the first import immediately after account connection.
      // If we have a watch channel, include it so the worker can seed and reuse
      // the incremental sync cursor from day one.
      const initialSyncJobId = `google-sync-initial|${userId}|${Date.now()}`;
      await getCalendarSyncQueue().add(
        JobType.GOOGLE_SYNC,
        {
          jobType: JobType.GOOGLE_SYNC,
          requestId: randomUUID(),
          idempotencyKey: initialSyncJobId,
          userId,
          payload:
            watchChannelId && watchCalendarId
              ? { channelId: watchChannelId, calendarId: watchCalendarId }
              : {},
        },
        {
          jobId: initialSyncJobId,
          attempts: 8,
          backoff: { type: "calendar_exp" as "exponential", delay: 30_000 },
        },
      );

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

// ─── DELETE /api/v1/auth/google ─────────────────────────────────────
// Disconnect a previously connected Google account.
// Removes stored tokens and active watch channels for this user.
router.delete(
  "/google",
  oauthRateLimit,
  authMiddleware as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      let googleAccount: Awaited<ReturnType<typeof getTokens>> = null;
      try {
        googleAccount = await getTokens(user.id, "google");
      } catch {
        // If token rows are already invalid/reauth-required, proceed with
        // local disconnect cleanup anyway.
      }

      // Stop active channels before token deletion for best-effort Google-side cleanup.
      const stoppedWatchChannels = await stopAllWatchChannelsForUser(user.id);

      if (googleAccount) {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
        );

        // Revoke both tokens when available. Failures are logged and ignored
        // so account disconnect still succeeds locally.
        try {
          await oauth2Client.revokeToken(googleAccount.accessToken);
        } catch (err) {
          console.warn(
            `[auth/google disconnect] access token revoke failed for user ${user.id}: ${String(err)}`,
          );
        }

        try {
          await oauth2Client.revokeToken(googleAccount.refreshToken);
        } catch (err) {
          console.warn(
            `[auth/google disconnect] refresh token revoke failed for user ${user.id}: ${String(err)}`,
          );
        }
      }

      await deleteTokens(user.id, "google");

      res.status(200).json({
        message: "Google account disconnected successfully",
        provider: "google",
        disconnected: true,
        stoppedWatchChannels,
      });
    } catch (err) {
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

      // Best-effort: seed presets + backfill profile from Supabase metadata so the
      // very first Settings load after signup shows the values captured at registration.
      void ensurePresetTemplates(user.id).catch(() => {});

      const profileRow = await query<{
        full_name: string | null;
        contact_no: string | null;
        company_name: string | null;
        address: string | null;
      }>(
        `SELECT full_name, contact_no, company_name, address
           FROM users
          WHERE id = $1
          LIMIT 1`,
        [user.id],
      );
      const profile = profileRow.rows[0] ?? {
        full_name: null,
        contact_no: null,
        company_name: null,
        address: null,
      };

      // Back-fill from Supabase user_metadata if the local row is blank.
      if (
        !profile.full_name &&
        !profile.contact_no &&
        !profile.company_name &&
        !profile.address
      ) {
        try {
          const supabase = getSupabase();
          const { data } = await supabase.auth.admin.getUserById(user.id);
          const metadata = (data?.user?.user_metadata ?? {}) as Record<
            string,
            string
          >;
          if (
            metadata.fullName ||
            metadata.contactNo ||
            metadata.companyName ||
            metadata.address
          ) {
            await query(
              `UPDATE users
                  SET full_name    = COALESCE(full_name, $2),
                      contact_no   = COALESCE(contact_no, $3),
                      company_name = COALESCE(company_name, $4),
                      address      = COALESCE(address, $5),
                      updated_at   = NOW()
                WHERE id = $1`,
              [
                user.id,
                metadata.fullName ?? null,
                metadata.contactNo ?? null,
                metadata.companyName ?? null,
                metadata.address ?? null,
              ],
            );
            profile.full_name = profile.full_name ?? metadata.fullName ?? null;
            profile.contact_no =
              profile.contact_no ?? metadata.contactNo ?? null;
            profile.company_name =
              profile.company_name ?? metadata.companyName ?? null;
            profile.address = profile.address ?? metadata.address ?? null;
          }
        } catch {
          // Non-fatal: metadata back-fill is best-effort.
        }
      }

      let googleAccount: Awaited<ReturnType<typeof getTokens>> = null;
      try {
        googleAccount = await getTokens(user.id, "google");
      } catch {
        googleAccount = null;
      }

      res.json({
        user: {
          id: user.id,
          email: user.email,
          fullName: profile.full_name ?? undefined,
          contactNo: profile.contact_no ?? undefined,
          companyName: profile.company_name ?? undefined,
          address: profile.address ?? undefined,
        },
        connectedAccounts: {
          google: googleAccount
            ? {
                connected: true,
                email: user.email,
                expiresAt: googleAccount.expiresAt,
                reauthRequired: googleAccount.reauthRequired ?? false,
              }
            : {
                connected: false,
                email: undefined,
                expiresAt: null,
                reauthRequired: false,
              },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PUT /api/v1/auth/profile ──────────────────────────────────────
// Update the signed-in user's profile fields. Writes to both the local
// `users` table (source of truth for backend) and Supabase `user_metadata`
// (so any other consumer of the Supabase JWT sees the same values).
const UpdateProfileSchema = z.object({
  fullName: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(254).optional(),
  contactNo: z.string().trim().min(3).max(32).optional(),
  companyName: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(1).max(240).optional(),
});

router.put(
  "/profile",
  authMiddleware as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = UpdateProfileSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((i) => i.message).join(", "),
        );
      }

      const { fullName, email, contactNo, companyName, address } = parsed.data;
      const normalizedEmail = email ? normalizeEmail(email) : undefined;

      await query(
        `UPDATE users
            SET full_name    = COALESCE($2, full_name),
                contact_no   = COALESCE($3, contact_no),
                company_name = COALESCE($4, company_name),
                address      = COALESCE($5, address),
                email        = COALESCE($6, email),
                updated_at   = NOW()
          WHERE id = $1`,
        [
          user.id,
          fullName ?? null,
          contactNo ?? null,
          companyName ?? null,
          address ?? null,
          normalizedEmail ?? null,
        ],
      );

      // Mirror into Supabase metadata (and email if changed) — best effort.
      try {
        const supabase = getSupabase();
        const metadataUpdate: Record<string, string> = {};
        if (fullName) metadataUpdate.fullName = fullName;
        if (contactNo) metadataUpdate.contactNo = contactNo;
        if (companyName) metadataUpdate.companyName = companyName;
        if (address) metadataUpdate.address = address;

        if (Object.keys(metadataUpdate).length > 0 || normalizedEmail) {
          await supabase.auth.admin.updateUserById(user.id, {
            ...(normalizedEmail ? { email: normalizedEmail } : {}),
            user_metadata: metadataUpdate,
          });
        }
      } catch (mirrorErr) {
        req.log?.warn("Failed to mirror profile into Supabase metadata", {
          error:
            mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
        });
      }

      const row = await query<{
        email: string;
        full_name: string | null;
        contact_no: string | null;
        company_name: string | null;
        address: string | null;
      }>(
        `SELECT email, full_name, contact_no, company_name, address
           FROM users
          WHERE id = $1
          LIMIT 1`,
        [user.id],
      );
      const updated = row.rows[0];

      let googleAccount: Awaited<ReturnType<typeof getTokens>> = null;
      try {
        googleAccount = await getTokens(user.id, "google");
      } catch {
        googleAccount = null;
      }

      res.json({
        user: {
          id: user.id,
          email: updated?.email ?? user.email,
          fullName: updated?.full_name ?? undefined,
          contactNo: updated?.contact_no ?? undefined,
          companyName: updated?.company_name ?? undefined,
          address: updated?.address ?? undefined,
        },
        connectedAccounts: {
          google: googleAccount
            ? {
                connected: true,
                email: updated?.email ?? user.email,
                expiresAt: googleAccount.expiresAt,
                reauthRequired: googleAccount.reauthRequired ?? false,
              }
            : {
                connected: false,
                email: undefined,
                expiresAt: null,
                reauthRequired: false,
              },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
