# Colab API & Internal Endpoints (Verified from `googlecolab/colab-vscode` v0.9.7)

Verified on 2026-11-09 against `googlecolab/colab-vscode` (`v0.9.7`) and the published `Google.colab-0.9.7.vsix`
on OpenVSX.

## 1. Domains and Headers

- **`ColabApiDomain`**: `https://colab.research.google.com`
- **`ColabGapiDomain`**: `https://colab.pa.googleapis.com`
- **`ColabPublicApiDomain`**: `https://colaboratory.googleapis.com`

Headers orca-colab sends on API requests (it identifies as itself, never as the VS Code extension):

```http
Authorization: Bearer <access_token>
Accept: application/json
User-Agent: orca-colab/<version>
```

OAuth uses the plugin's own Desktop client (GCP project `orca-colab-community`); all three
scopes are non-sensitive there. Google requires the client secret on every token request (verified
2026-11-13: a refresh without it returns `400 invalid_request "client_secret is missing."`), so the CLI
sends code exchanges and refreshes to the token relay (`token-relay/`, DESIGN D21), which adds the
secret. `ORCA_COLAB_CLIENT_ID` / `ORCA_COLAB_CLIENT_SECRET` switch to a user's own client and call Google
directly. Revocation (`POST https://oauth2.googleapis.com/revoke`, form `token=…`) needs no secret.

