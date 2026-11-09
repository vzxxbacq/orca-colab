# Design

## Goal

Let a coding agent running **locally** in Orca (Claude Code, Codex, …) set up a Google Colab GPU
runtime together with the user in a few minutes, then use that GPU as a compute backend: sync code to
it, run training or inference there, forward ports, pull results back. The workspace, the agent and the
user's credentials stay on the local machine. Colab is a disposable GPU box reached over the user's
tailnet.

Three deliverables, one repo:

| Deliverable | Who uses it | What it is |
|---|---|---|
| `skills/colab-gpu/SKILL.md` | the agent | Procedure: when to reach for Colab, how to run the one-time setup with the user, the per-session flow, how to run work and fetch results, hygiene. Installed with `npx skills add vzxxbacq/orca-colab`. |
| `bin/orca-colab.mjs` (+ `bin/lib/`) | the agent (via the skill) and the user | Zero-dependency Node CLI. `doctor`, `setup`, `up`, `status`, `run`, `sync`, `pull`, `forward`, `down`. Every command has `--json`. Run as `npx -y github:vzxxbacq/orca-colab#<tag> <cmd>` or `npm i -g`. |
| Orca plugin (`orca-plugin.json`, `worker/`, `panel/`) | the user, in Orca's UI | Panel showing sessions, GPU, age and prerequisites; a "Start Colab session" command that opens an Orca terminal running `orca-colab up`; status bar item with the live session count. |
| `notebooks/orca-colab-bootstrap.ipynb` | runs inside Colab | Joins the tailnet, starts `sshd`, reports the GPU. |

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Agents run locally; Colab is a compute backend reached over SSH**, not an Orca remote host. | The owner's call. Keeps credentials, repo and agent sessions on the laptop; Colab VMs are too short-lived to host agent state. The earlier VM-recipe design is kept as an optional later mode (see "Optional remote-workspace mode"). |
| D2 | **Tailscale with a plain `sshd` inside Colab** (not Tailscale SSH, not a public tunnel). | Colab allows no inbound traffic; Tailscale userspace mode forwards inbound tailnet traffic to local ports. Tailscale SSH's default ACL is `check` mode, which breaks non-interactive clients. Self-hosted DERP works unchanged (the DERP map comes from the control plane); Headscale works through a `loginServer` setting. |
| D3 | **Pre-authorised, reusable, ephemeral, tagged auth key** (`tag:orca-colab`) joins Colab to the tailnet. The user creates it once in the admin console; `setup` stores it in `~/.orca-colab/config.json` (0600). | No per-session Tailscale login click. Ephemeral devices vanish when the VM dies, so no device accumulation. The key's only power is to add a tagged node; ACLs can confine such nodes to inbound SSH from the user's own devices. 90-day max expiry; `doctor` warns 7 days ahead. |
| D4 | **One SSH key pair for all sessions**, `~/.orca-colab/id_ed25519`, created by `setup`. | Lets the public key be prefilled once (D5). Per-session keys bought nothing once auth keys replaced pasting. |
| D5 | **Two notebook paths.** Default: the user saves a personal copy of the bootstrap notebook in Drive with the auth key, login server and public key prefilled in the form cell; `setup` prints the exact values and `config.notebookUrl` stores the copy's URL. Fallback: open the GitHub-hosted notebook and paste one line `<authkey> <pubkey>` from the clipboard. | Default path makes a session "Colab tab opens → click Run". Fallback needs no Drive and still has zero logins. |
| D6 | **Session discovery = a new online tailnet peer with hostname prefix `orca-colab-`** that was not present when `up` started; the notebook generates the suffix. | No id has to travel from laptop to Colab. `up --name x` pins the hostname for the fallback path. |
| D7 | **File transfer = `rsync` over SSH when available, else `tar | ssh`**; `sync` pushes the workspace (honouring `.gitignore` and `.colabignore`), `pull` fetches a remote path. No Git credentials go to Colab. | Works for private repos and uncommitted work, which is what an agent mid-task has. |
| D8 | **Port forwarding is plain `ssh -L`** managed by the CLI (`forward <port>` records the pid; `down` kills it). | Jupyter, TensorBoard, Gradio, vLLM on Colab show up at `localhost:<port>` for the user and the agent. |
| D9 | **No Google OAuth in milestone 1.** The browser session is the Google login. | Consumer Colab has no runtime API. OAuth is only worth it for Drive automation (M3) or Colab Enterprise (M4). |
| D10 | **`down` = `google.colab.runtime.unassign()` over SSH, best effort, then local cleanup.** No suspend/resume: a dead runtime is a dead runtime. | Colab cannot pause. Frees quota promptly without extra credentials. |
| D11 | **The Orca plugin is thin on provisioning, thick on stewardship.** It never provisions; it reads `~/.orca-colab/`, launches the CLI in an Orca terminal, and owns the always-on parts: credit ledger, idle watchdog, budget alerts. | Provisioning needs the user's shell, clipboard and browser. Watching sessions and credits needs a process that outlives any one CLI call; the worker is kept alive by its status bar item. |
| D12 | **Credits are tracked locally in a ledger, not read from an API.** Each session records GPU type, start, end and a per-hour rate from an editable rate table; the user enters the balance shown in Colab's Resources pane, and the plugin counts down from there. | Colab exposes no compute-unit API, not even inside the VM. A ledger with periodic calibration is the only honest option; the plugin always labels numbers as estimates and shows when the balance was last calibrated. |
| D13 | **Calibration can be automated through Orca's embedded browser** (`orca browser`, the user's own persistent Google session): a same-origin `fetch` in page context against the internal endpoint the Resources pane itself calls, falling back to the pane's text, falling back to "enter it manually". Optional, M2; manual entry stays the source of truth. No headless browser, no Google OAuth token: Google blocks sign-in from automated browsers, and a headless stack would add a heavy dependency for a session the user already has in Orca. | Real Chromium with a login the user did once; we store no credential. Structured JSON from the internal endpoint is far more stable than UI copy, but it is still undocumented, so every failure degrades to manual. Precise, API-backed numbers exist only on Colab Enterprise via GCP Billing (M4). |
| D14 | **Idle watchdog in the worker.** When a session shows no CLI activity (`run`/`sync`/`pull`/`forward` traffic) and GPU utilisation under 5 % for `autoStopIdleMinutes` (default 20), the worker notifies, then runs `down` after a 5-minute grace unless the user cancels. Sessions started with `up --keep` are exempt. | Forgotten runtimes are where Colab credits actually go. Paid GPUs burn units even when idle. |
| D15 | **Several Google accounts = several credit pools.** Config holds `accounts: [{ label, notebookUrl, balance, calibratedAt }]`; `up --account` picks one; the panel shows each pool. | Users with Pro on one account and pay-as-you-go on another need to choose where a session's cost lands. |

