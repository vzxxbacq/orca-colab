import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { ensureColabHome, getColabPaths, readJsonFile, writeJsonAtomic } from "./colab-home.mjs";
import { openUrlInSystemBrowser } from "./open-url.mjs";

export const COLAB_OAUTH_CONFIG = Object.freeze({
  colabApiDomain: "https://colab.research.google.com",
  colabPublicApiDomain: "https://colaboratory.googleapis.com",
  authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revokeEndpoint: "https://oauth2.googleapis.com/revoke",
  userInfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: [
    "profile",
    "email",
    "https://www.googleapis.com/auth/colaboratory",
  ],
});

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const OAUTH_REAUTH_REQUIRED = "OAUTH_REAUTH_REQUIRED";
// Answers no retry changes: the refresh token is dead, or this client may no longer use it.
const DEFINITIVE_OAUTH_REFUSALS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);
const COLAB_SCOPE = "https://www.googleapis.com/auth/colaboratory";

function describeRefusal(error, description) {
  if (error === "client_changed") {
    return "signed in before orca-colab switched to its own Google OAuth client";
  }
  if (error === "colab_scope_missing") {
    return "the sign-in no longer includes Colab access";
  }
  return `Google sign-in expired or was revoked (${[error, description].filter(Boolean).join(": ")})`;
}

// The saved sign-in cannot be used again; only a new sign-in fixes it. Never built for a network
// failure or a 5xx.
export function reauthRequiredError({ account = null, email = null, error, description = null, at = null }) {
  const who = account ? ` for account '${account}'${email && email !== account ? ` (${email})` : ""}` : "";
  const reason = describeRefusal(error, description);
  const message =
    error === "client_changed" || error === "colab_scope_missing"
      ? `Google sign-in${who} is no longer usable: ${reason}. Sign in again with 'orca-colab auth login' (tick the Colab permission); no sign-out is needed.`
      : `${reason}${who}. Sign in again with 'orca-colab auth login' (tick the Colab permission); no sign-out is needed.`;
  return Object.assign(new Error(message), {
    name: "OAuthReauthRequiredError",
    code: OAUTH_REAUTH_REQUIRED,
    account,
    email,
    googleError: error,
    googleErrorDescription: description,
    reason,
    at,
  });
}

// What a failed command puts in its --json payload for this error.
export function reauthErrorPayload(err) {
  return {
    ok: false,
    error: err.message,
    code: OAUTH_REAUTH_REQUIRED,
    reauthRequired: true,
    account: err.account ?? null,
    googleError: err.googleError ?? null,
    googleErrorDescription: err.googleErrorDescription ?? null,
    hint: "Run 'orca-colab auth login' to sign in again; no sign-out is needed.",
  };
}

// The plugin's own Desktop OAuth client (GCP project orca-colab-community). Its secret lives
// only in the token relay (token-relay/), which adds it to the two token requests and keeps nothing.
const DEFAULT_DESKTOP_CLIENT_ID = "744100990078-mbs5l25fle4cup2b3pphq8ovatdetvnn.apps.googleusercontent.com";
export const DEFAULT_TOKEN_RELAY = "https://orca-colab-token-relay.fhq981014.workers.dev";

export function resolveOAuthClientConfig(homeDir = os.homedir()) {
  if (process.env.ORCA_COLAB_CLIENT_ID && process.env.ORCA_COLAB_CLIENT_SECRET) {
    return {
      clientId: process.env.ORCA_COLAB_CLIENT_ID,
      clientSecret: process.env.ORCA_COLAB_CLIENT_SECRET,
    };
  }
  const store = readOAuthStore(homeDir);
  if (store.clientConfig?.clientId && store.clientConfig?.clientSecret) {
    return {
      clientId: store.clientConfig.clientId,
      clientSecret: store.clientConfig.clientSecret,
    };
  }
  return {
    clientId: DEFAULT_DESKTOP_CLIENT_ID,
    clientSecret: null,
    relayUrl: process.env.ORCA_COLAB_TOKEN_RELAY || DEFAULT_TOKEN_RELAY,
  };
}

