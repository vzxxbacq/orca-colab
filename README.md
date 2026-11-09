# orca-colab

An [Orca](https://github.com/stablyai/orca) plugin that runs Orca workspaces, terminals and coding agents
on a Google Colab runtime. Colab provides the GPU/TPU machine; Orca provides the IDE, the agents and the
workflow. Nothing but an SSH public key is sent to Colab.

Status: design complete, implementation in progress. See `docs/DESIGN.md` and `docs/TODO.md`.

## How it will work

1. In Orca, create a workspace with the **Colab GPU** environment recipe.
2. Orca runs the recipe on your machine: it generates an SSH key, copies the public key line to your
   clipboard and opens the bootstrap notebook in Colab.
3. In Colab, pick a GPU runtime, paste the key into the form field and run the cell. The cell joins your
   Tailscale tailnet (browser login) and starts `sshd`.
4. The recipe sees the new tailnet peer, pushes your repo to it over SSH and hands the host to Orca.
   Orca deploys its own server (orcad) there. Terminals and agents now run on Colab.

Requirements on your machine: Orca ≥ 1.4.248, Node ≥ 20, Tailscale signed in, `git`, `ssh-keygen`.

## Development

```sh
orca plugin validate .
orca plugin dev watch .
```

License: MIT.