## The user's experience

One-time (about 5 minutes, agent-guided):

1. Agent runs `orca-colab doctor`; tells the user what is missing (Tailscale signed in, Node ≥ 20, rsync).
2. Agent asks the user to create a Tailscale auth key (reusable, ephemeral, pre-approved, tag
   `orca-colab`) and paste it into the terminal when `orca-colab setup` prompts. `setup` writes config and
   the SSH key pair, prints the three values to prefill, and offers to open the notebook so the user can
   "Save a copy in Drive", fill the form once, and paste the copy's URL back.

Per session (about 2 minutes, mostly waiting on Colab):

1. Agent runs `orca-colab up --json` (or the user presses "Start Colab session" in the Orca panel).
   The Colab tab opens on the user's notebook copy.
2. User picks a GPU runtime if not already set, presses Run. Tailscale auth and `sshd` take ~60 s.
3. `up` sees the peer, probes SSH, runs `nvidia-smi --query-gpu=name,memory.total --format=csv`, prints
   the session JSON and exits. Agent continues on its own: `sync`, `run`, `pull`, `forward`.

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
  multiplier (default 1.0 until measured; recorded per session when the notebook reports total RAM).
- **Ledger** `~/.orca-colab/ledger.jsonl`, one line per event: `session.start`, `session.end` (with cause
  `user|idle-watchdog|colab-died`), `calibrate` (balance, source `manual|browser`), `budget.set`.
  Estimated balance = last calibration − Σ(hours × rate) since. Free-tier accounts have no balance; the
  ledger still records hours so the user can see usage against the unofficial quota.
