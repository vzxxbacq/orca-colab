# Colab API & Internal Endpoints (Verified from `googlecolab/colab-vscode` v0.9.7)

Verified on 2026-11-09 against `googlecolab/colab-vscode` (`v0.9.7`) and the published `Google.colab-0.9.7.vsix`
on OpenVSX.

## 1. Domains and Headers

- **`ColabApiDomain`**: `https://colab.research.google.com`
- **`ColabGapiDomain`**: `https://colab.pa.googleapis.com`
- **`ColabPublicApiDomain`**: `https://colaboratory.googleapis.com`

Required headers on API requests:

```http
Authorization: Bearer <access_token>
Accept: application/json
X-Colab-Client-Agent: vscode
X-Colab-VS-Code-App-Name: Orca
X-Colab-VS-Code-Extension-Version: 0.9.7
```

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
  X-Colab-Client-Agent: vscode
  ```
- **Protocol**:
  - Client sends JSON frames: `{"data": "<shell input>\n"}` or `{"cols": 120, "rows": 40}`.
  - Server sends JSON frames: `{"data": "<terminal output>"}`.
- **Bootstrap Usage**:
  `orca-colab up` connects to `/colab/tty` immediately after runtime assignment and pipes the Tailscale +
  `sshd` bootstrap script into the root shell—no browser tab or notebook cell click needed.

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