// With a user-supplied secret the request goes straight to Google; otherwise through the relay.
async function postTokenGrant(grant, { clientId, clientSecret, relayUrl, fetchImpl }) {
  if (clientSecret) {
    return fetchImpl(COLAB_OAUTH_CONFIG.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...grant, client_id: clientId, client_secret: clientSecret }).toString(),
    });
  }
  const { grant_type: grantType, ...rest } = grant;
  const path = grantType === "refresh_token" ? "/refresh" : "/token";
  return fetchImpl(`${String(relayUrl).replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rest),
  });
}

// Google revokes the grant, not the one token: every refresh token this Google account holds for the
// OAuth client stops working, on every machine. No client secret needed.
export async function revokeGoogleToken(token, { fetchImpl = fetch } = {}) {
  if (!token) return false;
  try {
    const res = await fetchImpl(COLAB_OAUTH_CONFIG.revokeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function generatePkcePair() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function buildGoogleAuthUrl({
  redirectUri,
  nonce,
  codeChallenge,
  scopes = COLAB_OAUTH_CONFIG.scopes,
  clientId = resolveOAuthClientConfig().clientId,
  loginHint,
  prompt = "select_account consent",
}) {
  const url = new URL(COLAB_OAUTH_CONFIG.authEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", `nonce=${nonce}`);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (prompt) {
    url.searchParams.set("prompt", prompt);
  }
  if (loginHint) {
    url.searchParams.set("login_hint", loginHint);
  }
  return url.toString();
}

export function readOAuthStore(homeDir = os.homedir()) {
  const { oauthPath } = getColabPaths(homeDir);
  const parsed = readJsonFile(oauthPath);
  if (!parsed || typeof parsed !== "object") {
    return { accounts: {} };
  }
  return {
    ...(parsed.clientConfig ? { clientConfig: parsed.clientConfig } : {}),
    accounts:
      parsed.accounts && typeof parsed.accounts === "object"
        ? { ...parsed.accounts }
        : {},
  };
}

export function writeOAuthStore(store, homeDir = os.homedir()) {
  const { oauthPath } = ensureColabHome(homeDir);
  const normalized = {
    ...(store?.clientConfig ? { clientConfig: store.clientConfig } : {}),
    accounts: store && typeof store.accounts === "object" ? store.accounts : {},
  };
  writeJsonAtomic(oauthPath, normalized, { mode: 0o600 });
  return normalized;
}

export function resolveOAuthAccountKey(account = "default", store = null, homeDir = os.homedir()) {
  const s = store || readOAuthStore(homeDir);
  const accounts = s?.accounts || {};
  const requested = String(account || "default").trim();
  if (accounts[requested]) {
    return requested;
  }
  const lower = requested.toLowerCase();
  for (const [key, entry] of Object.entries(accounts)) {
    if (
      key.toLowerCase() === lower ||
      (typeof entry?.email === "string" && entry.email.toLowerCase() === lower)
    ) {
      return key;
    }
  }
  return requested;
}

export function getStoredOAuthCredentials(account = "default", homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  const key = resolveOAuthAccountKey(account, store, homeDir);
  const entry = store.accounts?.[key];
  if (!entry || typeof entry.refreshToken !== "string" || !entry.refreshToken) {
    return null;
  }
  return entry;
}

export function saveOAuthCredentials(account, credentials, homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  const key = String(account || "default").trim();
  store.accounts[key] = {
    refreshToken: credentials.refreshToken,
    accessToken: credentials.accessToken,
    expiryDate: credentials.expiryDate,
    scope: credentials.scope || COLAB_OAUTH_CONFIG.scopes.join(" "),
    email: credentials.email || null,
    name: credentials.name || null,
    clientId: credentials.clientId || null,
    // `updatedAt` moves with every refresh; these two say how old the sign-in itself is and when Google
    // said it would end it (only clients that issue time-limited refresh tokens say so).
    signedInAt: "signedInAt" in credentials ? credentials.signedInAt || null : new Date().toISOString(),
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt || null,
    updatedAt: new Date().toISOString(),
  };
  writeOAuthStore(store, homeDir);
  return readOAuthAccountStatus(key, homeDir);
}

export function removeOAuthCredentials(account = "default", homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  const key = resolveOAuthAccountKey(account, store, homeDir);
  const existed = Boolean(store.accounts?.[key]);
  if (existed) {
    delete store.accounts[key];
    writeOAuthStore(store, homeDir);
  }
  return existed;
}

// A refresh token only works with the client that issued it; sign-ins from before v0.3.0 used another one.
function issuedByCurrentClient(entry, homeDir) {
  return entry.clientId === resolveOAuthClientConfig(homeDir).clientId;
}

// Sign-out removes this machine's entry and leaves Google alone: revoking would sign out every other
// machine that uses the same Google account (see revokeGoogleToken). `revoke` is that explicit "sign out
// everywhere"; the local entry is removed even when Google cannot be reached.
export async function signOutOAuthAccount(
  account = "default",
  homeDir = os.homedir(),
  { fetchImpl = fetch, revoke = false } = {},
) {
  const store = readOAuthStore(homeDir);
  const key = resolveOAuthAccountKey(account, store, homeDir);
  const entry = store.accounts?.[key];
  const revoked =
    revoke && entry ? await revokeGoogleToken(entry.refreshToken || entry.accessToken, { fetchImpl }) : false;
  const removed = removeOAuthCredentials(key, homeDir);
  return { account: key, removed, revoked };
}

// Recorded against the refresh token Google refused, so a sign-in that finished meanwhile stays clean.
function markReauthRequired(account, refusedRefreshToken, { error, description }, homeDir) {
  const store = readOAuthStore(homeDir);
  const entry = store.accounts?.[account];
  if (!entry || entry.refreshToken !== refusedRefreshToken) {
    return null;
  }
  const reauthAt = entry.reauthRequired && entry.reauthError === error ? entry.reauthAt : new Date().toISOString();
  store.accounts[account] = {
    ...entry,
    reauthRequired: true,
    reauthError: error,
    reauthDescription: description || null,
    reauthAt,
  };
  writeOAuthStore(store, homeDir);
  return reauthAt;
}

export function readOAuthAccountStatus(account = "default", homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  const key = resolveOAuthAccountKey(account, store, homeDir);
  const entry = store.accounts?.[key];
  if (!entry || typeof entry.refreshToken !== "string" || !entry.refreshToken) {
    return {
      account: key,
      authenticated: false,
      email: null,
      name: null,
      updatedAt: null,
    };
  }
  if (!issuedByCurrentClient(entry, homeDir)) {
    return {
      account: key,
      authenticated: false,
      reauthRequired: true,
      reauthError: "client_changed",
      reauthReason: describeRefusal("client_changed"),
      reauthAt: null,
      email: entry.email || null,
      name: entry.name || null,
      updatedAt: entry.updatedAt || null,
    };
  }
  const lifetime = {
    signedInAt: entry.signedInAt || null,
    refreshTokenExpiresAt: entry.refreshTokenExpiresAt || null,
  };
  if (entry.reauthRequired) {
    return {
      account: key,
      authenticated: false,
      reauthRequired: true,
      reauthError: entry.reauthError || null,
      reauthReason: describeRefusal(entry.reauthError, entry.reauthDescription),
      reauthAt: entry.reauthAt || null,
      email: entry.email || null,
      name: entry.name || null,
      updatedAt: entry.updatedAt || null,
      ...lifetime,
    };
  }
  return {
    account: key,
    authenticated: true,
    email: entry.email || null,
    name: entry.name || null,
    updatedAt: entry.updatedAt || null,
    ...lifetime,
  };
}

// Every account with a saved sign-in, usable or not.
export function listStoredOAuthAccounts(homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  return Object.keys(store.accounts || {})
    .map((key) => readOAuthAccountStatus(key, homeDir))
    .filter((entry) => entry.authenticated || entry.reauthRequired);
}

export function listOAuthAccounts(homeDir = os.homedir()) {
  return listStoredOAuthAccounts(homeDir).filter((entry) => entry.authenticated);
}

// Accounts whose saved sign-in Google refuses; they need `auth login` again, not a sign-out.
export function listReauthAccounts(homeDir = os.homedir()) {
  return listStoredOAuthAccounts(homeDir).filter((entry) => entry.reauthRequired);
}

export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  redirectUri,
  homeDir = os.homedir(),
  clientConfig = resolveOAuthClientConfig(homeDir),
  fetchImpl = fetch,
}) {
  const response = await postTokenGrant(
    { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri },
    { ...clientConfig, fetchImpl },
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (${response.status}): ${errText}`);
  }

  const tokens = await response.json();
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("OAuth response missing access_token or refresh_token.");
  }

  const expiryDate = tokens.expiry_date
    ? Number(tokens.expiry_date)
    : Date.now() + Number(tokens.expires_in || 3600) * 1000;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate,
    scope: tokens.scope || COLAB_OAUTH_CONFIG.scopes.join(" "),
    refreshTokenExpiresAt: refreshTokenExpiry(tokens),
  };
}