- **Budget**: optional `monthlyBudgetCu`; the status bar turns `warning` at 80 %, `danger` at 100 %; the
  skill tells the agent to confirm with the user before `up` once the budget is exceeded.
- **Pre-flight estimate**: `up --json` returns `estimatedCuPerHour`; the skill makes the agent state
  "about N CU/h, ~H hours of balance left" before long jobs and prefer T4 unless the task needs more.
- **Calibration sources**: `credits set <balance> [--account]` (manual, from Colab's Resources pane);
  M2 `credits calibrate --browser` opens colab.research.google.com in Orca's embedded browser, calls the
  Resources pane's internal endpoint from page context (same origin, user cookies), parses the JSON, and
  only then falls back to the pane text; the panel's Calibrate button runs the same. The user signs in
  to Google inside Orca's browser once; nothing is stored by this plugin.
- **Idle watchdog** (D14): the CLI stamps `lastActivityAt` in the session file on every command; the
  worker samples `nvidia-smi --query-gpu=utilization.gpu` over SSH every 5 min; both idle → notify → `down`.

CLI additions: `credits [--json]` (balances, burn, projection), `credits set <cu> [--account A]`,
`credits budget <cu>`, `credits calibrate --browser` (M2), `ledger [--month YYYY-MM] [--json]`,
`rates [--set T4=2.0]`, `up --keep` (no auto-stop), `up --account A`.

## CLI (`bin/orca-colab.mjs`)

Plain Node ≥ 20, zero dependencies, `package.json` with `"bin"`. State:

```
~/.orca-colab/config.json        { authKey, loginServer?, notebookUrl?, tags, projectRootBase } (0600)
~/.orca-colab/id_ed25519(.pub)   global key pair, comment "orca-colab"
~/.orca-colab/known_hosts        per-IP host keys; hosts are disposable, StrictHostKeyChecking=accept-new
~/.orca-colab/sessions/<name>.json  { name, account, hostname, ip, gpu, rateKey, cuPerHour, createdAt,
                                      lastActivityAt, keep, remoteRoot, forwards: [{port, pid}] }
~/.orca-colab/ledger.jsonl       append-only credit events (see Credit management)
~/.orca-colab/rates.json         editable CU/h table
```

| Command | Does | Exit |
|---|---|---|
| `doctor [--json]` | Finds `tailscale` (PATH, macOS app bundle, Windows path), parses `tailscale status --json` (`BackendState`, `Self`), checks `ssh`, `ssh-keygen`, `rsync` (optional), `git`, clipboard tool, config presence, auth-key age. | 0 all good, 1 something missing (each line actionable) |
| `setup [--auth-key K] [--login-server URL] [--notebook-url URL] [--non-interactive]` | Writes config, generates the key pair if absent, prints prefill values, optionally opens the notebook. Prompts on a TTY for anything not passed. | 0 / 1 |
| `up [--name N] [--timeout S=600] [--no-open] [--json]` | Snapshots current peers, opens the notebook URL (copying `<authkey> <pubkey>` to the clipboard on the fallback path), waits for a new `orca-colab-*` peer online, probes the `SSH-` banner on 22, reads GPU info, writes the session file, prints it. Streams `[colab]` progress to stderr. | 0, 1 prerequisite, 2 timeout (says which step), 3 aborted |
| `status [--json]` / `ls` | Lists sessions, re-checking reachability (3 s TCP probe) and age. | 0 |
| `run [--session N] [--cwd DIR] -- <cmd…>` | `ssh root@ip` with a pty when stdin is a TTY, streams output, propagates the exit code. `--cwd` defaults to the session's `remoteRoot`. | remote exit code |
| `sync [--session N] [--to DIR] [path=.]` | rsync `-az --delete --filter=':- .gitignore' --filter=':- .colabignore'` to `/content/orca/<basename>`; `tar | ssh` fallback. Records `remoteRoot`. | 0 / 1 |
| `pull [--session N] <remotePath> <localPath>` | rsync or `ssh tar` back. | 0 / 1 |
| `forward [--session N] <port>[:<remotePort>]` / `forward --stop <port>` | Background `ssh -N -L`, pid recorded in the session file; prints `http://localhost:<port>`. | 0 / 1 |
| `down [--session N|--all] [--json]` | Kills forwards, `ssh … python3 -c 'from google.colab import runtime; runtime.unassign()'` with a 20 s timeout, ignores failure, deletes the session file. | 0 |

Every SSH invocation uses `-i ~/.orca-colab/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes
-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=~/.orca-colab/known_hosts -o ConnectTimeout=10`.
Default session = the only one, or the newest; `--session` otherwise. `--json` output is one object on
stdout; everything else on stderr, so agents can parse safely.

## Skill (`skills/colab-gpu/SKILL.md`)

Frontmatter `name: colab-gpu`, `description` that triggers on: GPU, CUDA, training, fine-tuning, model
inference too heavy for the laptop, "Colab", "run this on a GPU". Body sections:

1. **Resolve the CLI**: prefer `orca-colab` on PATH, else `npx -y github:vzxxbacq/orca-colab#<tag>`.
   Always pass `--json` and read stdout only.
2. **First run with the user**: run `doctor`; for each failure give the user the one action; run `setup`
   in an Orca terminal the user can see (`orca terminal` from the orca-cli skill, or ask them). Explain
   the auth key's scope in one sentence. Confirm with `doctor` again.
3. **Start a session**: `up --json`; while waiting, tell the user exactly: "A Colab tab opened. Choose a
   GPU runtime (Runtime → Change runtime type) if needed and press Run on the cell." Do not poll faster
   than the CLI does; it blocks until done.
4. **Do the work**: `sync` the workspace, `run -- pip install -r requirements.txt`, `run -- python
   train.py …` with `nohup`/`tmux` for long jobs and `run -- tail -f` to follow; `pull` results into the
   workspace; `forward` for TensorBoard/Jupyter/Gradio and give the user the localhost URL.
5. **Hygiene**: Colab sessions die (≈90 min idle on free tier, 12 h cap; longer on Pro). Pull results as
   soon as they exist; write checkpoints to the synced dir and pull them; tell the user to keep the tab
   open; run `down` when finished. Never store secrets on Colab beyond the session; pass API keys as
   `run --env` only when the user agrees.
6. **Failure table**: `up` exit 2 → ask whether the cell was run / GPU quota exhausted; `run` connection
   refused → `status`, likely the runtime died, offer `up` again and re-`sync`.

Distribution: `npx skills add vzxxbacq/orca-colab` (agentskills layout); the README shows the command.
The Orca plugin's panel also shows it for copy-paste. `contributes.skills` in Orca manifests is still
reserved, so the plugin cannot install the skill itself yet.

## Bootstrap notebook (`notebooks/orca-colab-bootstrap.ipynb`)

Markdown cell: what this does, "pick a GPU runtime first", the one-line security note. Form cell:

```python
#@title Connect this runtime to your tailnet for orca-colab
TAILSCALE_AUTH_KEY = ""     #@param {type:"string"}
SSH_PUBLIC_KEY = ""         #@param {type:"string"}
TAILSCALE_LOGIN_SERVER = "" #@param {type:"string"}
HOSTNAME_SUFFIX = ""        #@param {type:"string"}
PASTE = ""                  #@param {type:"string"}   # fallback: "<authkey> <pubkey>" in one line
```

Code cell, as root:

1. Resolve values (`PASTE` overrides the two fields); fail loudly if the key does not start with
   `ssh-ed25519`/`ssh-rsa` or the auth key does not start with `tskey-`.
2. `apt-get install -y -qq openssh-server rsync`; `authorized_keys` 0600; `PermitRootLogin
   prohibit-password`, `PasswordAuthentication no`; start `sshd`.
3. Install Tailscale; `tailscaled --tun=userspace-networking --socks5-server=localhost:1055
   --state=/root/tailscaled.state &`; `tailscale up --authkey … --hostname orca-colab-<suffix or 6 random
   chars> --accept-dns=false --accept-routes=false [--login-server …]`.
4. Print `nvidia-smi -L` (or the "no GPU" hint), `tailscale ip -4`, and "Connected. Keep this tab open."
5. Separate, not-auto-run cell: a keepalive loop that touches a file every 5 min (does not defeat the
   browser idle rule; documented as such).

No outputs committed. No pip packages.

## Orca plugin

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "colab",
  "name": "Google Colab GPU",
  "version": "0.1.0",
  "description": "Use a Google Colab GPU runtime as a compute backend from your local Orca workspace and agents.",
  "repository": "https://github.com/vzxxbacq/orca-colab",
  "license": "MIT",
  "engines": { "orca": ">=1.4.248" },
  "pluginApi": 1,
  "main": "worker/main.mjs",
  "contributes": {
    "panels": [{ "id": "colab", "title": "Colab GPU", "icon": "zap", "entry": "panel/index.html" }],
    "commands": [
      { "id": "colab.up", "title": "Colab: Start GPU session", "when": "workspace" },
      { "id": "colab.down", "title": "Colab: Stop GPU session" },
      { "id": "colab.showPanel", "title": "Colab: Show sessions" }
    ],
    "statusBarItems": [{ "id": "colab-sessions", "icon": "zap", "text": "Colab", "command": "colab.showPanel" }]
  },
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "terminal:send" },
    { "kind": "notifications:show" },
    { "kind": "storage:own" }
  ]
}
```

- Worker: reads `~/.orca-colab/sessions/*.json` and the ledger (30 s poll + `fs.watch`), updates the
  status bar (`Colab: T4 · 1.96 CU/h · ≈61 CU`, hidden with no sessions and no balance; tone follows the
  budget), runs the idle watchdog (D14) and the budget alerts. `colab.up` → `terminal.create` in the focused workspace running `npx -y
  github:vzxxbacq/orca-colab#<tag> up`; `colab.down` likewise with `down`. Panel handlers: `colab.sessions`,
  `colab.doctor`.
- Panel: prerequisites ✓/✗; the credit block above per account (Calibrate, Set budget); sessions (name,
  GPU, CU/h, cost so far, IP, age, idle state, forwards) with Start/Stop/Keep; a monthly usage bar; the
  skill install command for copy; the three-step per-session text.
  Inline assets only; Orca frame CSS variables.
- Install identity `vzxxbacq.colab` (publisher derived from the repo owner).

## Optional remote-workspace mode (not scheduled)

The first design made Colab an Orca remote host via a VM recipe (`contributes.vmRecipes`, `ssh` result,
orcad deployed by Orca). It still works with this repo's notebook and could ship later as a second
recipe for users who *do* want agents on the GPU box. Facts for it are kept in
`docs/orca-plugin-facts.md` § VM recipes. Do not build it unless a TODO item asks.

## Milestones

- **M1 — Skill + CLI usable end to end on macOS.** `doctor`, `setup`, `up`, `run`, `sync`, `pull`,
  `forward`, `down`, `credits`/`ledger` with manual calibration, notebook, SKILL.md, release tag. Exit: a local agent, following the skill, trains a
  toy model on a T4 and pulls the checkpoint back with the user only pressing Run in Colab.
- **M2 — Orca plugin + platforms.** Panel with credit block, status bar, idle watchdog, budget alerts,
  browser calibration via Orca's embedded browser; terminal-launched commands; Linux/Windows paths; abort
  handling; Headscale `loginServer`; auth-key expiry warnings; CI.
- **M3 — Drive automation.** Optional OAuth (`drive.file`): `setup` creates the Drive copy with prefilled
  values; `up` reads the notebook's saved outputs to detect the IP without needing a tailnet peer scan.
- **M4 — Colab Enterprise.** Vertex AI runtime templates and execution jobs: GPU type chosen from the CLI,
  no browser at all, long-running paid runtimes.
- **M5 — Remote-workspace mode** as a second recipe, if asked.

## Known limits

- Colab sessions end (≈90 min idle / 12 h on free, longer on Pro/Pro+); nothing persists on the VM.
  Everything valuable must be `pull`ed or pushed to Git/Drive/HF from Colab.
- GPU type is chosen in Colab's UI until M4.
- Credit figures are estimates: Google publishes no per-GPU rate and no balance API. Rates drift; the
  user recalibrates from the Resources pane, and the panel shows how stale the calibration is.
- Throughput through a DERP relay is a few MB/s: fine for code and logs, wrong for datasets and weights;
  have Colab download those directly.
- Local Tailscale must be installed and signed in; `rsync` recommended (Windows: use WSL's or the tar
  fallback).
