# TODO

Legend: `[ ]` open · `[~] name` in progress · `[x]` done (one-line result). Work top to bottom within a
milestone. Each item is one PR. Split when a PR would exceed ~300 lines.

## M1 — Skill + CLI end to end on macOS

- [ ] **M1.1 Scaffold.** `package.json` (`"type": "module"`, `"bin": {"orca-colab": "bin/orca-colab.mjs"}`,
      `"engines": {"node": ">=20"}`, no dependencies), `bin/orca-colab.mjs` dispatching
      `doctor|setup|up|status|ls|run|sync|pull|forward|down` to `bin/commands/<name>.mjs`, shared stderr
      logger with `[colab]` prefix, `--json` flag plumbing, exit codes per DESIGN. Exit: `node
      bin/orca-colab.mjs --help` lists commands.
- [ ] **M1.2 State + config.** `bin/lib/colab-home.mjs` (home dir via `os.homedir()`, 0700 dir, atomic
      JSON write tmp+rename, 0600 for config), `bin/lib/session-store.mjs` (list/read/write/delete
      sessions, "default session" rule). `node --test` for atomic write and default-session selection.
- [ ] **M1.3 Doctor.** `bin/lib/tailscale-cli.mjs` (locate binary, `status --json` parse: BackendState,
      Self, Peer map), `bin/lib/doctor.mjs` (checks per DESIGN, structured result), `doctor` command
      output. Test with a fixture status JSON.
- [ ] **M1.4 Setup.** Prompts (`node:readline/promises`) or flags; `bin/lib/ssh-keypair.mjs` (ed25519,
      comment `orca-colab`); writes config; prints prefill values; `bin/lib/open-url.mjs` and
      `bin/lib/clipboard.mjs` (pbcopy / wl-copy / xclip / clip.exe, graceful fallback).
- [ ] **M1.5 Peer discovery + SSH probe.** `bin/lib/tailscale-peer-wait.mjs` (snapshot, poll 3 s, new
      online `orca-colab-*` peer, IPv4), `bin/lib/ssh-banner-probe.mjs` (TCP 22, `SSH-` banner, deadline,
      AbortSignal). Tests with a fake status runner and a local fake banner server.
- [ ] **M1.6 `up`.** Orchestrates M1.3–M1.5, fallback clipboard line when `notebookUrl` is absent, GPU
      query via `bin/lib/ssh-exec.mjs` (common ssh argv builder), writes the session, prints JSON, exit
      codes 1/2/3, overall deadline. Test: JSON shape for fixed inputs (hardcoded expected).
- [ ] **M1.7 `run`, `status`, `ls`.** pty passthrough when TTY, exit code propagation, `--cwd`.
- [ ] **M1.8 `sync`, `pull`.** rsync detection, filters for `.gitignore` and `.colabignore`, `tar | ssh`
      fallback, `remoteRoot` recorded. Test the filter/argv builder only.
- [ ] **M1.9 `forward`, `down`.** Background `ssh -N -L` with pid in the session file, `--stop`; `down`
      kills forwards, best-effort `runtime.unassign()`, deletes the session.
- [ ] **M1.9b Credits (ledger + rates + manual calibration).** `bin/lib/rate-table.mjs` (defaults,
      `nvidia-smi` name → key mapping, user overrides), `bin/lib/credit-ledger.mjs` (append-only JSONL,
      balance projection from last calibration), `credits`, `credits set`, `credits budget`, `ledger`,
      `rates` commands; `up` records `rateKey`/`cuPerHour` and returns `estimatedCuPerHour`; `down` writes
      `session.end`. Tests: projection math with hardcoded events; GPU name mapping.
- [ ] **M1.10 Bootstrap notebook.** Per DESIGN. Validate inputs, sshd, tailscaled userspace, `tailscale up`
      with auth key and optional login server, GPU/IP report, separate keepalive cell. No outputs.
