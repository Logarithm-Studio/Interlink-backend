import { query, withTransaction } from "../../../config/db";
import { createHash } from "node:crypto";
import { executeComposioProxy, listConnections } from "../../composio/composio.service";
import { AppError, NotFoundError } from "../../../utils/errors";
import { getDealDetail, listReps, type DealDetail, type DealStage, type SalesRep } from "../sales/sales.service";
import { fingerprintHubSpotProperties, type HubSpotMonitoredField } from "./hubspot-monitor.model";
import { getKey } from "../../../security/keyring";
import {
  MARKETING_DEAL_STAGES,
  fingerprintHubSpotSyncPreview,
  mapConfiguredHubSpotOwnerToRep,
  mapConfiguredHubSpotStageToInterlink,
  pickMappedHubSpotDealStage,
  type HubSpotPipeline,
  type HubSpotStage,
  type HubSpotStageMappings,
} from "./hubspot-mapping.model";

const PROVIDER = "hubspot";
const API_VERSION = "2026-09";
const LOCK_STALE_AFTER_MINUTES = 20;
type JsonObject = Record<string, unknown>;
type HubSpotRecord = { id: string; properties?: Record<string, string | null> };
type HubSpotPipelineStage = HubSpotStage;
type HubSpotOwner = { id: string; email?: string; firstName?: string; lastName?: string; archived?: boolean };
type HubSpotMappingPreference = {
  pipelineId: string | null;
  stageMappings: HubSpotStageMappings;
  ownerMappings: Record<string, string>;
  updatedAt: Date | null;
};

export interface HubSpotSetup {
  pipelines: HubSpotPipeline[];
  owners: HubSpotOwner[];
  reps: SalesRep[];
  mapping: HubSpotMappingPreference;
}

export interface HubSpotSyncPreview {
  dealId: string;
  fingerprint: string;
  contact: {
    action: "create" | "update";
    externalId: string | null;
    email: string;
    name: string;
    company: string | null;
    title: string | null;
    phone: string | null;
    existing: Record<string, string | null> | null;
  };
  deal: {
    action: "create" | "update";
    externalId: string | null;
    campaignId: string | null;
    title: string;
    stage: string;
    hubspotStage: string;
    hubspotStageId: string;
    pipeline: string;
    pipelineId: string;
    ownerRep: string | null;
    hubspotOwner: string | null;
    hubspotOwnerId: string | null;
    amountCents: number;
    currency: string;
    closeDate: string | null;
    notes: string | null;
    existing: Record<string, string | null> | null;
  };
  consent: "unchanged";
  warning: string;
}

export const HUBSPOT_IMPORT_FIELDS = [
  "contact_name", "contact_company", "contact_title", "contact_phone",
  "deal_title", "deal_stage", "deal_value", "deal_close_date", "deal_owner",
] as const;
export type HubSpotImportField = typeof HUBSPOT_IMPORT_FIELDS[number];
export interface HubSpotImportChange {
  field: HubSpotImportField;
  label: string;
  localValue: string | null;
  hubspotValue: string | null;
  importable: boolean;
  reason: string | null;
}
export interface HubSpotImportPreview {
  dealId: string;
  fingerprint: string;
  changes: HubSpotImportChange[];
  warning: string;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asRecords(value: unknown): HubSpotRecord[] {
  const results = asObject(value).results;
  if (!Array.isArray(results)) return [];
  return results.filter((row): row is HubSpotRecord => {
    const item = asObject(row);
    return typeof item.id === "string" && item.id.length > 0;
  });
}

function providerError(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError("HubSpot denied access. Reconnect it and confirm the required CRM read/write permissions are available.", 403);
  }
  if (status === 429) return new AppError("HubSpot is rate limiting requests. Wait a moment and retry.", 429);
  if (status >= 500) return new AppError("HubSpot is temporarily unavailable. No success was recorded; review HubSpot before retrying.", 502);
  return new AppError("HubSpot rejected this CRM change. Check the HubSpot pipeline rules, required fields, and connected-app permissions.", 422);
}

async function request(
  userId: string,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  body?: unknown,
  parameters?: Array<{ in: "query"; name: string; value: string | number }>,
  acceptedStatuses: number[] = [],
): Promise<{ status: number; data: unknown }> {
  const response = await executeComposioProxy(userId, PROVIDER, endpoint, method, body, parameters);
  if ((response.status < 200 || response.status >= 300) && !acceptedStatuses.includes(response.status)) {
    throw providerError(response.status);
  }
  return response;
}

async function assertConnected(userId: string): Promise<void> {
  const active = (await listConnections(userId)).some((connection) =>
    connection.toolkitSlug === PROVIDER && connection.status === "active" && connection.connectedAccountId,
  );
  if (!active) throw new AppError("Connect HubSpot in Settings → Connected accounts before syncing a deal.", 409);
}

async function loadDeal(userId: string, dealId: string): Promise<DealDetail> {
  const detail = await getDealDetail(userId, dealId);
  if (!detail) throw new NotFoundError("Marketing deal");
  if (!detail.deal.contactId || !detail.contact) {
    throw new AppError("Link this deal to a contact before syncing it to HubSpot.", 409);
  }
  if (!detail.contact.email?.trim()) {
    throw new AppError("Add an email address to this contact before syncing it to HubSpot.", 409);
  }
  if (detail.deal.source !== "marketing" && !detail.deal.marketingCampaignId) {
    throw new AppError("Only a campaign-attributed marketing deal can use this sync flow.", 409);
  }
  return detail;
}

async function getMapping(userId: string, recordType: "contact" | "deal", localId: string): Promise<{
  externalId: string | null; status: string; startedAt: Date | null;
} | null> {
  const result = await query(
    `SELECT external_record_id,sync_status,sync_started_at
       FROM sales_marketing_external_records
      WHERE user_id=$1 AND provider=$2 AND record_type=$3 AND local_record_id=$4`,
    [userId, PROVIDER, recordType, localId],
  );
  const row = result.rows[0];
  return row ? { externalId: row.external_record_id, status: row.sync_status, startedAt: row.sync_started_at } : null;
}

async function getMappedObject(
  userId: string,
  type: "contacts" | "deals",
  id: string,
  properties: string,
): Promise<HubSpotRecord | null> {
  const endpoint = `/crm/objects/${API_VERSION}/${type}/${encodeURIComponent(id)}`;
  const response = await request(userId, endpoint, "GET", undefined, [
    { in: "query", name: "properties", value: properties },
  ], [404]);
  if (response.status === 404) return null;
  const item = asObject(response.data);
  return typeof item.id === "string" ? item as HubSpotRecord : null;
}

