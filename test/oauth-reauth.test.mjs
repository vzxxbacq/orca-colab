import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runAuth } from "../bin/commands/auth.mjs";
import { run as runDoctorCommand } from "../bin/commands/doctor.mjs";
import { run as runUp } from "../bin/commands/up.mjs";
import { discoverAccountRuntimes } from "../bin/lib/account-runtimes.mjs";
import {
  getValidAccessToken,
  readOAuthAccountStatus,
  readOAuthStore,
  resolveOAuthClientConfig,
  runLoopbackOAuthFlow,
  saveOAuthCredentials,
} from "../bin/lib/colab-oauth.mjs";
import { DashboardSnapshotBuilder } from "../bin/lib/dashboard-snapshot.mjs";
import { runDoctor } from "../bin/lib/doctor.mjs";
import { createColabMcpTools } from "../bin/lib/mcp-tools.mjs";
import { main } from "../bin/orca-colab.mjs";

const COLAB_SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/colaboratory";
const REFUSAL = { error: "invalid_grant", error_description: "Token has been expired or revoked." };
const REASON = "Google sign-in expired or was revoked (invalid_grant: Token has been expired or revoked.)";

function tempHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-colab-reauth-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// `expiresInMs` > 0 leaves a usable cached access token, as on a machine whose refresh token was
// revoked within the last hour.
function signIn(home, { expiresInMs = -1000 } = {}) {
  saveOAuthCredentials(
    "default",
    {
      refreshToken: "dead-refresh",
      accessToken: "old-access",
      expiryDate: Date.now() + expiresInMs,
      email: "u@example.com",
      clientId: resolveOAuthClientConfig(home).clientId,
    },
    home,
  );
}

// Google's answer to every refresh; any other request is answered 200 so reachability checks pass.
function googleAnswers(status, body) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return String(url).endsWith("/refresh")
      ? new Response(JSON.stringify(body), { status })
      : new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl, refreshes: () => calls.filter((u) => u.endsWith("/refresh")).length };
}

function buffers() {
  let out = "";
  return { stdout: { write: (c) => { out += c; } }, stderr: { write: () => {} }, json: () => JSON.parse(out) };
}

test("a refresh answered invalid_grant is recorded as sign-in needed and not asked again", async (t) => {
  const home = tempHome(t);
  signIn(home);
  const google = googleAnswers(400, REFUSAL);

  await assert.rejects(getValidAccessToken({ homeDir: home, fetchImpl: google.fetchImpl }), {
    code: "OAUTH_REAUTH_REQUIRED",
    account: "default",
    googleError: "invalid_grant",
    googleErrorDescription: "Token has been expired or revoked.",
  });
  const entry = readOAuthStore(home).accounts.default;
  assert.equal(entry.reauthRequired, true);
  assert.equal(entry.reauthError, "invalid_grant");
  assert.equal(entry.refreshToken, "dead-refresh");

  const status = readOAuthAccountStatus("default", home);
  assert.equal(status.authenticated, false);
  assert.equal(status.reauthRequired, true);
  assert.equal(status.reauthError, "invalid_grant");
  assert.equal(status.reauthReason, REASON);
  assert.equal(status.reauthAt, entry.reauthAt);

  await assert.rejects(getValidAccessToken({ homeDir: home, fetchImpl: google.fetchImpl }), { code: "OAUTH_REAUTH_REQUIRED" });
  assert.equal(google.refreshes(), 1);
});

test("invalid_client, unauthorized_client and a refresh without the Colab scope need a sign-in too", async (t) => {
  for (const [status, body, googleError] of [
    [401, { error: "invalid_client" }, "invalid_client"],
    [400, { error: "unauthorized_client" }, "unauthorized_client"],
    [200, { access_token: "a2", expires_in: 3600, scope: "openid email" }, "colab_scope_missing"],
  ]) {
    const home = tempHome(t);
    signIn(home);
    await assert.rejects(getValidAccessToken({ homeDir: home, fetchImpl: googleAnswers(status, body).fetchImpl }), {
      code: "OAUTH_REAUTH_REQUIRED",
      googleError,
    });
    assert.equal(readOAuthAccountStatus("default", home).reauthError, googleError);
  }
});