- [ ] **M1.11 SKILL.md.** `skills/colab-gpu/SKILL.md` per DESIGN § Skill, plus `skills/colab-gpu/
      references/cli.md` (the command table) so the skill body stays short. Verify
      `npx skills add vzxxbacq/orca-colab` installs it (from a branch is fine).
- [ ] **M1.12 Release v0.1.0.** Tag, README quick start, confirm `npx -y github:vzxxbacq/orca-colab#v0.1.0
      doctor` works from an empty directory on macOS.
- [ ] **M1.13 Live test (human + agent).** Owner creates the auth key and the Drive copy with the agent's
      guidance; agent runs `up`, syncs a toy PyTorch script, trains on a T4, pulls the checkpoint. Record
      timings and rough edges here.

## M2 — Orca plugin + platforms

- [ ] `orca-plugin.json` per DESIGN, `worker/main.mjs` (sessions + ledger watch, status bar text and
      tone, `colab.up`/`colab.down` via `terminal.create`), `panel/index.html` with the credit block.
      `orca plugin validate .` → 0.
- [ ] Idle watchdog (D14): `lastActivityAt` stamping in every CLI command, worker samples GPU utilisation
      over SSH, notify → 5-min grace → `down`; `up --keep` exemption; `settings.autoStopIdleMinutes`.
- [ ] Budget alerts: `monthlyBudgetCu` in config, status bar tone at 80 % / 100 %, notification once per
      threshold per month, skill rule to confirm before `up` when over budget.
- [ ] Browser calibration, step 1 (research): open Colab in Orca's browser with DevTools network
      capture, open the Resources pane, record the request that returns compute units (URL, method,
      headers, response shape). Write it to `docs/colab-internal-endpoints.md` with the capture date.
- [ ] Browser calibration, step 2: `credits calibrate --browser` using `orca browser` to run a
      same-origin page-context `fetch` of that endpoint and parse the JSON; fallback to pane text;
      fallback to a clear "enter manually" message. Panel Calibrate button. Never fail `up`/`down` on it.
- [ ] Multiple accounts (D15): `accounts[]` in config, `up --account`, per-account balance in panel.
- [ ] Linux (`xdg-open`, `wl-copy`/`xclip`, `orca-ide` wording) and Windows (`clip.exe`, `start`, no
      rsync → tar fallback, ssh from OpenSSH-for-Windows).
- [ ] Abort: SIGTERM/SIGINT during `up` leaves no partial session file; test by aborting the signal.
- [ ] Auth-key age tracking in config (`authKeyCreatedAt`), `doctor` warns at 83 days.
- [ ] Headscale: `loginServer` end to end.
- [ ] CI: `node --test`; manifest check against Orca's JSON schema (fetch the schema file in the workflow).
- [ ] Add the `orca-plugin` GitHub topic once the plugin exists.

## M3 — Drive automation
- [ ] OAuth PKCE loopback (`drive.file`), token at `~/.orca-colab/google-token.json` 0600.
- [ ] `setup --drive` creates the prefilled copy; `up` polls the copy's outputs for the tailnet IP.

## M4 — Colab Enterprise
- [ ] Runtime templates listing, `up --enterprise --gpu a100`, execution job that runs the bootstrap.

## M5 — Remote-workspace mode (only if asked)
- [ ] Second recipe `recipes/colab-remote-workspace.json` reusing the notebook; see facts § VM recipes.

## Decisions pending
- `remoteRoot` default: `/content/orca/<basename>`. Keeps Colab's sample data and Drive mounts separate.
- Default rate table values need a source. Current numbers are the community-observed Nov 2026 figures;
  mark them "approximate" in the UI and let the first live test (M1.13) refine T4 from an actual
  before/after reading of the Resources pane.
- Should `run` default to `tmux` sessions for long jobs so a dropped SSH does not kill training? Leaning
  yes: `run --detach NAME` → `tmux new -d -s NAME`, `run --attach NAME`. Decide in M1.7.
