import { createHmac } from "node:crypto";

export const HUBSPOT_MONITORED_PROPERTIES = {
  firstname: "contact_name",
  lastname: "contact_name",
  company: "contact_company",
  jobtitle: "contact_title",
  phone: "contact_phone",
  dealname: "deal_title",
  dealstage: "deal_stage",
  hubspot_owner_id: "deal_owner",
  amount: "deal_value",
  deal_currency_code: "deal_value",
  closedate: "deal_close_date",
} as const;

export type HubSpotMonitoredField = typeof HUBSPOT_MONITORED_PROPERTIES[keyof typeof HUBSPOT_MONITORED_PROPERTIES];

export interface HubSpotMonitoredProperties {
  contact: Record<string, string | null | undefined>;
  deal: Record<string, string | null | undefined>;
}

/** Hash only supported CRM properties; never persist provider values in the monitoring state. */
export function fingerprintHubSpotProperties(properties: HubSpotMonitoredProperties, secret: Buffer | string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [property, field] of Object.entries(HUBSPOT_MONITORED_PROPERTIES)) {
    const isDealField = field.startsWith("deal_");
    const source = isDealField ? properties.deal : properties.contact;
    const value = source[property] ?? null;
    const fingerprintKey = `${isDealField ? "deal" : "contact"}.${property}`;
    output[fingerprintKey] = createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
  }
  return output;
}

export function changedHubSpotFields(
  previous: Record<string, string>,
  current: Record<string, string>,
): HubSpotMonitoredField[] {
  const fields = new Set<HubSpotMonitoredField>();
  for (const [property, field] of Object.entries(HUBSPOT_MONITORED_PROPERTIES) as Array<[keyof typeof HUBSPOT_MONITORED_PROPERTIES, HubSpotMonitoredField]>) {
    const key = property.startsWith("deal") || property === "amount" || property === "deal_currency_code" || property === "closedate"
      ? `deal.${property}`
      : `contact.${property}`;
    if (Object.prototype.hasOwnProperty.call(previous, key) && previous[key] !== current[key]) fields.add(field);
  }
  return [...fields].sort();
}

export function mergeHubSpotReviewFields(
  pending: readonly string[],
  changed: readonly HubSpotMonitoredField[],
  reviewed: readonly string[] = [],
): HubSpotMonitoredField[] {
  const reviewedSet = new Set(reviewed);
  return [...new Set([...pending, ...changed])]
    .filter((field): field is HubSpotMonitoredField => Object.values(HUBSPOT_MONITORED_PROPERTIES).includes(field as HubSpotMonitoredField))
    .filter((field) => !reviewedSet.has(field))
    .sort();
}