async function findContact(userId: string, email: string): Promise<HubSpotRecord[]> {
  const response = await request(userId, `/crm/objects/${API_VERSION}/contacts/search`, "POST", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email.trim().toLowerCase() }] }],
    properties: ["email", "firstname", "lastname", "company", "jobtitle", "phone"], limit: 2,
  });
  return asRecords(response.data);
}

async function findDealByMarker(userId: string, marker: string): Promise<HubSpotRecord[]> {
  const response = await request(userId, `/crm/objects/${API_VERSION}/deals/search`, "POST", {
    filterGroups: [{ filters: [{ propertyName: "description", operator: "CONTAINS_TOKEN", value: marker }] }],
    properties: ["dealname", "description", "amount", "deal_currency_code", "dealstage", "pipeline", "closedate", "hubspot_owner_id"], limit: 3,
  });
  return asRecords(response.data);
}

export function dealMarker(dealId: string): string {
  return `INTERLINKDEAL${dealId.replace(/-/g, "").toUpperCase()}`;
}

function isClosedStage(stage: HubSpotPipelineStage): boolean {
  return stage.metadata?.isClosed === true || stage.metadata?.isClosed === "true";
}

export function mapHubSpotStageToInterlink(
  stage: HubSpotPipelineStage,
  pipelineId: string | null,
  selectedPipelineId: string | null,
  mappings: HubSpotStageMappings,
): DealStage | null {
  return mapConfiguredHubSpotStageToInterlink(pipelineId, stage.id, selectedPipelineId, mappings);
}

export function pickHubSpotDealStage(
  dealStage: DealStage,
  pipeline: HubSpotPipeline,
  mappings: HubSpotStageMappings,
): { id: string; label: string } {
  try {
    return pickMappedHubSpotDealStage(dealStage, pipeline, mappings);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "Map this Interlink stage in Marketing integrations.", 409);
  }
}

async function getHubSpotPipelines(userId: string): Promise<HubSpotPipeline[]> {
  const response = await request(userId, `/crm/pipelines/${API_VERSION}/deals`, "GET");
  const raw = asObject(response.data).results;
  if (!Array.isArray(raw)) return [];
  const listed = raw.map(asObject).filter((item): item is JsonObject & { id: string } =>
    typeof item.id === "string" && item.id.length > 0,
  );
  return Promise.all(listed.map(async (item) => {
    if (Array.isArray(item.stages)) return item as unknown as HubSpotPipeline;
    const detail = await request(userId, `/crm/pipelines/${API_VERSION}/deals/${encodeURIComponent(item.id)}`, "GET");
    const value = asObject(detail.data);
    return {
      id: item.id,
      label: typeof value.label === "string" ? value.label : typeof item.label === "string" ? item.label : item.id,
      stages: Array.isArray(value.stages) ? value.stages.filter((stage): stage is HubSpotPipelineStage => typeof asObject(stage).id === "string") : [],
    };
  }));
}

async function getHubSpotOwners(userId: string): Promise<HubSpotOwner[]> {
  const owners: HubSpotOwner[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await request(userId, `/crm/owners/${API_VERSION}`, "GET", undefined,
      [{ in: "query", name: "limit", value: 100 }, ...(after ? [{ in: "query" as const, name: "after", value: after }] : [])]);
    const data = asObject(response.data);
    if (Array.isArray(data.results)) {
      for (const value of data.results) {
        const row = asObject(value);
        if (typeof row.id === "string" && row.id && row.archived !== true) {
          owners.push({
            id: row.id,
            email: typeof row.email === "string" ? row.email : undefined,
            firstName: typeof row.firstName === "string" ? row.firstName : undefined,
            lastName: typeof row.lastName === "string" ? row.lastName : undefined,
          });
        }
      }
    }
    const next = asObject(asObject(data.paging).next).after;
    after = typeof next === "string" && next.length ? next : null;
    if (!after) break;
  }
  return owners;
}

async function getHubSpotMappingPreference(userId: string): Promise<HubSpotMappingPreference> {
  const result = await query<{
    pipeline_id: string | null;
    stage_mappings: HubSpotStageMappings;
    owner_mappings: Record<string, string>;
    updated_at: Date;
  }>(`SELECT pipeline_id,stage_mappings,owner_mappings,updated_at
        FROM sales_marketing_hubspot_preferences WHERE user_id=$1`, [userId]);
  const row = result.rows[0];
  return row ? {
    pipelineId: row.pipeline_id,
    stageMappings: row.stage_mappings ?? {},
    ownerMappings: row.owner_mappings ?? {},
    updatedAt: row.updated_at,
  } : { pipelineId: null, stageMappings: {}, ownerMappings: {}, updatedAt: null };
}

export async function getMarketingHubSpotSetup(userId: string): Promise<{
  pipelines: HubSpotPipeline[];
  owners: Omit<HubSpotOwner, "archived">[];
  reps: SalesRep[];
  mapping: HubSpotMappingPreference;
}> {
  await assertConnected(userId);
  const [pipelines, owners, reps, mapping] = await Promise.all([
    getHubSpotPipelines(userId), getHubSpotOwners(userId), listReps(userId), getHubSpotMappingPreference(userId),
  ]);
  return { pipelines, owners, reps, mapping };
}

