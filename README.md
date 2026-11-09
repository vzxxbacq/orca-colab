# orca-colab

Use a Google Colab GPU from your local [Orca](https://github.com/stablyai/orca) workspace. A skill teaches
your coding agent to set it up with you and use it; a zero-dependency CLI does the work; a thin Orca plugin
shows the sessions. Your agent, code and credentials stay on your machine. Colab is a disposable GPU box
reached over your Tailscale tailnet.

Status: Milestone 1 (`v0.1.0`) — Skill + CLI + Bootstrap notebook. See `docs/DESIGN.md` and `docs/TODO.md`.

## Quick start

One-time setup (about 5 minutes, guided by your coding agent):

```sh
npx skills add vzxxbacq/orca-colab                      # install the colab-gpu agent skill
npx -y github:vzxxbacq/orca-colab#v0.1.0 doctor --json  # check local prerequisites
npx -y github:vzxxbacq/orca-colab#v0.1.0 setup          # save Tailscale auth key (0600) & generate SSH keypair
```

Per session:

1. The agent runs `orca-colab up --json` (or `npx -y github:vzxxbacq/orca-colab#v0.1.0 up --json`). Your bootstrap notebook opens in Colab (inside Orca's embedded browser when running in an Orca terminal).
2. You pick a GPU runtime (`Runtime → Change runtime type`) and press **Run**. The cell joins your tailnet and starts `sshd`.
3. The CLI detects the new `orca-colab-*` peer, verifies SSH, and reports the GPU and approximate CU/h burn rate. The agent then `sync`s the workspace, `run`s jobs, `forward`s ports (TensorBoard, Jupyter, Gradio) and `pull`s results. `down` triggers the in-kernel `runtime.unassign()` watcher and verifies port 22 closes.

```sh
npx -y github:vzxxbacq/orca-colab#v0.1.0 up --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 sync --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 run -- nvidia-smi
npx -y github:vzxxbacq/orca-colab#v0.1.0 pull /content/orca/out ./out --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 credits set 85.4 --json
npx -y github:vzxxbacq/orca-colab#v0.1.0 down --json
```

Requirements on your machine: Node ≥ 20, Tailscale signed in, OpenSSH, `rsync` (recommended), `git`.

## Development

```sh
node --test
node bin/orca-colab.mjs doctor
```

License: MIT.
