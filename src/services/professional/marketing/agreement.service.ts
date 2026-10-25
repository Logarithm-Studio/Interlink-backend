import { createHash } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "../../../config/db";
import { AppError, NotFoundError } from "../../../utils/errors";
import { executeComposioProxy } from "../../composio/composio.service";
import { getDealDetail } from "../sales/sales.service";
import { enqueueJob } from "../../jobQueue.service";

export const AgreementInput = z.object({ dealId: z.string().uuid(), requirements: z.string().trim().min(10).max(20000), signerName: z.string().trim().min(1).max(100), signerEmail: z.string().email().max(100) });
type Row = Record<string, unknown> & { id: string; user_id: string; contract_id: string; title: string; body: string; signer_name: string; signer_email: string; status: string; account_id: string | null; base_uri: string | null; envelope_id: string | null; provider_version:string|null };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
function fingerprint(row: Row) { return createHash("sha256").update(JSON.stringify([row.id, row.body, row.signer_name, row.signer_email])).digest("hex"); }
const columns = "a.*,c.title,c.body,c.amount_cents,c.currency,c.deal_id";

async function requireAgreement(userId: string, id: string): Promise<Row> {
  const row = (await query<Row>(`SELECT ${columns} FROM sales_marketing_agreements a JOIN sales_contracts c ON c.id=a.contract_id AND c.user_id=a.user_id WHERE a.id=$1 AND a.user_id=$2`, [id, userId])).rows[0];
  if (!row) throw new NotFoundError("Agreement");
  return row;
}
export async function getAgreement(userId: string, id: string) { const row = await requireAgreement(userId, id); return { ...row, fingerprint: fingerprint(row) }; }
export async function listAgreements(userId: string) {
  const rows = (await query<Row>(`SELECT ${columns} FROM sales_marketing_agreements a JOIN sales_contracts c ON c.id=a.contract_id AND c.user_id=a.user_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [userId])).rows;
  return rows.map(row => ({ ...row, fingerprint: fingerprint(row) }));
}
export async function createAgreement(userId: string, raw: z.infer<typeof AgreementInput>) {
  const input = AgreementInput.parse(raw);
  const detail = await getDealDetail(userId, input.dealId);
  if (!detail) throw new NotFoundError("Deal");
  const value = `${detail.deal.currency} ${(detail.deal.amountCents / 100).toFixed(2)}`;
  // Faithfully assemble supplied terms; do not invent legal clauses or commercial terms.
  const body = `${detail.deal.title} — Agreement\n\nClient: ${input.signerName} (${input.signerEmail})\nDeal value: ${value}\n\nScope, deliverables and agreed terms\n\n${input.requirements}`;
  const id = await withTransaction(async client => {
    const contract = await client.query<{ id: string }>("INSERT INTO sales_contracts(user_id,deal_id,title,body,amount_cents,currency) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [userId, input.dealId, `${detail.deal.title} — Agreement`, body, detail.deal.amountCents, detail.deal.currency]);
    return (await client.query<{ id: string }>("INSERT INTO sales_marketing_agreements(user_id,contract_id,signer_name,signer_email,requirements) VALUES($1,$2,$3,$4,$5) RETURNING id", [userId, contract.rows[0].id, input.signerName, input.signerEmail, input.requirements])).rows[0].id;
  });
  return getAgreement(userId, id);
}
export async function editAgreement(userId: string, id: string, body: string) {
  await withTransaction(async client => {
    const row = (await client.query<Row>("SELECT * FROM sales_marketing_agreements WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, userId])).rows[0];
    if (!row) throw new NotFoundError("Agreement");
    if (row.status !== "draft") throw new AppError("Only an unsent local draft can be edited. Create a new agreement for revised terms.", 409);
    await client.query("UPDATE sales_contracts SET body=$3 WHERE id=$1 AND user_id=$2", [row.contract_id, userId, body]);
    await client.query("UPDATE sales_marketing_agreements SET updated_at=now() WHERE id=$1 AND user_id=$2", [id, userId]);
  });
  return getAgreement(userId, id);
}

async function provider(userId: string, endpoint: string, method: "GET" | "POST" | "PUT", body?: unknown) {
  const result = await executeComposioProxy(userId, "docusign", endpoint, method, body);
  if (result.status < 200 || result.status >= 300) throw new AppError("DocuSign did not confirm the request. Check account permissions and provider status.", 502);
  return object(result.data);
}
export async function getAgreementAccounts(userId: string) {
  const host = process.env.DOCUSIGN_AUTH_URL || "https://account-d.docusign.com";
  if (!["https://account.docusign.com", "https://account-d.docusign.com"].includes(host)) throw new AppError("Configure an official DocuSign authorization host.", 503);
  const info = await provider(userId, `${host}/oauth/userinfo`, "GET");
  if (!Array.isArray(info.accounts)) throw new AppError("DocuSign returned no account list.", 502);
  return info.accounts.flatMap(value => {
    const account = object(value);
    if (typeof account.account_id !== "string" || typeof account.base_uri !== "string" || !/^https:\/\/[a-z0-9-]+\.docusign\.net$/i.test(account.base_uri)) return [];
    return [{ id: account.account_id, name: String(account.account_name ?? account.account_id), baseUri: account.base_uri }];
  });
}
async function markReview(userId: string, id: string, message: string) {
  await query("UPDATE sales_marketing_agreements SET status='review',last_error=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('preparing','sending')", [id, userId, message]);
}
export async function prepareAgreement(userId: string, id: string, accountId: string, expected: string) {
  const row = await requireAgreement(userId, id);
  if (row.status !== "draft" || fingerprint(row) !== expected) throw new AppError("The agreement changed. Refresh and review the full draft again.", 409);
  const account = (await getAgreementAccounts(userId)).find(item => item.id === accountId);
  if (!account) throw new AppError("Choose an available DocuSign account.", 400);
  const claim = await withTransaction(async client => {
    const current = (await client.query<Row>(`SELECT ${columns} FROM sales_marketing_agreements a JOIN sales_contracts c ON c.id=a.contract_id AND c.user_id=a.user_id WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a,c`, [id, userId])).rows[0];
    if (!current || current.status !== "draft" || fingerprint(current) !== expected) throw new AppError("This draft changed before approval. Review it again.", 409);
    return client.query("UPDATE sales_marketing_agreements SET status='preparing',account_id=$3,base_uri=$4,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id", [id, userId, account.id, account.baseUri]);
  });
  if (!claim.rows.length) throw new AppError("Agreement preparation is already in progress.", 409);
  try {
    const anchor = `/interlink_signature_${row.id}/`;
    const html = `<html><body><pre style="white-space:pre-wrap;font-family:Arial">${escapeHtml(row.body)}</pre><p>Signature: <span style="color:white;font-size:1px">${anchor}</span></p></body></html>`;
    const envelope = await provider(userId, `${account.baseUri}/restapi/v2.1/accounts/${encodeURIComponent(account.id)}/envelopes`, "POST", {
      status: "created", transactionId: row.id, emailSubject: row.title.slice(0, 100),
      documents: [{ documentBase64: Buffer.from(html).toString("base64"), name: "Agreement.html", fileExtension: "html", documentId: "1" }],
      recipients: { signers: [{ email: row.signer_email, name: row.signer_name, recipientId: "1", routingOrder: "1", tabs: { signHereTabs: [{ anchorString: anchor, anchorUnits: "pixels", anchorXOffset: "0", anchorYOffset: "0" }] } }] },
      customFields: { textCustomFields: [{ name: "InterlinkAgreementId", value: row.id, show: "false", required: "false" }] },
    });
    if (typeof envelope.envelopeId !== "string" || envelope.status !== "created") throw new Error("Missing draft envelope confirmation");
    await query("UPDATE sales_marketing_agreements SET envelope_id=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='preparing'", [id, userId, envelope.envelopeId]);
    const snapshot=await provider(userId,`${account.baseUri}/restapi/v2.1/accounts/${encodeURIComponent(account.id)}/envelopes/${encodeURIComponent(envelope.envelopeId)}`,"GET");
    if(snapshot.status!=="created"||typeof snapshot.lastModifiedDateTime!=="string"||!snapshot.lastModifiedDateTime)throw new Error("Missing provider draft version");
    await query("UPDATE sales_marketing_agreements SET status='prepared',provider_version=$3,last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='preparing'", [id, userId, snapshot.lastModifiedDateTime]);
  } catch {
    await markReview(userId, id, "Envelope preparation was not confirmed. Check DocuSign and reconcile its envelope ID before trying another create.");
  }
  return getAgreement(userId, id);
}

function endpoint(row: Row) {
  if (!row.base_uri || !/^https:\/\/[a-z0-9-]+\.docusign\.net$/i.test(row.base_uri) || !row.account_id || !row.envelope_id) throw new AppError("This agreement has no confirmed envelope. Reconcile it before continuing.", 409);
  return `${row.base_uri}/restapi/v2.1/accounts/${encodeURIComponent(row.account_id)}/envelopes/${encodeURIComponent(row.envelope_id)}`;
}
export async function sendAgreement(userId: string, id: string, expected: string) {
  const row = await requireAgreement(userId, id);
  if (row.status !== "prepared" || fingerprint(row) !== expected) throw new AppError("Review the current prepared agreement before sending.", 409);
  const target = endpoint(row);
  const [remote,recipients]=await Promise.all([provider(userId,target,"GET"),provider(userId,`${target}/recipients`,"GET")]);
  const signers=Array.isArray(recipients.signers)?recipients.signers.map(object):[];
  if(remote.status!=="created"||!row.provider_version||remote.lastModifiedDateTime!==row.provider_version||signers.length!==1||String(signers[0].email).toLowerCase()!==row.signer_email.toLowerCase()||signers[0].name!==row.signer_name||Object.entries(recipients).some(([key,value])=>key!=="signers"&&Array.isArray(value)&&value.length>0)) {
    await query("UPDATE sales_marketing_agreements SET status='review',last_error='The provider draft or its recipients changed. Review DocuSign and create a new agreement for revised terms.',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='prepared'",[id,userId]);
    throw new AppError("The DocuSign draft changed after preparation. No signature request was sent.",409);
  }
  const claimed = await query("UPDATE sales_marketing_agreements SET status='sending',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='prepared' RETURNING id", [id, userId]);
  if (!claimed.rows.length) throw new AppError("This envelope is already being sent.", 409);
  try {
    await provider(userId, target, "PUT", { status: "sent" });
    return await refreshAgreement(userId, id);
  } catch {
    await markReview(userId, id, "Signature delivery was not confirmed. Check the envelope status before any retry.");
    return getAgreement(userId, id);
  }
}

export async function refreshAgreement(userId: string, id: string) {
  const row = await requireAgreement(userId, id);
  const result = await provider(userId, endpoint(row), "GET");
  const status = String(result.status ?? "").toLowerCase();
  if(status==="created"&&row.provider_version&&result.lastModifiedDateTime!==row.provider_version){
    await query("UPDATE sales_marketing_agreements SET status='review',last_error='This envelope was edited outside Interlink. Review it in DocuSign before creating revised terms.',last_checked_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('prepared','review')",[id,userId]);
    return getAgreement(userId,id);
  }
  if(status==="created"&&!row.provider_version&&typeof result.lastModifiedDateTime==="string") {
    // A reconciled creation may obtain its first provider snapshot only after its marker was verified.
    await query("UPDATE sales_marketing_agreements SET provider_version=$3 WHERE id=$1 AND user_id=$2 AND status='review' AND provider_version IS NULL",[id,userId,result.lastModifiedDateTime]);
  }
  const mapped = ({ created: "prepared", sent: "sent", delivered: "sent", completed: "completed", declined: "declined", voided: "voided" } as Record<string, string>)[status];
  if (mapped === "prepared" && ["sending", "sent"].includes(row.status)) throw new AppError("The envelope operation is still being resolved. Check its status again shortly.", 409);
  if (!mapped || (typeof result.envelopeId === "string" && result.envelopeId !== row.envelope_id)) throw new AppError("DocuSign returned an unexpected envelope status.", 502);
  await withTransaction(async client => {
    // A late read must not downgrade a terminal provider-confirmed outcome.
    const changed = await client.query("UPDATE sales_marketing_agreements SET status=$3,last_checked_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status=$4 AND status NOT IN ('completed','declined','voided') RETURNING contract_id", [id, userId, mapped, row.status]);
    if (!changed.rows[0]) return;
    if (["sent", "completed", "declined"].includes(mapped)) await client.query("UPDATE sales_contracts SET status=$3,sent_at=COALESCE(sent_at,now()),signed_at=CASE WHEN $3='signed' THEN COALESCE(signed_at,now()) ELSE signed_at END WHERE id=$1 AND user_id=$2", [row.contract_id, userId, mapped === "completed" ? "signed" : mapped]);
  });
  return getAgreement(userId, id);
}

export async function reconcileAgreement(userId: string, id: string, envelopeId: string) {
  const row = await requireAgreement(userId, id);
  if (row.status !== "review" || row.envelope_id || !row.base_uri || !row.account_id) throw new AppError("Only an uncertain envelope creation needs ID reconciliation.", 409);
  const candidate = { ...row, envelope_id: envelopeId };
  const fields = await provider(userId, `${endpoint(candidate)}/custom_fields`, "GET");
  if (!Array.isArray(fields.textCustomFields) || !fields.textCustomFields.some(value => object(value).name === "InterlinkAgreementId" && object(value).value === id)) throw new AppError("This envelope does not contain the matching Interlink agreement marker.", 409);
  await query("UPDATE sales_marketing_agreements SET envelope_id=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='review' AND envelope_id IS NULL", [id, userId, envelopeId]);
  return refreshAgreement(userId, id);
}
export async function dispatchAgreementChecks(now=new Date()) {
  await query("UPDATE sales_marketing_agreements SET status='review',last_error='Provider operation was interrupted. Reconcile the envelope before continuing.',updated_at=now() WHERE status IN ('preparing','sending') AND updated_at < now()-interval '20 minutes'");
  const rows = (await query<Row>("SELECT * FROM sales_marketing_agreements WHERE status IN ('sent','review') AND envelope_id IS NOT NULL AND (last_checked_at IS NULL OR last_checked_at<now()-interval '55 minutes') ORDER BY last_checked_at NULLS FIRST LIMIT 25")).rows;
  for (const row of rows) {
    const key=`marketing-agreement:${row.id}:${Math.floor(now.getTime()/3600000)}`;
    try { await enqueueJob("marketing-agreement-check",{jobType:"marketing.agreement.check",idempotencyKey:key,userId:row.user_id,payload:{agreementId:row.id}},{jobId:key,retries:5}); } catch { /* The next hourly dispatch retains due records. */ }
  }
}

export async function checkAgreementStatus(userId:string,id:string) {
  const row=await requireAgreement(userId,id);
  if(["completed","declined","voided"].includes(row.status))return;
  try { await refreshAgreement(userId,id); }
  catch(error){await query("UPDATE sales_marketing_agreements SET last_checked_at=now(),last_error='Signature status could not be refreshed. Check the provider connection.',updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('sent','review')",[id,userId]);throw error;}
}

export async function retryAgreementPreparation(userId:string,id:string,expected:string) {
  const row=await requireAgreement(userId,id);
  if(row.status!=="review"||row.envelope_id||!row.account_id||fingerprint(row)!==expected)throw new AppError("Review the current unresolved envelope before confirming a retry.",409);
  const reset=await query("UPDATE sales_marketing_agreements SET status='draft',last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='review' AND envelope_id IS NULL RETURNING id",[id,userId]);
  if(!reset.rows.length)throw new AppError("Another operation already handled this envelope.",409);
  return prepareAgreement(userId,id,row.account_id,expected);
}