export async function saveMarketingHubSpotSetup(userId: string, input: {
  pipelineId: string;
  stageMappings: HubSpotStageMappings;
  ownerMappings: Record<string, string>;
}): Promise<HubSpotMappingPreference> {
  await assertConnected(userId);
  const [pipelines, owners, reps] = await Promise.all([
    getHubSpotPipelines(userId), getHubSpotOwners(userId), listReps(userId),
  ]);
  const pipeline = pipelines.find((item) => item.id === input.pipelineId);
  if (!pipeline) throw new AppError("Choose a current HubSpot pipeline from this workspace.", 409);
  if (!pipeline.stages?.length) throw new AppError("HubSpot returned no stages for this pipeline. Check the connected app's pipeline access.", 409);

  const stageMappings: HubSpotStageMappings = {};
  for (const localStage of MARKETING_DEAL_STAGES) {
    const providerStageId = input.stageMappings[localStage];
    if (!providerStageId) continue;
    const stage = pipeline.stages.find((item) => item.id === providerStageId);
    if (!stage) throw new AppError("A selected HubSpot stage changed. Reload the setup and save again.", 409);
    const closed = isClosedStage(stage);
    const probability = Number(stage.metadata?.probability);
    if (localStage === "won" && (!closed || !Number.isFinite(probability) || probability < 1)) throw new AppError("Map Interlink's won stage to a closed-won HubSpot stage.", 400);
    if (localStage === "lost" && (!closed || !Number.isFinite(probability) || probability > 0)) throw new AppError("Map Interlink's lost stage to a closed-lost HubSpot stage.", 400);
    if (localStage !== "won" && localStage !== "lost" && closed) throw new AppError(`Map Interlink's ${localStage} stage to an open HubSpot stage.`, 400);
    stageMappings[localStage] = providerStageId;
  }

  const repIds = new Set(reps.map((rep) => rep.id));
  const ownerIds = new Set(owners.map((owner) => owner.id));
  const ownerMappings: Record<string, string> = {};
  for (const [repId, ownerId] of Object.entries(input.ownerMappings)) {
    if (!repIds.has(repId) || !ownerIds.has(ownerId)) throw new AppError("A representative or HubSpot owner changed. Reload the setup and save again.", 409);
    ownerMappings[repId] = ownerId;
  }
  if (new Set(Object.values(ownerMappings)).size !== Object.keys(ownerMappings).length) {
    throw new AppError("Each HubSpot owner can be mapped to only one Interlink representative so CRM changes can be imported unambiguously.", 400);
  }

  const result = await query<{ pipeline_id: string; stage_mappings: HubSpotStageMappings; owner_mappings: Record<string, string>; updated_at: Date }>(
    `INSERT INTO sales_marketing_hubspot_preferences (user_id,pipeline_id,stage_mappings,owner_mappings)
     VALUES ($1,$2,$3::jsonb,$4::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET pipeline_id=EXCLUDED.pipeline_id,
       stage_mappings=EXCLUDED.stage_mappings,owner_mappings=EXCLUDED.owner_mappings,updated_at=now()
     RETURNING pipeline_id,stage_mappings,owner_mappings,updated_at`,
    [userId, input.pipelineId, JSON.stringify(stageMappings), JSON.stringify(ownerMappings)],
  );
  const saved = result.rows[0];
  return { pipelineId: saved.pipeline_id, stageMappings: saved.stage_mappings, ownerMappings: saved.owner_mappings, updatedAt: saved.updated_at };
}

interface HubSpotImportSnapshot {
  detail: DealDetail;
  contact: HubSpotRecord;
  deal: HubSpotRecord;
  pipeline: HubSpotPipeline | null;
  mapping: HubSpotMappingPreference;
  reps: SalesRep[];
}

async function loadHubSpotImportSnapshot(userId: string, dealId: string): Promise<HubSpotImportSnapshot> {
  await assertConnected(userId);
  const detail = await loadDeal(userId, dealId);
  const [contactMapping, dealMapping, mapping, reps] = await Promise.all([
    getMapping(userId, "contact", detail.contact!.id), getMapping(userId, "deal", detail.deal.id),
    getHubSpotMappingPreference(userId), listReps(userId),
  ]);
  let contact: HubSpotRecord | null;
  if (contactMapping?.externalId) {
    contact = await getMappedObject(userId, "contacts", contactMapping.externalId, "email,firstname,lastname,company,jobtitle,phone");
    if (!contact) throw new AppError("The linked HubSpot contact was not found. Refresh the mapping before importing.", 409);
  } else {
    const matches = await findContact(userId, detail.contact!.email!.trim().toLowerCase());
    if (matches.length > 1) throw new AppError("HubSpot returned multiple exact email matches. Resolve the duplicate contacts before importing.", 409);
    contact = matches[0] ?? null;
  }
  let deal: HubSpotRecord | null;
  if (dealMapping?.externalId) {
    deal = await getMappedObject(userId, "deals", dealMapping.externalId, "dealname,amount,deal_currency_code,dealstage,pipeline,closedate,hubspot_owner_id");
    if (!deal) throw new AppError("The linked HubSpot deal was not found. Refresh the mapping before importing.", 409);
  } else {
    const matches = await findDealByMarker(userId, dealMarker(detail.deal.id));
    if (matches.length > 1) throw new AppError("More than one HubSpot deal has Interlink's recovery marker. Resolve that duplicate before importing.", 409);
    deal = matches[0] ?? null;
  }
  if (!contact || !deal) throw new AppError("Sync this opportunity to HubSpot once before importing provider changes.", 409);

  const pipelineId = deal.properties?.pipeline;
  let pipeline: HubSpotPipeline | null = null;
  if (pipelineId) {
    pipeline = (await getHubSpotPipelines(userId)).find((item) => item.id === pipelineId) ?? null;
  }
  return { detail, contact, deal, pipeline, mapping, reps };
}

/** Read and hash only the CRM properties supported by the reviewed import flow. */
export interface MarketingHubSpotFingerprintSnapshot {
  fingerprints: Record<string, string>; keyId: string; reviewFields: HubSpotMonitoredField[];
}

export async function readMarketingHubSpotProviderFingerprints(userId: string, dealId: string, preferredKeyId?: string): Promise<MarketingHubSpotFingerprintSnapshot> {
  await assertConnected(userId);
  const detail = await loadDeal(userId, dealId);
  const [contactMapping, dealMapping] = await Promise.all([
    getMapping(userId, "contact", detail.contact!.id), getMapping(userId, "deal", detail.deal.id),
  ]);
  if (!dealMapping?.externalId) throw new AppError("Sync this opportunity to HubSpot before enabling change checks.", 409);
  let contact: HubSpotRecord | null = null;
  if (contactMapping?.externalId) {
    contact = await getMappedObject(userId, "contacts", contactMapping.externalId, "firstname,lastname,company,jobtitle,phone");
  } else {
    const matches = await findContact(userId, detail.contact!.email!.trim().toLowerCase());
    if (matches.length > 1) throw new AppError("HubSpot returned multiple exact email matches. Resolve the duplicate contacts before monitoring.", 409);
    contact = matches[0] ?? null;
  }
  const deal = await getMappedObject(userId, "deals", dealMapping.externalId, "dealname,dealstage,amount,deal_currency_code,closedate,pipeline,hubspot_owner_id");
  if (!contact || !deal) throw new AppError("The mapped HubSpot contact or deal was not found. Review the connection before enabling change checks.", 409);
  const key = preferredKeyId ? (() => { try { return getKey(preferredKeyId); } catch { return getKey(); } })() : getKey();
  const pipelineId = deal.properties?.pipeline;
  const pipeline = pipelineId
    ? (await getHubSpotPipelines(userId)).find((item) => item.id === pipelineId) ?? null
    : null;
  const [mapping, reps] = await Promise.all([getHubSpotMappingPreference(userId), listReps(userId)]);
  const snapshot = { detail, contact, deal, pipeline, mapping, reps };
  return {
    fingerprints: fingerprintHubSpotProperties({
      contact: contact.properties ?? {},
      deal: deal.properties ?? {},
    }, key.key),
    keyId: key.kid,
    reviewFields: buildHubSpotImportPreview(snapshot).changes.map((change) => change.field),
  };
}

function property(record: HubSpotRecord, key: string): string | null {
  const value = record.properties?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasProperty(record: HubSpotRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record.properties ?? {}, key);
}