`colab.pa.googleapis.com/v1/user-info` rejects third-party clients (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`), so
the compute-unit balance comes from `GET https://colab.research.google.com/tun/m/ccu-info?authuser=0`
(verified 2026-11-12 with the project's client): `)]}'`-prefixed JSON with `currentBalance`,
`consumptionRateHourly`, `assignmentsCount`, `eligibleGpus`, `eligibleTpus`; no subscription tier.
Runtimes still go through the public `colaboratory.googleapis.com/v1beta` API.

## 2. OAuth 2.0 PKCE Loopback (`src/auth/flows/loopback.ts`, `src/auth/scopes.ts`)

- **Authorization endpoint**: `https://accounts.google.com/o/oauth2/v2/auth`
- **Token endpoint**: `https://oauth2.googleapis.com/token`
- **Revoke endpoint**: `https://oauth2.googleapis.com/revoke`
- **Scopes**:
  - `profile`
  - `email`
  - `https://www.googleapis.com/auth/colaboratory`
- **Loopback Redirect URI**: `http://127.0.0.1:<ephemeral_port>`
- **Why loopback in system browser works with Passkeys**:
  The authorization URL opens in the user's default system browser (Chrome/Safari/Edge), where WebAuthn
  Passkeys and existing Google sessions work natively. Once the user approves, Google redirects to
  `http://127.0.0.1:<port>/?state=nonce%3D...&code=...`, and the CLI exchanges `code` + `code_verifier`
  for `{ access_token, refresh_token, expiry_date }`, stored locally in `~/.orca-colab/google-oauth.json` (`0600`).

## 3. Runtime Assignment & Lifecycle (`https://colaboratory.googleapis.com`)

### List Eligible Runtime Specs
- **Request**: `GET https://colaboratory.googleapis.com/v1beta/runtimespecs`
- **Response**:
  ```json
  {
    "runtimeSpecs": [
      {
        "key": { "variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_STANDARD" },
        "eligible": true
      }
    ]
  }
  ```

### Create / Assign Runtime (Browserless)
- **Request**: `POST https://colaboratory.googleapis.com/v1beta/runtimes?requestId=<uuid4>`
- **Body**:
  ```json
  {
    "runtimeSpec": {
      "variant": "VARIANT_GPU",
      "accelerator": "T4",
      "shape": "SHAPE_STANDARD"
    }
  }
  ```
- **Response**: Long-running `Operation` (`{ "name": "operations/<opId>", "done": false }`).
- **Wait on Operation**:
  `GET https://colaboratory.googleapis.com/v1/operations/<opId>:wait?timeout=200s`
  Returns completed `Operation` with:
  ```json
  {
    "name": "operations/<opId>",
    "done": true,
    "response": {
      "name": "runtimes/<runtimeId>",
      "runtimeSpec": {
        "variant": "VARIANT_GPU",
        "accelerator": "T4",
        "shape": "SHAPE_STANDARD"
      },
      "connectionInfo": {
        "endpoint": "<endpoint-id>",
        "url": "https://<proxy-host>",
        "token": "<runtime-proxy-token>",
        "expireTime": "2026-11-09T10:00:00Z"
      }
    }
  }
  ```

### Refresh Connection / Keepalive (Browserless)
- **Request**: `GET https://colaboratory.googleapis.com/v1beta/runtimes/<runtimeId>`
- **Response**: Updated `Runtime` with refreshed `connectionInfo.token` and `connectionInfo.expireTime`.

### List Active Runtimes
- **Request**: `GET https://colaboratory.googleapis.com/v1beta/runtimes`
- **Response**: `{ "runtimes": [ ... ] }`

### Unassign / Delete Runtime (Browserless)
- **Request**: `DELETE https://colaboratory.googleapis.com/v1beta/runtimes/<runtimeId>?allowMissing=true`
- **Response**: `200 OK` (`{}`). Immediately releases the Colab VM.

## 4. Remote Terminal WebSocket (`wss://<runtime-url>/colab/tty`)

- **URL**: `wss://<connectionInfo.url host>/colab/tty`
- **Headers**:
  ```http
  X-Colab-Runtime-Proxy-Token: <connectionInfo.token>
  ```
- **Protocol**:
  - Client sends JSON frames: `{"data": "<shell input>\n"}` or `{"cols": 120, "rows": 40}`.
  - Server sends JSON frames: `{"data": "<terminal output>"}`.
- **Bootstrap Usage**:
  `orca-colab up` connects to `/colab/tty` immediately after runtime assignment and pipes the Tailscale +
  `sshd` bootstrap script into the root shell—no browser tab or notebook cell click needed.

### One shared terminal (verified 2026-11-23)

`/colab/tty` attaches every client to the same tmux session (`session 0`, one shell, one `/dev/pts`) and
detaches the client that was attached before: the earlier websocket receives `[detached (from session 0)]`
and is closed, while its command keeps running in the shared shell and the newcomer's input queues behind
it. Two `orca-colab` commands on one runtime therefore broke each other: the first failed with "WebSocket
closed before command finished" about two seconds after the second connected.

## 4b. Per-command terminals and stdin upload (Jupyter Server API on the runtime)

The runtime's Jupyter Server (2.x, rooted at `/`) answers its standard API on the proxy URL with the same
`X-Colab-Runtime-Proxy-Token` header:

- `POST /api/terminals` → `{ "name": "7", ... }`; `DELETE /api/terminals/7` hangs up that shell.
- `wss://<runtime>/terminals/websocket/7`: terminado frames, client `["stdin", "<input>"]`, server
  `["stdout", "<output>"]`. Each terminal is its own shell and pty, starting in `/` (the shared tty starts in
  `/content`). One message above about 10 MB closes the connection.
- `PUT /api/contents/<path>` with `{ "type": "file", "format": "base64", "content": … }` writes a non-hidden
  file; for large files send `"chunk": 1, 2, …` and `-1` for the last piece. A single 64 MB body is accepted, a
  200 MB one is refused (400). Measured on a CPU runtime: 8 MB in 6 s, 40 MB in 19 s, against 97 s for 8 MB
  typed through a terminal.

`execCommandOverTty` opens one terminal per command and deletes it afterwards, uploads stdin (the `sync`
archive) as `/tmp/orca-colab-stdin-<id>` instead of typing it, and falls back to `/colab/tty` with inline
stdin when the runtime refuses `POST /api/terminals` or the upload.

## 4c. Records on the runtime (verified 2026-11-24 on a CPU runtime)

The same Jupyter Server answers these with the `X-Colab-Runtime-Proxy-Token` header, about 0.25 s each:

- `PUT /api/contents/<dir>` with `{ "type": "directory" }` creates one level (201, also when it exists);
  a file in a directory that does not exist is refused (500), so parents are created first.
- Hidden paths are accepted by the contents API and by `/files` (`/content/orca/.orca-colab/…`).
- `GET /api/contents/<dir>?content=1` lists entries with `name`, `type`, `size` and `last_modified`: one
  request shows every job's record age and log size. `GET /api/contents/<file>?content=1&format=text`
  returns the text; a missing path answers 404.
- `GET /files/<path>` honours `Range`: `bytes=N-` answers 206 with `Content-Range: bytes N-M/TOTAL`, 416
  when `N` is at or past the end, and `bytes=-N` returns the last `N` bytes. That is how a log is followed
  and how a first read of a large log takes only its end.
- A process started from a per-command terminal with `nohup setsid … &` survives `DELETE /api/terminals/<name>`,
  which is what lets a job outlive the client that submitted it.
- `GET https://colaboratory.googleapis.com/v1beta/runtimes` returns every runtime of the account with
  `connectionInfo.url` and a fresh `connectionInfo.token`, whichever machine assigned it.

Layout under `/content/orca/.orca-colab/` (DESIGN D25): `session.json`, `tasks/<id>.json`, `tasks/<id>.log`,
`tasks/<id>.sh` (read and deleted by the runner), `tasks/<id>.stop` (stop request), `tasks/_job-runner-v1.py`,
`activity/<machine>.json`.

## 5. CCU Balance, Burn Rate & Live Hardware Resources

### Compute Units (CCU) & Tier Info
- **Request**: `GET https://colab.pa.googleapis.com/v1/user-info?get_ccu_consumption_info=true`
- **Response** (`ConsumptionUserInfoSchema` in `src/colab/client/v1/api.ts`):
  ```json
  {
    "subscriptionTier": "SUBSCRIPTION_TIER_PRO",
    "paidComputeUnitsBalance": 98.4,
    "consumptionRateHourly": 1.96,
    "assignmentsCount": 1,
    "eligibleAccelerators": [
      { "variant": "VARIANT_GPU", "models": ["T4", "L4", "A100"] }
    ],
    "freeCcuQuotaInfo": {
      "remainingTokens": "1000",
      "nextRefillTimestampSec": 1762732800
    }
  }
  ```

### Live Runtime RAM, Disk & GPU Utilization
- **Request**: `GET <connectionInfo.url>/api/colab/resources`
- **Headers**: `X-Colab-Runtime-Proxy-Token: <connectionInfo.token>`
- **Response** (`ResourcesSchema` in `src/colab/client/v1/api.ts`):
  ```json
  {
    "memory": { "totalBytes": 13605826560, "freeBytes": 11200000000 },
    "disks": [
      { "filesystem": { "label": "root", "totalBytes": 120000000000, "usedBytes": 31000000000 } }
    ],
    "gpus": [
      {
        "name": "Tesla T4",
        "memoryUsedBytes": 536870912,
        "memoryTotalBytes": 16106127360,
        "gpuUtilization": 0.12,
        "memoryUtilization": 0.03
      }
    ]
  }
  ```

## 6. What keeps a runtime assigned (investigated 2026-11-24)

**What happened.** Three G4 runtimes of one account left Colab's runtime list without anyone releasing
them, 38, 21 and 23.5 minutes after `up` (ledger cause `colab-died`). The first two ran a cloudflared
tunnel; the third ran no tunnel and no SSH, only `orca-colab forward` from another machine, and had just
answered two requests. All three were used only through terminals, the contents API and `/files`.

**What Colab's reference client does** (`googlecolab/colab-vscode`, the client the `v1beta` API was built for):

- Until 2026-09-25 it sent a keep-alive itself: `GET https://colab.research.google.com/tun/m/<endpoint>/keep-alive/`
  with the header `X-Colab-Tunnel: Google`, every 5 minutes, per assigned server
  (`src/colab/keep-alive.ts`, `ColabClient.sendKeepAlive` in `src/colab/client/v1/index.ts`). It sent one
  only when `GET /api/kernels` on the runtime showed a kernel with `connections > 0`, and that kernel was
  `starting`, `busy`, `restarting` or `autorestarting` or had a `last_activity` in the last hour; an idle
  one got a prompt and 30 more minutes when the user answered it.
- Commit `1e60764` (#718, 2026-09-25) removed that controller: "With cl/982796273 rolled out to Production,
  the client-side `ServerKeepAliveController` is effectively a no-op now." Colab now decides on its own
  side; v0.9.7 calls no keep-alive endpoint at all, only `GET /v1beta/runtimes/<id>` to refresh the proxy
  token five minutes before `expireTime` (`src/colab/connection-refresher.ts`).
- Its own comment on lifetimes (`src/jupyter/storage.ts`): "An assigned server is ephemeral: an idle one is
  reclaimed within ~30 minutes and none outlive 24 hours".
- The API's discovery document (`src/colab/client/v2/colab-api.json`) has no keep-alive, touch or
  heartbeat method (`runtimes` list/create/get/delete, `runtimespecs`, `subscription`), and a `Runtime`
  carries no state, idle time or end reason.

So the only signal that client ever treated as "in use" is a kernel with a connected client and recent
activity. orca-colab started no kernel: `GET /api/status` on its runtimes answered
`{"connections": 0, "kernels": 0}`, which is what an abandoned runtime looks like.

**What orca-colab does now** (`bin/lib/runtime-presence.mjs`, DESIGN D28): while a runtime is in use, the
machine using it holds the connection a notebook front end holds.

- `POST /api/sessions` with `{ "path": "orca-colab-presence", "name": "orca-colab", "type": "console",
  "kernel": { "name": "python3" } }`: Jupyter answers with the existing session when one has that path, so
  every machine shares one kernel.
- `wss://<runtime>/api/kernels/<kernel id>/channels?session_id=<uuid>` with the proxy token header, held
  open; `/api/status` then shows `connections: 1, kernels: 1`. A `kernel_info_request` on the shell channel
  every 4 minutes keeps the kernel's `last_activity` recent. Nothing is executed on the kernel.
- On leaving: the websocket is closed, and when `GET /api/kernels/<id>` then shows `connections: 0` the
  session is deleted (`DELETE /api/sessions/<id>`), so a runtime nobody uses looks as it did before.

**No reason is given.** After a runtime is gone, `GET /v1beta/runtimes/<id>` answers 404 and the list simply
omits it; orca-colab records what it knows itself (how long the runtime lived and whether one of its
clients was connected until the end).
