// orca-colab token relay: adds the app's Google OAuth client secret to two token requests and nothing
// else. It stores, logs and forwards nothing besides the request to Google and Google's answer.
// Source of truth for what it may do: README "Google sign-in relay".
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MAX_BODY_BYTES = 4096;
// The desktop flow only ever redirects to the user's own machine.
const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/;
// Per client IP. A person signs in rarely and refreshes about once an hour per account, so these only
// bite a script hammering the relay; an office behind one IP still fits comfortably.
export const RATE_RULES = [
  { windowMs: 60_000, max: 30 },
  { windowMs: 3_600_000, max: 300 },
];
const ABOUT =
  "orca-colab token relay. POST /token exchanges a PKCE authorization code, POST /refresh refreshes an " +
  "access token; both add the app's client secret and return Google's answer unchanged. Nothing is " +
  "stored or logged. Source: https://github.com/vzxxbacq/orca-colab/tree/main/token-relay\n";

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}

// Fixed windows per rule; returns 0 when the request may pass, else the seconds until it may.
export function takeRateToken(windows, now, rules = RATE_RULES) {
  for (const rule of rules) {
    const w = windows[rule.windowMs];
    if (w && now - w.start < rule.windowMs && w.count >= rule.max) {
      return Math.ceil((w.start + rule.windowMs - now) / 1000);
    }
  }
  for (const rule of rules) {
    const w = windows[rule.windowMs];
    if (!w || now - w.start >= rule.windowMs) windows[rule.windowMs] = { start: now, count: 1 };
    else w.count += 1;
  }
  return 0;
}

// One instance per client IP (idFromName), so every Cloudflare location sees the same count. Counts live
// in memory only; an instance evicted after a quiet spell simply starts its windows again.
export class IpRateLimiter {
  constructor() {
    this.windows = {};
  }

  async fetch() {
    const retryAfter = takeRateToken(this.windows, Date.now());
    return new Response(null, { status: retryAfter ? 429 : 204, headers: { "retry-after": String(retryAfter) } });
  }
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isToken = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !/\s/.test(v);

function grantFor(path, body) {
  if (path === "/token") {
    if (!isToken(body.code, 2048) || !isToken(body.code_verifier, 128) || !LOOPBACK_REDIRECT.test(body.redirect_uri ?? "")) {
      return null;
    }
    return {
      grant_type: "authorization_code",
      code: body.code,
      code_verifier: body.code_verifier,
      redirect_uri: body.redirect_uri,
    };
  }
  if (path === "/refresh") {
    if (!isToken(body.refresh_token, 2048)) return null;
    return { grant_type: "refresh_token", refresh_token: body.refresh_token };
  }
  return null;
}

export default {
  async fetch(request, env, _ctx, { fetchImpl = fetch } = {}) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      return new Response(ABOUT, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.method !== "POST" || (pathname !== "/token" && pathname !== "/refresh")) {
      return json(404, { error: "not_found" });
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return json(413, { error: "request_too_large" });
    }
    if (env.IP_LIMITER) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const verdict = await env.IP_LIMITER.get(env.IP_LIMITER.idFromName(ip)).fetch("https://limiter/");
      if (verdict.status === 429) {
        const retryAfter = verdict.headers.get("retry-after") ?? "60";
        return json(429, { error: "rate_limited", retryAfterSeconds: Number(retryAfter) }, { "retry-after": retryAfter });
      }
    }
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return json(503, { error: "relay_not_configured" });
    }
    const body = await readJsonBody(request);
    const grant = body && grantFor(pathname, body);
    if (!grant) return json(400, { error: "invalid_request" });

    const upstream = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...grant,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      }),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};
