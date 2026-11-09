# orca-colab — agent instructions

Orca plugin that turns a Google Colab runtime into an Orca remote host, so Orca workspaces, terminals
and coding agents run on Colab's GPU/TPU machines.

Read in this order before touching code:

1. `docs/DESIGN.md` — architecture, flows and the decisions already made. Do not re-litigate them; open
   a TODO item with a rationale if you think one is wrong.
2. `docs/orca-plugin-facts.md` — verified facts about Orca's plugin and VM recipe runtime, with source
   paths in the Orca repo. Trust these over memory.
3. `docs/TODO.md` — the work queue. Pick the first unclaimed item in the current milestone, mark it
   `[~]` with your name, and mark it `[x]` with a one-line result when done.

## Repo layout (target)

```
orca-plugin.json          manifest (format 2, execution: trusted-worker)
recipes/colab-gpu.json    VM recipe Orca runs locally (create/suspend/resume/destroy)
bin/orca-colab.mjs        local recipe CLI, plain Node ≥ 20, zero dependencies
worker/main.mjs           plugin worker: status bar, panel requests, doctor
panel/index.html          sidebar panel (isolated frame, no network, inline assets only)
notebooks/orca-colab-bootstrap.ipynb   the notebook the user runs inside Colab
docs/                     design, facts, TODO
```

## Hard rules

- **Zero runtime dependencies** in `bin/` and `worker/`. Node builtins only. The recipe CLI runs on the
  user's machine through `npx -y github:vzxxbacq/orca-colab#<tag>`, so install time must stay near zero.
- **Credentials never leave the user's machine** except the SSH public key pasted into Colab. No Google
  OAuth in milestone 1. No tokens embedded in the notebook or the repo.
- **Cross-platform recipe CLI**: macOS, Linux, Windows. Recipes run through the OS shell with
  `cwd = local repo path`; the shell is `cmd.exe` on Windows, so recipe command strings must not use
  `$HOME`, `~`, `&&` chains that differ, or POSIX quoting. Put all logic in Node, keep the command string
  to `npx -y github:vzxxbacq/orca-colab#<tag> <mode>`.
- **Recipe contract is strict**: the last line of stdout for `create`/`resume` must be exactly the JSON
  Orca parses (see facts doc). Everything human-readable goes to stderr.
- **Idempotent and interruptible**: `create` may be aborted by Orca at any time (SIGTERM / process group
  kill). Never leave a half-written state dir; write `state.json` atomically (tmp + rename).
- **No comments that restate code.** One line, why not how, only where the code cannot say it.
- **No file names like `utils`, `helpers`, `common`.** Name files after the concept they hold
  (`tailscale-peer-wait.mjs`, `ssh-keypair.mjs`, `colab-state-dir.mjs`).
- **Tests**: add one only when it would fail if your change were reverted and it hardcodes its expected
  values. Use `node --test`. Never test timing, copy, or third-party behaviour.
- **Notebook edits**: edit `notebooks/*.ipynb` as JSON by hand or with `jupyter nbconvert --clear-output`;
  never commit cell outputs or execution counts.

## Commands

```sh
node bin/orca-colab.mjs doctor            # local prerequisite check (tailscale, ssh-keygen, git, clipboard)
node --test                               # unit tests (none are required by default)
# From an Orca checkout:           pnpm validate:plugin /path/to/orca-colab
# With the Orca CLI installed:     orca plugin validate .   &&   orca plugin dev watch .
```

Run `orca plugin validate .` (or `pnpm validate:plugin`) before every push. It must exit 0.

## Testing against real Colab

The human owner (henryfang) has Colab access and will run the bootstrap notebook and sign in to Google
and Tailscale when asked. Agents cannot. When a task needs a live Colab run, finish everything that can
be verified locally (doctor, key generation, clipboard, JSON contract, timeout paths with a fake
`tailscale status` fixture), then stop and write exactly what the human must do in the TODO item.

## Git

- Work on a branch per TODO item, open a PR to `main`, squash-merge. Tag releases `vX.Y.Z` and bump
  `version` in `orca-plugin.json` in the same commit; the recipe command pins that tag.
- Commit messages: `area: what changed` (`recipe: wait for tailscale peer before probing ssh`).