function safeProviderText(value: string | null, maxLength: number): boolean {
  return value === null || (value.length <= maxLength && !value.includes("\u0000"));
}

function parseHubSpotAmountCents(value: string | null): number | null {
  if (!value || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function normalizeHubSpotDate(value: string | null): string | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function importFingerprint(snapshot: HubSpotImportSnapshot): string {
  const { detail, contact, deal, pipeline } = snapshot;
  const relevant = (record: HubSpotRecord, keys: string[]) => keys.map((key) => [hasProperty(record, key), record.properties?.[key] ?? null]);
  const providerStage = pipeline?.stages?.find((item) => item.id === deal.properties?.dealstage);
  const payload = {
    local: {
      contactId: detail.contact!.id, name: detail.contact!.name, company: detail.contact!.company,
      title: detail.contact!.title, phone: detail.contact!.phone, dealId: detail.deal.id,
      dealTitle: detail.deal.title, stage: detail.deal.stage, amountCents: detail.deal.amountCents,
      currency: detail.deal.currency, closeDate: detail.deal.closeDate, ownerRep: detail.deal.ownerRep,
    },
    contact: { id: contact.id, properties: relevant(contact, ["firstname", "lastname", "company", "jobtitle", "phone"]) },
    deal: { id: deal.id, properties: relevant(deal, ["dealname", "amount", "deal_currency_code", "dealstage", "pipeline", "closedate", "hubspot_owner_id"]) },
    mappings: snapshot.mapping,
    stage: providerStage ? {
      id: providerStage.id, label: providerStage.label,
      isClosed: providerStage.metadata?.isClosed, probability: providerStage.metadata?.probability,
    } : null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildHubSpotImportPreview(snapshot: HubSpotImportSnapshot): HubSpotImportPreview {
  const { detail, contact, deal, pipeline } = snapshot;
  const changes: HubSpotImportChange[] = [];
  const add = (
    field: HubSpotImportField, label: string, localValue: string | null, hubspotValue: string | null,
    changed: boolean, importable = true, reason: string | null = null,
  ) => {
    if (changed) changes.push({ field, label, localValue, hubspotValue, importable, reason });
  };

  const hubspotName = [property(contact, "firstname"), property(contact, "lastname")].filter(Boolean).join(" ") || null;
  if (hasProperty(contact, "firstname") && hasProperty(contact, "lastname")) {
    const importable = Boolean(hubspotName && safeProviderText(hubspotName, 200));
    add("contact_name", "Contact name", detail.contact!.name, hubspotName, Boolean(hubspotName && hubspotName !== detail.contact!.name.trim()), importable,
      importable ? null : hubspotName ? "HubSpot contact name exceeds the supported length." : "HubSpot has no contact name to import.");
  }
  for (const [field, label, localValue, remoteValue] of [
    ["contact_company", "Company", detail.contact!.company, property(contact, "company")],
    ["contact_title", "Job title", detail.contact!.title, property(contact, "jobtitle")],
    ["contact_phone", "Phone", detail.contact!.phone, property(contact, "phone")],
  ] as const) {
    const propertyName = field === "contact_company" ? "company" : field === "contact_title" ? "jobtitle" : "phone";
    if (!hasProperty(contact, propertyName)) continue;
    const local = localValue?.trim() || null;
    const remote = remoteValue?.trim() || null;
    const limit = field === "contact_phone" ? 50 : 200;
    const importable = safeProviderText(remote, limit);
    add(field, label, local, remote, local !== remote, importable,
      importable ? null : `${label} exceeds the supported length.`);
  }

  const remoteTitle = property(deal, "dealname");
  if (hasProperty(deal, "dealname")) {
    const importable = Boolean(remoteTitle && safeProviderText(remoteTitle, 200));
    add("deal_title", "Opportunity name", detail.deal.title, remoteTitle,
      Boolean(remoteTitle && remoteTitle !== detail.deal.title.trim()), importable,
      importable ? null : remoteTitle ? "HubSpot opportunity name exceeds the supported length." : "HubSpot has no opportunity name to import.");
  }

  const remoteStageId = property(deal, "dealstage");
  const remoteStage = pipeline?.stages?.find((item) => item.id === remoteStageId);
  const mappedStage = remoteStage ? mapHubSpotStageToInterlink(
    remoteStage, property(deal, "pipeline"), snapshot.mapping.pipelineId, snapshot.mapping.stageMappings,
  ) : null;
  const remoteStageLabel = remoteStage?.label ?? remoteStageId;
  const stageImportable = Boolean(mappedStage);
  if (hasProperty(deal, "dealstage")) {
    const stageChanged = mappedStage ? mappedStage !== detail.deal.stage : Boolean(remoteStageId);
    add("deal_stage", "Opportunity stage", detail.deal.stage, remoteStageLabel,
      stageChanged, stageImportable, stageImportable ? null : "HubSpot stage cannot be mapped safely to an Interlink stage.");
  }

  const remoteAmount = property(deal, "amount");
  const remoteCurrency = property(deal, "deal_currency_code")?.toUpperCase() ?? null;
  const amountCents = parseHubSpotAmountCents(remoteAmount);
  const currencyValid = Boolean(remoteCurrency && /^[A-Z]{3}$/.test(remoteCurrency));
  const valueImportable = amountCents !== null && currencyValid;
  const localValue = `${(detail.deal.amountCents / 100).toFixed(2)} ${detail.deal.currency}`;
  const remoteValue = remoteAmount === null && remoteCurrency === null ? null : `${remoteAmount ?? "?"} ${remoteCurrency ?? "?"}`;
  if (hasProperty(deal, "amount") && hasProperty(deal, "deal_currency_code")) {
    const valueChanged = valueImportable
      ? amountCents !== detail.deal.amountCents || remoteCurrency !== detail.deal.currency.toUpperCase()
      : Boolean(remoteAmount || remoteCurrency);
    add("deal_value", "Opportunity value", localValue, remoteValue, valueChanged, valueImportable,
      valueImportable ? null : "HubSpot amount or currency is missing or invalid.");
  }

  const remoteCloseDate = property(deal, "closedate");
  const closeDate = normalizeHubSpotDate(remoteCloseDate);
  const dateImportable = remoteCloseDate === null || closeDate !== null;
  if (hasProperty(deal, "closedate")) {
    add("deal_close_date", "Expected close date", detail.deal.closeDate, closeDate,
      detail.deal.closeDate !== closeDate || !dateImportable, dateImportable,
      dateImportable ? null : "HubSpot close date is invalid.");
  }

  const remoteOwnerId = property(deal, "hubspot_owner_id");
  const mappedRepId = mapConfiguredHubSpotOwnerToRep(remoteOwnerId, snapshot.mapping.ownerMappings);
  const mappedRep = mappedRepId ? snapshot.reps.find((rep) => rep.id === mappedRepId) : null;
  const ownerImportable = remoteOwnerId === null || Boolean(mappedRep);
  if (hasProperty(deal, "hubspot_owner_id")) {
    add("deal_owner", "Opportunity owner", detail.deal.ownerRep,
      mappedRep?.name ?? (remoteOwnerId ? `Unmapped HubSpot owner (${remoteOwnerId})` : null),
      detail.deal.ownerRep !== (mappedRep?.name ?? null) || !ownerImportable,
      ownerImportable,
      ownerImportable ? null : "Map this active HubSpot owner to one Interlink sales representative before importing.");
  }

  return {
    dealId: detail.deal.id,
    fingerprint: importFingerprint(snapshot),
    changes,
    warning: "Only the fields shown can be imported. Email identity, marketing consent, campaign attribution, and follow-up history are never changed. Confirmed imports are recorded in CRM sync history.",
  };
}

export async function previewHubSpotChangesForMarketingDeal(userId: string, dealId: string): Promise<HubSpotImportPreview> {
  const snapshot = await loadHubSpotImportSnapshot(userId, dealId);
  return buildHubSpotImportPreview(snapshot);
}

export async function importHubSpotChangesForMarketingDeal(
  userId: string,
  dealId: string,
  expectedFingerprint: string,
  fields: HubSpotImportField[],
): Promise<{ importedFields: HubSpotImportField[]; contactId: string; dealId: string }> {
  const snapshot = await loadHubSpotImportSnapshot(userId, dealId);
  const preview = buildHubSpotImportPreview(snapshot);
  if (preview.fingerprint !== expectedFingerprint) {
    throw new AppError("HubSpot or Interlink changed after this preview. Refresh the review before importing.", 409);
  }
  const allowed = new Map(preview.changes.filter((change) => change.importable).map((change) => [change.field, change]));
  const selected = [...new Set(fields)];
  if (!selected.length || selected.some((field) => !allowed.has(field))) {
    throw new AppError("Select at least one safe, changed field from the current HubSpot preview.", 400);
  }

  const contact = snapshot.contact;
  const deal = snapshot.deal;
  const dealProps = deal.properties ?? {};
  const selectedSet = new Set(selected);
  const ownerRepId = selectedSet.has("deal_owner")
    ? mapConfiguredHubSpotOwnerToRep(property(deal, "hubspot_owner_id"), snapshot.mapping.ownerMappings)
    : undefined;
  const ownerRep = ownerRepId ? snapshot.reps.find((rep) => rep.id === ownerRepId)?.name ?? null : null;
  const contactName = [property(contact, "firstname"), property(contact, "lastname")].filter(Boolean).join(" ").trim();
  const importedDetail = selected.map((field) => allowed.get(field)!.label).join(", ");
  await claimSync(userId, snapshot.detail.deal);
  try {
    await withTransaction(async (client) => {
      const currentDeal = await client.query<{ title: string; stage: DealStage; amount_cents: string | number; currency: string; close_date: string | null; owner_rep: string | null }>(
        `SELECT title,stage,amount_cents,currency,close_date,owner_rep FROM sales_deals WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [snapshot.detail.deal.id, userId],
      );
      const lockedDeal = currentDeal.rows[0];
      if (!lockedDeal) throw new NotFoundError("Marketing opportunity");
      const closeDateNow = lockedDeal.close_date ? String(lockedDeal.close_date).slice(0, 10) : null;
      if (lockedDeal.title !== snapshot.detail.deal.title || lockedDeal.stage !== snapshot.detail.deal.stage
        || Number(lockedDeal.amount_cents) !== snapshot.detail.deal.amountCents
        || lockedDeal.currency !== snapshot.detail.deal.currency || closeDateNow !== snapshot.detail.deal.closeDate
        || lockedDeal.owner_rep !== snapshot.detail.deal.ownerRep) {
        throw new AppError("The Interlink opportunity changed while this import was starting. Refresh the review before importing.", 409);
      }
      const currentContact = await client.query<{ name: string; company: string | null; title: string | null; phone: string | null }>(
        `SELECT name,company,title,phone FROM sales_contacts WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [snapshot.detail.contact!.id, userId],
      );
      const lockedContact = currentContact.rows[0];
      if (!lockedContact) throw new NotFoundError("Marketing contact");
      if (lockedContact.name !== snapshot.detail.contact!.name || lockedContact.company !== snapshot.detail.contact!.company
        || lockedContact.title !== snapshot.detail.contact!.title || lockedContact.phone !== snapshot.detail.contact!.phone) {
        throw new AppError("The Interlink contact changed while this import was starting. Refresh the review before importing.", 409);
      }

      const contactFields = selected.some((field) => field.startsWith("contact_"));
      if (contactFields) {
        const updated = await client.query(
          `UPDATE sales_contacts SET
             name=CASE WHEN $3::boolean THEN $4 ELSE name END,
             company=CASE WHEN $5::boolean THEN $6 ELSE company END,
             title=CASE WHEN $7::boolean THEN $8 ELSE title END,
             phone=CASE WHEN $9::boolean THEN $10 ELSE phone END,
             updated_at=now()
           WHERE id=$1 AND user_id=$2 RETURNING id`,
          [snapshot.detail.contact!.id, userId,
            selectedSet.has("contact_name"), contactName,
            selectedSet.has("contact_company"), property(contact, "company"),
            selectedSet.has("contact_title"), property(contact, "jobtitle"),
            selectedSet.has("contact_phone"), property(contact, "phone")],
        );
        if (!updated.rows[0]) throw new NotFoundError("Marketing contact");
      }

      const dealFields = selected.some((field) => field.startsWith("deal_"));
      let updatedStage: DealStage | null = null;
      if (dealFields) {
        const stage = selectedSet.has("deal_stage")
          ? snapshot.pipeline?.stages?.find((item) => item.id === dealProps.dealstage)
          : null;
        updatedStage = stage ? mapHubSpotStageToInterlink(
          stage, property(deal, "pipeline"), snapshot.mapping.pipelineId, snapshot.mapping.stageMappings,
        ) : null;
        const amountCents = selectedSet.has("deal_value") ? parseHubSpotAmountCents(property(deal, "amount")) : null;
        const currency = selectedSet.has("deal_value") ? property(deal, "deal_currency_code")?.toUpperCase() ?? null : null;
        const closeDateRaw = property(deal, "closedate");
        const closeDate = selectedSet.has("deal_close_date") ? normalizeHubSpotDate(closeDateRaw) : null;
        const updated = await client.query(
          `UPDATE sales_deals SET
             title=CASE WHEN $3::boolean THEN $4 ELSE title END,
             stage=CASE WHEN $5::boolean THEN $6 ELSE stage END,
             amount_cents=CASE WHEN $7::boolean THEN $8 ELSE amount_cents END,
             currency=CASE WHEN $7::boolean THEN $9 ELSE currency END,
             close_date=CASE WHEN $10::boolean THEN $11::date ELSE close_date END,
             owner_rep=CASE WHEN $12::boolean THEN $13 ELSE owner_rep END,
             last_activity_at=now(),updated_at=now()
           WHERE id=$1 AND user_id=$2 RETURNING contact_id,stage`,
          [snapshot.detail.deal.id, userId,
            selectedSet.has("deal_title"), property(deal, "dealname"),
            selectedSet.has("deal_stage"), updatedStage,
            selectedSet.has("deal_value"), amountCents, currency,
            selectedSet.has("deal_close_date"), closeDate,
            selectedSet.has("deal_owner"), ownerRep],
        );
        if (!updated.rows[0]) throw new NotFoundError("Marketing opportunity");
        if (updatedStage === "won" && updated.rows[0].contact_id) {
          await client.query(`UPDATE sales_contacts SET marketing_lead_status='converted',updated_at=now() WHERE id=$1 AND user_id=$2`, [updated.rows[0].contact_id, userId]);
        }
        await client.query(
          `INSERT INTO sales_activities(user_id,deal_id,contact_id,kind,note)
           VALUES($1,$2,$3,'hubspot_reconciled',$4)`,
          [userId, snapshot.detail.deal.id, snapshot.detail.contact!.id, `Imported reviewed HubSpot fields: ${importedDetail}.`],
        );
      }

      for (const [recordType, localId, externalId] of [
        ["contact", snapshot.detail.contact!.id, contact.id], ["deal", snapshot.detail.deal.id, deal.id],
      ] as const) {
        await client.query(
          `INSERT INTO sales_marketing_external_records
             (user_id,provider,record_type,local_record_id,external_record_id,sync_status,sync_started_at,last_synced_at,last_error)
           VALUES($1,$2,$3,$4,$5,'synced',NULL,now(),NULL)
           ON CONFLICT (user_id,provider,record_type,local_record_id)
           DO UPDATE SET external_record_id=EXCLUDED.external_record_id,sync_status='synced',sync_started_at=NULL,
             last_synced_at=now(),last_error=NULL,updated_at=now()`,
          [userId, PROVIDER, recordType, localId, externalId],
        );
        await client.query(
          `INSERT INTO sales_marketing_external_sync_events
             (user_id,provider,record_type,local_record_id,external_record_id,operation,outcome,detail)
           VALUES($1,$2,$3,$4,$5,'reconcile','success',$6)`,
          [userId, PROVIDER, recordType, localId, externalId, `Imported reviewed HubSpot fields: ${importedDetail}.`],
        );
      }

      const monitor = await client.query<{ provider_change_fields: string[] }>(
        `SELECT provider_change_fields FROM sales_marketing_external_records
          WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3 FOR UPDATE`,
        [userId, PROVIDER, snapshot.detail.deal.id],
      );
      const pendingFields = new Set<string>(monitor.rows[0]?.provider_change_fields ?? []);
      for (const change of preview.changes) pendingFields.add(change.field);
      for (const field of selectedSet) pendingFields.delete(field);
      const remainingFields = [...pendingFields].sort();
      const currentKey = getKey();
      const currentFingerprints = fingerprintHubSpotProperties({
        contact: snapshot.contact.properties ?? {},
        deal: snapshot.deal.properties ?? {},
      }, currentKey.key);
      await client.query(
        `UPDATE sales_marketing_external_records
            SET provider_fingerprints=$4::jsonb,provider_fingerprint_key_id=$6,provider_change_fields=$5::text[],
                provider_changed_at=CASE WHEN cardinality($5::text[])>0 THEN COALESCE(provider_changed_at,now()) ELSE NULL END,
                provider_check_error=NULL,updated_at=now()
          WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3`,
        [userId, PROVIDER, snapshot.detail.deal.id, JSON.stringify(currentFingerprints), remainingFields, currentKey.kid],
      );
    });
    return { importedFields: selected, contactId: contact.id, dealId: deal.id };
  } catch (error) {
    try { await recordFailure(userId, snapshot.detail.deal.id, snapshot.detail.contact!.id, error); }
    catch { /* preserve the import failure; audit errors must not mask it */ }
    throw error;
  }
}

async function resolveHubSpotOwner(
  userId: string,
  deal: DealDetail["deal"],
  contactId: string,
  mapping: HubSpotMappingPreference,
): Promise<{ repName: string; ownerId: string; ownerName: string } | null> {
  const result = deal.ownerRep?.trim()
    ? await query<{ id: string; name: string }>(
      `SELECT id,name FROM sales_reps
        WHERE user_id=$1 AND (id::text=$2 OR lower(name)=lower($2))
        ORDER BY CASE WHEN id::text=$2 THEN 0 ELSE 1 END LIMIT 2`,
      [userId, deal.ownerRep.trim()],
    )
    : await query<{ id: string; name: string }>(
      `SELECT r.id,r.name FROM sales_contacts c
         JOIN sales_reps r ON r.id=c.marketing_owner_rep_id AND r.user_id=c.user_id
        WHERE c.id=$1 AND c.user_id=$2 LIMIT 2`,
      [contactId, userId],
    );
  if (!result.rows.length) return null;
  if (result.rows.length !== 1) {
    throw new AppError("Add this deal owner to the Sales representative roster and map them in Marketing integrations before syncing.", 409);
  }
  const rep = result.rows[0];
  const ownerId = mapping.ownerMappings[rep.id];
  if (!ownerId) throw new AppError(`Map ${rep.name} to an active HubSpot owner in Marketing integrations before syncing this deal.`, 409);
  const owner = (await getHubSpotOwners(userId)).find((item) => item.id === ownerId);
  if (!owner) throw new AppError(`The HubSpot owner mapped to ${rep.name} is no longer active. Refresh Marketing integrations and update the mapping.`, 409);
  const ownerName = [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim() || owner.email || owner.id;
  return { repName: rep.name, ownerId: owner.id, ownerName };
}

async function previewData(userId: string, dealId: string): Promise<HubSpotSyncPreview> {
  await assertConnected(userId);
  const detail = await loadDeal(userId, dealId);
  const [contactMapping, dealMapping, mapping, pipelines] = await Promise.all([
    getMapping(userId, "contact", detail.contact!.id),
    getMapping(userId, "deal", detail.deal.id),
    getHubSpotMappingPreference(userId),
    getHubSpotPipelines(userId),
  ]);
  if (!mapping.pipelineId) throw new AppError("Choose a HubSpot deal pipeline and map the required Interlink stages in Marketing integrations before syncing.", 409);
  const pipeline = pipelines.find((item) => item.id === mapping.pipelineId);
  if (!pipeline) throw new AppError("The configured HubSpot pipeline is no longer available. Refresh Marketing integrations and choose a current pipeline.", 409);
  const email = detail.contact!.email!.trim().toLowerCase();
  let externalContact: HubSpotRecord | null = null;
  if (contactMapping?.externalId) {
    externalContact = await getMappedObject(userId, "contacts", contactMapping.externalId, "email,firstname,lastname,company,jobtitle,phone");
    if (!externalContact) throw new AppError("The linked HubSpot contact was not found. Review the connection or resolve the stale mapping before syncing again.", 409);
  } else {
    const matches = await findContact(userId, email);
    if (matches.length > 1) throw new AppError("HubSpot returned multiple exact email matches. Resolve the duplicate contacts in HubSpot first.", 409);
    externalContact = matches[0] ?? null;
  }

  const marker = dealMarker(detail.deal.id);
  let externalDeal: HubSpotRecord | null = null;
  if (dealMapping?.externalId) {
    externalDeal = await getMappedObject(userId, "deals", dealMapping.externalId, "dealname,description,amount,deal_currency_code,dealstage,pipeline,closedate,hubspot_owner_id");
    if (!externalDeal) throw new AppError("The linked HubSpot deal was not found. Review the connection or resolve the stale mapping before syncing again.", 409);
  } else {
    const matches = await findDealByMarker(userId, marker);
    if (matches.length > 1) throw new AppError("More than one HubSpot deal has Interlink's recovery marker. Resolve that duplicate before syncing.", 409);
    externalDeal = matches[0] ?? null;
  }

  const selectedStage = pickHubSpotDealStage(detail.deal.stage, pipeline, mapping.stageMappings);
  const owner = await resolveHubSpotOwner(userId, detail.deal, detail.contact!.id, mapping);
  const preview = {
    dealId: detail.deal.id,
    contact: {
      action: externalContact ? "update" as const : "create" as const, externalId: externalContact?.id ?? null,
      email, name: detail.contact!.name, company: detail.contact!.company, title: detail.contact!.title,
      phone: detail.contact!.phone, existing: externalContact?.properties ?? null,
    },
    deal: {
      action: externalDeal ? "update" as const : "create" as const, externalId: externalDeal?.id ?? null,
      campaignId: detail.deal.marketingCampaignId,
      title: detail.deal.title, stage: detail.deal.stage, hubspotStage: selectedStage.label,
      hubspotStageId: selectedStage.id,
      pipeline: pipeline.label ?? pipeline.id,
      pipelineId: pipeline.id,
      ownerRep: owner?.repName ?? detail.deal.ownerRep,
      hubspotOwner: owner?.ownerName ?? null,
      hubspotOwnerId: owner?.ownerId ?? null,
      amountCents: detail.deal.amountCents, currency: detail.deal.currency,
      closeDate: detail.deal.closeDate, notes: detail.deal.notes,
      existing: externalDeal?.properties ?? null,
    },
    consent: "unchanged" as const,
    warning: "This confirmed one-way sync updates HubSpot contact/deal fields. It never changes consent or sends email. Interlink remains the source for campaign attribution and follow-up history.",
  };
  const fingerprint = fingerprintHubSpotSyncPreview(preview);
  return { ...preview, fingerprint };
}

export async function previewMarketingDealHubSpotSync(userId: string, dealId: string): Promise<HubSpotSyncPreview> {
  return previewData(userId, dealId);
}

async function claimSync(userId: string, deal: DealDetail["deal"]): Promise<void> {
  await withTransaction(async (client) => {
    for (const [recordType, localRecordId] of [["contact", deal.contactId!], ["deal", deal.id]] as const) {
      const claim = await client.query(
        `INSERT INTO sales_marketing_external_records
           (user_id,provider,record_type,local_record_id,sync_status,sync_started_at,last_error)
         VALUES($1,$2,$3,$4,'syncing',now(),NULL)
         ON CONFLICT (user_id,provider,record_type,local_record_id)
         DO UPDATE SET sync_status='syncing',sync_started_at=now(),last_error=NULL,updated_at=now()
          WHERE sales_marketing_external_records.sync_status <> 'syncing'
             OR sales_marketing_external_records.sync_started_at < now() - ($5::int * interval '1 minute')
         RETURNING id`,
        [userId, PROVIDER, recordType, localRecordId, LOCK_STALE_AFTER_MINUTES],
      );
      if (!claim.rows[0]) throw new AppError("A HubSpot sync for this deal is already running. Refresh its status before retrying.", 409);
    }
  });
}

async function saveRecord(
  userId: string,
  type: "contact" | "deal",
  localId: string,
  externalId: string,
  operation: "create" | "update" | "associate" | "reconcile",
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE sales_marketing_external_records
          SET external_record_id=$5,sync_status='synced',sync_started_at=NULL,
              last_synced_at=now(),last_error=NULL,updated_at=now()
        WHERE user_id=$1 AND provider=$2 AND record_type=$3 AND local_record_id=$4`,
      [userId, PROVIDER, type, localId, externalId],
    );
    await client.query(
      `INSERT INTO sales_marketing_external_sync_events
         (user_id,provider,record_type,local_record_id,external_record_id,operation,outcome,detail)
       VALUES($1,$2,$3,$4,$5,$6,'success',$7)`,
      [userId, PROVIDER, type, localId, externalId, operation, `HubSpot ${type} ${operation} completed.`],
    );
  });
}

async function recordFailure(userId: string, dealId: string, contactId: string, error: unknown): Promise<void> {
  const needsReview = error instanceof AppError && error.statusCode >= 500;
  const status = needsReview ? "review" : "failed";
  const safeDetail = error instanceof AppError ? error.message : "HubSpot did not confirm this change. Review the provider record before retrying.";
  await withTransaction(async (client) => {
    for (const [recordType, localRecordId] of [["contact", contactId], ["deal", dealId]] as const) {
      await client.query(
        `UPDATE sales_marketing_external_records SET sync_status=$5,sync_started_at=NULL,last_error=$6,updated_at=now()
          WHERE user_id=$1 AND provider=$2 AND record_type=$3 AND local_record_id=$4 AND sync_status='syncing'`,
        [userId, PROVIDER, recordType, localRecordId, status, safeDetail.slice(0, 1000)],
      );
      await client.query(
        `INSERT INTO sales_marketing_external_sync_events
           (user_id,provider,record_type,local_record_id,operation,outcome,detail)
         VALUES($1,$2,$3,$4,'reconcile',$5,$6)`,
        [userId, PROVIDER, recordType, localRecordId, needsReview ? "review" : "failure", safeDetail.slice(0, 1000)],
      );
    }
  });
}

function contactProperties(preview: HubSpotSyncPreview["contact"]): Record<string, string> {
  const [firstName, ...lastName] = preview.name.trim().split(/\s+/);
  return {
    email: preview.email,
    ...(firstName ? { firstname: firstName } : {}),
    ...(lastName.length ? { lastname: lastName.join(" ") } : {}),
    ...(preview.company?.trim() ? { company: preview.company.trim() } : {}),
    ...(preview.title?.trim() ? { jobtitle: preview.title.trim() } : {}),
    ...(preview.phone?.trim() ? { phone: preview.phone.trim() } : {}),
  };
}

async function writeContact(userId: string, preview: HubSpotSyncPreview["contact"]): Promise<{ id: string; operation: "create" | "update" | "reconcile" }> {
  const properties = contactProperties(preview);
  if (preview.externalId) {
    const current = preview.existing ?? {};
    const changed = Object.fromEntries(Object.entries(properties).filter(([key, value]) =>
      key === "email" ? false : (current[key] ?? "") !== value,
    ));
    if (Object.keys(changed).length) {
      await request(userId, `/crm/objects/${API_VERSION}/contacts/${encodeURIComponent(preview.externalId)}`, "PATCH", { properties: changed });
    }
    return { id: preview.externalId, operation: "update" };
  }
  const created = await request(userId, `/crm/objects/${API_VERSION}/contacts`, "POST", { properties });
  const id = asObject(created.data).id;
  if (typeof id === "string" && id) return { id, operation: "create" };
  const recovered = await findContact(userId, preview.email);
  if (recovered.length === 1) return { id: recovered[0].id, operation: "reconcile" };
  throw new AppError("HubSpot did not return a verifiable contact ID. Review HubSpot before retrying.", 502);
}

async function associationTypeId(userId: string): Promise<number> {
  const response = await request(userId, `/crm/associations/${API_VERSION}/deals/contacts/labels`, "GET");
  const labels = asObject(response.data).results;
  if (!Array.isArray(labels)) throw new AppError("HubSpot did not return deal/contact association types.", 409);
  const defaultLabel = labels.map(asObject).find((row) => row.category === "HUBSPOT_DEFINED" && typeof row.typeId === "number");
  if (!defaultLabel) throw new AppError("HubSpot has no available default deal/contact association.", 409);
  return defaultLabel.typeId as number;
}

async function writeDeal(
  userId: string,
  dealId: string,
  contactId: string,
  preview: HubSpotSyncPreview["deal"],
): Promise<{ id: string; operation: "create" | "update" | "reconcile" }> {
  const marker = dealMarker(dealId);
  const description = [
    marker,
    preview.campaignId ? `Interlink campaign ID: ${preview.campaignId}` : null,
    preview.notes?.trim() ? `Interlink notes: ${preview.notes.trim()}` : null,
  ].filter(Boolean).join("\n\n");
  const properties: Record<string, string> = {
    dealname: preview.title,
    dealstage: preview.hubspotStageId,
    pipeline: preview.pipelineId,
    amount: (preview.amountCents / 100).toFixed(2),
    deal_currency_code: preview.currency.toUpperCase(),
    description,
  };
  if (preview.hubspotOwnerId) properties.hubspot_owner_id = preview.hubspotOwnerId;
  if (preview.closeDate) properties.closedate = `${preview.closeDate.slice(0, 10)}T00:00:00.000Z`;

  let id = preview.externalId;
  let operation: "create" | "update" | "reconcile" = preview.externalId ? "update" : "create";
  if (id) {
    await request(userId, `/crm/objects/${API_VERSION}/deals/${encodeURIComponent(id)}`, "PATCH", { properties });
  } else {
    const created = await request(userId, `/crm/objects/${API_VERSION}/deals`, "POST", { properties });
    const resultId = asObject(created.data).id;
    if (typeof resultId === "string" && resultId) id = resultId;
    else {
      const recovered = await findDealByMarker(userId, marker);
      if (recovered.length !== 1) throw new AppError("HubSpot did not return one verifiable deal ID. Review HubSpot before retrying.", 502);
      id = recovered[0].id;
      operation = "reconcile";
    }
  }
  if (!id) throw new AppError("HubSpot returned no deal ID.", 502);

  const associationId = await associationTypeId(userId);
  await request(userId,
    `/crm/objects/${API_VERSION}/deals/${encodeURIComponent(id)}/associations/contacts/${encodeURIComponent(contactId)}`,
    "PUT", [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: associationId }], undefined, [409],
  );
  return { id, operation };
}

export async function syncMarketingDealToHubSpot(userId: string, dealId: string, expectedFingerprint: string): Promise<{
  contactId: string; dealId: string; contactAction: string; dealAction: string;
}> {
  const preview = await previewData(userId, dealId);
  if (preview.fingerprint !== expectedFingerprint) {
    throw new AppError("HubSpot, Interlink, or the mapping changed after this preview. Refresh the review before syncing.", 409);
  }
  const detail = await loadDeal(userId, dealId);
  await claimSync(userId, detail.deal);

  try {
    const contact = await writeContact(userId, preview.contact);
    await saveRecord(userId, "contact", detail.contact!.id, contact.id, contact.operation);
    const deal = await writeDeal(userId, detail.deal.id, contact.id, preview.deal);
    await saveRecord(userId, "deal", detail.deal.id, deal.id, deal.operation);
    const monitoring = await query<{ monitor_enabled: boolean }>(
      `SELECT monitor_enabled FROM sales_marketing_external_records
        WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3`,
      [userId, PROVIDER, detail.deal.id],
    );
    if (monitoring.rows[0]?.monitor_enabled) {
      try {
        const providerSnapshot = await readMarketingHubSpotProviderFingerprints(userId, detail.deal.id);
        await query(
          `UPDATE sales_marketing_external_records
              SET provider_fingerprints=$4::jsonb,provider_fingerprint_key_id=$5,provider_change_fields=ARRAY[]::text[],
                  provider_changed_at=NULL,provider_last_checked_at=now(),provider_check_error=NULL,updated_at=now()
            WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3`,
          [userId, PROVIDER, detail.deal.id, JSON.stringify(providerSnapshot.fingerprints), providerSnapshot.keyId],
        );
      } catch {
        // A successful outbound sync must not be reclassified as failed because a follow-up read failed.
      }
    }
    return { contactId: contact.id, dealId: deal.id, contactAction: contact.operation, dealAction: deal.operation };
  } catch (error) {
    try { await recordFailure(userId, detail.deal.id, detail.contact!.id, error); }
    catch { /* preserve the CRM error; a failed audit write must not mask it */ }
    throw error;
  }
}
