import { isIP } from "node:net";

/** Bucket IPv6 clients by /64 so address rotation within a subnet cannot evade limits. */
export function normalizeClientIp(address: string | null | undefined): string | null {
  if (!address) return null;
  const candidate = address.trim().replace(/^\[|\]$/g, "").split("%")[0];
  if (isIP(candidate) === 4) return candidate;

  const mappedV4 = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedV4 && isIP(mappedV4) === 4) return mappedV4;
  if (isIP(candidate) !== 6) return null;

  const halves = candidate.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  if (groups.slice(0, 5).every((group) => Number.parseInt(group, 16) === 0) && Number.parseInt(groups[5], 16) === 0xffff) {
    const high = Number.parseInt(groups[6], 16);
    const low = Number.parseInt(groups[7], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
