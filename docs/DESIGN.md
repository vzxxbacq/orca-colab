# Design

## Goal

Let a coding agent running **locally** in Orca (Claude Code, Codex, …) set up a Google Colab GPU
runtime together with the user in a few minutes, then use that GPU as a compute backend: sync code to
it, run training or inference there, pull results back. The workspace, the agent and the user's
credentials stay on the local machine. Colab is a disposable GPU box reached only through public HTTPS
and WSS endpoints (the Colab API and the runtime's own proxy); no VPN, tailnet, SSH or inbound port is
assumed (D19).

Four deliverables, one repo:

| Deliverable | Who uses it | What it is |
|---|---|---|
| `skills/colab-gpu/SKILL.md` | the agent | Procedure: when to reach for Colab, how to run the one-time setup with the user, the per-session flow, how to run work and fetch results, hygiene. Installed with `npx skills add vzxxbacq/orca-colab`. |
| `bin/orca-colab.mjs` (+ `bin/lib/`) | the agent (via the skill) and the user | Zero-dependency Node CLI. `doctor`, `auth`, `up`, `status`, `run`, `job`, `sync`, `pull`, `down`, `credits`. Every command has `--json`. Run as `npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/<release-sha> <cmd>` or `npm i -g`. |
| `orca-colab mcp` (`bin/commands/mcp.mjs`) | the agent, as a connector | The CLI's commands as MCP tools on stdio (D22), for Orca bots (`orca bot tools add`), Claude Code, Codex and any other MCP client. No skill needed: the procedure travels in the server's `instructions` and the tool descriptions. |
| Orca plugin (`orca-plugin.json`, `worker/`, `panel/`) | the user, in Orca's UI | Panel showing every runtime of the signed-in Google account (also ones started from other machines, D25), GPU, age, jobs with live output and prerequisites; "Start/Stop GPU session" commands that call the Colab API in the worker; a shell on a runtime inside the panel; status bar item with the live session count. It opens no Orca terminal. |

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Agents run locally; Colab is a compute backend reached over the Colab API and the runtime proxy** (D19), not an Orca remote host. | The owner's call. Keeps credentials, repo and agent sessions on the laptop; Colab VMs are too short-lived to host agent state. The earlier VM-recipe design is kept as an optional later mode (see "Optional remote-workspace mode"). |
| D2–D8 | **Superseded in v0.3.0 by D19.** They covered the Tailscale + `sshd` path: tailnet auth keys, one SSH key pair, the bootstrap notebook (Drive copy or clipboard paste), peer discovery by hostname, `rsync`/`tar \| ssh` transfers and `ssh -L` port forwarding. | Removed with the owner's go-ahead on 2026-11-12: the product must not assume a private network, and the Direct API path (D9) covers provisioning, commands and transfers on its own. |
| D9 | **Provisioning = the Colab Direct API, after one Google sign-in.** `orca-colab auth login` runs an OAuth 2.0 PKCE loopback flow (`127.0.0.1:<port>`, scopes `profile email https://www.googleapis.com/auth/colaboratory`, all non-sensitive) with the plugin's own Desktop OAuth client (its secret held by the token relay, D21), never another product's client or headers, in the user's system browser (where Passkeys work natively), saving the refresh token in `~/.orca-colab/google-oauth.json` (`0600`). Once signed in, `up`, `down`, and `credits calibrate` talk directly to `colaboratory.googleapis.com` (`v1beta/runtimes`) and `colab.research.google.com/tun/m/ccu-info` (balance; `colab.pa.googleapis.com/v1/user-info` rejects third-party clients) plus `wss://<runtime>/colab/tty` with **zero browser tabs**. Signing in is required; there is no other provisioning path since v0.3.0. | Users with Passkey-protected Google accounts only sign in once in their default browser; every subsequent `up`, `down`, and CCU check is 100 % headless and deterministic. |
| D10 | **`down` releases the runtime via `DELETE /v1beta/runtimes/<id>?allowMissing=true`.** Success (including "already gone") deletes the session file and writes `session.end`; failure keeps the session as `zombie` with `reason: "api-delete-failed"` and tells the user to sign in again or delete the runtime in Colab's UI. Sessions left over from the Tailscale era have no runtime id; `down` only removes their local record. No suspend/resume: a dead runtime is a dead runtime. | Works without any browser tab and without reaching the VM. |
| D11 | **The Orca plugin is thin on provisioning, thick on stewardship and task management.** It reads `~/.orca-colab/`, manages GPU tasks and streams live task output, refreshes Colab runtime tokens, and owns the always-on parts: task execution monitor, live output streaming, credit ledger, idle watchdog, budget alerts. | Watching sessions, tasks, live task logs, and credits needs a process that outlives any one CLI call; the worker is kept alive by its status bar item. |
| D12 | **Credits combine live API calibration (`/tun/m/ccu-info`) with a local ledger.** Each session records GPU type, start, end and a per-hour rate from an editable rate table; `credits calibrate` fetches the real CCU balance and hourly burn rate via `colab.research.google.com/tun/m/ccu-info?authuser=0` (or via Orca's browser / manual entry), and the ledger counts down between calibrations. | Even with API calibration, projecting between checks and enforcing monthly budgets requires an append-only local ledger; projected numbers always carry the `estimated` prefix in `--json` and show calibration age. |
| D13 | **Calibration supports Direct API (`credits calibrate`), Orca's embedded browser (`credits calibrate --browser`), and manual entry (`credits set <cu>`).** Every failure degrades cleanly to manual entry. | Gives instant one-click CCU sync when OAuth is connected while preserving the browser and manual fallbacks. |
| D14 | **Idle watchdog in the worker, two independent signals, both required.** (1) No CLI or task activity: every CLI command and running job stamps `lastActivityAt` at start, every 60 s while it runs, and at exit, and records its pid in `activePids`; a session with a live pid or running task is never idle. (2) GPU utilisation under 5 % on **three consecutive** 5-minute samples. Only when both hold for `autoStopIdleMinutes` (default 20) does the worker notify, then run `down` after a 5-minute grace unless the user cancels. `up --keep` exempts a session. | Forgotten runtimes are where Colab credits go, but a 40-minute `run` or `job` that is downloading a dataset or writing a checkpoint must never be killed by one low GPU sample. |
| D15 | **Several Google accounts = several credit pools.** `config.json` holds the static part, `accounts: [{ label }]` and `defaultAccount`; OAuth tokens live in `google-oauth.json` (`0600`) keyed by account label; every money fact (calibrations, budgets, session costs) lives only in `ledger.jsonl`, keyed by account label. `up --account` picks one; the panel shows each pool. | Users with Pro on one account and pay-as-you-go on another need to choose where a session's cost lands. |
| D16 | **Security boundaries.** One PKCE loopback login in the system browser is all that is ever needed; no browser is opened during `up`. The plugin never reads or exports browser cookie databases. The runtime proxy token stays in the session file (0600) and is stripped from every `--json` output. | Keeps authentication clean, Passkey-compatible, and free of browser-cookie scraping. |
| D17 | **First-class Task Management (`job` CLI + Plugin Task Manager & Live Output Console).** Submitted algorithm/compute tasks (`orca-colab job submit`) are persisted in `~/.orca-colab/tasks/<id>.json` with real-time stdout/stderr streamed to `~/.orca-colab/tasks/<id>.log`. Commands can optionally sync the workspace first (`--sync`), run detached in the background (default) or foreground (`--wait`), be stopped (`job stop <id>`), and have their live output streamed in the Orca plugin panel. | Treating Colab as an algorithm compute backend requires queuing/running training jobs, monitoring their live stdout/stderr in the panel without keeping an interactive SSH shell open, and inspecting exit codes and durations after completion. |
| D18 | **Superseded by D25 (2026-11-24).** It covered remote Orca servers through a terminal: one `Colab Bridge` terminal per server running `orca-colab watch`, state read back from the screen as gzip+base64 frames, actions typed in as control lines, sign-in tokens sealed to the server's key (`bin/commands/watch.mjs`, `bin/lib/bridge-frames.mjs`, `bin/lib/credential-envelope.mjs`, `TerminalBridge` in the worker, settings `remoteCliCommand` and `autoBridge`). | Removed with the owner's go-ahead: the bridge depended on finding the workspace on the server through the `orca` CLI (it never found folder workspaces such as a bot's home), on a visible terminal nobody may close, and on `orca-colab` being runnable there. |
| D19 | **Public endpoints only.** Everything the CLI does goes to `colaboratory.googleapis.com` (runtimes), `colab.research.google.com/tun/m/ccu-info` (balance) and the runtime's proxy URL (Jupyter terminals for commands, D23; `/api/contents` for uploads; `wss://…/colab/tty` as fallback, `https://…/files/…` and `/api/colab/resources` with `X-Colab-Runtime-Proxy-Token`). No VPN, tailnet, SSH, key pair or inbound port. There is no direct port forwarding, only `forward` over Jupyter (D24): the proxy only reaches Jupyter on 8080 (verified 2026-11-12: other ports and `/proxy/<port>` return 404); agents query services on the runtime with `run -- curl localhost:<port>`. | Works on any network the user's browser works on, and leaves nothing to configure beyond the Google sign-in. |
| D20 | **`pull` = remote `tar -czf /tmp/…` over the tty, then HTTPS download from Jupyter `/files`, then local `tar -xzf`.** The tty returns text and mangles binary output, and Jupyter refuses hidden paths, so packing first gives one binary-safe path for files, directories and dotfiles. The remote archive is deleted afterwards. `sync` still sends a tar.gz as base64 stdin over the tty (binary-safe in that direction). | Verified 2026-11-12: a 3 MB random file arrives with the same sha256; no `rsync` or SSH needed. |
| D21 | **Token relay holds the client secret.** A Cloudflare Worker (`token-relay/`, `orca-colab-token-relay.fhq981014.workers.dev`, Workers Free plan) accepts only `POST /token` (PKCE code, verifier, loopback `redirect_uri`) and `POST /refresh` (refresh token), adds the client ID and secret, and returns Google's answer unchanged; it stores and logs nothing and calls no Colab API. The CLI uses it unless `ORCA_COLAB_CLIENT_ID/SECRET` name the user's own client. `auth logout` revokes the refresh token at Google before deleting it. | v0.3.0 embedded the secret and secret scanners flagged it. The relay keeps it out of the repo, lets the owner rotate it without a release and switch the relay off. It cannot tell the CLI from anyone else, so it does not stop phishing or the use of a stolen refresh token; revocation on logout and the phishing warnings address those. The free plan stops serving at its daily quota instead of billing. A per-IP limit of 30 requests/minute and 300/hour, kept in memory by one Durable Object per IP, stops a single client from spending that quota; Cloudflare's built-in rate-limit binding did not block anything in testing, the Durable Object limit held exactly (30 of 60 concurrent requests passed, 2026-11-13). |
| D22 | **The connector is an MCP server inside the CLI: `orca-colab mcp` on stdio, hand-written JSON-RPC, no SDK.** Orca has no connector format for third parties; a custom connector is an MCP server added with `orca bot tools add "<command>"`. Each tool builds the argv of one CLI command, runs it in-process through `main()` with `--json`, and returns that object (plus `ok`, and `hint` naming the next tool); so guardrails, `~/.orca-colab` files, ledger events, `assign.lock` and activity stamps are the CLI's own, and the panel shows MCP activity through the same polling it uses for CLI runs. Three things differ from a terminal. (1) `run` starts a child CLI process, because the task record's `localPid` is what the panel's Stop button and `job stop` terminate, and in-process that would be the server; a `run` still going after `timeout_seconds` is left running and handed back as a task id. (2) Nothing blocks for long: `job_submit` never waits, `job_wait` / `job_logs since_bytes` replace `--wait` / `--follow`, waits default to 45 s (Codex cuts a tool call at 60 s). (3) Sign-in is two calls: `auth_login` runs `auth login` in the background inside the server (same loopback flow, relay and `google-oauth.json`), returns the URL as soon as the browser was asked to open it, and `auth_wait` reports the end; `auth_redirect` covers a browser on another machine. `sync`, `pull` and `job_submit sync` take `workspace_path` (or the client's single MCP root): the server's cwd is not the workspace. `up` and `down` ignore client cancellation and finish before the server exits. | One pinned `npx … mcp` command works in every client. An SDK would add a dependency tree to every `npx` install for a tools-only stdio server that needs about 200 lines of protocol. In-process calls keep one implementation: a tool cannot drift from its command, and `test/mcp-server.test.mjs` fails when a command or flag has no entry in `CLI_COVERAGE`. |
| D23 | **One Jupyter terminal per command, not the shared `/colab/tty`.** `/colab/tty` is a single tmux session that detaches the previous client, so a second command on a runtime (a `run` during a job, the panel next to an agent, two agents) cut the first one's connection and queued behind it in the same shell. `execCommandOverTty` now asks the runtime's Jupyter Server for a terminal of its own (`POST /api/terminals`, `wss://…/terminals/websocket/<name>`), deletes it when the command ends or is aborted (which hangs up the remote process), and sends stdin (the `sync` archive) as a file through `PUT /api/contents` instead of typing it. `/colab/tty` stays as the fallback when a runtime refuses terminals, and for the interactive shell (`run -- bash -l`). Details and measurements: `docs/colab-internal-endpoints.md` § 4b. | Found 2026-11-23 through the MCP server: `job_submit` and `run` sent in the same instant, the job failed after 2 s. Commands now run in parallel with no lock or queue, and `sync` got about fifteen times faster as a side effect (8 MB: 97 s → 6 s). The cost is about 1.5 s per command for creating and deleting the terminal, and three more undocumented-by-Colab (but standard Jupyter) endpoints. |
| D24 | **`forward` = requests as files through Jupyter, replayed by a helper on the runtime.** Re-verified 2026-11-23: `https://<port>-<host>` and `/proxy/<port>` answer 404 with the runtime proxy token (also for a server bound to 0.0.0.0), and the runtime's Jupyter has no proxy extension, so 8080 is the only way in. `orca-colab forward --port P` starts a small Python helper on the runtime once (over a per-command terminal, D23) and listens on `127.0.0.1` locally. Per request: the listener writes `req-<id>` (one JSON line of method, target and headers, then the body) with `PUT /api/contents`, the helper replays it against `127.0.0.1:P` and writes `res-<id>.json` (status, headers; bodies up to 256 kB inline) and `res-<id>.body`, and the listener polls `/files` for them and streams the body back. The helper stops when the listener stops or stops sending keep-alives (3 minutes). The listener reads the session file on every call, refreshes the proxy token itself when the runtime refuses it (an expired token is answered with 404, not 401) and answers `502 session_gone` once Colab no longer has the runtime. The forward is recorded in the session (`forwards`, pid in `activePids`), so `status` and the panel show it and the idle watchdog leaves the session alone. | The owner needs an HTTP API on the runtime reachable from outside, and runtimes that ran a tunnel were taken away by Colab twice within 20 minutes; with this, the public tunnel runs on the user's machine and the runtime sees only ordinary Jupyter requests. Files were chosen over a per-request terminal command (about 3 s each, and terminal output moves about 100 kB/s) and over a long-lived multiplexing terminal (same half second once the response body has to come through `/files` anyway, with a connection to keep alive across token refreshes). Cost: about 0.5 s per request (two 0.25 s round trips), responses only when complete, HTTP only. |
| D25 | **The account is the unit, and the runtime carries its own records.** A Colab runtime belongs to a Google account, so every machine signed in to it can list it (`GET /v1beta/runtimes` returns each runtime with a fresh proxy URL and token) and reach it. What other machines need is therefore kept on the runtime under `/content/orca/.orca-colab/`, written and read through its Jupyter server with the proxy token (`PUT`/`GET /api/contents/…`, `/files/…` with `Range`; hidden paths work on both, verified 2026-11-24): `session.json` (name, account email, origin = machine + agent + workspace, GPU, rate, start time, keep flag, runtime id) written by `up`; `tasks/<id>.json` + `tasks/<id>.log` for every `run` and `job`; `activity/<machine>.json` (last command and until when it counts as still going). **Jobs run detached**: the client uploads the record, a shell script and the log head, then one per-command terminal (D23) starts `tasks/_job-runner-v1.py` with `nohup setsid`; the command writes straight into the log file, the runner rewrites the record every 15 s and stops the command when `tasks/<id>.stop` appears. The client then only follows (record + `Range` reads of the log) into its local copy, so the log is complete whoever reads it and the job survives the client. **Other machines**: `discoverAccountRuntimes` turns a listed runtime this machine has no session for into a local session file (`adopted: true`, `origin` from the record; no record = unknown origin), refreshes tokens and the keep flag of known ones and drops sessions Colab no longer lists; `mirrorRuntimeTasks` / `mirrorTaskLog` copy job records and output into `~/.orca-colab/tasks/`. `status`, `job ls/logs/stop`, the session lookup of `run`/`sync`/`pull`/`forward`, and the panel's snapshot builder call them, so every existing command and the panel work on any runtime of the account from the same local files as before. **Guards**: the idle rule (D14) also takes the runtime's `activity/` and running jobs (`busyBy`, `idleMs` on the runtime side's clock); `down` refuses a runtime another machine is using (`reason: "in-use-elsewhere"`) unless `--force`, and equally one whose records it cannot read (`reason: "use-unknown"`; it refreshes the proxy token first, because the proxy answers an expired token like a missing file, and a runtime Colab reports gone is released as before); the watchdog likewise stops nothing without a read of the records in the last three minutes; unknown-origin runtimes are never auto-stopped (they may be a notebook open in Colab). The panel shows a line-mode shell held by the worker on a Jupyter terminal websocket (`bin/lib/runtime-shell.mjs`). **Per machine still**: the sign-in, the ledger, and the default guardrails in `config.json`. Guardrails that follow a project are D26. | The owner's call ("fully replace the bridge"). A panel on a laptop must show the runtime an agent started on a server without any process, terminal or install on that server; Colab already gives every signed-in machine the route, and the runtime is the one place all of them can read. Verified 2026-11-24 on a CPU runtime with two `~/.orca-colab` homes on one account: the second lists the first's runtime by name and origin, lists its job, reads its log live (about 0.25 s per request), stops it, and is refused `down` while the first is busy; a job whose follower was killed kept running and finished. |
| D26 | **Guardrails live in the project: `<project>/.orca/colab.json`, over the machine's config.** Fields, all optional: `allowedGpus`, `maxConcurrentSessions`, `monthlyBudgetCu`, `autoStopIdleMinutes`; whole-line `//` comments are allowed. The CLI walks up from its cwd, the MCP tools from `workspace_path` / the single root / the server's cwd (`bin/lib/project-guardrails.mjs`); the nearest file wins, a field it leaves out comes from `~/.orca-colab/config.json`, and with no file everything behaves as before. A file that cannot be read or holds a bad value fails `up` and `doctor` (never a silent fallback). **Budget per project**: `session.start` / `session.end` ledger events and the session file carry `project` (the folder holding `.orca`), `estimateProjectMonthlyUse` sums hours × rate for them on this machine, and the hard limit in `up` uses the project's `monthlyBudgetCu` when set (`scope: "project"` in the refusal) and the machine's account budget otherwise; a cap set by the project counts the runtimes started from that project. Budgets are therefore per project or per machine, never per Google account. **For machines that cannot read the project**: `up` writes the guardrails in force and their source (`guardrails: { source: "project"\|"machine", file, allowedGpus, maxConcurrentSessions, monthlyBudgetCu, budgetScope, autoStopIdleMinutes }`), `project`, `origin.directory` and, when Orca set it, `origin.orcaWorkspace` (`ORCA_WORKTREE_ID`) into the runtime's `session.json` (D25); a reused runtime keeps what it was started with; the watchdog honours a recorded project `autoStopIdleMinutes`. **Panel**: for a project on this computer the Guardrails view reads and writes that file through the worker (created on the first value set, removed with the last), with a switch to the machine default; for a project on an Orca server it shows the recorded guardrails read-only and opens the file with `orca file open <path> --worktree <selector> --environment <env> --focus`, trying the recorded `orcaWorkspace` selector and `name:<focused workspace>` on each saved environment (a plugin is not told which server holds a workspace), and shows the exact path with each refusal when none opens it (`renderer_unavailable` on a headless server). It never writes a remote file. | The owner's decision, replacing the Drive `appDataFolder` candidate: no new OAuth scope and no re-consent, the limits sit next to the code they govern, can be shared through git or kept out of it, and reach a server with the project instead of needing a channel to it. The price is that a budget is not account-wide: two projects, or one project on two machines, each count their own. |

## The user's experience

One-time (about a minute):

1. Agent runs `orca-colab doctor --json`; if `checks.oauth` is not ok it asks the user to sign in
   (`orca-colab auth login` or **Sign in with Google** in the panel) and to tick the Colab permission on
   Google's consent page.

Per session (well under a minute):

1. Agent runs `orca-colab up --gpu T4 --json` (or the user presses Launch in the Orca panel). The CLI
   assigns the runtime through the Colab API, queries the GPU over `/colab/tty`, writes the session and
   exits. No browser tab opens.
2. Agent continues on its own: `sync`, `job submit` / `run`, `pull`, `down`.


## Credit management

What the user sees in the panel, per account:

```
Account: work (Pro)              balance ≈ 61.3 CU   calibrated 2 days ago   [Calibrate]
Burn now: 1.96 CU/h (T4)        at this rate ≈ 31 h left     budget: 80 CU/month, used 18.7
Sessions this month: 7          wasted idle (auto-stopped): 2.4 CU
```

Mechanics:

- **Rate table** `~/.orca-colab/rates.json`, user-editable, shipped defaults (compute units per hour,
  approximate, Nov 2026): `T4 1.96`, `L4 4.82`, `A100 11.77`, `TPU v2-8 1.76`, `CPU 0.08`, `unknown 2`.
  `nvidia-smi` names map to keys (`Tesla T4` → `T4`, `NVIDIA A100-SXM4-40GB` → `A100`). High-RAM adds a
  multiplier (default 1.0 until measured; recorded per session when the runtime reports total RAM).
- **Ledger** `~/.orca-colab/ledger.jsonl`, one line per event: `session.start`, `session.end` (with cause
  `user|idle-watchdog|colab-died`), `calibrate` (balance, source `manual|browser`), `budget.set`.
  Estimated balance = last calibration − Σ(hours × rate) since. Free-tier accounts have no balance; the
  ledger still records hours so the user can see usage against the unofficial quota.
- **Budget**: optional, set per account with `credits budget <cu>` (a `budget.set` ledger event; the latest one wins; `0` removes it); the status bar turns `warning` at 80 %, `danger` at 100 %. It is a hard
  limit for the CLI, the MCP server and the panel alike: once `estimatedMonthlyUsedCu` reaches `budgetCu`, `up` refuses to start a new runtime
  (exit 1, `step: "budget"`, `code: "BUDGET_REACHED"`, the estimated figures and a hint that the owner can raise it). Attaching to a session that is already running
  is not refused and nothing running is stopped; the figures stay estimates.
- **Pre-flight estimate**: `up --json` returns `estimatedCuPerHour`; the skill makes the agent state
  "about N CU/h, ~H hours of balance left" before long jobs and prefer T4 unless the task needs more.
- **Calibration sources**: `credits set <balance> [--account]` (manual, from Colab's Resources pane);
  M2 `credits calibrate --browser` opens colab.research.google.com with `orca tab create --url`, calls the
  Resources pane's internal endpoint from page context with `orca eval --expression --page <browserPageId
  from tab create --json> --expect-url …` (same origin, user cookies), parses the JSON, and only then falls back to the pane text; the panel's Calibrate button runs the same. The user signs in
  to Google inside Orca's browser once; nothing is stored by this plugin.
- **Idle watchdog** (D14): the CLI stamps `lastActivityAt` in the session file and on the runtime on every
  command; the worker samples GPU utilisation from the runtime's `/api/colab/resources` every 5 min and reads
  the runtime's records of every machine (D25); all idle → notify → `down`.

CLI additions: `credits [--json]` (balances, burn, projection), `credits set <cu> [--account A]`,
`credits budget <cu>`, `credits calibrate --browser` (M2), `ledger [--month YYYY-MM] [--json]`,
`rates [--set T4=2.0]`, `up --keep` (no auto-stop), `up --account A`.

## CLI (`bin/orca-colab.mjs`)

Plain Node ≥ 20, zero dependencies, `package.json` with `"bin"`. State:

```
~/.orca-colab/config.json        static settings, 0600: { remoteRootBase, accounts: [{ label }], defaultAccount,
                                   allowedGpus?, maxConcurrentSessions? }
                                   Never balances or budgets: those are ledger events (single source of truth).
~/.orca-colab/google-oauth.json  per-account OAuth 2.0 tokens, 0600: { accounts: { [label]: { refreshToken,
                                   accessToken, expiryDate, email? } } }. Never logged or emitted in --json.
~/.orca-colab/sessions/<name>.json  { name, account, hostname, transport: "colab-tty", gpu, rateKey,
                                      cuPerHour, createdAt, lastActivityAt, activePids, keep,
                                      state: active|zombie, remoteRoot,
                                      colabRuntime: { id, endpoint, baseUrl, token, tokenExpiry } }
~/.orca-colab/tasks/<id>.json    { id, name, command, sessionName, account, cwd, status:
                                   running|succeeded|failed|stopped, exitCode, createdAt, startedAt,
                                   finishedAt, localPid, remotePid?, logPath }
~/.orca-colab/tasks/<id>.log     combined stdout/stderr stream for task <id>
~/.orca-colab/ledger.jsonl       append-only credit events (see Credit management)
~/.orca-colab/rates.json         editable CU/h table
```

| Command | Does | Exit |
|---|---|---|
| `doctor [--json]` | Checks Node ≥ 20, `git`, `tar` and the Google sign-in. | 0 all good, 1 something missing (each line actionable) |
| `auth [login\|status\|logout] [--account A] [--json]` | Loopback PKCE OAuth 2.0 login in system default browser with the project's own OAuth client (supports Passkey), shows connected Google account & Colab tier/balance, or revokes/removes stored credentials. | 0 / 1 |
| `up [--name N] [--account A] [--gpu T4\|L4\|A100\|CPU] [--high-ram] [--new] [--keep] [--json]` | Assigns (or reuses) a runtime via `POST /v1beta/runtimes`, queries the GPU over `wss://<runtime>/colab/tty`, writes the session. | 0, 1 not signed in / policy / budget / provisioning (says which `step`), 3 aborted |
| `status [--local] [--json]` / `ls` | D25: asks Colab for the account's runtimes first (`--local` skips it), so runtimes started from other machines are listed with `origin` and `startedHere`. Lists sessions with age and `reachable` (live runtime proxy, not a zombie), and `recentlyEnded`: the sessions that ended in the last 24 hours with time, `cause` and a reason, so a session dropped because Colab no longer had it (`colab-died`) is explained in the CLI, the MCP server and a panel notice. Never prints the proxy token. | 0 |
| `run [--session N] [--cwd DIR] -- <cmd…>` | Runs the command over `/colab/tty`, streams output, propagates the exit code; `run -- bash -l` on a TTY is an interactive shell. `--cwd` defaults to the session's `remoteRoot`. | remote exit code |
| `job submit [--session N] [--name TITLE] [--cwd DIR] [--env K=V] [--sync [PATH]] [--wait] [--json] -- <cmd…>` | Submits an algorithm/compute task to the GPU session, streams stdout/stderr to `~/.orca-colab/tasks/<id>.log`, and tracks status (`running`, `succeeded`, `failed`, `stopped`) in `~/.orca-colab/tasks/<id>.json`. Runs detached by default (`--wait` blocks and streams). | 0 (or remote exit code with `--wait`) |
| `job ls [--session N] [--status S] [--json]` | Lists submitted tasks with status, duration, exit code, session, and command. | 0 |
| `job logs <id> [--tail N=100] [--follow] [--json]` | Reads or follows the live stdout/stderr log for task `<id>`. | 0 / 1 |
| `job stop <id> [--json]` | Terminates a running task (kills remote process group and local runner) and marks it `stopped`. | 0 / 1 |
| `sync [--session N] [--to DIR] [path=.]` | Local `tar -czf` (honouring `.gitignore` and `.colabignore`, excluding `.git/`), unpacked at `/content/orca/<basename>` over `/colab/tty`. Records `remoteRoot`. | 0 / 1 |
| `pull [--session N] <remotePath> <localDir>` | D20: pack on the runtime, download from Jupyter `/files` over HTTPS, unpack into `<localDir>/<basename>`. | 0 / 1 |
| `down [--session N\|--all] [--force] [--json]` | D25: a runtime another machine is using is left alone (`reason: "in-use-elsewhere"`, exit 1) unless `--force`. D10: `DELETE /v1beta/runtimes/<id>?allowMissing=true`, `session.end` in the ledger, session file deleted; `zombie` when the API refuses. | 0 released, 4 zombie |
| `credits [--account A] [--json]` | Estimated balance, burn rate, projection, budget use per account, from the ledger. | 0 |
| `credits set <cu> [--account A]` / `credits budget <cu> [--account A]` / `credits calibrate [--browser] [--account A]` | Append `calibrate` / `budget.set` events. `calibrate` queries `/tun/m/ccu-info` via OAuth API first, or Orca's browser with `--browser`. | 0 / 1 |
| `ledger [--month YYYY-MM] [--json]` | Session and calibration history. | 0 |
| `rates [--set KEY=CU_PER_HOUR]` | Show or override the rate table. | 0 |
| `forward --port P [--session N] [--listen HOST:PORT] [--timeout S]` | D24: local HTTP listener that forwards each request to port `P` on the runtime; runs until interrupted. | 0 / 1 |
| `mcp` | D22: serves the commands above as MCP tools on stdio until stdin closes. stdout carries JSON-RPC only. | 0 |

Every CLI command stamps `lastActivityAt` (start, every 60 s, exit) and its pid for the watchdog (D14),
and the same on the runtime (`activity/<machine>.json`, D25) for the watchdogs of other machines.
Default session = the only one, else the newest started on this machine, else the newest; `--session` otherwise. `--json` output is one object on
stdout; everything else on stderr, so agents can parse safely.

## Skill (`skills/colab-gpu/SKILL.md`)

Frontmatter `name: colab-gpu`, `description` that triggers on: GPU, CUDA, training, fine-tuning, model
inference too heavy for the laptop, "Colab", "run this on a GPU". Body sections:

1. **Resolve the CLI**: prefer `orca-colab` on PATH, else `npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/<release-sha>`.
   Always pass `--json` and read stdout only.
2. **First run with the user**: run `doctor`; if not signed in, ask the user to run `auth login` (or use
   the panel) and tick the Colab permission. Confirm with `doctor` again.
3. **Start a session**: `up --gpu <allowed> --json`; it blocks until the runtime is ready.
4. **Do the work**: `sync` the workspace, `run -- pip install -r requirements.txt`, `run -- python
   train.py …` with `nohup`/`tmux` for long jobs and `run -- tail -f` to follow; `pull` results into the
   workspace; query services on the runtime with `run -- curl localhost:<port>`, or `forward` them (D24).
5. **Hygiene**: Colab sessions die (≈90 min idle on free tier, 12 h cap; longer on Pro). Pull results as
   soon as they exist; write checkpoints to the synced dir and pull them; run `down` when finished. Never store secrets on Colab beyond the session; pass API keys as
   `run --env` only when the user agrees.
6. **Failure table**: `up` exit 1 at `prerequisites` → sign in; other `up` failures → quota or GPU
   availability; `run` WebSocket error → `status`, likely the runtime died, offer `up` again and re-`sync`.

Distribution: `npx skills add vzxxbacq/orca-colab` (agentskills layout); the README shows the command.
The Orca plugin's panel also shows it for copy-paste. `contributes.skills` in Orca manifests is still
reserved, so the plugin cannot install the skill itself yet.

## Bootstrap notebook (removed)

The notebook that joined Colab to a tailnet and started `sshd` was deleted in v0.3.0 together with the
rest of the Tailscale path (D2–D8, D19). Runtimes are provisioned only through the Colab API.

## Orca plugin

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "colab",
  "name": "Colab GPU (Community) for Orca",
  "version": "0.1.0",
  "description": "Give Claude Code, Codex and your other Orca agents a Google Colab GPU: launch T4, L4 or A100 runtimes, sync code, run training jobs and pull results back.",
  "repository": "https://github.com/vzxxbacq/orca-colab",
  "license": "MIT",
  "engines": { "orca": ">=1.4.248" },
  "pluginApi": 1,
  "main": "worker/main.mjs",
  "contributes": {
    "panels": [{ "id": "colab", "title": "Colab GPU", "icon": "zap", "entry": "panel/index.html" }],
    "commands": [
      { "id": "colab.up", "title": "Colab: Start GPU session" },
      { "id": "colab.down", "title": "Colab: Stop GPU session" },
      { "id": "colab.showPanel", "title": "Colab: Show sessions" }
    ],
    "statusBarItems": [{ "id": "colab-sessions", "icon": "zap", "text": "Colab", "command": "colab.showPanel" }],
    "settings": [
      { "key": "autoStopIdleMinutes", "title": "Auto-stop idle sessions after (minutes)", "type": "integer", "default": 20, "minimum": 0 },
      { "key": "cliCommand", "title": "orca-colab command", "type": "string", "default": "npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/2944ee151e7ef2d08a5598c00c6cce4e3109f13c" }
    ]
  },
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "notifications:show" },
    { "kind": "settings:own" }
  ]
}
```

- Worker: reads `~/.orca-colab/sessions/*.json`, `~/.orca-colab/tasks/*.json`, and the ledger (poll + `fs.watch`), streams active task log updates (`~/.orca-colab/tasks/<id>.log`) to the panel via `orca.panels.post("colab.taskOutput", ...)`, refreshes `colabRuntime` proxy tokens before expiry, updates the status bar (`Colab: T4 · 1 running · 1.96 CU/h · ≈61 CU`, hidden with no sessions and no balance; tone follows the budget), runs the idle watchdog (D14) and the budget alerts. `colab.up` → resolve the focused workspace's id by matching `workspace.readContext` against `workspace.list` (readContext has no id), then `terminal.create({ workspaceId, title: "Colab", command: "<cliCommand> up" })` (or provisions headlessly via `colab.startSession`); `colab.down` likewise with `down`. `colab.showPanel` spawns `orca plugin open vzxxbacq.colab --panel colab` (no host method opens a panel). Panel handlers: `colab.dashboard` (`colab.sessions` + `colab.doctor` + `colab.tasks` + `colab.credits`), `colab.authLogin`, `colab.startSession`, `colab.stopSession`, `colab.toggleKeep`, `colab.submitTask`, `colab.stopTask`, `colab.getTaskLogs`, `colab.calibrateCredits`, `colab.setCredits`, `colab.setBudget`, `colab.openTerminal`.
- Panel:
  1. **Header & Account / Auth Bar**: Google OAuth status badge (`Sign in with Google` or connected account + tier), prerequisite indicators (`Google OAuth`), and quick refresh.
  2. **GPU Runtime & Resource Monitor**: Accelerator selector (`T4`, `L4`, `A100`, `CPU`), 1-click browserless **Start GPU** / **Open Terminal**, active session cards showing GPU model, VRAM, live RAM/Disk/GPU utilization bars, uptime, burn rate, and **Keep** / **Stop** controls.
  3. **Task Manager & Job Queue**:
     - **Submit Task Form**: Task title, command input (e.g. `python3 train.py --epochs 20`), optional `Sync workspace first` checkbox, and **Submit Task** button.
     - **Task List**: Displays all submitted tasks (`RUNNING`, `SUCCEEDED`, `FAILED`, `STOPPED`) with live elapsed timer, exit code, session badge, command preview, and action buttons (**Output**, **Stop**, **Run in Terminal**).
  4. **Current Task Live Output Console**:
     - Real-time terminal log viewer for the active or selected task (`~/.orca-colab/tasks/<id>.log`), with status badge, auto-scroll (`Follow`) toggle, **Copy Output**, and **Refresh**.
  5. **Credits & Budget Stewardship**: Estimated balance, live burn rate, remaining hours projection, **Sync CCU** (Direct API / Browser), manual balance & monthly budget controls, and skill install snippet.
  Inline assets only; Orca frame CSS variables.
  6. **Origin labels**: the top bar names this machine; every runtime card says *started here*, *from
     <agent> · <machine>* or *unknown origin*, and who is using it right now; a job from another machine
     carries that machine's name. The guardrails card says it edits this machine's guardrails.
  7. **Shell**: a line-mode shell on a runtime (Jupyter terminal websocket held by the worker), with the
     `orca-colab run -- bash -l` command to paste elsewhere for a full terminal.
- One source for every focused workspace (D25): `AccountDashboard` in `worker/main.mjs` builds snapshots
  from this machine's `~/.orca-colab` and keeps it in line with the account (`syncFromRuntimes`: every 5 s
  while the panel is open, every 60 s otherwise, and before each watchdog tick). The focused workspace only
  decides whether "sync this workspace" is offered: a workspace whose `workspace.list` row has a remote
  `hostId`, or that `workspace.list` does not contain, has its files on an Orca server, where the worker
  cannot read them (`bin/lib/orca-remote-helper.mjs` lists this machine's terminals to tell same-named
  checkouts apart). Settings: `autoStopIdleMinutes`, `cliCommand` (shown for pasting; the panel does not
  run it). Capabilities: `workspace:read`, `notifications:show`, `settings:own`.
- Install identity `vzxxbacq.colab` (publisher derived from the repo owner).

## Optional remote-workspace mode (not scheduled)

The first design made Colab an Orca remote host via a VM recipe (`contributes.vmRecipes`, `ssh` result,
orcad deployed by Orca). It relied on the bootstrap notebook removed in v0.3.0 and could ship later as a second
recipe for users who *do* want agents on the GPU box. Facts for it are kept in
`docs/orca-plugin-facts.md` § VM recipes. Do not build it unless a TODO item asks.

## Milestones

- **M1 — Skill + CLI usable end to end on macOS.** `doctor`, `setup`, `up`, `run`, `sync`, `pull`,
  `forward`, `down`, `credits`/`ledger` with manual calibration, notebook, SKILL.md, release tag. Exit: a local agent, following the skill, trains a
  toy model on a T4 and pulls the checkpoint back with the user only pressing Run in Colab.
- **M2 — Orca plugin + platforms.** Panel with credit block, status bar, idle watchdog, budget alerts,
  browser calibration via Orca's embedded browser; terminal-launched commands; Linux/Windows paths; abort
  handling; Headscale `loginServer`; auth-key expiry warnings; CI.
- **M3 — Drive automation.** Dropped in v0.3.0: the Direct API needs no notebook copy.
- **M4 — Colab Enterprise.** Vertex AI runtime templates and execution jobs: GPU type chosen from the CLI,
  no browser at all, long-running paid runtimes.
- **M5 — Remote-workspace mode** as a second recipe, if asked.

## Known limits

- Colab sessions end (≈90 min idle / 12 h on free, longer on Pro/Pro+); nothing persists on the VM.
  Everything valuable must be `pull`ed or pushed to Git/Drive/HF from Colab.
- Credit figures between calibrations are estimates: Google publishes no per-GPU rate. `/tun/m/ccu-info`
  gives the real balance on demand; the panel shows how stale the calibration is.
- `sync` holds the whole workspace tar.gz in memory (256 MB cap) and uploads it base64 through the runtime's Jupyter contents API (typed over the tty only as a fallback): fine for
  code, wrong for datasets and weights; have Colab download those directly.
- `forward` (D24) is HTTP request/response only: no WebSockets, no streaming, about 0.5 s per request. `/tun/m/ccu-info` and Jupyter `/files` are undocumented runtime endpoints that
  Google may change.
- Several machines (D25, D26): a budget is per project or per machine, never per Google account, and the ledger is per machine; the panel cannot read or write the guardrails file of a project on an Orca server (it shows what runtimes recorded and opens the file in Orca's editor); a runtime of unknown origin
  shows without name, start time or jobs; the panel cannot sync a workspace whose files are on a remote
  Orca server; the panel's shell is line mode (no full-screen programs); a first copy of a log larger than
  1 MB takes only its end (the full log stays on the runtime); records on the runtime die with it, so the
  local copies are the history. Each command pays about half a second for the activity stamps, and `run`
  about a second more than a bare terminal command, for the job record.
