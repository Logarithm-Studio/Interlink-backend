export function resolveMarketingTodoistProjectId(
  campaignProjectId: string | null,
  defaultProjectId: string | null,
): string | null {
  return campaignProjectId ?? defaultProjectId;
}
