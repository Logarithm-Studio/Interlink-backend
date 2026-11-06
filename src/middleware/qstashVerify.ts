import { Request, Response, NextFunction } from "express";
import { getQStashReceiver } from "../config/qstash";
import { resolveWorkerOrigin } from "../config/workerOrigin";

/**
 * Express middleware that verifies the Upstash-Signature header on incoming
 * QStash callbacks.  Must be applied to all /api/v1/workers/* routes.
 *
 * Signature is computed over the raw request body bytes, so app.ts must
 * store the raw body via the express.json() `verify` callback (req.rawBody).
 *
 * In development (NODE_ENV !== "production") verification is skipped so you
 * can test worker endpoints locally via curl/Postman without signing.
 */
export async function verifyQStash(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    return next();
  }

  const signature = req.headers["upstash-signature"];
  if (!signature || typeof signature !== "string") {
    res.status(401).json({ error: "Missing Upstash-Signature header" });
    return;
  }

  let receiver: ReturnType<typeof getQStashReceiver>;
  let origin: string | undefined;
  try {
    receiver = getQStashReceiver();
    origin = resolveWorkerOrigin(process.env);
    if (!origin) throw new Error("Worker origin is missing");
  } catch {
    res.status(503).json({ error: "Worker verification is not configured" });
    return;
  }

  // Re-serializing parsed JSON changes the bytes QStash signed. Fail closed if
  // the hosting runtime did not preserve them rather than verifying a guess.
  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  if (typeof rawBody !== "string") {
    res.status(503).json({ error: "Worker request body was not preserved" });
    return;
  }

  try {
    await receiver.verify({ signature, body: rawBody, url: origin + req.originalUrl });
    next();
  } catch (error) {
    // Fixed diagnostic codes distinguish transport faults without disclosing
    // JWTs, signing keys, URLs or body hashes from the SDK's error message.
    const message = error instanceof Error ? error.message : "";
    if (message === "crypto is not defined" || message === "CryptoKey is not defined") {
      res.status(503).json({ error: "Worker cryptography is unavailable", code: "WORKER_CRYPTO_UNAVAILABLE" });
      return;
    }
    const code = message.startsWith("invalid subject:") ? "WORKER_DESTINATION_MISMATCH"
      : message.startsWith("body hash does not match") ? "WORKER_BODY_MISMATCH"
      : "WORKER_SIGNATURE_INVALID";
    const reason = message === "signature verification failed" ? "signature_mismatch"
      : message.includes('"exp" claim') || message.includes('"nbf" claim') ? "signature_time_invalid"
      : "verification_failed";
    res.status(401).json({ error: "Invalid QStash signature", code, reason });
  }
}
