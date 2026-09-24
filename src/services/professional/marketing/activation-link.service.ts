import { randomBytes } from "node:crypto";
import { query, withTransaction } from "../../../config/db";
import { AppError, NotFoundError } from "../../../utils/errors";
import { buildMarketingActivationTrackedUrl, resolveMarketingPublicBase, safeActivationRedirectTarget } from "./activation-link.model";

export async function getMarketingActivationTrackedLink(userId: string, activationId: string): Promise<{ url: string }> {
  const publicBase = resolveMarketingPublicBase();
  if (!publicBase) throw new AppError("Set a public HTTPS base URL before sharing tracked activation links.", 503);
  const token = await withTransaction(async (client) => {
    const current = await client.query<{ public_link_token: string | null; external_url: string | null }>(
      `SELECT public_link_token,external_url FROM sales_marketing_activations WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [activationId, userId],
    );
    const row = current.rows[0];
    if (!row) throw new NotFoundError("Marketing activation");
    if (!safeActivationRedirectTarget(row.external_url)) throw new AppError("Add a valid HTTP or HTTPS destination link before sharing a tracked link.", 409);
    if (row.public_link_token) return row.public_link_token;
    const generated = randomBytes(32).toString("base64url");
    await client.query(
      `UPDATE sales_marketing_activations SET public_link_token=$3,updated_at=now() WHERE id=$1 AND user_id=$2`,
      [activationId, userId, generated],
    );
    await client.query(
      `INSERT INTO sales_marketing_activation_events(user_id,activation_id,action,changed_fields)
       VALUES($1,$2,'updated',$3::text[])`, [userId, activationId, ["trackedLink"]],
    );
    return generated;
  });
  return { url: buildMarketingActivationTrackedUrl(publicBase, token) };
}

/** Count each redirect request in a UTC daily bucket without storing IPs, referrers, or user agents. */
export async function recordMarketingActivationRedirect(token: string): Promise<string | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; user_id: string; external_url: string | null }>(
      `SELECT id,user_id,external_url FROM sales_marketing_activations WHERE public_link_token=$1 FOR UPDATE`, [token],
    );
    const row = result.rows[0];
    const target = safeActivationRedirectTarget(row?.external_url);
    if (!row || !target) return null;
    await client.query(
      `INSERT INTO sales_marketing_activation_link_metrics(user_id,activation_id,metric_date,redirect_count)
       VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,1)
       ON CONFLICT (user_id,activation_id,metric_date)
       DO UPDATE SET redirect_count=sales_marketing_activation_link_metrics.redirect_count+1,updated_at=now()`,
      [row.user_id, row.id],
    );
    return target;
  });
}
