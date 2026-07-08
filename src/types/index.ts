import { Request } from "express";

// ─── User ───────────────────────────────────────────────────────────
export interface AppUser {
  id: string;
  email: string;
  timezone?: string;
}

export interface AuthenticatedRequest extends Request {
  user: AppUser;
  /**
   * The Google account resolved for this request's mode (via the
   * X-Interlink-Mode header). Populated by `resolveGoogleAccountForRequest`.
   */
  googleAccountId?: string;
}

/** Which app mode a connected Google account is bound to. */
export type GoogleAccountRole = "personal" | "professional";

// ─── Connected Accounts ─────────────────────────────────────────────
export interface ConnectedAccount {
  id: string;
  userId: string;
  provider: "google" | "microsoft";
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  createdAt: Date;
  /** True when the stored tokens are invalid and the user must reconnect. */
  reauthRequired?: boolean;
  /** Real connected mailbox address (Google only; null until back-filled). */
  email?: string | null;
  /** Which mode uses this account: 'personal' | 'professional' | null. */
  role?: GoogleAccountRole | null;
  /** Fallback account when no mode/role resolves to a specific one. */
  isPrimary?: boolean;
}

// ─── Normalized Event ───────────────────────────────────────────────
export interface NormalizedEvent {
  id?: string;
  userId: string;
  /** The Google account this event was synced from (null for legacy rows). */
  googleAccountId?: string | null;
  googleAccountEmail?: string | null;
  googleAccountRole?: "personal" | "professional" | null;
  googleAccountIsPrimary?: boolean | null;
  externalEventId: string;
  provider: "google" | "microsoft";
  eventType: string;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  timezone: string | null;
  location: string | null;
  status: string;
  isCancelled: boolean;
  organizerEmail: string | null;
  attendees: Attendee[];
  isRecurring: boolean;
  /** Provider-level series/master ID for recurring event series. */
  seriesId?: string | null;
  /** Provider-level identifier for this specific occurrence in the series. */
  occurrenceId?: string | null;
  metadata: Record<string, unknown>;
  updatedAt?: Date;
  createdAt?: Date;
}

export interface Attendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
}

// ─── Conflict Detection ─────────────────────────────────────────────
export interface ConflictResult {
  /** Stable UUID from the `conflicts` table (present after DB persist). */
  id?: string;
  conflictingEvents: [string, string];
  conflictType: "overlap" | "buffer_violation";
  severity: "high" | "medium" | "low";
  overlapMinutes: number;
  status?: "active" | "cleared";
  firstDetectedAt?: Date;
  lastDetectedAt?: Date;
}

// ─── Event Snapshot ─────────────────────────────────────────────────
export interface EventSnapshot {
  id: string;
  eventId: string;
  snapshot: Record<string, unknown>;
  createdAt: Date;
}
