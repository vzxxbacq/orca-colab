# orca-colab

[**English**](./README.md) | [**简体中文**](./README.zh-CN.md)

Use Google Colab GPUs as an autonomous compute backend for local coding agents in [Orca](https://github.com/stablyai/orca).

- **Humans set guardrails**: Sign in with Google, pick allowed GPU tiers, and cap concurrent runtimes & monthly Compute Units.
- **Agents manage compute**: Agents autonomously check policy, provision or scale parallel runtimes, install dependencies, stream task logs, and release idle GPUs.
- **Direct API connection**: Connects directly to Google Colab without Tailscale or manual browser steps (optional Tailscale SSH also supported).

## Quick Start

### 1. Install

```sh
orca plugin install github:vzxxbacq/orca-colab
```

For local development or standalone skill installation:

```sh
orca plugin dev load .
npx skills add vzxxbacq/orca-colab
```

### 2. Configure

1. Open the **Colab GPU** panel in Orca and click **Sign in with Google**.
2. Set allowed GPU tiers and concurrency limits under **Guardrails & CU**.
3. Ask your agent to run any GPU task.

## CLI

Full reference: [`skills/colab-gpu/references/cli.md`](./skills/colab-gpu/references/cli.md)

```sh
orca-colab auth [login --add | list | switch <account>] --json
orca-colab doctor --json
orca-colab up [--new] [--account <account>] --json
orca-colab job submit --name "Train" --wait --json -- <cmd>
orca-colab run --json -- <cmd>
orca-colab sync [path] --json
orca-colab pull <remote> <local> --json
orca-colab down [--all] --json
```

## Remote Orca servers

If your project lives on a remote Orca server, the **Colab GPU** panel in the desktop app shows that
server's sessions, tasks, live output and Google accounts, not your laptop's. The plugin opens one
background terminal named `Colab Bridge` in the workspace and drives `orca-colab watch` through it; no
SSH, daemon or extra login is needed beyond the Orca connection you already have. Set the plugin
setting **orca-colab command on remote Orca servers** if `orca-colab` is not on the server's `PATH`
(for a checkout: `node /path/to/orca-colab/bin/orca-colab.mjs`). Google sign-in from the panel then
runs on the server: open the link it shows, approve, and paste the `http://127.0.0.1:…` address your
browser lands on back into the panel (CLI equivalent: `auth login --no-browser` + `auth redirect <url>`).
Local projects keep working as before.

## License

MIT
