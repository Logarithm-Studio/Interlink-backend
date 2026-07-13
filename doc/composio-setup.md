# Composio setup

Composio brokers OAuth + API access to the long tail of third-party apps (HubSpot, Salesforce,
Stripe, Zendesk, Intercom, QuickBooks, Linear, Asana, Greenhouse, DocuSign, Mailchimp, Zoom,
Calendly, Dropbox, Airtable, Telegram, Discord).

**The point:** every native integration in this repo (Google, Slack, Notion, Jira, GitHub, Trello,
Todoist, Spotify, Microsoft) required registering an OAuth app, holding a client secret, and
writing a bespoke service. Composio owns the OAuth apps, so a toolkit connects with
`composio.toolkits.authorize(userId, slug)` and **we register nothing and store no tokens**.

## Setup (one key, ~2 minutes)

1. Create an account at [composio.dev](https://composio.dev) and copy your API key.
2. Add it to `.env`:
   ```
   COMPOSIO_API_KEY=<your-key>
   ```
3. Run `npm run migrate` (applies `060_composio_connections.sql`).
4. Restart the server. The app's **Settings → Connected accounts** screen now shows a
   **More Apps** section; each row connects in one tap.

That's the whole setup. There is no per-vendor configuration.

## What it costs

Composio **meters tool executions** — not a free lunch, just a different bill:

| Plan | Tool calls / month | Price |
|---|---|---|
| Free | 20,000 | $0 |
| Ridiculously Cheap | 200,000 | $29/mo |
| Serious Business | 2,000,000 | $229/mo |

Premium tools (search APIs, code sandboxes) bill at 3x. Only Composio-brokered tool calls are
metered — the native integrations (Google, Slack, Notion, …) stay free, which is one reason they
were deliberately **not** migrated onto Composio.

Composio also does not pay for the underlying services: Stripe, Twilio, RentCast etc. still bill
you directly, and it cannot bypass vendor-side account rules (e.g. Spotify's Dev-Mode allow-list).

## How it's wired

- **Service:** [src/services/composio/composio.service.ts](../src/services/composio/composio.service.ts)
- **Routes:** `/api/v1/composio/*` — see [API.md](../API.md)
- **Table:** `composio_connections` — stores only a pointer (`connected_account_id`), never a token.
- **Agent:** tools are merged into both command centers. A Composio tool is an `UPPER_SNAKE` slug
  (`HUBSPOT_CREATE_CONTACT`); native tools are `lower_snake` (`send_gmail`), so dispatch is
  unambiguous.

### Tool budget (important)

Gemini's function-calling degrades badly past a few dozen declarations, and the native tool set
already spends ~60. So Composio tools are loaded **only for toolkits the user actually connected**,
capped at `MAX_COMPOSIO_TOOLS` (40) with `MAX_TOOLS_PER_TOOLKIT` (12), and cached for 5 minutes.
Connecting 300 toolkits will not load 3,000 tools. If you need to scale past ~8 connected toolkits
per user, the next step is Composio's semantic tool-search rather than raising the cap.

### Read vs. write

Composio slugs are classified by action verb: `GET_/LIST_/FETCH_/SEARCH_/FIND_/READ_/RETRIEVE_/
COUNT_/EXPORT_` are read-only and auto-chain inside the agent loop. **Everything else defaults to a
write**, so it goes through the app's existing confirm-before-execute sheet. This default is
deliberate — silently auto-running an unknown connector write (say `STRIPE_CREATE_REFUND`) is not
an acceptable failure mode.

## Known hardening follow-ups

- **Toolkit version pinning.** `tools.execute` is called with `dangerouslySkipVersionCheck: true`,
  which resolves each toolkit to `latest`. That means a connector's schema can change under us.
  The hardened alternative is a pinned `toolkitVersions` map (e.g. `{ github: '20250909_00' }`) —
  deferred because it means hand-maintaining a version per connector.
- **Adding a toolkit** to the catalog: add one entry to `COMPOSIO_CATALOG` in the service and an
  icon/color to `TOOLKIT_STYLE` in
  [components/settings/composio-section.tsx](../../Interlink-app/components/settings/composio-section.tsx).
  Nothing else — no OAuth registration, no new service module.
