# Lead embed — POC

A fake partner website ("Summit Roofing Co.") that embeds the **real** Scanifly estimator from **portal-beta** in an iframe. A "behind the scenes" panel shows each step as it happens. Nothing is mocked: the link is minted by `api.portal-beta.scanifly.com`, and the iframe is the deployed `portal-beta.scanifly.com/embed/roof-estimator`.

The embed can estimate a new roof, solar, or both. It can open empty, or prefilled with an address the partner already collected.

## Run it

1. On **portal-beta**, log in as an admin of a test company → **Account → Access Tokens** → create a token. The embed bills that company's credits.
2. Then:

```bash
cp .env.example .env      # paste the token into SCANIFLY_API_KEY
node server.mjs           # Node 21.7+ for .env loading; no dependencies
```

Open **http://localhost:4100**. Every load or refresh is one partner page view, which mints one new link.

`SCANIFLY_API_URL=http://localhost:3000/api` points it at a local portal-be instead.

> **Credits.** A prefilled page load starts a billed measurement straight away, and a roof result also uses one of that home's free previews. "Use Street View" / "Try another view" buy up to six Street View photos. Use a test company.

## Trying the options

The form on the partner page maps straight onto the mint request. You can also put the same values in the URL:

| Query param | Values | Mint body |
|---|---|---|
| `products` | `roof` (default), `solar`, `roof,solar` | `products: ['roof', 'solar']` |
| `address` | any address | `prefill.address`, geocoded by Scanifly at mint time |
| `shingleId` | an id from the catalogue (roof only) | `prefill.shingleId` |
| `mode` | `result` (default with an address), `full` | `mode` |

For example: `http://localhost:4100/?address=1600 Wynkoop St, Denver, CO&products=roof,solar&mode=full`

What each looks like:

| Choice | The homeowner sees |
|---|---|
| Roof, no address | The step-by-step estimator. "Use Street View" offers the views from nearby panoramas to pick from. |
| Solar, no address | Just the address step, then the panel layout, system size, panels, kWh per year and a price (when the company set a solar $/W). |
| Roof + solar | The roof estimator with a Roofing / Solar toggle over the result. One measurement feeds both. |
| Any, with an address, `result` | Opens on the result with nothing to fill in. A roof renders its first preview by itself, with "Try another view" to change the photo. |
| Any, with an address, `full` | Every step, with the address already filled in. |

## The flow

```
Homeowner's browser        Partner server (this POC)        portal-beta
───────────────────        ─────────────────────────        ───────────
GET partner page ───────►  POST /api/v1/roof-estimator/embed-sessions
                           x-api-token: <partner key>
                           { products, prefill, mode } ───► geocode the prefill, issue a single-use code (5 min)
                           ◄──────────────── { url: portal-beta…/embed/roof-estimator?code=…, expiresAt }
◄── HTML with <iframe src=url>

iframe (portal-fe) ───────────────────────────────────────► POST /roof-estimator/embed/session { code }
  strips ?code from its URL                                 code deleted → 1-hour session token,
◄────────────────────────────────────────────────────────── plus the prefill, mode and products

measure, render, quote ───────────────────────────────────► /roof-estimator/embed/* (session-scoped)
events ── postMessage ─► partner page
```

The prefill travels with the code in Scanifly's cache, never in the iframe URL, so the homeowner's address does not end up in history or referrers.

The panel can only report what the partner can actually observe: its own mint call, the iframe's `load` event, and the `postMessage` events the iframe sends. The code exchange happens inside the cross-origin iframe. To watch it, use **Open embed in new tab** (which mints a fresh link) or inspect the iframe in DevTools.

**Replay the spent link** puts the already-redeemed URL back in the iframe. portal-beta refuses it with a 401 and the embed shows "This estimator link is no longer valid." That's what a cached page or a leaked URL gets.

## Partner integration

```js
// Partner's server, on every page render. Never cache this page: the link is single-use.
const { url } = await fetch('https://api.portal.scanifly.com/api/v1/roof-estimator/embed-sessions', {
  method: 'POST',
  headers: { 'x-api-token': process.env.SCANIFLY_API_KEY, 'content-type': 'application/json' },
  // All optional. Without a body the embed opens empty, as a roof estimator.
  body: JSON.stringify({
    products: ['roof', 'solar'],
    prefill: { address: '1600 Wynkoop St, Denver, CO', shingleId: '…' },
    mode: 'result',
  }),
}).then((r) => r.json());
```

```html
<iframe src="{{url}}" title="Estimator" style="width:100%;height:860px;border:0"></iframe>
```

`GET /api/v1/roof-estimator/shingles` (same API key) lists the company's catalogue, for a colour picker on the partner's own form. A bad address or unknown shingle is a 400 at mint time, before any link exists.

### Events

The iframe posts `{ source: 'scanifly-roof-estimator', version: 1, type, payload }` to its parent. Check `event.origin` is Scanifly's before trusting one.

| `type` | When |
|---|---|
| `ready` / `error` | The link was redeemed / is no good |
| `resize` | `{ height }` — size the iframe to fit |
| `property-selected` | The address was settled |
| `measurement-complete` / `measurement-failed` | The roof was measured (with `solar` figures when solar is on) |
| `preview-generated` | A shingle preview rendered |
| `proposal-created` / `pdf-generated` | A proposal was saved / its PDF link is ready |

## Open questions

1. **Framing policy.** portal-beta sends no `X-Frame-Options` or `frame-ancestors`, so any site can frame it. Should portal-fe send `frame-ancestors` per partner? That needs each partner's allowed domains, and the same list would pin the `postMessage` target origin.
2. **Bill sizing for solar.** Solar fills the roof today. Sizing to a monthly bill needs an electricity rate setting and the usage passed into the Solar AI run.
3. **Theming.** Should the partner's colours and logo be passed at mint time?
4. **Abuse.** A bot check, rate limits and a monthly cap per installer before this goes public.
