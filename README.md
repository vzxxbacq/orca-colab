# orca-colab

Use a Google Colab GPU from your local [Orca](https://github.com/stablyai/orca) workspace. A skill teaches
your coding agent to set it up with you and use it; a zero-dependency CLI does the work; a thin Orca plugin
shows the sessions. Your agent, code and credentials stay on your machine. Colab is a disposable GPU box
reached over your Tailscale tailnet.

Status: Milestone 1 & 2 (`v0.1.0`) — Skill + CLI + Colab VS Code Direct API + Task Manager + Orca Plugin. See `docs/DESIGN.md` and `docs/TODO.md`.

## Quick start

One-time setup (about 5 minutes, guided by your coding agent):

```sh
npx skills add vzxxbacq/orca-colab                      # install the colab-gpu agent skill
npx -y github:vzxxbacq/orca-colab#v0.1.0 doctor --json  # check local prerequisites
npx -y github:vzxxbacq/orca-colab#v0.1.0 setup          # save Tailscale auth key (0600) & generate SSH keypair
npx -y github:vzxxbacq/orca-colab#v0.1.0 auth login     # sign in once in default browser (Passkey supported) for headless API provisioning
```

Per session (browserless with `auth login`, or notebook fallback):

1. Run `orca-colab up --gpu T4 --json`. When signed in via `auth login`, it assigns the Colab runtime directly via `colaboratory.googleapis.com/v1beta/runtimes` and bootstraps Tailscale + `sshd` over `/colab/tty` with **zero browser tabs**.
2. Submit and manage GPU compute tasks with `job submit`, `job ls`, `job logs`, and `job stop` (or view live streaming task output in the Orca **Colab GPU** panel).

```sh
npx -y github:vzxxbacq/orca-colab#v0.1.0 up --gpu T4 --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 sync --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 job submit --name "Train ResMLP" --wait --json -- python3 train.py
npx -y github:vzxxbacq/orca-colab#v0.1.0 job logs <task-id>
npx -y github:vzxxbacq/orca-colab#v0.1.0 pull /content/orca/out ./out --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 credits calibrate --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 down --json
```

Requirements on your machine: Node ≥ 20, Tailscale signed in, OpenSSH, `rsync` (recommended), `git`.

## Development

```sh
node --test
node bin/orca-colab.mjs doctor
```

License: MIT.