test("a network failure, a 5xx and a rate limit leave the sign-in as it was", async (t) => {
  const unreachable = async () => {
    throw Object.assign(new Error("Could not reach relay: ECONNREFUSED"), { code: "NETWORK_UNREACHABLE" });
  };
  for (const [fetchImpl, code] of [
    [unreachable, "NETWORK_UNREACHABLE"],
    [googleAnswers(503, REFUSAL).fetchImpl, "OAUTH_REFRESH_FAILED"],
    [googleAnswers(429, { error: "rate_limited" }).fetchImpl, "OAUTH_REFRESH_FAILED"],
    [googleAnswers(400, { error: "invalid_request" }).fetchImpl, "OAUTH_REFRESH_FAILED"],
  ]) {
    const home = tempHome(t);
    signIn(home);
    await assert.rejects(getValidAccessToken({ homeDir: home, fetchImpl }), { code });
    assert.equal(readOAuthAccountStatus("default", home).authenticated, true);
    assert.equal(readOAuthStore(home).accounts.default.reauthRequired, undefined);
  }

  const home = tempHome(t);
  signIn(home);
  const io = buffers();
  await runAuth(["status"], { json: true, homeDir: home, fetchImpl: unreachable, ...io });
  assert.equal(io.json().authenticated, true);
  assert.equal(io.json().networkError, "Could not reach relay: ECONNREFUSED");
  await assert.rejects(runUp([], { json: true, homeDir: home, env: {}, fetchImpl: unreachable, ...buffers() }), {
    code: "NETWORK_UNREACHABLE",
  });
});

test("auth status, auth list and doctor report the refused sign-in", async (t) => {
  const home = tempHome(t);
  signIn(home);
  const google = googleAnswers(400, REFUSAL);

  assert.equal(runDoctor({ homeDir: home, env: {} }).checks.oauth.ok, true);

  const status = buffers();
  await runAuth(["status"], { json: true, homeDir: home, fetchImpl: google.fetchImpl, ...status });
  assert.equal(status.json().authenticated, false);
  assert.equal(status.json().reauthRequired, true);
  assert.equal(status.json().reauthReason, REASON);
  assert.equal(status.json().networkError, null);
  assert.deepEqual(status.json().accounts, []);
  assert.equal(status.json().reauthAccounts[0].email, "u@example.com");

  const list = buffers();
  await runAuth(["list"], { json: true, homeDir: home, fetchImpl: google.fetchImpl, ...list });
  assert.equal(list.json().accounts.length, 1);
  assert.equal(list.json().accounts[0].authenticated, false);
  assert.equal(list.json().accounts[0].reauthRequired, true);
  assert.equal(list.json().accounts[0].reauthError, "invalid_grant");

  const offline = runDoctor({ homeDir: home, env: {} });
  assert.equal(offline.ok, false);
  assert.equal(offline.mode, "unconfigured");
  assert.equal(offline.checks.oauth.reauthRequired, true);
  assert.equal(offline.checks.oauth.reauthReason, REASON);
  assert.equal(
    offline.checks.oauth.action,
    `${REASON} for u@example.com. Sign in again with 'orca-colab auth login' (tick the Colab permission); no sign-out is needed.`,
  );
});

test("doctor --network refreshes for real, so a cached access token cannot hide a dead sign-in", async (t) => {
  const home = tempHome(t);
  signIn(home, { expiresInMs: 3_600_000 });
  const google = googleAnswers(400, REFUSAL);

  const plain = buffers();
  await runDoctorCommand([], { json: true, homeDir: home, env: {}, fetchImpl: google.fetchImpl, ...plain });
  assert.equal(plain.json().checks.oauth.ok, true);
  assert.equal(google.calls.length, 0);

  const checked = buffers();
  assert.equal(await runDoctorCommand(["--network"], { json: true, homeDir: home, env: {}, fetchImpl: google.fetchImpl, ...checked }), 1);
  const report = checked.json();
  assert.equal(report.ok, false);
  assert.equal(report.checks.oauth.ok, false);
  assert.equal(report.checks.oauth.reauthRequired, true);
  assert.equal(report.checks.oauth.refresh[0].result, "refused");
  assert.equal(report.checks.network.ok, true);
});