// Google adds `refresh_token_expires_in` only when the refresh token has a fixed lifetime, as with an
// OAuth client whose consent screen is in "Testing" (7 days).
function refreshTokenExpiry(tokens) {
  const seconds = Number(tokens?.refresh_token_expires_in);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null;
}

export async function refreshAccessToken({
  refreshToken,
  homeDir = os.homedir(),
  clientConfig = resolveOAuthClientConfig(homeDir),
  fetchImpl = fetch,
}) {
  const response = await postTokenGrant(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    { ...clientConfig, fetchImpl },
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    let refusal = null;
    try {
      refusal = JSON.parse(errText);
    } catch {
      // Not JSON (a gateway page, an empty body): not Google's verdict on the token.
    }
    if (response.status >= 400 && response.status < 500 && DEFINITIVE_OAUTH_REFUSALS.has(refusal?.error)) {
      throw reauthRequiredError({
        error: refusal.error,
        description: typeof refusal.error_description === "string" ? refusal.error_description : null,
      });
    }
    throw Object.assign(new Error(`OAuth token refresh failed (${response.status}): ${errText}`), {
      code: "OAUTH_REFRESH_FAILED",
      status: response.status,
    });
  }

  const tokens = await response.json();
  if (!tokens.access_token) {
    throw new Error("OAuth refresh response missing access_token.");
  }
  if (typeof tokens.scope === "string" && !grantedColabScope(tokens.scope)) {
    throw reauthRequiredError({ error: "colab_scope_missing" });
  }

  const expiryDate = tokens.expiry_date
    ? Number(tokens.expiry_date)
    : Date.now() + Number(tokens.expires_in || 3600) * 1000;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiryDate,
    scope: tokens.scope,
    refreshTokenExpiresAt: refreshTokenExpiry(tokens),
  };
}

