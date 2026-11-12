import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { COLAB_HEADERS } from "../bin/lib/colab-api-client.mjs";
import {
  getValidAccessToken,
  readOAuthAccountStatus,
  readOAuthStore,
  runLoopbackOAuthFlow,
  resolveOAuthClientConfig,
  saveOAuthCredentials,
} from "../bin/lib/colab-oauth.mjs";

const fresh = { refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, email: "u@example.com" };

test("a sign-in from another OAuth client asks for a new login instead of refreshing", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-colab-oauth-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  saveOAuthCredentials("legacy", fresh, home);
  assert.equal(readOAuthAccountStatus("legacy", home).authenticated, false);
  assert.equal(readOAuthAccountStatus("legacy", home).reauthRequired, true);
  assert.equal(await getValidAccessToken({ account: "legacy", homeDir: home }), null);

  saveOAuthCredentials("current", { ...fresh, clientId: resolveOAuthClientConfig(home).clientId }, home);
  assert.equal(readOAuthAccountStatus("current", home).authenticated, true);
  assert.equal(await getValidAccessToken({ account: "current", homeDir: home }), "a");
});

test("Colab API requests no longer identify as the VS Code extension", () => {
  assert.deepEqual(
    Object.keys(COLAB_HEADERS).filter((h) => /vs-?code|client-agent/i.test(h)),
    [],
  );
});

test("a sign-in where the Colab checkbox was left unticked fails and stores nothing", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-colab-oauth-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let page;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    }),
  });
  const openBrowser = async (authUrl) => {
    const redirect = new URL(authUrl).searchParams.get("redirect_uri");
    const state = new URL(authUrl).searchParams.get("state");
    page = fetch(`${redirect}/?state=${encodeURIComponent(state)}&code=c`);
  };

  await assert.rejects(runLoopbackOAuthFlow({ homeDir: home, openBrowser, fetchImpl }), {
    code: "COLAB_SCOPE_NOT_GRANTED",
  });
  assert.equal((await page).status, 403);
  assert.deepEqual(readOAuthStore(home).accounts, {});
});
