# Interlink Backend AI Guidelines

You are an AI assistant working on the Interlink project, an AI-Based Calendar & Task Automation Platform.

## Technology Stack
- **Runtime**: Node.js (via `tsx` in dev mode, compiled to JS in prod via `tsc`)
- **Language**: TypeScript (strict mode preferred)
- **Web Framework**: Express
- **Database**: PostgreSQL (`pg`, `postgres`)
- **Background Jobs**: BullMQ + Redis for asynchronous processing 
- **Data Validation**: Zod
- **External Integrations**: Google APIs (OAuth, Calendar), OpenAI, Supabase

## Architectural Principles
1. **MVP Focus**: The current objective prioritizes Google Calendar sync, event listings, travel-time-based reminder scheduling, and user/event decline email workflows. Skip components mapped for post-MVP (like Outlook).
2. **Strict Client-Server Contract**: The Node.js backend entirely manages REST APIs, Google OAuth token lifecycle, the background sync strategy using watch APIs/webhooks, and sending Gmail emails. A separate Flutter frontend project processes the UI forms, push notifications, and transmits users' device location explicitly via backend APIs. 
3. **Idempotent API Design**: Ensure that all state-mutating API endpoints handle duplicates gracefully or maintain idempotent behavior.
4. **Queue-Driven Logic**: Features like heavy sync computations, reminder scheduling (`reminder.compute`, `reminder.fire`), and email queuing must be handled via BullMQ worker flows (`src/worker.ts`) strictly separated from synchronous web routes.
5. **Data Source of Truth**: The PostgreSQL database remains the single source of truth for all events, generated email templates, background jobs, and cached user GPS coordinates securely. 

## Coding Standards
- Strictly use **TypeScript** and appropriately define interfaces/types per sub-module.
- Rely on **Zod** schema validations on the boundary layer (Express routes) to parse and cleanly validate incoming user payload prior to calling any internal service logic.
- Conform logic to standard conventional REST concepts incorporating a predictable `/api/v1/...` namespace. Ensure informative HTTP error codes are dispatched cleanly. 
- Ensure handlers are modular and decoupled from exact framework specifics when reasonable.

## File References 
- Constantly reference the detailed architecture and scopes defined in `mvp-implementation-plan.md` and `mvp-goal.md`. You should heavily study these documents before executing refactors or designing databases.
- When generating SQL queries, make sure they operate smoothly with Node's native raw drivers `pg` or `postgres` mapping to structured domain models. 

## Developer Workflow
- Manage migrations manually via custom scripts (e.g., `npm run migrate` mapped to `src/db/migrations/runner.ts`). 
- Validate lint/type issues through `npm run lint`.
- Start the development system leveraging `npm run dev` and `npm run worker:dev`.