test("doctor --network clears a recorded refusal once Google accepts the refresh again", async (t) => {
  const home = tempHome(t);
  signIn(home);
  await assert.rejects(getValidAccessToken({ homeDir: home, fetchImpl: googleAnswers(401, { error: "invalid_client" }).fetchImpl }));
  assert.equal(readOAuthAccountStatus("default", home).reauthRequired, true);

  const io = buffers();
  const accepted = googleAnswers(200, { access_token: "a2", expires_in: 3600, scope: COLAB_SCOPES });
  await runDoctorCommand(["--network"], { json: true, homeDir: home, env: {}, fetchImpl: accepted.fetchImpl, ...io });
  assert.equal(io.json().checks.oauth.ok, true);
  assert.equal(io.json().checks.oauth.refresh[0].result, "accepted");
  assert.equal(readOAuthAccountStatus("default", home).authenticated, true);
  assert.equal(readOAuthStore(home).accounts.default.reauthRequired, undefined);
});

test("the panel snapshot shows the refused sign-in and why its syncs stopped", async (t) => {
  const home = tempHome(t);
  signIn(home);
  const google = googleAnswers(400, REFUSAL);
  const builder = new DashboardSnapshotBuilder({ homeDir: home, env: {}, fetchImpl: google.fetchImpl });

  await builder.syncFromRuntimes({ maxAgeMs: 0 });
  const snap = await builder.build({ includeLiveMetrics: true });
  assert.equal(snap.auth.authenticated, false);
  assert.equal(snap.auth.reauthRequired, true);
  assert.equal(snap.auth.reauthReason, REASON);
  assert.deepEqual(snap.oauthAccounts, []);
  assert.deepEqual(snap.reauthAccounts.map((a) => a.email), ["u@example.com"]);
  assert.equal(snap.doctor.checks.oauth.ok, false);
  assert.match(snap.runtimeSync.error, /^Google sign-in expired or was revoked \(invalid_grant: Token has been expired or revoked\.\) for account 'default' \(u@example\.com\)\. Sign in again/);

  // The credits sync finds it as well, when it is the first to refresh.
  const second = tempHome(t);
  signIn(second);
  const fresh = new DashboardSnapshotBuilder({ homeDir: second, env: {}, fetchImpl: google.fetchImpl });
  fresh.doctor();
  const first = await fresh.build({ includeLiveMetrics: true });
  assert.equal(first.auth.reauthRequired, true);
  assert.match(first.creditsSync.error, /^Google sign-in expired or was revoked/);
  assert.equal(first.doctor.checks.oauth.ok, false);

  const changes = await discoverAccountRuntimes({ homeDir: second, env: {}, fetchImpl: google.fetchImpl });
  assert.match(changes.reauthRequired, /^Google sign-in expired or was revoked/);
  assert.equal(changes.unreachable, null);
});

test("up fails with the real cause and the way out", async (t) => {
  const home = tempHome(t);
  signIn(home);
  await assert.rejects(
    runUp([], { json: true, homeDir: home, env: {}, fetchImpl: googleAnswers(400, REFUSAL).fetchImpl, ...buffers() }),
    (err) => {
      assert.equal(err.exitCode, 1);
      assert.equal(err.payload.code, "OAUTH_REAUTH_REQUIRED");
      assert.equal(err.payload.reauthRequired, true);
      assert.equal(err.payload.googleError, "invalid_grant");
      assert.equal(err.payload.step, "prerequisites");
      assert.equal(
        err.payload.error,
        `${REASON} for account 'default' (u@example.com). Sign in again with 'orca-colab auth login' (tick the Colab permission); no sign-out is needed.`,
      );
      return true;
    },
  );
});

test("the CLI prints the code and the hint for a command stopped by the refused sign-in", async (t) => {
  const home = tempHome(t);
  signIn(home);
  await assert.rejects(getValidAccessToken({ homeDir: home, fetchImpl: googleAnswers(400, REFUSAL).fetchImpl }));
  const io = buffers();
  assert.equal(await main(["up", "--json"], { homeDir: home, env: {}, ...io }), 1);
  assert.equal(io.json().code, "OAUTH_REAUTH_REQUIRED");
  assert.equal(io.json().hint, "Run 'orca-colab auth login' to sign in again; no sign-out is needed.");
});

