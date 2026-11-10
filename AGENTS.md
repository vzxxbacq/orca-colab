# orca-colab — agent instructions

A skill, a CLI and a thin Orca plugin that let a coding agent running locally in Orca set up a Google
Colab GPU runtime together with the user and use it as a compute backend over the user's tailnet.
Agents, the workspace and credentials stay local; Colab is a disposable GPU box reached over SSH.

Read in this order before touching code:

1. `docs/DESIGN.md` — architecture, flows and the decisions already made. Do not re-litigate them; open
   a TODO item with a rationale if you think one is wrong.
2. `docs/orca-plugin-facts.md` — verified facts about Orca's plugin and VM recipe runtime, with source
   paths in the Orca repo. Trust these over memory.
3. `docs/TODO.md` — the work queue. Pick the first unclaimed item in the current milestone, mark it
   `[~]` with your name, and mark it `[x]` with a one-line result when done.

## Repo layout (target)

```
skills/colab-gpu/SKILL.md   the agent-facing procedure (agentskills layout; npx skills add vzxxbacq/orca-colab)
skills/colab-gpu/references/cli.md   command table the skill links to
bin/orca-colab.mjs          CLI entry; bin/commands/<name>.mjs per command; bin/lib/ concept modules
notebooks/orca-colab-bootstrap.ipynb   the notebook the user runs inside Colab
orca-plugin.json, worker/, panel/      thin Orca plugin (M2): sessions panel, status bar, terminal launcher
docs/                       design, verified Orca facts, TODO
```

## Hard rules

- **Zero runtime dependencies** in `bin/` and `worker/`. Node builtins only. The CLI runs on the user's
  machine through `npx -y github:vzxxbacq/orca-colab#<tag>`, so install time must stay near zero.
- **Credentials never leave the user's machine** except the SSH public key pasted into Colab. No Google
  OAuth in milestone 1. No tokens embedded in the notebook or the repo.
- **Cross-platform CLI**: macOS, Linux, Windows. Use `os.homedir()`, never `$HOME`; spawn with argv
  arrays, never shell strings; locate `tailscale` by its known install paths when not on PATH.
- **Agent-parsable output**: with `--json`, stdout carries exactly one JSON object and nothing else.
  Progress, prompts and errors go to stderr with the `[colab]` prefix. Exit codes are part of the
  contract (see DESIGN § CLI); the skill depends on them.
- **Idempotent and interruptible**: `up` may be killed at any time. Never leave a half-written session
  file; write JSON atomically (tmp + rename). `down` must succeed even when Colab is already gone.
- **Credits are estimates.** Every number derived from the ledger is labelled approximate and shows its
  calibration age. Never present a projected balance as a fact, in the UI or in `--json` (`estimated`
  prefix on field names).
- **Secrets**: the Tailscale auth key lives only in `~/.orca-colab/config.json` (0600) and in the user's
  own notebook copy. Never log it, never put it in `--json` output, never commit a notebook with it.
- **No comments that restate code.** One line, why not how, only where the code cannot say it.
- **No file names like `utils`, `helpers`, `common`.** Name files after the concept they hold
  (`tailscale-peer-wait.mjs`, `ssh-keypair.mjs`, `session-store.mjs`).
- **Tests**: add one only when it would fail if your change were reverted and it hardcodes its expected
  values. Use `node --test`. Never test timing, copy, or third-party behaviour.
- **Notebook edits**: edit `notebooks/*.ipynb` as JSON by hand or with `jupyter nbconvert --clear-output`;
  never commit cell outputs or execution counts.

## Commands

```sh
node bin/orca-colab.mjs doctor --json     # local prerequisite check
node --test                               # unit tests
# Plugin (M2), with the Orca CLI installed:  orca plugin validate .   &&   orca plugin dev watch .
```

Run `node --test` (and, once the plugin exists, `orca plugin validate .`) before every push.

## Testing against real Colab

The human owner has Colab access, a signed-in Tailscale client and will press Run in Colab, create the
Tailscale auth key and save the Drive notebook copy when asked. Agents cannot do those. When a task needs
a live Colab run, finish everything verifiable locally (doctor, key generation, clipboard, JSON contract,
timeout paths with a fake `tailscale status` fixture, a fake SSH banner server), then stop and write
exactly what the human must do in the TODO item.

## Git

- Work on a branch per TODO item, open a PR to `main`, squash-merge. Tag releases `vX.Y.Z` and bump
  `version` in `package.json` (and `orca-plugin.json` once it exists) in the same commit; the skill and
  the plugin pin that tag in their `npx` commands.
- Commit messages: `area: what changed` (`up: wait for tailscale peer before probing ssh`).

## Releases: what needs the owner's approval

- **Patch and minor releases** (`vX.Y.Z` → `vX.Y.Z+1` or `vX.Y+1.0`) may be tagged and pushed without
  asking, after `node --test` and `orca plugin validate .` pass.
- **Major releases** (`vX.0.0`) need the owner's explicit approval first. Propose the version, the reason
  and the changelog, then stop and wait. Never tag or push a major version on your own.
- **Breaking changes need advance warning**, in the same message that proposes the work, before any code
  is written: anything that renames or removes a CLI command, flag, `--json` field, exit code, plugin
  setting key or capability; changes the session, task or ledger file formats under `~/.orca-colab`;
  changes the `watch` frame protocol; or raises `engines.orca`. State what breaks, who is affected
  (skill, plugin, remote `watch` of an older version) and the migration, and wait for a go-ahead.
- A tag listed in the Orca community catalog can never move. Ship fixes as a new tag.