export async function fetchGoogleUserProfile(accessToken, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(COLAB_OAUTH_CONFIG.userInfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      return { email: null, name: null };
    }
    const profile = await res.json();
    return {
      email: typeof profile.email === "string" ? profile.email : null,
      name: typeof profile.name === "string" ? profile.name : null,
    };
  } catch {
    return { email: null, name: null };
  }
}

// `recheck` asks Google again about a sign-in already recorded as refused (and clears the record when
// Google accepts it); `forceRefresh` skips the cached access token, which says nothing about the
// refresh token.
export async function getValidAccessToken({
  account = "default",
  homeDir = os.homedir(),
  fetchImpl = fetch,
  recheck = false,
  forceRefresh = false,
} = {}) {
  const store = readOAuthStore(homeDir);
  const resolvedKey = resolveOAuthAccountKey(account, store, homeDir);
  const stored = store.accounts?.[resolvedKey];
  if (!stored || typeof stored.refreshToken !== "string" || !stored.refreshToken) {
    return null;
  }
  if (!issuedByCurrentClient(stored, homeDir)) {
    return null;
  }

  const refused = (error, description, at) =>
    reauthRequiredError({ account: resolvedKey, email: stored.email || null, error, description, at });
  if (stored.reauthRequired && !recheck) {
    throw refused(stored.reauthError, stored.reauthDescription, stored.reauthAt || null);
  }

  const now = Date.now();
  if (
    !forceRefresh &&
    !stored.reauthRequired &&
    stored.accessToken &&
    typeof stored.expiryDate === "number" &&
    stored.expiryDate - TOKEN_REFRESH_BUFFER_MS > now
  ) {
    return stored.accessToken;
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken({
      refreshToken: stored.refreshToken,
      homeDir,
      fetchImpl,
    });
  } catch (err) {
    if (err?.code !== OAUTH_REAUTH_REQUIRED) throw err;
    const at = markReauthRequired(
      resolvedKey,
      stored.refreshToken,
      { error: err.googleError, description: err.googleErrorDescription },
      homeDir,
    );
    throw refused(err.googleError, err.googleErrorDescription, at);
  }

  saveOAuthCredentials(
    resolvedKey,
    {
      ...stored,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiryDate: refreshed.expiryDate,
      signedInAt: stored.signedInAt || null,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt || stored.refreshTokenExpiresAt || null,
    },
    homeDir,
  );

  return refreshed.accessToken;
}

