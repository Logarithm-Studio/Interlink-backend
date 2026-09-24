import { createHash } from "node:crypto";
import type { DealStage } from "../sales/sales.service";

export const MARKETING_DEAL_STAGES: readonly DealStage[] = [
  "lead", "qualified", "proposal", "negotiation", "nurture", "won", "lost",
];

export type HubSpotStage = {
  id: string;
  label?: string;
  metadata?: { isClosed?: boolean | string; probability?: string | number };
};

export type HubSpotPipeline = {
  id: string;
  label?: string;
  stages?: HubSpotStage[];
};

export type HubSpotStageMappings = Partial<Record<DealStage, string>>;

export function fingerprintHubSpotSyncPreview(preview: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(preview)).digest("hex");
}

function isClosed(stage: HubSpotStage): boolean {
  return stage.metadata?.isClosed === true || stage.metadata?.isClosed === "true";
}

export function pickMappedHubSpotDealStage(
  dealStage: DealStage,
  pipeline: HubSpotPipeline,
  mappings: HubSpotStageMappings,
): { id: string; label: string } {
  const mappedId = mappings[dealStage];
  if (!mappedId) {
    throw new Error(`Map the Interlink “${dealStage}” stage to a HubSpot stage in Marketing integrations before syncing.`);
  }
  const stage = pipeline.stages?.find((item) => item.id === mappedId);
  if (!stage) throw new Error("The configured HubSpot stage is no longer in the selected pipeline. Refresh Marketing integrations and update the mapping.");

  const probability = Number(stage.metadata?.probability);
  if (dealStage === "won" && (!isClosed(stage) || !Number.isFinite(probability) || probability < 1)) {
    throw new Error("Map Interlink’s won stage to a closed-won HubSpot stage.");
  }
  if (dealStage === "lost" && (!isClosed(stage) || !Number.isFinite(probability) || probability > 0)) {
    throw new Error("Map Interlink’s lost stage to a closed-lost HubSpot stage.");
  }
  if (dealStage !== "won" && dealStage !== "lost" && isClosed(stage)) {
    throw new Error(`Map Interlink’s ${dealStage} stage to an open HubSpot stage.`);
  }
  return { id: stage.id, label: stage.label ?? stage.id };
}

/** Imports only a uniquely configured stage mapping; stage names and order are never guessed. */
export function mapConfiguredHubSpotStageToInterlink(
  pipelineId: string | null,
  stageId: string | null,
  selectedPipelineId: string | null,
  mappings: HubSpotStageMappings,
): DealStage | null {
  if (!pipelineId || !stageId || pipelineId !== selectedPipelineId) return null;
  const matches = MARKETING_DEAL_STAGES.filter((stage) => mappings[stage] === stageId);
  return matches.length === 1 ? matches[0] : null;
}

export function mapConfiguredHubSpotOwnerToRep(
  ownerId: string | null,
  mappings: Record<string, string>,
): string | null {
  if (!ownerId) return null;
  const matches = Object.entries(mappings).filter(([, hubSpotOwnerId]) => hubSpotOwnerId === ownerId);
  return matches.length === 1 ? matches[0][0] : null;
}
