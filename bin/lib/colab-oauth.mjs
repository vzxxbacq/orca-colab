import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { ensureColabHome, getColabPaths, readJsonFile, writeJsonAtomic } from "./colab-home.mjs";
import { openUrlInSystemBrowser } from "./open-url.mjs";

export const COLAB_OAUTH_CONFIG = Object.freeze({
  colabApiDomain: "https://colab.research.google.com",
  colabGapiDomain: "https://colab.pa.googleapis.com",
  colabPublicApiDomain: "https://colaboratory.googleapis.com",
  authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revokeEndpoint: "https://oauth2.googleapis.com/revoke",
  userInfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
  openVsxLatestUrl: "https://open-vsx.org/api/google/colab/latest",
  scopes: [
    "profile",
    "email",
    "https://www.googleapis.com/auth/colaboratory",
  ],
});

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const DEFAULT_DESKTOP_CLIENT_PARTS = [
  "MTAxNDE2MDQ5MDE1OS1jdm90M2JlYTd0Z2twNzJh",
  "NG0yOWgyMGQ5ZGRvNmJuZS5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
];
const DEFAULT_DESKTOP_SECRET_PARTS = [
  "R09DU1BYLUVGNEZpcmJWUWNMckRS",
  "dndqY3BEWFUtMGlVcTQ=",
];

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
    clientId: Buffer.from(DEFAULT_DESKTOP_CLIENT_PARTS.join(""), "base64").toString("utf8"),
    clientSecret: Buffer.from(DEFAULT_DESKTOP_SECRET_PARTS.join(""), "base64").toString("utf8"),
  };
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
  prompt = "consent",
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

export function getStoredOAuthCredentials(account = "default", homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  const entry = store.accounts?.[account];
  if (!entry || typeof entry.refreshToken !== "string" || !entry.refreshToken) {
    return null;
  }
  return entry;
}

export function saveOAuthCredentials(account, credentials, homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  store.accounts[account] = {
    refreshToken: credentials.refreshToken,
    accessToken: credentials.accessToken,
    expiryDate: credentials.expiryDate,
    scope: credentials.scope || COLAB_OAUTH_CONFIG.scopes.join(" "),
    email: credentials.email || null,
    name: credentials.name || null,
    updatedAt: new Date().toISOString(),
  };
  writeOAuthStore(store, homeDir);
  return readOAuthAccountStatus(account, homeDir);
}

export function removeOAuthCredentials(account = "default", homeDir = os.homedir()) {
  const store = readOAuthStore(homeDir);
  const existed = Boolean(store.accounts?.[account]);
  if (existed) {
    delete store.accounts[account];
    writeOAuthStore(store, homeDir);
  }
  return existed;
}

export function readOAuthAccountStatus(account = "default", homeDir = os.homedir()) {
  const entry = getStoredOAuthCredentials(account, homeDir);
  if (!entry) {
    return {
      account,
      authenticated: false,
      email: null,
      name: null,
      updatedAt: null,
    };
  }
  return {
    account,
    authenticated: true,
    email: entry.email || null,
    name: entry.name || null,
    updatedAt: entry.updatedAt || null,
  };
}

export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  redirectUri,
  homeDir = os.homedir(),
  clientId = resolveOAuthClientConfig(homeDir).clientId,
  clientSecret = resolveOAuthClientConfig(homeDir).clientSecret,
  fetchImpl = fetch,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetchImpl(COLAB_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

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
  };
}

export async function refreshAccessToken({
  refreshToken,
  homeDir = os.homedir(),
  clientId = resolveOAuthClientConfig(homeDir).clientId,
  clientSecret = resolveOAuthClientConfig(homeDir).clientSecret,
  fetchImpl = fetch,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetchImpl(COLAB_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OAuth token refresh failed (${response.status}): ${errText}`);
  }

  const tokens = await response.json();
  if (!tokens.access_token) {
    throw new Error("OAuth refresh response missing access_token.");
  }

  const expiryDate = tokens.expiry_date
    ? Number(tokens.expiry_date)
    : Date.now() + Number(tokens.expires_in || 3600) * 1000;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiryDate,
    scope: tokens.scope,
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

export async function getValidAccessToken({
  account = "default",
  homeDir = os.homedir(),
  fetchImpl = fetch,
} = {}) {
  const stored = getStoredOAuthCredentials(account, homeDir);
  if (!stored) {
    return null;
  }

  const now = Date.now();
  if (
    stored.accessToken &&
    typeof stored.expiryDate === "number" &&
    stored.expiryDate - TOKEN_REFRESH_BUFFER_MS > now
  ) {
    return stored.accessToken;
  }

  const refreshed = await refreshAccessToken({
    refreshToken: stored.refreshToken,
    homeDir,
    fetchImpl,
  });

  saveOAuthCredentials(
    account,
    {
      ...stored,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiryDate: refreshed.expiryDate,
    },
    homeDir,
  );

  return refreshed.accessToken;
}

export async function runLoopbackOAuthFlow({
  account = "default",
  homeDir = os.homedir(),
  timeoutMs = 180_000,
  openBrowser = openUrlInSystemBrowser,
  fetchImpl = fetch,
  onAuthUrl,
  signal,
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

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Signed in to Google Colab</title><body style="font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px 36px;max-width:440px;text-align:center"><h2 style="margin:0 0 8px;color:#38bdf8">Signed in to Google Colab</h2><p style="margin:0;color:#94a3b8;font-size:14px">orca-colab is now connected. You can close this browser tab and return to Orca.</p></div></body>`,
      );
      resolveCode(code);
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
  const { clientId, clientSecret } = resolveOAuthClientConfig(homeDir);
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
    const code = await Promise.race([codePromise, timeoutPromise, abortPromise]);
    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier,
      redirectUri,
      homeDir,
      clientId,
      clientSecret,
      fetchImpl,
    });
    const profile = await fetchGoogleUserProfile(tokens.accessToken, { fetchImpl });
    return saveOAuthCredentials(
      account,
      {
        ...tokens,
        email: profile.email,
        name: profile.name,
      },
      homeDir,
    );
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
