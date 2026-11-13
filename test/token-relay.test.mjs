import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import relay from "../token-relay/src/index.mjs";
import {
  DEFAULT_TOKEN_RELAY,
  exchangeAuthorizationCode,
  readOAuthStore,
  refreshAccessToken,
  resolveOAuthClientConfig,
  saveOAuthCredentials,
  signOutOAuthAccount,
} from "../bin/lib/colab-oauth.mjs";

const ENV = { GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "relay-secret" };
const post = (pathname, body, headers = {}) =>
  new Request(`https://relay.example${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("the relay adds the client secret to a loopback PKCE exchange and a refresh, and returns Google's answer", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response('{"access_token":"a"}', { status: 200 });
  };
  const exchanged = await relay.fetch(
    post("/token", { code: "4/abc", code_verifier: "v".repeat(43), redirect_uri: "http://127.0.0.1:53123" }),
    ENV,
    null,
    { fetchImpl },
  );
  const refreshed = await relay.fetch(post("/refresh", { refresh_token: "1//r" }), ENV, null, { fetchImpl });

  assert.equal(exchanged.status, 200);
  assert.equal(await refreshed.text(), '{"access_token":"a"}');
  assert.deepEqual(sent, [
    {
      url: "https://oauth2.googleapis.com/token",
      body: {
        grant_type: "authorization_code",
        code: "4/abc",
        code_verifier: "v".repeat(43),
        redirect_uri: "http://127.0.0.1:53123",
        client_id: "cid.apps.googleusercontent.com",
        client_secret: "relay-secret",
      },
    },
    {
      url: "https://oauth2.googleapis.com/token",
      body: {
        grant_type: "refresh_token",
        refresh_token: "1//r",
        client_id: "cid.apps.googleusercontent.com",
        client_secret: "relay-secret",
      },
    },
  ]);
});

test("the relay refuses anything but the two loopback token requests, and rate-limits per IP", async () => {
  const fetchImpl = async () => assert.fail("Google must not be called");
  const status = async (req, env = ENV) => (await relay.fetch(req, env, null, { fetchImpl })).status;
  const ok = { code: "4/abc", code_verifier: "v".repeat(43), redirect_uri: "http://127.0.0.1:1" };

  assert.equal(await status(post("/token", { ...ok, redirect_uri: "https://evil.example/cb" })), 400);
  assert.equal(await status(post("/token", { ...ok, grant_type: "client_credentials", code: "" })), 400);
  assert.equal(await status(post("/refresh", "not json")), 400);
  assert.equal(await status(post("/revoke", ok)), 404);
  assert.equal(await status(new Request("https://relay.example/token")), 404);
  assert.equal(await status(post("/refresh", { refresh_token: "x".repeat(5000) })), 400);
  assert.equal(await status(post("/token", ok), { GOOGLE_CLIENT_ID: "cid" }), 503);
  const limited = { ...ENV, RATE_LIMITER: { limit: async ({ key }) => ({ success: key !== "203.0.113.9" }) } };
  assert.equal(await status(post("/token", ok, { "cf-connecting-ip": "203.0.113.9" }), limited), 429);
});

test("the CLI sends token requests through the relay without a secret, or straight to Google with a user's own client", async (t) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), { status: 200 });
  };
  await exchangeAuthorizationCode({ code: "c", codeVerifier: "v", redirectUri: "http://127.0.0.1:9", fetchImpl });
  await refreshAccessToken({ refreshToken: "r", fetchImpl });
  assert.deepEqual(calls.map((c) => [c.url, JSON.parse(c.body)]), [
    [`${DEFAULT_TOKEN_RELAY}/token`, { code: "c", code_verifier: "v", redirect_uri: "http://127.0.0.1:9" }],
    [`${DEFAULT_TOKEN_RELAY}/refresh`, { refresh_token: "r" }],
  ]);
  assert.equal(resolveOAuthClientConfig().clientSecret, null);

  process.env.ORCA_COLAB_CLIENT_ID = "own-id";
  process.env.ORCA_COLAB_CLIENT_SECRET = "own-secret";
  t.after(() => {
    delete process.env.ORCA_COLAB_CLIENT_ID;
    delete process.env.ORCA_COLAB_CLIENT_SECRET;
  });
  calls.length = 0;
  await refreshAccessToken({ refreshToken: "r", fetchImpl });
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), {
    grant_type: "refresh_token",
    refresh_token: "r",
    client_id: "own-id",
    client_secret: "own-secret",
  });
});

test("signing out revokes the refresh token at Google before removing it locally", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-colab-signout-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveOAuthCredentials("default", { refreshToken: "1//keep-out", accessToken: "a", expiryDate: 0 }, home);
  const revoked = [];
  const fetchImpl = async (url, init) => {
    revoked.push({ url, token: new URLSearchParams(init.body).get("token") });
    return new Response("", { status: 200 });
  };
  assert.deepEqual(await signOutOAuthAccount("default", home, { fetchImpl }), {
    account: "default",
    removed: true,
    revoked: true,
  });
  assert.deepEqual(revoked, [{ url: "https://oauth2.googleapis.com/revoke", token: "1//keep-out" }]);
  assert.deepEqual(readOAuthStore(home).accounts, {});
});
