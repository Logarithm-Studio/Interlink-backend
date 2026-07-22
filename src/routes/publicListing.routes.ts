/**
 * Public listing pages — `GET /l/:slug`. **No auth**: this is the link an agent emails to
 * buyers, so it renders server-side HTML rather than JSON (a buyer opens it in a normal
 * browser, not the app).
 *
 * Everything rendered here is user-authored (address, description, agent name), so every
 * interpolation goes through `esc()`. Photo URLs come from our own Supabase bucket, but they
 * are escaped as attributes too — a stored URL is still data, not trusted markup.
 */

import { Router, Request, Response, NextFunction } from "express";
import { getPublicListing, type PublicListing } from "../services/professional/realestate/listingPhotos.service";

const router = Router();

function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(cents: number, currency: string): string {
  const symbol = currency === "USD" || !currency ? "$" : `${currency} `;
  return `${symbol}${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function renderPage(listing: PublicListing): string {
  const specs = [
    listing.beds !== null ? `${listing.beds} bd` : null,
    listing.baths !== null ? `${listing.baths} ba` : null,
    listing.sqft !== null ? `${listing.sqft.toLocaleString("en-US")} sqft` : null,
  ].filter(Boolean) as string[];

  const cover = listing.photos[0];
  const gallery = listing.photos
    .slice(1)
    .map((p) => `<img src="${esc(p)}" alt="${esc(listing.address)}" loading="lazy" />`)
    .join("");

  // No cover photo is the common case for a just-created listing — show a neutral band
  // rather than a broken image so the page still reads as intentional.
  const hero = cover
    ? `<img class="hero" src="${esc(cover)}" alt="${esc(listing.address)}" />`
    : `<div class="hero hero--empty">Photos coming soon</div>`;

  const contact = listing.agentEmail
    ? `<a class="cta" href="mailto:${esc(listing.agentEmail)}?subject=${encodeURIComponent(`Inquiry: ${listing.address}`)}">Contact ${esc(listing.agentName ?? "the agent")}</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(listing.address)}</title>
<meta property="og:title" content="${esc(listing.address)}" />
<meta property="og:description" content="${esc(money(listing.priceCents, listing.currency))}${specs.length ? ` · ${esc(specs.join(" · "))}` : ""}" />
${cover ? `<meta property="og:image" content="${esc(cover)}" />` : ""}
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#101014; --muted:#6b6b76; --line:#e6e6ec; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0e0e11; --fg:#f2f2f5; --muted:#9a9aa6; --line:#26262e; --card:#16161b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 0 48px; }
  .hero { width:100%; aspect-ratio: 3/2; object-fit: cover; display:block; }
  .hero--empty { display:flex; align-items:center; justify-content:center;
                 background:var(--line); color:var(--muted); font-size:15px; }
  .body { padding: 24px 20px 0; }
  .price { font-size: 34px; font-weight: 700; letter-spacing:-0.02em; margin: 0; }
  .addr { font-size: 17px; color: var(--muted); margin: 6px 0 0; }
  .specs { display:flex; flex-wrap:wrap; gap:8px; margin: 18px 0 0; padding:0; list-style:none; }
  .specs li { border:1px solid var(--line); border-radius:999px; padding:6px 14px; font-size:14px; }
  .status { display:inline-block; margin-top:16px; padding:4px 12px; border-radius:999px;
            background:#12a150; color:#fff; font-size:12px; font-weight:600;
            text-transform:uppercase; letter-spacing:0.04em; }
  .desc { margin: 24px 0 0; font-size:16px; line-height:1.6; white-space: pre-wrap; }
  .gallery { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px,1fr));
             gap:8px; margin: 28px 0 0; }
  .gallery img { width:100%; aspect-ratio:4/3; object-fit:cover; border-radius:10px; display:block; }
  .cta { display:block; margin: 32px 0 0; padding: 15px; text-align:center; border-radius:12px;
         background:var(--fg); color:var(--bg); text-decoration:none; font-weight:600; font-size:16px; }
  .foot { margin: 28px 0 0; padding-top: 20px; border-top:1px solid var(--line);
          color:var(--muted); font-size:13px; }
</style>
</head>
<body>
  <div class="wrap">
    ${hero}
    <div class="body">
      <p class="price">${esc(money(listing.priceCents, listing.currency))}</p>
      <p class="addr">${esc(listing.address)}</p>
      ${specs.length ? `<ul class="specs">${specs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      ${listing.status === "active" ? `<span class="status">For sale</span>` : ""}
      ${listing.description ? `<p class="desc">${esc(listing.description)}</p>` : ""}
      ${gallery ? `<div class="gallery">${gallery}</div>` : ""}
      ${contact}
      <p class="foot">${listing.agentName ? `Listed by ${esc(listing.agentName)} · ` : ""}Shared via Interlink</p>
    </div>
  </div>
</body>
</html>`;
}

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Listing unavailable</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#fff;color:#101014;text-align:center}
@media(prefers-color-scheme:dark){body{background:#0e0e11;color:#f2f2f5}}
p{color:#6b6b76;margin-top:8px}</style></head>
<body><div><h1>Listing unavailable</h1><p>This listing is no longer shared.</p></div></body></html>`;

router.get("/l/:slug", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const listing = await getPublicListing(req.params.slug);
    if (!listing) {
      res.status(404).type("html").send(NOT_FOUND);
      return;
    }
    // helmet's global CSP is `img-src 'self' data:`, which would block the Supabase-hosted
    // photos — the whole point of the page. Override with a policy that is *tighter* than the
    // default everywhere else (no scripts at all) but allows https images.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    // Short cache: photos/price can change, but a listing shared to many buyers at once
    // shouldn't hit the DB for every open.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(renderPage(listing));
  } catch (err) {
    next(err);
  }
});

export default router;
