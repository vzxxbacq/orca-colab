# TODO

Legend: `[ ]` open · `[~] name` in progress · `[x]` done (one-line result). Work top to bottom within a
milestone. Each item is one PR. Split when a PR would exceed ~300 lines.

## M1 — Skill + CLI end to end on macOS

- [x] **M1.1 Scaffold.** `package.json` (`"type": "module"`, `"bin": {"orca-colab": "bin/orca-colab.mjs"}`,
      `"engines": {"node": ">=20"}`, no dependencies), `bin/orca-colab.mjs` dispatching
      `doctor|setup|up|status|ls|run|sync|pull|forward|down|credits|ledger|rates` to
      `bin/commands/<name>.mjs` (credits/ledger/rates are stubs until M1.9b), shared stderr
      logger with `[colab]` prefix, `--json` flag plumbing, exit codes per DESIGN. Exit: `node
      bin/orca-colab.mjs --help` lists commands. — Done: CLI entry, 13 command handlers, `--json` and `[colab]` stderr plumbing (`test/cli-scaffold.test.mjs`).
- [x] **M1.2 State + config.** `bin/lib/colab-home.mjs` (home dir via `os.homedir()`, 0700 dir, atomic
      JSON write tmp+rename, 0600 for config; config shape per DESIGN with `accounts: [{ label: "default",
      notebookUrl? }]` and `defaultAccount: "default"` from day one), `bin/lib/session-store.mjs` (list/read/write/delete
      sessions, "default session" rule). `node --test` for atomic write and default-session selection. — Done: atomic 0600 config/session persistence and default-session selection (`test/state-and-sessions.test.mjs`).
- [x] **M1.3 Doctor.** `bin/lib/tailscale-cli.mjs` (locate binary, `status --json` parse: BackendState,
      Self, Peer map), `bin/lib/doctor.mjs` (checks per DESIGN, structured result), `doctor` command
      output. Test with a fixture status JSON. — Done: Tailscale locator/status parser and structured prerequisite checks (`test/doctor.test.mjs`).
- [x] **M1.4 Setup.** Prompts (`node:readline/promises`) or flags; `bin/lib/ssh-keypair.mjs` (ed25519,
      comment `orca-colab`); writes config; prints prefill values; `bin/lib/open-url.mjs` and
      `bin/lib/clipboard.mjs` (pbcopy / wl-copy / xclip / clip.exe, graceful fallback). — Done: `setup` command, ed25519 keygen, clipboard and Orca/system browser helpers (`test/setup.test.mjs`).
- [x] **M1.5 Peer discovery + SSH probe.** `bin/lib/tailscale-peer-wait.mjs` (snapshot, poll 3 s, new
      online `orca-colab-*` peer, IPv4), `bin/lib/ssh-banner-probe.mjs` (TCP 22, `SSH-` banner, deadline,
      AbortSignal). Tests with a fake status runner and a local fake banner server. — Done: Tailscale peer discovery and TCP 22 SSH banner probe with timeout/abort handling (`test/peer-and-probe.test.mjs`).
- [x] **M1.6 `up`.** Orchestrates M1.3–M1.5, fallback clipboard line when `accounts[default].notebookUrl` is absent, GPU
      query via `bin/lib/ssh-exec.mjs` (common ssh argv builder), writes the session, prints JSON, exit
      codes 1/2/3, overall deadline. Test: JSON shape for fixed inputs (hardcoded expected). — Done: `up` session orchestration, SSH argv builder and GPU query (`test/up.test.mjs`).
- [x] **M1.7 `run`, `status`, `ls`.** pty passthrough when TTY, exit code propagation, `--cwd`. — Done: `run` with PTY passthrough, `--cwd`/`--env`/tmux flags, exit code propagation, and `status`/`ls` reachability probe (`test/run-and-status.test.mjs`).
- [x] **M1.8 `sync`, `pull`.** rsync detection, filters for `.gitignore` and `.colabignore`, `tar | ssh`
      fallback, `remoteRoot` recorded. Test the filter/argv builder only. — Done: `sync` and `pull` with rsync `.gitignore`/`.colabignore` filters and `tar | ssh` fallback (`test/sync-and-pull.test.mjs`).
