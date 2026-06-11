import { getPool, query } from "../../config/db";

export interface EmailTemplate {
  id: string;
  userId: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  isActiveDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface EmailTemplateRow {
  id: string;
  user_id: string;
  name: string;
  subject_template: string;
  body_template: string;
  is_active_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export const SYSTEM_DEFAULT_DECLINE_TEMPLATE = {
  name: "System Default",
  subjectTemplate: "Unable to attend: {{eventTitle}}",
  bodyTemplate:
    'Hi,\n\nUnfortunately, I will not be able to attend "{{eventTitle}}".\n\nThanks for understanding.',
} as const;

export const SYSTEM_DEFAULT_TEMPLATE_ID = "system-default";

function buildSystemTemplate(
  userId: string,
  isActiveDefault: boolean,
): EmailTemplate {
  return {
    id: SYSTEM_DEFAULT_TEMPLATE_ID,
    userId,
    name: SYSTEM_DEFAULT_DECLINE_TEMPLATE.name,
    subjectTemplate: SYSTEM_DEFAULT_DECLINE_TEMPLATE.subjectTemplate,
    bodyTemplate: SYSTEM_DEFAULT_DECLINE_TEMPLATE.bodyTemplate,
    isActiveDefault,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function mapRow(row: EmailTemplateRow): EmailTemplate {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    isActiveDefault: row.is_active_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const PRESET_TEMPLATES: {
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
}[] = [
  {
    name: "Brief",
    subjectTemplate: "Cannot make it: {{eventTitle}}",
    bodyTemplate:
      "Hi,\n\nUnfortunately I will not be able to attend {{eventTitle}}. Apologies for the short notice.\n\nThanks.",
  },
  {
    name: "Formal",
    subjectTemplate: "Regrets: Unable to attend {{eventTitle}}",
    bodyTemplate:
      'Dear team,\n\nI regret to inform you that I will be unable to attend "{{eventTitle}}" on {{eventStart}}. I apologise for any inconvenience this may cause and would appreciate receiving any notes or action items afterwards so I can follow up accordingly.\n\nKind regards.',
  },
  {
    name: "Casual",
    subjectTemplate: "Skipping {{eventTitle}} — sorry!",
    bodyTemplate:
      "Hey!\n\nSomething came up and I won't be able to make {{eventTitle}}. Happy to catch up on anything I missed — just send the notes my way.\n\nCheers.",
  },
];

export async function ensurePresetTemplates(userId: string): Promise<void> {
  const names = PRESET_TEMPLATES.map((preset) => preset.name);
  const subjects = PRESET_TEMPLATES.map((preset) => preset.subjectTemplate);
  const bodies = PRESET_TEMPLATES.map((preset) => preset.bodyTemplate);

  await query(
    `WITH preset(name, subject_template, body_template) AS (
       SELECT *
       FROM unnest($2::text[], $3::text[], $4::text[])
     )
     INSERT INTO email_templates
       (user_id, name, subject_template, body_template, is_active_default)
     SELECT $1, p.name, p.subject_template, p.body_template, FALSE
       FROM preset p
      WHERE NOT EXISTS (
              SELECT 1
                FROM email_templates et
               WHERE et.user_id = $1
                 AND et.name = p.name
            )`,
    [userId, names, subjects, bodies],
  );
}

export async function listEmailTemplates(
  userId: string,
): Promise<EmailTemplate[]> {
  await ensurePresetTemplates(userId);

  const result = await query<EmailTemplateRow>(
    `SELECT id, user_id, name, subject_template, body_template,
            is_active_default, created_at, updated_at
       FROM email_templates
      WHERE user_id = $1
      ORDER BY is_active_default DESC, updated_at DESC`,
    [userId],
  );
  const customTemplates = result.rows.map(mapRow);
  const hasActiveCustom = customTemplates.some((t) => t.isActiveDefault);

  return [buildSystemTemplate(userId, !hasActiveCustom), ...customTemplates];
}

export async function getEmailTemplateById(
  userId: string,
  templateId: string,
): Promise<EmailTemplate | null> {
  if (templateId === SYSTEM_DEFAULT_TEMPLATE_ID) {
    const active = await getActiveDefaultTemplate(userId);
    return buildSystemTemplate(userId, !active);
  }

  const result = await query<EmailTemplateRow>(
    `SELECT id, user_id, name, subject_template, body_template,
            is_active_default, created_at, updated_at
       FROM email_templates
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [templateId, userId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function createEmailTemplate(params: {
  userId: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  isActiveDefault?: boolean;
}): Promise<EmailTemplate> {
  const {
    userId,
    name,
    subjectTemplate,
    bodyTemplate,
    isActiveDefault = false,
  } = params;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (isActiveDefault) {
      await client.query(
        `UPDATE email_templates
            SET is_active_default = false,
                updated_at = now()
          WHERE user_id = $1 AND is_active_default = true`,
        [userId],
      );
    }

    const insert = await client.query<EmailTemplateRow>(
      `INSERT INTO email_templates
         (user_id, name, subject_template, body_template, is_active_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, name, subject_template, body_template,
                 is_active_default, created_at, updated_at`,
      [userId, name, subjectTemplate, bodyTemplate, isActiveDefault],
    );

    await client.query("COMMIT");
    return mapRow(insert.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updateEmailTemplate(params: {
  userId: string;
  templateId: string;
  name?: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
}): Promise<EmailTemplate | null> {
  const { userId, templateId, name, subjectTemplate, bodyTemplate } = params;

  const setClauses: string[] = [];
  const values: unknown[] = [templateId, userId];
  let idx = 3;

  if (name !== undefined) {
    setClauses.push(`name = $${idx++}`);
    values.push(name);
  }
  if (subjectTemplate !== undefined) {
    setClauses.push(`subject_template = $${idx++}`);
    values.push(subjectTemplate);
  }
  if (bodyTemplate !== undefined) {
    setClauses.push(`body_template = $${idx++}`);
    values.push(bodyTemplate);
  }

  if (setClauses.length === 0) return getEmailTemplateById(userId, templateId);

  setClauses.push("updated_at = now()");

  const result = await query<EmailTemplateRow>(
    `UPDATE email_templates
        SET ${setClauses.join(", ")}
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, name, subject_template, body_template,
                is_active_default, created_at, updated_at`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function deleteEmailTemplate(
  userId: string,
  templateId: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM email_templates WHERE id = $1 AND user_id = $2`,
    [templateId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setActiveDefaultTemplate(
  userId: string,
  templateId: string,
): Promise<EmailTemplate | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (templateId === SYSTEM_DEFAULT_TEMPLATE_ID) {
      await client.query(
        `UPDATE email_templates
            SET is_active_default = false,
                updated_at = now()
          WHERE user_id = $1 AND is_active_default = true`,
        [userId],
      );
      await client.query("COMMIT");
      return buildSystemTemplate(userId, true);
    }

    const ownsTemplate = await client.query<{ id: string }>(
      `SELECT id FROM email_templates WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [templateId, userId],
    );
    if (ownsTemplate.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `UPDATE email_templates
          SET is_active_default = false,
              updated_at = now()
        WHERE user_id = $1 AND is_active_default = true`,
      [userId],
    );

    const updated = await client.query<EmailTemplateRow>(
      `UPDATE email_templates
          SET is_active_default = true,
              updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id, user_id, name, subject_template, body_template,
                  is_active_default, created_at, updated_at`,
      [templateId, userId],
    );

    await client.query("COMMIT");
    return mapRow(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getActiveDefaultTemplate(
  userId: string,
): Promise<EmailTemplate | null> {
  const result = await query<EmailTemplateRow>(
    `SELECT id, user_id, name, subject_template, body_template,
            is_active_default, created_at, updated_at
       FROM email_templates
      WHERE user_id = $1 AND is_active_default = true
      LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function getEffectiveDeclineTemplate(userId: string): Promise<{
  source: "custom" | "system";
  template: {
    id?: string;
    name: string;
    subjectTemplate: string;
    bodyTemplate: string;
  };
}> {
  const active = await getActiveDefaultTemplate(userId);
  if (active) {
    return {
      source: "custom",
      template: {
        id: active.id,
        name: active.name,
        subjectTemplate: active.subjectTemplate,
        bodyTemplate: active.bodyTemplate,
      },
    };
  }

  return {
    source: "system",
    template: {
      id: SYSTEM_DEFAULT_TEMPLATE_ID,
      name: SYSTEM_DEFAULT_DECLINE_TEMPLATE.name,
      subjectTemplate: SYSTEM_DEFAULT_DECLINE_TEMPLATE.subjectTemplate,
      bodyTemplate: SYSTEM_DEFAULT_DECLINE_TEMPLATE.bodyTemplate,
    },
  };
}
