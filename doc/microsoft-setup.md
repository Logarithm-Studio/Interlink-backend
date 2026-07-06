# Microsoft (Azure AD) setup — Outlook, Teams, and OneDrive

One Azure AD **app registration** powers all four Microsoft surfaces in Interlink: Outlook mail,
Outlook calendar, Microsoft Teams chat, and OneDrive. The backend code
(`src/services/microsoft/microsoft.service.ts` + `routes/microsoft.routes.ts`) is already wired —
it only needs the credentials below in `.env`.

## 1. Register the app

1. Go to <https://portal.azure.com> → **Microsoft Entra ID** (Azure AD) → **App registrations** →
   **New registration**.
2. **Name:** `Interlink`.
3. **Supported account types:** choose **"Accounts in any organizational directory and personal
   Microsoft accounts"** if you want personal @outlook.com users too (uses tenant `common`). For a
   single org, pick single-tenant and set `MICROSOFT_TENANT` to your tenant id.
4. **Redirect URI:** platform **Web**, value
   `${API_BASE_URL}/api/v1/microsoft/callback` (e.g. `https://your-backend/api/v1/microsoft/callback`).
   It must match `MICROSOFT_REDIRECT_URI` exactly.
5. Register.

## 2. Client secret

App → **Certificates & secrets** → **New client secret** → copy the **Value** (not the id).

## 3. API permissions (delegated)

App → **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**,
add: `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`,
`Chat.ReadWrite`, `ChannelMessage.Send`, `Files.ReadWrite`. Grant admin consent if your tenant
requires it. (These exactly match `SCOPES` in `microsoft.service.ts`.)

## 4. Environment variables

```
MICROSOFT_CLIENT_ID=<application (client) id>
MICROSOFT_CLIENT_SECRET=<client secret value>
MICROSOFT_TENANT=common            # or your tenant id for single-tenant
MICROSOFT_REDIRECT_URI=${API_BASE_URL}/api/v1/microsoft/callback
```

## 5. Connect from the app

Settings → Connected Accounts → **Microsoft** → connect. One consent unlocks Outlook mail/calendar,
Teams, and OneDrive across the assistant (tools `get_outlook_inbox`, `send_outlook_mail`,
`list_outlook_events`, `create_outlook_event`, `list_teams_chats`, `send_teams_message`,
`list_onedrive_files`, `share_onedrive_file`) and the Gmail↔Outlook mailbox switch in Settings.

**Note:** Teams `Chat.ReadWrite` / `ChannelMessage.Send` on personal Microsoft accounts is limited —
Teams chat works best with work/school (organizational) accounts.
