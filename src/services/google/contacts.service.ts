/**
 * Google People (Contacts) service. Lets the assistant resolve a spoken name into
 * an email address — so "schedule a meeting with Sarah and Tom" or "email the design
 * team" actually reaches real people. Reuses the shared Google OAuth token; requires
 * the contacts.readonly scope (existing users must reconnect Google to grant it).
 */

import { google, people_v1 } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getPeopleClient(userId: string): Promise<people_v1.People> {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.people({ version: "v1", auth });
}

export interface Contact {
  name: string;
  email: string;
  phone?: string;
}

function mapPeople(people: people_v1.Schema$Person[] | undefined): Contact[] {
  const out: Contact[] = [];
  for (const p of people ?? []) {
    const email = p.emailAddresses?.find((e) => e.value)?.value;
    if (!email) continue;
    out.push({
      name: p.names?.find((n) => n.displayName)?.displayName ?? email.split("@")[0],
      email,
      phone: p.phoneNumbers?.find((n) => n.value)?.value ?? undefined,
    });
  }
  return out;
}

/**
 * Search the user's contacts (and "other contacts" — people they've emailed) by name
 * or email. Returns the best matches so the model can pick recipients.
 */
export async function searchContacts(userId: string, query: string): Promise<Contact[]> {
  const people = await getPeopleClient(userId);
  const q = query.trim();
  if (!q) return listContacts(userId);

  const results: Contact[] = [];
  const seen = new Set<string>();
  const push = (contacts: Contact[]) => {
    for (const c of contacts) {
      const key = c.email.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push(c);
      }
    }
  };

  // Saved contacts.
  try {
    const res = await people.people.searchContacts({ query: q, readMask: "names,emailAddresses,phoneNumbers", pageSize: 10 });
    push(mapPeople((res.data.results ?? []).map((r) => r.person!).filter(Boolean)));
  } catch {
    // scope/warmup issues — fall through to other contacts
  }

  // "Other contacts" — people the user has corresponded with but not saved.
  try {
    const res = await people.otherContacts.search({ query: q, readMask: "names,emailAddresses", pageSize: 10 });
    push(mapPeople((res.data.results ?? []).map((r) => r.person!).filter(Boolean)));
  } catch {
    // ignore
  }

  return results.slice(0, 10);
}

/** List the user's saved contacts (most relevant first). */
export async function listContacts(userId: string): Promise<Contact[]> {
  const people = await getPeopleClient(userId);
  const res = await people.people.connections.list({
    resourceName: "people/me",
    personFields: "names,emailAddresses,phoneNumbers",
    sortOrder: "LAST_MODIFIED_DESCENDING",
    pageSize: 25,
  });
  return mapPeople(res.data.connections ?? []);
}
