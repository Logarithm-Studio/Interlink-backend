/**
 * PermanentJobError — thrown inside a worker endpoint to signal that retrying
 * will not help (e.g. missing required fields, auth permanently revoked).
 *
 * The worker route handler catches this and responds with HTTP 422 so QStash
 * does not retry the message (QStash only retries on 5xx responses).
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
