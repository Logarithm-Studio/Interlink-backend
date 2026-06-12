import { Request, Response, NextFunction } from "express";
import { getQStashReceiver } from "../config/qstash";

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

  const rawBody: string =
    (req as Request & { rawBody?: string }).rawBody ??
    JSON.stringify(req.body ?? {});

  try {
    const receiver = getQStashReceiver();
    await receiver.verify({ signature, body: rawBody });
    next();
  } catch {
    res.status(401).json({ error: "Invalid QStash signature" });
  }
}
