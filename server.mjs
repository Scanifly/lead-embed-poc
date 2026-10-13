/*
  Roof estimator embed — proof of concept.

  Plays the part of a partner's website (a roofing company) embedding the real Scanifly roof
  estimator from portal-beta. On every page view this server spends its Scanifly API key on one
  embed link and renders it into an <iframe src>; everything inside the iframe is the deployed
  portal-fe, talking to the deployed portal-be. Nothing here is mocked.

    PARTNER   http://localhost:4100              this server
    SCANIFLY  https://api.portal-beta.scanifly.com   mints the link (POST /api/v1/...)
              https://portal-beta.scanifly.com       serves /embed/roof-estimator in the iframe

  Configure with a .env file next to this one (see .env.example).
*/
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* No .env: fall back to whatever is in the shell environment. */
}

const PARTNER_PORT = Number(process.env.PARTNER_PORT ?? 4100);
const PARTNER_ORIGIN = `http://localhost:${PARTNER_PORT}`;
const API_URL = (process.env.SCANIFLY_API_URL ?? 'https://api.portal-beta.scanifly.com/api').replace(/\/$/, '');
const API_KEY = process.env.SCANIFLY_API_KEY;
/* The signingSecret of the webhook subscription pointing at /webhooks/scanifly, if there is one. */
const WEBHOOK_SECRET = process.env.SCANIFLY_WEBHOOK_SECRET;
/* How far a webhook's signing time may drift from ours before it counts as a replay. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/* ---------------------------------------------------------------------------------------------
   The "behind the scenes" log the page renders. Only what the partner can actually observe goes
   in here: its own server's calls, and what the iframe chooses to tell it.
--------------------------------------------------------------------------------------------- */

const events = [];

/**
 * Records one step of the flow for the demo's process panel.
 *
 * @param {'partner' | 'browser' | 'scanifly'} lane Whose side of the exchange this line is from.
 * @param {string} title Short headline for the step.
 * @param {object} [detail] Request/response shapes worth showing; never a whole credential.
 */
const logEvent = (lane, title, detail) => {
  events.push({ id: events.length + 1, at: new Date().toISOString(), lane, title, detail });
  if (events.length > 500) events.splice(0, events.length - 500);
};

/**
 * Shortens a credential for display, so the panel shows that one was sent without showing it.
 */
const redact = (value) => (value ? `${String(value).slice(0, 4)}…${String(value).slice(-4)}` : value);

/**
 * Redacts the single-use code inside a minted URL, keeping the rest readable.
 */
const redactUrl = (url) => url.replace(/code=([^&]+)/, (_, code) => `code=${redact(code)}`);

/* ---------------------------------------------------------------------------------------------
   Small HTTP helpers.
--------------------------------------------------------------------------------------------- */

/**
 * Writes a JSON response with the given status.
 */
const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(status === 204 ? undefined : JSON.stringify(body));
};

/**
 * Reads and parses a JSON request body, resolving to an empty object when there is none.
 */
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });

/**
 * Reads a request body as raw bytes: a webhook signature covers the bytes as sent, so they must be
 * verified before any JSON parsing.
 */
const readRaw = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/* Webhook event ids already handled; retries reuse the id, so a repeat is acknowledged and dropped. */
const seenWebhookEvents = new Set();

/**
 * Checks a delivery's `x-scanifly-signature` (`t=<unix>,v1=<hex>`) against our signing secret.
 * 'unsigned' when no secret is configured, so the demo still shows deliveries before one is set.
 */