// Which store entry a fresh sign-in lands in: the entry that already holds this email, else the
// requested label, else the email itself when adding or when "default" belongs to someone else.
export function resolveTargetAccount({ store, account = "default", addAccount = false, email = null }) {
  let targetAccount = account || "default";
  if (!email) {
    return targetAccount === "auto" ? "default" : targetAccount;
  }
  const existingMatch = Object.entries(store?.accounts || {}).find(
    ([, entry]) => typeof entry?.email === "string" && entry.email.toLowerCase() === email.toLowerCase(),
  );
  if (existingMatch && (targetAccount === "default" || targetAccount === "auto" || addAccount)) {
    return existingMatch[0];
  }
  if (
    addAccount ||
    targetAccount === "auto" ||
    (targetAccount === "default" &&
      store?.accounts?.default?.email &&
      store.accounts.default.email.toLowerCase() !== email.toLowerCase())
  ) {
    return email;
  }
  return targetAccount;
}

function callbackPage(title, text, color) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px 36px;max-width:440px;text-align:center"><h2 style="margin:0 0 8px;color:${color}">${title}</h2><p style="margin:0;color:#94a3b8;font-size:14px">${text}</p></div></body>`;
}

// Google's granular consent lists extra scopes as checkboxes that start unticked, so a sign-in can succeed
// without Colab access.
export function grantedColabScope(scope) {
  return String(scope || "").split(/\s+/).includes(COLAB_SCOPE);
}

// Sign-in ends on a loopback address of the machine that runs orca-colab. A browser elsewhere cannot load
// it; `handOff` says where the user takes the address instead.
export function remoteBrowserSignInNote(handOff) {
  return `If the browser is on another machine than orca-colab, the last page (http://127.0.0.1:PORT/...) will not load. That is expected: copy its full address from the address bar and ${handOff}. That address is a one-time key to the Colab account; send it nowhere else.`;
}

