# orca-colab — agent instructions

A skill, a CLI and a thin Orca plugin that let a coding agent running locally in Orca set up a Google
Colab GPU runtime together with the user and use it as a compute backend. Agents, the workspace and
credentials stay local; Colab is a disposable GPU box reached only through public HTTPS/WSS endpoints
(the Colab API and the runtime's proxy). Never assume a VPN, tailnet, SSH or inbound port (DESIGN D19).

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
orca-plugin.json, worker/, panel/      thin Orca plugin (M2): sessions panel, status bar, terminal launcher
docs/                       design, verified Orca facts, TODO
```

## Hard rules

- **Zero runtime dependencies** in `bin/` and `worker/`. Node builtins only. The CLI runs on the user's
  machine through `npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/<release sha>`, so install time must stay near zero.
- **Credentials never leave the user's machine.** Google tokens live only in
  `~/.orca-colab/google-oauth.json` (0600); the runtime proxy token only in the session file. No user
  token is ever embedded in the repo. The app's own Desktop OAuth client ID and secret in
  `bin/lib/colab-oauth.mjs` are not user credentials: Google treats installed-app client secrets as
  public (PKCE + loopback protect the flow).
- **Cross-platform CLI**: macOS, Linux, Windows. Use `os.homedir()`, never `$HOME`; spawn with argv
  arrays, never shell strings.
- **Agent-parsable output**: with `--json`, stdout carries exactly one JSON object and nothing else.
  Progress, prompts and errors go to stderr with the `[colab]` prefix. Exit codes are part of the
  contract (see DESIGN § CLI); the skill depends on them.
- **Idempotent and interruptible**: `up` may be killed at any time. Never leave a half-written session
  file; write JSON atomically (tmp + rename). `down` must succeed even when Colab is already gone.
- **Credits are estimates.** Every number derived from the ledger is labelled approximate and shows its
  calibration age. Never present a projected balance as a fact, in the UI or in `--json` (`estimated`
  prefix on field names).
- **Secrets**: never log a Google token or a runtime proxy token, and never put one in `--json` output.
- **No comments that restate code.** One line, why not how, only where the code cannot say it.
- **No file names like `utils`, `helpers`, `common`.** Name files after the concept they hold
  (`jupyter-files.mjs`, `credential-envelope.mjs`, `session-store.mjs`).
- **Tests**: add one only when it would fail if your change were reverted and it hardcodes its expected
  values. Use `node --test`. Never test timing, copy, or third-party behaviour.

## Commands

```sh
node bin/orca-colab.mjs doctor --json     # local prerequisite check
node --test                               # unit tests
# Plugin (M2), with the Orca CLI installed:  orca plugin validate .   &&   orca plugin dev watch .
```

Run `node --test` (and, once the plugin exists, `orca plugin validate .`) before every push.

## Testing against real Colab

The human owner has Colab access and signs in with `orca-colab auth login` when asked (agents cannot
click through Google's consent page). Once signed in, an agent can run the whole flow itself: prefer
`up --gpu CPU` for checks that do not need a GPU, and always `down` afterwards. Finish everything
verifiable locally first (JSON contract, fake `execTty` / `fetchImpl` injections in tests).

## Git

- Work on a branch per TODO item, open a PR to `main`, squash-merge.
- Releases pin a **full commit SHA, never a tag**, in every `npx` command (plugin default, worker, skill,
  READMEs, DESIGN), because tags can move after the Orca review. The pin is the codeload tarball URL,
  because npm 10 cannot fetch `github:vzxxbacq/orca-colab#<40-hex sha>`. A commit
  cannot contain its own SHA, so a release is two commits made directly on `main` (never squashed, so the
  pinned SHA stays reachable):
  1. `release: vX.Y.Z; ...` — bump `version` in `package.json` and `orca-plugin.json`; pins unchanged.
  2. `release: pin vX.Y.Z to <short sha>` — run `node scripts/release-pin.mjs HEAD` (it refuses if `bin/`
     or `package.json` changed since that commit), run `node --test`, commit, and tag **this** commit
     `vX.Y.Z`. The tag's CLI files are identical to the pinned commit's.
- Commit messages: `area: what changed` (`pull: download the archive from Jupyter /files`).

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

