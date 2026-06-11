import { createHash, createHmac, randomInt, timingSafeEqual } from "crypto";
import nodemailer, { Transporter } from "nodemailer";
import { query } from "../config/db";

type VerificationPurpose = "signup";

interface VerificationRow {
  id: string;
  email: string;
  purpose: string;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  used_at: Date | null;
}

const DEFAULT_CODE_TTL_MINUTES = 10;
const DEFAULT_VERIFY_TOKEN_TTL_SECONDS = 15 * 60;

let transporter: Transporter | null = null;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getCodePepper(): string {
  return (
    process.env.EMAIL_VERIFICATION_PEPPER ??
    process.env.ACTION_SIGNING_SECRET ??
    process.env.ENCRYPTION_KEY ??
    ""
  );
}

function getVerificationTokenSecret(): string {
  const secret =
    process.env.EMAIL_VERIFICATION_TOKEN_SECRET ??
    process.env.ACTION_SIGNING_SECRET;

  if (!secret) {
    throw new Error(
      "EMAIL_VERIFICATION_TOKEN_SECRET or ACTION_SIGNING_SECRET must be set",
    );
  }

  return secret;
}

function hashCode(email: string, code: string): string {
  const pepper = getCodePepper();
  return createHash("sha256")
    .update(`${normalizeEmail(email)}|${code}|${pepper}`)
    .digest("hex");
}

function issueVerificationToken(
  email: string,
  purpose: VerificationPurpose,
): string {
  const payload = {
    email: normalizeEmail(email),
    purpose,
    exp: Math.floor(Date.now() / 1000) + DEFAULT_VERIFY_TOKEN_TTL_SECONDS,
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(getVerificationTokenSecret()))
    .update(encoded)
    .digest("hex");

  return `${encoded}.${signature}`;
}

export function validateVerificationToken(
  token: string,
  email: string,
  purpose: VerificationPurpose,
): boolean {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex < 1) {
    return false;
  }

  const encoded = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);

  const expectedSig = createHmac(
    "sha256",
    Buffer.from(getVerificationTokenSecret()),
  )
    .update(encoded)
    .digest("hex");

  const expectedBuf = Buffer.from(expectedSig, "hex");
  const providedBuf = Buffer.from(providedSig, "hex");

  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf-8"),
    ) as {
      email?: string;
      purpose?: string;
      exp?: number;
    };

    if (!payload.email || !payload.exp || !payload.purpose) {
      return false;
    }

    if (payload.email !== normalizeEmail(email)) {
      return false;
    }

    if (payload.purpose !== purpose) {
      return false;
    }

    return Math.floor(Date.now() / 1000) <= payload.exp;
  } catch {
    return false;
  }
}

function getTransporter(): Transporter {
  if (transporter) {
    return transporter;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS must be set");
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: {
      user,
      pass,
    },
  });

  return transporter;
}

export async function sendEmailVerificationCode(
  email: string,
  purpose: VerificationPurpose = "signup",
): Promise<{ expiresAt: Date }> {
  const normalizedEmail = normalizeEmail(email);
  const code = String(randomInt(1000, 10000));
  const codeHash = hashCode(normalizedEmail, code);

  const ttlMinutes = Number(
    process.env.EMAIL_VERIFICATION_CODE_TTL_MINUTES ??
      DEFAULT_CODE_TTL_MINUTES.toString(),
  );
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  // Invalidate previous active codes for this user/purpose.
  await query(
    `UPDATE email_verification_codes
        SET used_at = NOW()
      WHERE email = $1
        AND purpose = $2
        AND used_at IS NULL`,
    [normalizedEmail, purpose],
  );

  await query(
    `INSERT INTO email_verification_codes
       (email, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [normalizedEmail, purpose, codeHash, expiresAt],
  );

  const from = process.env.SMTP_FROM;
  if (!from) {
    throw new Error("SMTP_FROM must be set");
  }

  await getTransporter().sendMail({
    from,
    to: normalizedEmail,
    subject: "Your Interlink verification code",
    text: `Your Interlink verification code is ${code}. This code expires in ${ttlMinutes} minutes.`,
  });

  return { expiresAt };
}

export async function verifyEmailVerificationCode(
  email: string,
  code: string,
  purpose: VerificationPurpose = "signup",
): Promise<{
  verified: boolean;
  verificationToken?: string;
  reason?: "code_not_found" | "code_expired" | "invalid_code" | "too_many_attempts";
}> {
  const normalizedEmail = normalizeEmail(email);

  const result = await query<VerificationRow>(
    `SELECT id, email, purpose, code_hash, attempts, max_attempts, expires_at, used_at
       FROM email_verification_codes
      WHERE email = $1
        AND purpose = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalizedEmail, purpose],
  );

  const row = result.rows[0];
  if (!row || row.used_at) {
    return { verified: false, reason: "code_not_found" };
  }

  if (row.attempts >= row.max_attempts) {
    return { verified: false, reason: "too_many_attempts" };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { verified: false, reason: "code_expired" };
  }

  const providedHash = hashCode(normalizedEmail, code);
  const expectedBuf = Buffer.from(row.code_hash, "hex");
  const providedBuf = Buffer.from(providedHash, "hex");

  const isMatch =
    expectedBuf.length === providedBuf.length &&
    timingSafeEqual(expectedBuf, providedBuf);

  if (!isMatch) {
    await query(
      `UPDATE email_verification_codes
          SET attempts = attempts + 1
        WHERE id = $1`,
      [row.id],
    );
    return { verified: false, reason: "invalid_code" };
  }

  await query(
    `UPDATE email_verification_codes
        SET used_at = NOW()
      WHERE id = $1`,
    [row.id],
  );

  return {
    verified: true,
    verificationToken: issueVerificationToken(normalizedEmail, purpose),
  };
}