const verifyWebhook = (header, rawBody) => {
  if (!WEBHOOK_SECRET) return 'unsigned';

  const parts = Object.fromEntries(
    String(header ?? '')
      .split(',')
      .map((part) => part.split('=', 2)),
  );
  const timestamp = Number(parts.t);

  if (!parts.v1 || !Number.isFinite(timestamp)) return 'invalid';
  if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return 'invalid';

  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.`).update(rawBody).digest('hex');
  const provided = Buffer.from(parts.v1, 'hex');

  return provided.length === expected.length / 2 && timingSafeEqual(provided, Buffer.from(expected, 'hex'))
    ? 'valid'
    : 'invalid';
};

/**
 * Escapes a value for safe interpolation into HTML.
 */
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Serves public/partner.html with its `{{KEY}}` placeholders filled in. Values must be pre-escaped.
 */
const sendPartnerPage = async (res, values) => {
  let html = await readFile(path.join(ROOT, 'public', 'partner.html'), 'utf8');
  for (const [key, value] of Object.entries(values)) html = html.replaceAll(`{{${key}}}`, value);
  /*
    Never cached: the iframe src carries a single-use code, so a cached copy of this page would
    hand the same spent code to every visitor after the first.
  */
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
};

/* ---------------------------------------------------------------------------------------------
   The one call a partner's server ever makes to Scanifly.
--------------------------------------------------------------------------------------------- */

/**
 * Spends the API key on a single-use embed link from portal-beta.
 *
 * Server to server: the key goes from this process to Scanifly and never reaches the browser.
 * Throws with Scanifly's own status and message when the mint is refused.
 */
const mintEmbedLink = async (mintBody, { retried = false } = {}) => {
  const endpoint = `${API_URL}/v1/roof-estimator/embed-sessions`;

  logEvent('partner', mintBody?.prefill ? 'Form submitted → mint a prefilled link' : mintBody?.products ? 'Form submitted → mint a link' : 'Page requested → mint a fresh embed link', {
    request: `POST ${endpoint}`,
    headers: { 'x-api-token': redact(API_KEY) },
    ...(mintBody && { body: mintBody }),
  });

  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-api-token': API_KEY, ...(mintBody && { 'content-type': 'application/json' }) },
    ...(mintBody && { body: JSON.stringify(mintBody) }),
  });
  const body = await response.json().catch(() => ({}));
  const ms = Date.now() - startedAt;

  /* A Scanifly build from before externalId refuses the field; mint without it rather than fail. */
  if (response.status === 400 && mintBody?.externalId && !retried && JSON.stringify(body).includes('externalId')) {
    logEvent('scanifly', 'This Scanifly API does not take externalId yet — minting without it', body);
    const { externalId: _dropped, ...withoutExternalId } = mintBody;

    return mintEmbedLink(withoutExternalId, { retried: true });
  }

  if (!response.ok) {
    logEvent('scanifly', `Mint refused (${response.status})`, body);
    throw Object.assign(new Error(body.message ?? `HTTP ${response.status}`), { status: response.status });
  }

  logEvent('scanifly', `${response.status} — single-use link issued (${ms} ms)`, {
    url: redactUrl(body.url),
    expiresAt: body.expiresAt,
  });

  return body;
};

/* ---------------------------------------------------------------------------------------------
   Routes.
--------------------------------------------------------------------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, PARTNER_ORIGIN);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      let minted = null;
      let error = null;

      if (!API_KEY) {
        error = 'SCANIFLY_API_KEY is not set. Create an access token on portal-beta (Account → Access Tokens) and put it in .env.';
      } else {
        /*
          What the partner's own form gathered: the address, and optionally a colour from the
          catalogue. With an address the link opens straight on the rendered roof.
        */
        const address = url.searchParams.get('address')?.trim();
        /* What the partner's page sells: roof, solar or both. Scanifly defaults to roof. */
        const products = url.searchParams.get('products')?.split(',').filter(Boolean);
        const offersRoof = !products || products.includes('roof');
        /* A colour only means something to a link that renders roofs; Scanifly 400s it otherwise. */
        const shingleId = offersRoof ? url.searchParams.get('shingleId')?.trim() : undefined;
        const body = {
          /* 'result' opens on the rendered roof; 'full' keeps every step, with the address filled in. */
          ...(address && {
            prefill: { address, ...(shingleId && { shingleId }) },
            mode: url.searchParams.get('mode') === 'full' ? 'full' : 'result',
          }),
          ...(products?.length && { products }),
          /*
            The partner's own id for this visit -- in real life their CRM's id for the form. Every
            lead the embed measures carries it, and it comes back in that lead's webhooks.
          */
          externalId: `summit-${randomBytes(3).toString('hex')}`,
        };
        const mintBody = body;

        try {
          minted = await mintEmbedLink(mintBody);
        } catch (mintError) {
          error =
            mintError.status === 401
              ? 'portal-beta rejected the API key (401). It may be expired, revoked, or from a different environment.'
              : `Minting failed: ${mintError.message}`;
        }
      }

      return sendPartnerPage(res, {
        EMBED_URL: minted ? escapeHtml(minted.url) : '',
        EMBED_ORIGIN: minted ? escapeHtml(new URL(minted.url).origin) : '',
        EXPIRES_AT: minted ? escapeHtml(minted.expiresAt) : '',
        API_URL: escapeHtml(API_URL),
        ERROR: error ? escapeHtml(error) : '',
      });
    }

    /* The company's shingle catalogue, for the partner's own colour picker. Server-side: it needs the key. */
    if (req.method === 'GET' && url.pathname === '/__poc/shingles') {
      const response = await fetch(`${API_URL}/v1/roof-estimator/shingles`, {
        headers: { 'x-api-token': API_KEY },
      });
      const body = await response.json().catch(() => ({}));
      logEvent('partner', `Catalogue requested (${response.status})`, {
        request: `GET ${API_URL}/v1/roof-estimator/shingles`,
      });
      return sendJson(res, response.ok ? 200 : response.status, body);
    }

    /*
      Scanifly's lead webhooks, server to server. Verified the way the integrator docs say: an
      HMAC-SHA256 of "{t}.{raw body}" keyed by the subscription's signingSecret, inside a five-minute
      window, de-duplicated on the retry-stable event id.
    */
    if (req.method === 'POST' && url.pathname === '/webhooks/scanifly') {
      const raw = await readRaw(req);
      const eventId = req.headers['x-scanifly-event-id'];
      const verdict = verifyWebhook(req.headers['x-scanifly-signature'], raw);

      if (verdict === 'invalid') {
        logEvent('webhook', 'Webhook refused — bad or stale signature', { eventId });
        return sendJson(res, 401, { message: 'Invalid signature' });
      }

      /* A retry of a delivery already taken: acknowledge it, act on it once. */
      if (eventId && seenWebhookEvents.has(eventId)) return sendJson(res, 204);
      if (eventId) seenWebhookEvents.add(eventId);

      const payload = JSON.parse(raw.toString('utf8'));
      const externalId = payload.lead?.externalId;

      logEvent('webhook', `Webhook ← ${payload.eventType}${externalId ? ` · ${externalId}` : ''} (${verdict === 'valid' ? 'signature ✓' : 'unsigned — set SCANIFLY_WEBHOOK_SECRET'})`, {
        headers: {
          'x-scanifly-event-id': eventId,
          'x-scanifly-event-type': req.headers['x-scanifly-event-type'],
          'x-scanifly-attempt': req.headers['x-scanifly-attempt'],
        },
        payload,
      });

      return sendJson(res, 204);
    }

    /* Lets the page add browser-side lines (iframe load, postMessage) to the shared log. */
    if (req.method === 'POST' && url.pathname === '/__poc/browser-event') {
      const { title, detail } = await readJson(req);
      logEvent('browser', String(title).slice(0, 200), detail);
      return sendJson(res, 204);
    }

    if (req.method === 'GET' && url.pathname === '/__poc/events') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return sendJson(res, 200, events.filter((e) => e.id > since));
    }

    if (req.method === 'POST' && url.pathname === '/__poc/reset') {
      events.length = 0;
      return sendJson(res, 204);
    }

    res.writeHead(404).end('Not found');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error.message ?? error));
  }
});

server.listen(PARTNER_PORT, () => {
  console.log(`Partner site  ${PARTNER_ORIGIN}`);
  console.log(`Minting from  ${API_URL}${API_KEY ? '' : '   (SCANIFLY_API_KEY not set!)'}`);
});
