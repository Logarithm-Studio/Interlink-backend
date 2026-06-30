/**
 * Tax Document Gathering service (Professional Mode, iter3).
 * Detect contractors over the reporting threshold, AI-draft a W-9 request,
 * send via Gmail, and track status.
 */

import { createHash, randomUUID } from "crypto";
import { query } from "../../config/db";
import { AppUser } from "../../types";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { generateTaxRequestEmail } from "../ai/ai.service";
import { createGmailDraft, sendGmailDraft } from "../email/gmail.service";
import { recordActivity } from "./activity.service";

export type W9Status = "missing" | "requested" | "received" | "filed";

export interface Contractor {
  id: string;
  name: string;
  email: string;
  ytdPaidCents: number;
  w9Status: W9Status;
  lastRequestAt: Date | null;
}

interface ContractorRow {
  id: string;
  name: string;
  email: string;
  ytd_paid_cents: string;
  w9_status: W9Status;
  last_request_at: Date | null;
}

const THRESHOLD_CENTS = 60000; // $600 IRS reporting threshold

function mapRow(r: ContractorRow): Contractor {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    ytdPaidCents: Number(r.ytd_paid_cents),
    w9Status: r.w9_status,
    lastRequestAt: r.last_request_at,
  };
}

export async function listContractors(userId: string): Promise<Contractor[]> {
  const res = await query<ContractorRow>(
    `SELECT id, name, email, ytd_paid_cents, w9_status, last_request_at
       FROM contractors WHERE user_id = $1 ORDER BY ytd_paid_cents DESC`,
    [userId],
  );
  return res.rows.map(mapRow);
}

export async function getContractor(
  userId: string,
  id: string,
): Promise<Contractor | null> {
  const res = await query<ContractorRow>(
    `SELECT id, name, email, ytd_paid_cents, w9_status, last_request_at
       FROM contractors WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Contractors over the reporting threshold still missing/awaiting a W-9. */
export function needsW9(c: Contractor): boolean {
  return c.ytdPaidCents >= THRESHOLD_CENTS && (c.w9Status === "missing" || c.w9Status === "requested");
}

async function loadSender(userId: string, fallbackEmail: string) {
  const res = await query<{ full_name: string | null; company_name: string | null }>(
    "SELECT full_name, company_name FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  return {
    name: res.rows[0]?.full_name?.trim() || fallbackEmail.split("@")[0] || "Accounts Payable",
    company: res.rows[0]?.company_name?.trim() || undefined,
  };
}

export interface W9RequestResult {
  contractorId: string;
  recipients: string[];
  subject: string;
  body: string;
  isAiFallback: boolean;
}

export async function sendW9Request(
  user: AppUser,
  contractorId: string,
): Promise<W9RequestResult> {
  const c = await getContractor(user.id, contractorId);
  if (!c) throw new NotFoundError("Contractor");
  if (!c.email?.trim()) throw new BadRequestError("Contractor has no email.");

  const sender = await loadSender(user.id, user.email);
  const taxYear = new Date().getFullYear();
  const ytdPaidFormatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(c.ytdPaidCents / 100);

  const generated = await generateTaxRequestEmail({
    userId: user.id,
    idempotencyKey: `ai:tax:${user.id}:${contractorId}:${taxYear}`,
    context: {
      contractorName: c.name,
      formType: "W-9",
      taxYear,
      ytdPaidFormatted,
      senderName: sender.name,
      companyName: sender.company,
    },
  });

  const subject = generated.data.subject;
  const body = generated.data.body;
  const recipients = [c.email.trim().toLowerCase()];
  const draftKey =
    `tax:draft:${user.id}:${contractorId}:${taxYear}:` +
    createHash("sha256").update(subject + body).digest("hex").slice(0, 12);

  const draft = await createGmailDraft({
    executionId: null,
    stepId: `tax_w9:${contractorId}`,
    userId: user.id,
    recipients,
    subject,
    body,
    idempotencyKey: draftKey,
  });
  await sendGmailDraft({
    executionId: `tax:${contractorId}`,
    stepId: `tax_w9:${contractorId}`,
    userId: user.id,
    providerDraftId: draft.providerDraftId,
    idempotencyKey: `tax:send:${user.id}:${contractorId}:${randomUUID()}`,
  });

  await query(
    `UPDATE contractors SET w9_status = 'requested', last_request_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [contractorId, user.id],
  );
  await recordActivity({
    userId: user.id,
    kind: "tax_request_sent",
    title: `W-9 request sent to ${c.name}`,
    entityType: "contractor",
    entityId: contractorId,
    status: "done",
  });

  return { contractorId, recipients, subject, body, isAiFallback: generated.isFallback };
}

export async function setContractorStatus(
  userId: string,
  contractorId: string,
  status: W9Status,
): Promise<void> {
  await query(
    `UPDATE contractors SET w9_status = $3, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [contractorId, userId, status],
  );
}

export async function seedDemoContractors(userId: string): Promise<number> {
  // (name, email-suffix, ytd_paid_cents, w9_status)
  const demo: [string, number, W9Status][] = [
    ["Jordan Vega (Design)", 240000, "missing"], // over threshold, needs W-9
    ["Priya Nair (Dev)", 980000, "missing"], // over threshold
    ["Sam Cole (Copywriting)", 45000, "missing"], // under threshold
    ["Lee Contracting LLC", 310000, "requested"], // over, already requested
  ];
  let inserted = 0;
  for (const [name, ytd, status] of demo) {
    const email = `${name.split(" ")[0].toLowerCase()}@example.com`;
    const res = await query(
      `INSERT INTO contractors (user_id, name, email, ytd_paid_cents, w9_status, source)
       VALUES ($1, $2, $3, $4, $5, 'demo')
       ON CONFLICT (user_id, name) DO NOTHING`,
      [userId, name, email, ytd, status],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}
