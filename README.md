# orca-colab

Use a Google Colab GPU from your local [Orca](https://github.com/stablyai/orca) workspace. A skill teaches
your coding agent to set it up with you and use it; a zero-dependency CLI does the work; a thin Orca plugin
shows the sessions. Your agent, code and credentials stay on your machine. Colab is a disposable GPU box
reached over your Tailscale tailnet.

Status: design complete, implementation in progress. See `docs/DESIGN.md` and `docs/TODO.md`.

## How it will work

One-time, guided by the agent: `orca-colab doctor`, then `orca-colab setup` with a Tailscale auth key
(reusable, ephemeral, tagged) and a personal copy of the bootstrap notebook saved in Drive.

Per session:

1. The agent runs `orca-colab up`. Your notebook copy opens in Colab.
2. You pick a GPU runtime and press Run. The cell joins your tailnet and starts `sshd`.
3. The CLI finds the new peer and reports the GPU. The agent then `sync`s the workspace, `run`s jobs,
   `forward`s ports (TensorBoard, Jupyter, Gradio) and `pull`s results. `down` releases the runtime.

```sh
npx skills add vzxxbacq/orca-colab          # install the agent skill
npx -y github:vzxxbacq/orca-colab doctor    # or: npm i -g github:vzxxbacq/orca-colab
```

Requirements on your machine: Node ≥ 20, Tailscale signed in, OpenSSH, `rsync` (recommended), `git`.

## Development

```sh
node --test
node bin/orca-colab.mjs doctor
```

License: MIT.