export async function runLoopbackOAuthFlow({
  account = "default",
  addAccount = false,
  homeDir = os.homedir(),
  timeoutMs = 180_000,
  openBrowser = openUrlInSystemBrowser,
  fetchImpl = fetch,
  onAuthUrl,
  signal,
  persist = true,
} = {}) {
  const nonce = randomUUID();
  const { codeVerifier, codeChallenge } = generatePkcePair();

  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      if (reqUrl.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (reqUrl.pathname !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const errorParam = reqUrl.searchParams.get("error");
      if (errorParam) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Colab Sign-in Failed</title><body style="font-family:system-ui;padding:32px"><h2>Google Colab sign-in failed: ${errorParam}</h2><p>You may close this tab.</p></body>`,
        );
        rejectCode(new Error(`Google OAuth returned error: ${errorParam}`));
        return;
      }

      const state = reqUrl.searchParams.get("state") || "";
      const parsedState = new URLSearchParams(state);
      const returnedNonce = parsedState.get("nonce");
      const code = reqUrl.searchParams.get("code");

      if (returnedNonce !== nonce || !code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid state or missing code.");
        return;
      }

      // The page waits for the token exchange so it can say whether Colab access was actually granted.
      resolveCode({ code, res });
    } catch (err) {
      rejectCode(err);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addressInfo = server.address();
  const redirectUri = `http://127.0.0.1:${addressInfo.port}`;
  const clientConfig = resolveOAuthClientConfig(homeDir);
  const { clientId } = clientConfig;
  const authUrl = buildGoogleAuthUrl({
    redirectUri,
    nonce,
    codeChallenge,
    clientId,
  });

  if (typeof onAuthUrl === "function") {
    onAuthUrl(authUrl, redirectUri);
  }

  await openBrowser(authUrl);

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Google sign-in after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });

  const abortPromise = new Promise((_, reject) => {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(new Error("OAuth sign-in aborted."));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("OAuth sign-in aborted.")),
      { once: true },
    );
  });

  try {
    const { code, res } = await Promise.race([codePromise, timeoutPromise, abortPromise]);
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode({
        code,
        codeVerifier,
        redirectUri,
        homeDir,
        clientConfig,
        fetchImpl,
      });
    } catch (err) {
      // Google's consent went through; what failed is this machine's own request for the tokens.
      const reason = String(err?.message || err).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        callbackPage(
          "Google Colab sign-in failed",
          `${reason}<br><br>Nothing was saved. Fix the cause, then press Sign in again in Orca (or run 'orca-colab auth login'); no restart is needed.`,
          "#f87171",
        ),
      );
      throw err;
    }
    if (!grantedColabScope(tokens.scope)) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        callbackPage(
          "Colab access was not granted",
          "Google's consent page lists Colab access as a checkbox that starts unticked. Sign in again from Orca and tick &ldquo;Read, write and delete your Colab resources&rdquo; (or Select all).",
          "#fbbf24",
        ),
      );
      const err = new Error(
        "Google did not grant Colab access: on the consent page, tick 'Read, write and delete your Colab resources' (or Select all), then sign in again.",
      );
      err.code = "COLAB_SCOPE_NOT_GRANTED";
      throw err;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      callbackPage(
        "Signed in to Google Colab",
        "orca-colab is now connected. You can close this browser tab and return to Orca.",
        "#38bdf8",
      ),
    );
    const profile = await fetchGoogleUserProfile(tokens.accessToken, { fetchImpl });
    const credentials = { ...tokens, email: profile.email, name: profile.name, clientId };
    if (!persist) {
      // The caller stores these elsewhere (for example on a remote Orca server).
      return { persisted: false, account, addAccount, email: profile.email, name: profile.name, credentials };
    }
    const targetAccount = resolveTargetAccount({
      store: readOAuthStore(homeDir),
      account,
      addAccount,
      email: profile.email,
    });
    return saveOAuthCredentials(targetAccount, credentials, homeDir);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
