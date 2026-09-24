import type { NotionDataSourceProperty } from "../../notion/notion.service";

export type MarketingNotionField = "objective" | "audience" | "offer" | "successMetric" | "channels" | "startDate" | "endDate" | "budget" | "campaignId";
export type MarketingNotionMapping = Partial<Record<MarketingNotionField, string | null>> & { campaignId: string };

const fieldTypes: Record<MarketingNotionField, string[]> = {
  campaignId: ["rich_text"], objective: ["rich_text"], audience: ["rich_text"], offer: ["rich_text"],
  successMetric: ["rich_text"], channels: ["rich_text"], startDate: ["date"], endDate: ["date"], budget: ["number"],
};

export function validateMarketingNotionMapping(mapping: MarketingNotionMapping, properties: NotionDataSourceProperty[]): string {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || typeof mapping.campaignId !== "string" || !mapping.campaignId.trim()) {
    throw new Error("Map a rich text property to the Interlink campaign ID before exporting.");
  }
  const titleProperty = properties.find((property) => property.type === "title")?.name;
  if (!titleProperty) throw new Error("This Notion database has no title property.");
  const used = new Set<string>([titleProperty]);
  for (const field of Object.keys(fieldTypes) as MarketingNotionField[]) {
    const value = mapping[field];
    if (value === null || value === undefined || value === "") {
      if (field === "campaignId") throw new Error("Map a rich text property to the Interlink campaign ID before exporting.");
      continue;
    }
    const property = properties.find((item) => item.name === value);
    if (!property || !fieldTypes[field].includes(property.type)) throw new Error(`Choose a compatible Notion property for ${field}.`);
    if (used.has(property.name)) throw new Error("Each mapped field must use a different Notion property.");
    used.add(property.name);
  }
  return titleProperty;
}
