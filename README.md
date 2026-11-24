# Colab GPU for Orca: Google Colab GPUs for Claude Code, Codex and other AI coding agents

[**English**](./README.md) | [**简体中文**](./README.zh-CN.md) · [**Install from the Orca plugin directory**](https://orca.dev/plugins/vzxxbacq/orca-colab)

![Colab GPUs, run by your agent](./assets/cover.png)

**Colab GPU for Orca** (`orca-colab`) is an Orca plugin and command-line tool that lets Claude Code, Codex and other
AI coding agents run jobs on Google Colab GPUs.

Your coding agent needs a GPU; your laptop doesn't have one. **Colab GPU for Orca** lets Claude Code, Codex
and any other agent in [Orca](https://github.com/stablyai/orca) start a Google Colab T4, L4 or A100 runtime
on its own, sync the workspace, run training, fine-tuning or inference jobs, pull checkpoints and metrics
back, and shut the runtime down when it's done, with live output and compute-unit tracking in an Orca panel.
Your code, agents and credentials stay on your machine, and it runs on your own Colab account and
compute units. No VPN, SSH or notebook to babysit.

Install it in Orca from the [plugin directory](https://orca.dev/plugins/vzxxbacq/orca-colab) (**Colab GPU (Community) for Orca**), or use the
CLI alone with `npx`. A community project, not affiliated with Google.

## What you get

- **Agents manage compute**: the agent checks your policy, provisions or scales parallel runtimes, syncs the
  workspace, installs dependencies, runs jobs and releases idle GPUs, all through one JSON CLI.
- **Live output**: every agent run streams into the **Colab GPU** panel in real time, with history, exit
  codes and per-run GPU attribution.
- **Humans set guardrails**: sign in with Google, pick the allowed GPU tiers (T4, L4, A100, CPU), cap
  concurrent runtimes and the monthly Compute Unit budget. The agent cannot step outside them: once the
  estimated use this month reaches the budget, `up` refuses to start a new runtime (running ones keep going)
  until you raise it in the panel or with `orca-colab credits budget <cu>`.
- **Multiple runtimes and sessions**: run several GPUs side by side, name them, address them per command
  with `--session`, and switch between Google accounts.
- **Public endpoints only**: everything goes over HTTPS to Google's Colab API and the runtime's own
  proxy; no VPN, tailnet, SSH or open ports. `pull` downloads results (binary-safe) from the runtime.
- **Every machine sees the same runtimes**: the panel and the CLI list all runtimes of the Google account
  you are signed in to, including ones an agent started on another computer or on a remote Orca server,
  with their jobs and live output. No bridge and no terminal is involved. See
  [below](#several-machines-one-account).

## Quick Start

### 1. Install

From the Orca Community Plugins marketplace (Settings → Plugins → `vzxxbacq.colab`), or from GitHub:

```sh
orca plugin install github:vzxxbacq/orca-colab
```

The plugin bundles the `colab-gpu` agent skill but never installs it on its own: open **Agent Skill** in the panel's setup view, tick the folders (`~/.agents/skills`, `~/.claude/skills`, `~/.gemini/config/skills`) and press Install; Remove takes it out again. To install only the skill without the plugin, or to develop the plugin locally:

```sh
npx skills add vzxxbacq/orca-colab
orca plugin dev load .
```

The CLI needs no install step; agents call it as `npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/2944ee151e7ef2d08a5598c00c6cce4e3109f13c <command> --json`.

### 2. Configure

1. Open the **Colab GPU** panel in Orca and click **Sign in with Google**. On Google's consent page, tick **Read, write and delete your Colab resources** (or **Select all**); Google leaves it unticked by default.
2. Set allowed GPU tiers and concurrency limits under **Guardrails & CU**.
3. Ask your agent to run any GPU task.

### Google sign-in relay

Signing in uses the plugin's own Google OAuth client (Google's consent screen shows it as
*Colab GPU (Community) for Orca*). Google requires that client's secret on
every token request, so instead of shipping it inside the CLI, a small Cloudflare Worker,
`https://orca-colab-token-relay.fhq981014.workers.dev`, holds it. **The Worker does exactly one thing:**
it takes the one-time authorization code your own machine received (or a refresh token), adds the client
secret, sends that single request to `oauth2.googleapis.com/token` and returns Google's answer unchanged.
It stores nothing, logs nothing (request logs are off), never calls any Colab API and cannot act on your
account by itself. To keep one client from using up its free quota, it counts requests per IP address in
memory (30 a minute, 300 an hour). Its whole source is [`token-relay/src/index.mjs`](./token-relay/src/index.mjs).

To bypass it, create your own Desktop OAuth client in Google Cloud and set `ORCA_COLAB_CLIENT_ID` and
`ORCA_COLAB_CLIENT_SECRET`; orca-colab then talks to Google directly. `orca-colab auth logout` revokes
your token at Google before deleting it from `~/.orca-colab`.

## What an agent run looks like

A smoke test on a T4, exactly as the `colab-gpu` skill drives it:

```sh
orca-colab up --gpu T4 --json                                   # Tesla T4, ≈1.96 CU/h
orca-colab sync --json                                          # workspace → /content/orca/<dir>
orca-colab job submit --name "Smoke bench" --wait --json -- python3 bench.py
orca-colab run --json -- cat /content/orca/colab-smoke/results.json
orca-colab down --json                                          # runtime released
```

The whole round trip, including a 2048² fp16 matmul (≈21 TFLOPS) and 200 CNN training steps, took about
a minute of runtime and roughly 0.03 Compute Units. Credits in the panel and in `credits --json` are
estimates, labelled as such, and calibrated against your real balance on request.

## FAQ

### What is Colab GPU for Orca?
An Orca plugin and CLI (`orca-colab`) that gives AI coding agents a GPU. The agent starts a Google Colab
runtime on your account, syncs the workspace to it, runs jobs there and pulls the results back. It is listed
in the Orca plugin directory as *Colab GPU (Community) for Orca*.

### How do I give Claude Code (or Codex) a GPU?
Install the plugin in Orca, click **Sign in with Google** in the Colab GPU panel, then ask the agent for GPU
work. Through the bundled `colab-gpu` skill it runs `orca-colab up --gpu T4`, `sync`, `job submit --wait`,
`pull` and `down` on its own, and you watch the live output in the panel.

### Can I use it without Orca?
Yes. The CLI runs anywhere with Node.js 20+: `npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/<release> <command> --json`
(the exact pinned command is in each [release](https://github.com/vzxxbacq/orca-colab/releases)). Any agent
can use it through the skill: `npx skills add vzxxbacq/orca-colab`, or as an MCP server: see
[Use as a connector (MCP)](#use-as-a-connector-mcp).

### Which GPUs can it use?
Whatever Colab offers your account: typically T4, L4 and A100, plus CPU runtimes. You choose which ones
agents may start and how many at once under **Guardrails & CU**.

### How much does it cost?
The plugin is free and open source (MIT). Runtimes use your own Colab compute units at Colab's rates (a T4
reported about 1.2 CU/hour in our tests). The panel tracks your balance and a monthly budget, and, while Orca
is running, stops a forgotten idle runtime after 20 minutes (configurable). A full smoke test on a T4 took
about a minute and roughly 0.03 CU.

### Do I need SSH, ngrok, Tailscale or a VPN?
No. Everything goes over HTTPS and WebSockets to the Colab API and the runtime's own proxy. Nothing has to be
reachable on your network and no port is opened on the runtime. To reach an HTTP service that runs there, use
[`orca-colab forward`](#port-forwarding): it listens on your machine and carries each request over the same
authenticated channel.

### Does my code leave my machine?
Only what you sync, and only to your own Colab runtime. Agents, the workspace and your Google tokens stay on
your computer. Sign-in token requests pass through a [small relay](#google-sign-in-relay) that adds the app's
client secret and stores nothing.

### How do I get results back?
`orca-colab pull <remote path> <local dir> --json` packs the file or folder on the runtime, downloads it over
HTTPS and unpacks it locally. Binary files (checkpoints, weights) arrive byte for byte.

### What happens when the Colab runtime disconnects?
Colab runtimes are disposable and time-limited. Pull results as soon as they exist; if a runtime is gone,
`status --json` shows it and the agent can `down`, `up` and `sync` again.

### How is it different from the Colab extension for VS Code?
Google's extension connects notebooks open in VS Code to a Colab runtime for a person to work in. This
project is built for agents: a JSON CLI, a job manager with live logs, file sync and pull, budget guardrails
and an Orca panel. It is a community project, not affiliated with Google.

### How is it different from Modal, RunPod or other GPU clouds?
Those are separate GPU clouds with their own accounts and billing, better suited to long-running or
production workloads. Colab GPU for Orca reuses the Colab subscription or compute units you already have and
fits interactive experiments, fine-tuning and evaluation runs within Colab's session limits.

## CLI

Full reference: [`skills/colab-gpu/references/cli.md`](./skills/colab-gpu/references/cli.md)

```sh
orca-colab auth [login --add | list | switch <account>] --json
orca-colab doctor --json
orca-colab up --gpu T4 [--new] [--name <name>] [--account <account>] --json
orca-colab job submit --name "Train" --wait --json -- <cmd>
orca-colab run --json -- <cmd>
orca-colab sync [path] --json
orca-colab pull <remote> <localDir> --json
orca-colab forward --port <remote port> [--listen 127.0.0.1:<local port>]
orca-colab down [--all] --json
```

**Downloading results.** `orca-colab pull outputs ./results --json` packs `outputs` (relative to the synced
folder, or an absolute path such as `/content/model.pt`) into a tar.gz on the runtime, downloads it over
HTTPS from the runtime's own Jupyter server with the runtime's proxy token, and unpacks it into
`./results/outputs`. Files of any size and type arrive byte for byte; nothing needs to be reachable on
your network.

### Port forwarding

```sh
orca-colab forward --port 8000 [--session <name>] [--listen 127.0.0.1:8000] [--timeout 300]
```

While this runs, `http://127.0.0.1:8000` on your machine answers with whatever port 8000 on the runtime
answers: method, path, query, headers, body, status and response headers pass through unchanged, so JSON
APIs, multipart uploads and CORS preflights work as they are. Stop it with Ctrl-C. `status` and the panel show
active forwards, and a session with one is never auto-stopped as idle.

- **How it travels**: Colab's proxy reaches only the runtime's Jupyter server, so each request is written
  there as a file through the Jupyter contents API, replayed against `127.0.0.1:<port>` by a small helper
  process on the runtime, and the response is read back. No tunnel, SSH or open port on the runtime.
- **Cost per request**: about half a second on top of the service's own time (two round trips to the
  runtime). Measured: a 20 MB upload in 7 s, a 30 MB response in 3 s, a 90-second request, 6 requests at once.
- **Limits**: HTTP only. No WebSockets, and no streaming: a response arrives when it is complete, so
  server-sent events and chunked progress do not work. Request bodies up to 256 MB. One request may take
  `--timeout` seconds (default 300).
- **Errors from the forward itself** are JSON with status 502 or 504: `session_gone` (the runtime was
  released: `up` again, start the service, restart the forward), `port_unreachable` (nothing listens on that
  port on the runtime), `forward_timeout`.
- It binds to `127.0.0.1` unless `--listen` says otherwise. To publish the service, run your tunnel or
  reverse proxy on your own machine in front of the forward, not on the Colab runtime.

For a one-off query, `orca-colab run -- curl -s localhost:<port>/...` is still the shortest way.

## Use as a connector (MCP)

`orca-colab mcp` serves the whole CLI as [MCP](https://modelcontextprotocol.io) tools on stdio, so an agent
needs neither the skill nor a shell. Add it to an Orca bot:

```sh
orca bot tools add "npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/2944ee151e7ef2d08a5598c00c6cce4e3109f13c mcp" --name colab
```

Claude Code and Codex (Orca bots also pick up the tools of your own Claude Code or Codex setup):

```sh
claude mcp add colab --scope user -- npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/2944ee151e7ef2d08a5598c00c6cce4e3109f13c mcp
codex mcp add colab -- npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/2944ee151e7ef2d08a5598c00c6cce4e3109f13c mcp
```

Any other MCP client: command `npx`, arguments `-y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/2944ee151e7ef2d08a5598c00c6cce4e3109f13c mcp`.

- **Tools**: `doctor`, `status`, `up`, `sync`, `run`, `job_submit`, `job_list`, `job_logs`, `job_wait`,
  `job_stop`, `pull`, `down`, `credits`, `credits_calibrate`, `credits_set`, `credits_budget`, `ledger`,
  `rates`, and `auth_status`, `auth_login`, `auth_wait`, `auth_redirect`, `auth_list`, `auth_switch`,
  `auth_logout`. Each one runs the CLI command of the same name and returns its JSON, so your guardrails
  (allowed GPUs, runtime cap, monthly budget) apply unchanged: `up` refuses with `step: "policy"` or
  `step: "budget"`.
- **Sign-in from the agent**: with no Google sign-in, the agent calls `auth_login`. Your browser opens
  Google's consent page (the agent also gets the link to show you); tick **Read, write and delete your Colab
  resources** and the agent's `auth_wait` sees the sign-in finish. No terminal, no panel.
- **Signing in from another machine**: sign-in ends on `http://127.0.0.1:PORT/...` on the machine that runs
  `orca-colab`. When your browser is on a different machine (a remote Orca server, SSH), that last page will
  not load. That is expected: copy its full address from the address bar and give it to the agent
  (`auth_redirect`), or run `orca-colab auth redirect <address>` on that machine. The address is a one-time
  key to your Colab; send it nowhere else.
- **Same state as the panel**: the server reads and writes the same `~/.orca-colab` as the CLI. Runtimes,
  runs, jobs with live output, credits and the sign-in appear in the **Colab GPU** panel as they happen, and
  what you change there (guardrails, account, stopping a runtime or a job) is what the agent's next call sees.
  A panel on another computer signed in to the same Google account shows the runtimes and jobs too
  ([Several machines, one account](#several-machines-one-account)).
- **Paths**: the server does not run in your workspace, so `sync`, `pull` and `job_submit` with `sync` take
  `workspace_path` (clients that expose a single MCP root need not pass it).
- **Long work**: `job_submit` returns a job id at once; `job_wait` and `job_logs` follow it. Waits default to
  45 seconds. Codex stops a tool call after 60 seconds, which a slow `up` can exceed: the runtime is still
  created (`status` shows it), or set `tool_timeout_sec = 300` under `[mcp_servers.colab]` in
  `~/.codex/config.toml`.

## Several machines, one account

A Colab runtime belongs to a Google account, not to a computer. Every machine signed in to that account
(your laptop, a remote Orca server where an agent works, a second desktop) sees the same runtimes:

- **The panel and `orca-colab status` ask Colab** for the account's runtimes each time and show all of
  them, labelled by where they came from: *started here*, *from Claude Code · build-server*, or *unknown
  origin* for a runtime without an orca-colab record (an older version, or a notebook you have open in
  Colab).
- **What used to live only on the machine that ran `up` now also lives on the runtime**, under
  `/content/orca/.orca-colab/`, written and read over HTTPS through the runtime's own proxy (Jupyter):
  `session.json` (name, account, the machine and agent that started it, GPU, start time, keep flag),
  `tasks/<id>.json` and `tasks/<id>.log` for every `run` and `job`, and `activity/<machine>.json` (who used
  it last).
- **Jobs run detached on the runtime** with their output in that log file, so the log is complete for
  whoever reads it and the job survives the client that submitted it going away. `job ls`, `job logs
  [--follow]`, `job stop`, `run`, `sync`, `pull`, `forward` and `down` work from any machine, by session
  name.
- **A runtime in use is not stopped from elsewhere**: the idle auto-stop and `down` read the records on the
  runtime (jobs still running, commands still going, from any machine). `down` on a runtime another machine
  is using right now answers `reason: "in-use-elsewhere"` and needs `--force`; the panel asks you to press
  Stop twice. Runtimes of unknown origin are never auto-stopped.
- **A project on a remote Orca server** needs nothing special: open the panel in the desktop app and it
  shows the account's runtimes, whichever project is focused. The panel never opens an Orca terminal; its
  **Terminal** button is a shell on the runtime, shown in the panel. (For a full-screen terminal run
  `orca-colab run -- bash -l` in a terminal of your own.)

What stays on each machine: the Google sign-in (`~/.orca-colab/google-oauth.json`), the credit ledger with
its monthly budget, and the guardrails (allowed GPUs, session cap, idle auto-stop minutes). **The panel
edits the guardrails of the computer it runs on**; a remote server's agents follow that server's own
`~/.orca-colab/config.json` (`orca-colab credits budget <cu>` and the config file there). The balance itself
is the account's and is read from Colab.

Limits: "Sync this workspace" from the panel only works for a project whose files are on this computer;
for a project on a remote server let the agent there run `sync`. Two machines that share a hostname should
set `ORCA_COLAB_MACHINE` to tell them apart. A job started by an older orca-colab has no record on the
runtime and shows only on the machine that started it.

## License

MIT
