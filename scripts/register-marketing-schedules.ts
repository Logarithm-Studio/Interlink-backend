import "dotenv/config";
import { Client } from "@upstash/qstash";

type MarketingSchedule = {
  name: string;
  path: string;
  cron: string;
  description: string;
};

const SCHEDULES: MarketingSchedule[] = [
  {
    name: "hourly",
    path: "/api/v1/workers/marketing-todoist-dispatch",
    cron: "0 * * * *",
    description: "Todoist reconciliation, opted-in reminders, HubSpot checks, and scheduled social publishing",
  },
  {
    name: "daily",
    path: "/api/v1/workers/marketing-analytics-dispatch",
    cron: "15 2 * * *",
    description: "Opted-in analytics refresh and social post monitoring",
  },
];

function getDestination(path: string): string {
  const base = process.env.API_BASE_URL?.trim();
  if (!base) throw new Error("Set API_BASE_URL to the public backend origin before registering schedules.");

  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new Error("API_BASE_URL must be an absolute HTTP(S) URL.");
  }

  const isLocal = baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1";
  if (baseUrl.protocol !== "https:" && !(isLocal && baseUrl.protocol === "http:")) {
    throw new Error("API_BASE_URL must use HTTPS (HTTP is allowed only for localhost previews).");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("API_BASE_URL must not contain credentials, a query string, or a fragment.");
  }

  return new URL(path, baseUrl).toString();
}

function scheduleId(name: string, destination: string): string {
  const hostname = new URL(destination).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `interlink-marketing-${name}-${hostname}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--apply" && arg !== "--dry-run");
  if (unknownArgs.length) throw new Error(`Unknown option(s): ${unknownArgs.join(", ")}. Use --apply or --dry-run.`);

  const definitions = SCHEDULES.map((schedule) => {
    const destination = getDestination(schedule.path);
    return { ...schedule, destination, scheduleId: scheduleId(schedule.name, destination) };
  });

  if (!apply) {
    process.stdout.write("Dry run. No QStash schedules were changed.\n");
    for (const schedule of definitions) {
      process.stdout.write(`- ${schedule.name}: ${schedule.cron} UTC -> ${schedule.destination}\n  ${schedule.description}\n  ID: ${schedule.scheduleId}\n`);
    }
    process.stdout.write("Run `npm run marketing:schedules -- --apply` to create or update these schedules.\n");
    return;
  }

  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) throw new Error("Set QSTASH_TOKEN before applying schedules.");
  const client = new Client({ token });
  for (const schedule of definitions) {
    const result = await client.schedules.create({
      destination: schedule.destination,
      scheduleId: schedule.scheduleId,
      cron: schedule.cron,
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
      retries: 3,
      label: `interlink-marketing-${schedule.name}`,
    });
    process.stdout.write(`Registered ${schedule.name} marketing schedule: ${result.scheduleId} -> ${schedule.destination}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Marketing schedule setup failed: ${message}\n`);
  process.exitCode = 1;
});
