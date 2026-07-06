# Spotify setup — why "play" fails on a Premium account, and how to fix it

The Interlink personal assistant controls Spotify playback through the **Spotify Web API**
(`src/services/spotify/spotify.service.ts`). Playback works only when **all** of the following
are true. If any one is off, the API returns a 403/404 that used to be reported as
"requires Spotify Premium" — that message is now accurate only when Spotify genuinely reports
`PREMIUM_REQUIRED`; other 403s surface their real reason.

## 1. The account must be authorized on the Spotify Developer app (most common cause)

By default a Spotify app is in **Development Mode**, which only allows **up to 25 explicitly
allow-listed users**. Any account *not* on that list gets a **403 on every Web API playback
call** — regardless of whether it's Premium. A student Premium account is no exception.

Fix (you manage the Dashboard):

1. Go to <https://developer.spotify.com/dashboard> → select the Interlink app.
2. Open **Settings → User Management** (a.k.a. "Users and Access").
3. Add the full name + the Spotify account email of every tester who should be able to play.
4. Have that user **disconnect and reconnect** Spotify in the app (Settings → Connected Accounts)
   so a fresh token is issued under the now-authorized account.

To lift the 25-user cap for real users, submit the app for **Extended Quota Mode** in the
Dashboard (requires the app to meet Spotify's requirements). Until approved, only allow-listed
accounts can control playback.

## 2. Spotify Premium is required for playback control

Play/pause/skip/transfer are Premium-only Spotify features. Free accounts get `PREMIUM_REQUIRED`.
This is a genuine Spotify limitation, not something the backend can change.

## 3. An active device must exist

The Web API only accepts playback commands against an **active device**. If the Spotify app has
never played anything this session, the account has no active device and play calls fail
(`404 NO_ACTIVE_DEVICE`, or a device-restriction 403). The backend now resolves a concrete device,
transfers playback to wake it, and **retries the play once** after a short delay to cover the
asynchronous transfer (`resolveDeviceId` + `playOnResolvedDevice` in `spotify.service.ts`). Still,
the user should have the Spotify app **open on a phone or desktop** and ideally play/pause once.

## 4. Redirect URI + scopes must match

- `SPOTIFY_REDIRECT_URI` (env) must **exactly** match a Redirect URI registered in the Dashboard.
  Default is `${API_BASE_URL}/api/v1/spotify/callback` (backend-mediated flow).
- Scopes granted at connect time are set in `buildAuthUrl`:
  `user-read-playback-state user-modify-playback-state playlist-read-private user-library-read
  user-read-currently-playing`. If a user connected **before** a scope was added, their token
  lacks it — they must reconnect.

## Quick triage

| Symptom (app error text) | Likely cause | Action |
|---|---|---|
| "Spotify refused this action: …" (not Premium wording) | Dev-Mode allow-list, restricted device, or missing scope | Add account in User Management (§1); reconnect |
| "…requires Spotify Premium." | Genuinely a Free account | Upgrade to Premium |
| "No active Spotify device found…" | No active device | Open Spotify, play/pause once, retry |
| "Spotify is not connected…" | No token stored | Connect in Settings → Connected Accounts |
| "SPOTIFY_CLIENT_ID is not configured." | Server env missing | Set `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` in `.env` |