test("signing in again clears the refusal without a sign-out", async (t) => {
  const home = tempHome(t);
  signIn(home);
  await assert.rejects(getValidAccessToken({ homeDir: home, fetchImpl: googleAnswers(400, REFUSAL).fetchImpl }));
  assert.equal(readOAuthAccountStatus("default", home).reauthRequired, true);

  const fetchImpl = async (url) =>
    String(url).endsWith("/token")
      ? new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: COLAB_SCOPES, refresh_token_expires_in: 604799 }))
      : new Response(JSON.stringify({ email: "u@example.com", name: "U" }));
  let page;
  const openBrowser = async (authUrl) => {
    const params = new URL(authUrl).searchParams;
    page = fetch(`${params.get("redirect_uri")}/?state=${encodeURIComponent(params.get("state"))}&code=c`);
  };
  const status = await runLoopbackOAuthFlow({ homeDir: home, openBrowser, fetchImpl });
  await (await page).text();

  assert.equal(status.account, "default");
  assert.equal(status.authenticated, true);
  assert.equal(status.reauthRequired, undefined);
  const entry = readOAuthStore(home).accounts.default;
  assert.equal(entry.refreshToken, "new-refresh");
  assert.equal(entry.reauthRequired, undefined);
  // Google names a lifetime only for clients that limit it; doctor passes the date on.
  assert.equal(typeof entry.refreshTokenExpiresAt, "string");
  assert.match(runDoctor({ homeDir: home, env: {} }).warnings.join("\n"), /Google will end the sign-in of u@example\.com on /);
  assert.equal(await getValidAccessToken({ homeDir: home, fetchImpl: googleAnswers(400, REFUSAL).fetchImpl }), "new-access");
});

test("MCP auth_status, doctor and up say to sign in again with auth_login", async (t) => {
  const home = tempHome(t);
  signIn(home);
  const tools = createColabMcpTools({
    runMain: main,
    homeDir: home,
    env: { PATH: process.env.PATH ?? "" },
    commandContext: { fetchImpl: googleAnswers(400, REFUSAL).fetchImpl },
  });
  t.after(() => tools.settle());
  const again = /^The saved Google sign-in expired or was revoked .* Call the auth_login tool to sign in again, no sign-out needed/;

  const status = (await tools.call("auth_status", {})).structuredContent;
  assert.equal(status.authenticated, false);
  assert.equal(status.reauthRequired, true);
  assert.equal(status.reauthReason, REASON);
  assert.match(status.hint, again);

  const doctor = (await tools.call("doctor", {})).structuredContent;
  assert.equal(doctor.checks.oauth.ok, false);
  assert.equal(doctor.checks.oauth.reauthRequired, true);
  assert.match(doctor.hint, again);

  const up = (await tools.call("up", { gpu: "CPU" })).structuredContent;
  assert.equal(up.ok, false);
  assert.equal(up.code, "OAUTH_REAUTH_REQUIRED");
  assert.equal(up.step, "prerequisites");
  assert.match(up.hint, again);

  const wait = (await tools.call("auth_wait", {})).structuredContent;
  assert.equal(wait.state, "not_started");
  assert.match(wait.hint, again);
});

test("auth logout leaves Google alone unless --everywhere is given", async (t) => {
  const home = tempHome(t);
  const revokes = [];
  const fetchImpl = async (url) => {
    revokes.push(String(url));
    return new Response("", { status: 200 });
  };

  signIn(home);
  const local = buffers();
  await runAuth(["logout"], { json: true, homeDir: home, fetchImpl, ...local });
  assert.deepEqual(local.json(), { ok: true, account: "default", authenticated: false, removed: true, revoked: false, everywhere: false, accounts: [] });
  assert.deepEqual(revokes, []);

  signIn(home);
  const everywhere = buffers();
  await runAuth(["logout", "--everywhere"], { json: true, homeDir: home, fetchImpl, ...everywhere });
  assert.equal(everywhere.json().revoked, true);
  assert.deepEqual(revokes, ["https://oauth2.googleapis.com/revoke"]);
});
