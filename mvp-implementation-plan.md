# Interlink MVP Implementation Plan

## 1) Goal

Implement the product defined in goal.md with a practical MVP scope:

- Google Calendar sync
- Chronological event listing
- Travel-time-based reminder scheduling
- Attendance prompt (Yes / No)
- Email draft/send flow when user selects No
- Automatic background sync for future events

## 2) Locked Constraints

- Preparation buffer is fixed at 15 minutes (no user setting in MVP).
- Frontend client is Flutter.
- Backend remains Node.js + TypeScript + Express + PostgreSQL + Redis + BullMQ.
- Provider scope for MVP: Google only.
- Device location is captured in Flutter (with OS permission) and sent to backend.
- Backend does not fetch phone GPS directly; it only uses location sent by Flutter.

## 3) MVP Scope (In)

- OAuth connect with Google and token refresh handling.
- Event sync and normalization from Google Calendar.
- Event list API sorted by time.
- Travel time estimate from current location to event location.
- Reminder time calculation:

  Notification Time = Event Start Time - (Travel Time + 15 minutes)

- Worker-driven scheduling of reminder jobs.
- Actionable notification payload for Flutter deep-link handling.
- Attendance response API:
  - Yes: mark handled, no further action.
  - No: generate default/custom email draft and allow send.
- Continuous sync via webhook/watch + incremental cursor.

## 4) Out of Scope (For This MVP)

- Microsoft/Outlook integration.
- User-configurable preparation buffer.
- Multi-device push fanout optimization.
- Advanced workflow editor UI.
- Non-calendar automation types.

## 5) Architecture Changes Needed

### 5.1 Keep and Reuse

- Existing Google auth and token storage flow.
- Existing calendar sync + watch channel + incremental sync pipeline.
- Existing email draft/send services.
- Existing worker infrastructure and queues.

### 5.2 Add / Refactor

- Add travel-time service (Google Maps Distance Matrix or Routes API).
- Add event reminder scheduling service and queue processor.
- Add attendance action domain model (event reminder status, user response, timestamps).
- Add location ingestion contract from Flutter (lat, lng, capturedAt, accuracy if available).
- Add mobile-oriented API contracts for Flutter:
  - reminder feed / current pending prompt
  - submit attendance response
  - fetch email draft state for No flow
- Introduce explicit deep-link payload shape for Flutter.

## 6) Data Model Plan

Add new migration(s) for MVP-specific entities:

1. event_reminders

- id
- user_id
- event_id
- event_start_time
- travel_minutes
- prep_minutes (always 15 in MVP)
- reminder_at
- status (scheduled, fired, responded, expired, cancelled)
- created_at, updated_at

2. attendance_responses

- id
- user_id
- event_id
- reminder_id
- response (yes, no)
- responded_at
- source (push, in_app)

3. current_location_snapshots

- user_id
- latitude, longitude
- captured_at
- accuracy_meters (nullable)
- source (gps, network, fused)

Note: For MVP, persist location snapshots so reminder recomputation remains possible when app is backgrounded.

## 7) Backend API Plan (Flutter-Focused)

### Auth & Calendar

- Keep existing auth connect/callback/me endpoints.
- Keep manual sync endpoint for testing and fallback.

### Events

- GET events list (chronological).
- GET event detail (include location and participants).

### Location + Reminder

- POST user current location (Flutter -> backend).
- POST trigger reminder recomputation for upcoming events.
- GET pending attendance prompt(s).

Location payload (MVP):

- latitude
- longitude
- capturedAt (ISO)
- accuracyMeters (optional)

### Attendance

- POST attendance response for event/reminder:
  - yes -> close flow
  - no -> open email flow

### Email Flow for No

- POST generate default draft
- POST generate custom draft (from user text)
- POST send email

All mutation endpoints remain idempotent.

## 8) Worker & Queue Plan

### New Queue: reminders

Jobs:

- reminder.compute
  - compute travel minutes and reminder_at for upcoming events
- reminder.fire
  - create notification payload and dispatch to notifications queue
- reminder.expire
  - mark stale reminders when event time passes

### Existing Queues to Reuse

- notifications queue for push/email fallback delivery
- email queue/services for draft/send

## 9) Travel Time Plan

- Provider: Google Maps API.
- Inputs:
  - latest user current location from Flutter (lat/lng)
  - event location text or lat/lng (if available)
  - planned departure window
- Output:
  - travel_minutes (integer)
  - confidence/source metadata
- Fallback:
  - if travel API fails or event has no location, use 0 travel minutes and still schedule reminder (start - 15 min).

Location freshness rule (MVP):

- If latest location is older than freshness threshold (example: 30 minutes), recompute is skipped until Flutter sends a fresh update.

## 10) Flutter Integration Plan

### App Modules

- Auth module (Google connect + token handling via backend).
- Event list screen (chronological).
- Reminder prompt screen (Yes / No).
- Email draft screen (default/custom + send).
- Location module (permission handling + periodic/foreground location updates to backend).

### Deep Link Contract

Use a stable route contract, for example:

- interlink://attendance?reminderId=<id>&eventId=<id>
- interlink://email-draft?executionId=<id>&eventId=<id>

### Polling / Realtime Strategy (MVP)

- Poll pending prompt endpoint at a lightweight interval when app is active.
- Push notification opens deep link to exact action screen.
- Send location updates on meaningful movement and on app foreground resume.

## 11) Implementation Phases

### Phase A: Foundation Alignment

- Freeze MVP scope and constraints.
- Add migrations for reminders + attendance responses.
- Add domain services for reminder state transitions.

### Phase B: Travel + Reminder Engine

- Implement travel-time service.
- Implement location ingestion endpoint and snapshot persistence.
- Implement reminder compute and scheduling jobs.
- Add reminder firing processor and notification payload format.

### Phase C: Attendance Flow

- Build attendance response endpoint.
- Implement yes/no handling logic.
- Connect No branch to email draft generation and send.

### Phase D: Flutter Contracts

- Finalize API response/request JSON shapes for Flutter.
- Add endpoint-level examples for Flutter integration.
- Validate deep-link payload compatibility.

### Phase E: Validation

- End-to-end test:
  - sync -> reminder compute -> prompt -> yes/no -> email send (No path)
- Update TESTING docs and curl guide for MVP flow.

## 12) Acceptance Criteria

MVP is complete when:

1. User connects Google Calendar successfully.
2. Events appear in chronological list.
3. Reminder time is computed using travel + fixed 15 min buffer.
4. Flutter sends device location and backend accepts/persists it for reminder computation.
5. User receives attendance prompt before event.
6. Yes response closes flow with no extra action.
7. No response opens email draft flow and can send to organizer/attendees.
8. New/updated calendar events continue syncing automatically.
9. All key mutation endpoints are idempotent and auditable.

## 13) Risks and Mitigations

- Missing event location -> schedule with fallback (travel=0).
- Late location updates from app -> recompute reminder on location update.
- Push delivery failures -> fallback path (existing notification/email mechanisms).
- OAuth/token expiration -> existing reauth-required handling.

## 14) Immediate Next Execution Plan

Once approved, implementation starts in this exact order:

1. Add migrations (event_reminders + attendance_responses + current_location_snapshots).
2. Add location ingestion API (Flutter -> backend).
3. Implement reminder service + reminder queue processor.
4. Implement travel-time service integration.
5. Add attendance APIs.
6. Wire No branch to existing email draft/send pipeline.
7. Update docs and test scripts for Flutter team handoff.