- [x] **M1.9 `forward`, `down`.** Background `ssh -N -L` with pid in the session file, `--stop`; `down`
      kills forwards, touches `/root/.orca-colab/unassign` over SSH, waits ≤30 s for port 22 to close,
      deletes the session or marks it `zombie` (exit 4) with instructions (D10). Activity stamping
      (`lastActivityAt` start/60 s/exit, `activePids`) added to the shared command runner here. — Done: `forward`, `down` with D10 unassign sentinel/zombie handling, and `session-activity` stamping (`test/forward-and-down.test.mjs`).
- [x] **M1.9b Credits (ledger + rates + manual calibration).** `bin/lib/rate-table.mjs` (defaults,
      `nvidia-smi` name → key mapping, user overrides), `bin/lib/credit-ledger.mjs` (append-only JSONL,
      balance projection from last calibration), `credits`, `credits set`, `credits budget`, `ledger`,
      `rates` commands; `up` records `rateKey`/`cuPerHour` and returns `estimatedCuPerHour`; `down` writes
      `session.end`. Tests: projection math with hardcoded events; GPU name mapping. — Done: rate table, append-only credit ledger, projection math and `credits`/`ledger`/`rates` commands (`test/credits.test.mjs`).
- [x] **M1.10 Bootstrap notebook.** Per DESIGN. Validate inputs, sshd, tailscaled userspace, `tailscale up`
      with auth key and optional login server, in-kernel unassign watcher thread (D10), GPU/IP report,
      separate keepalive cell. No outputs. Verify in M1.13 that touching the sentinel over SSH really
      releases the runtime (watch Colab's UI); if `runtime.unassign()` needs the frontend connected,
      document that the tab must be open for `down` to work. — Done: `notebooks/orca-colab-bootstrap.ipynb` with input validation, sshd, tailscaled userspace, D10 unassign watcher and keepalive cell (`test/bootstrap-notebook.test.mjs`).
- [ ] **M1.11 SKILL.md.** Writes the pinned command `npx -y github:vzxxbacq/orca-colab#v0.1.0`; it cannot
      run until M1.12 tags, so this item verifies only the skill install, and M1.12 verifies the command.
       `skills/colab-gpu/SKILL.md` per DESIGN § Skill, plus `skills/colab-gpu/
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
- [ ] Idle watchdog (D14): worker reads `lastActivityAt`/`activePids`, samples GPU utilisation over SSH
      every 5 min, requires three consecutive <5 % samples **and** no activity/live pid for
      `autoStopIdleMinutes`, then notify → 5-min grace → `down`; `up --keep` exemption. Test the decision
      function with hardcoded sample sequences (a 40-minute run with one low sample must not trigger).
- [ ] Budget alerts: budget = latest `budget.set` ledger event per account (never config), status bar
      tone at 80 % / 100 %, notification once per threshold per month, skill rule to confirm before `up`
      when over budget.
- [ ] Orca browser research (D16): confirm Google sign-in and Colab cell execution work inside Orca's
      embedded browser (`orca tab create --url`), note any UA or popup issues, and record how `up` should
      detect "running inside Orca" (`ORCA_WORKTREE_ID || ORCA_WORKSPACE_ID || ORCA_PANE_KEY`). Then switch `up` to open the notebook there (`--system-browser` to
      override).
- [ ] Browser calibration, step 1 (research): open Colab in Orca's browser with DevTools network
      capture, open the Resources pane, record the request that returns compute units (URL, method,
      headers, response shape). Write it to `docs/colab-internal-endpoints.md` with the capture date.
- [ ] Browser calibration, step 2: `credits calibrate --browser` using `orca tab create --url --json` (keep `browserPageId`) + `orca eval --expression --page <id>
      --expect-url` to run a
      same-origin page-context `fetch` of that endpoint and parse the JSON; fallback to pane text;
      fallback to a clear "enter manually" message. Panel Calibrate button. Never fail `up`/`down` on it.
- [ ] Multiple accounts (D15): `setup --account <label>` appends to the existing `accounts[]`,
      `up --account`, per-account balance in panel. The shape already exists since M1.2.
- [ ] Linux (`xdg-open`, `wl-copy`/`xclip`, `orca-ide` wording) and Windows (`clip.exe`, `start`, no
      rsync → tar fallback, ssh from OpenSSH-for-Windows).
- [ ] Abort: SIGTERM/SIGINT during `up` leaves no partial session file; test by aborting the signal.
- [ ] `doctor` warns at 83 days from `authKeyCreatedAt` (written by `setup`, already in the config schema).
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
