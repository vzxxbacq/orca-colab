import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runAuth } from "../bin/commands/auth.mjs";
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

test("auth login --no-browser explains the 127.0.0.1 page that will not load and where to take its address", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-colab-oauth-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let err = "";
  const controller = new AbortController();
  const code = await runAuth(["login", "--no-browser"], {
    json: true,
    stdout: { write() {} },
    stderr: {
      write: (chunk) => {
        err += chunk;
        if (err.includes("auth redirect")) controller.abort();
      },
    },
    homeDir: home,
    signal: controller.signal,
  });
  assert.equal(code, 1);
  const lines = err.split("\n");
  assert.equal(lines[0], "[colab] Open the URL below in any browser and tick the Colab permission on Google's consent page.");
  assert.match(lines[1], /^\[colab\] Sign-in URL: https:\/\/accounts\.google\.com\//);
  assert.equal(
    lines[2],
    "[colab] If the browser is on another machine than orca-colab, the last page (http://127.0.0.1:PORT/...) will not load. That is expected: copy its full address from the address bar and run 'orca-colab auth redirect <address>' on this machine. That address is a one-time key to the Colab account; send it nowhere else.",
  );
});
