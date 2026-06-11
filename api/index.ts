/**
 * Vercel serverless entry point.
 *
 * Vercel's Node runtime invokes the module's default export as the request
 * handler `(req, res)`. We re-export the Express `app` (from src/app.ts), which
 * is a valid handler and — crucially — does NOT call `app.listen()`.
 *
 * src/server.ts (which DOES call app.listen) is only for local dev and
 * long-running hosts; importing it here would hang every request because a
 * listening server never returns a response to Vercel's gateway.
 *
 * All routes are served by this single function; see vercel.json, which
 * rewrites every path to /api so the Express router sees the original URL.
 */
import app from "../src/app";

export default app;
