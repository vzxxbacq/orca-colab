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
- [x] **M1.11 SKILL.md.** Writes the pinned command `npx -y github:vzxxbacq/orca-colab#v0.1.0`; it cannot
      run until M1.12 tags, so this item verifies only the skill install, and M1.12 verifies the command.
       `skills/colab-gpu/SKILL.md` per DESIGN § Skill, plus `skills/colab-gpu/
      references/cli.md` (the command table) so the skill body stays short. Verify
      `npx skills add vzxxbacq/orca-colab` installs it (from a branch is fine). — Done: `skills/colab-gpu/SKILL.md` and `skills/colab-gpu/references/cli.md`, verified with `npx skills add . --list` (`test/skill-files.test.mjs`).
- [x] **M1.12 Release v0.1.0.** Tag, README quick start, confirm `npx -y github:vzxxbacq/orca-colab#v0.1.0
      doctor` works from an empty directory on macOS. — Done: updated README quick start, tagged `v0.1.0`, and verified `npx -y github:vzxxbacq/orca-colab#v0.1.0 doctor --json` from `/tmp`.
- [x] **M1.13 Live test (human + agent).** Owner creates the auth key and the Drive copy with the agent's
      guidance; agent runs `up`, syncs a toy PyTorch script, trains on a T4, pulls the checkpoint. Record
      timings and rough edges here.
      Human steps: (1) create a reusable, ephemeral, pre-approved Tailscale auth key with tag `tag:orca-colab` in the Tailscale admin console; (2) run `node bin/orca-colab.mjs setup`, paste the `tskey-auth-...` key, save a personal copy of `notebooks/orca-colab-bootstrap.ipynb` in Google Drive with the prefill values, and paste the Drive URL; (3) when `node bin/orca-colab.mjs up --json` opens the notebook in Colab, select a T4 GPU runtime (`Runtime → Change runtime type`) and press **Run**. — Done: verified live on two real Google Colab Tesla T4 runtimes (`orca-colab-a7fc4b` and `orca-colab-c2c80a`, 15360 MiB VRAM over a self-hosted Headscale server); fixed Colab `/etc/ssh/sshd_config` (`Port 22`, `ListenAddress 0.0.0.0`, `MaxStartups 10:30:100`) and `#@param` parser quirk; synced, trained a 6-layer 13.16M-param `DeepResMLP` in FP16 in 5.201s (`63,003.3 samples/sec`), pulled metrics (`eval_metrics.json`), verified port forwarding (`18080:8080`), credits/ledger, and `runtime.unassign()` teardown.

## M2 — Orca plugin + Colab VS Code Direct API + Task Manager

- [x] **M2.1 Colab VS Code OAuth & Direct API.** `bin/lib/colab-oauth.mjs` (PKCE loopback OAuth in system browser, `0600` `~/.orca-colab/google-oauth.json`), `bin/lib/colab-api-client.mjs` (`v1beta/runtimes` assignment, `/colab/tty` WebSocket bootstrap, `DELETE v1beta/runtimes/{id}`, `v1/user-info` CCU balance, `api/colab/resources`), `bin/commands/auth.mjs`, and browserless `up`/`down`/`credits calibrate` integration. — Done: implemented PKCE loopback OAuth, Direct API runtime lifecycle, `/colab/tty` WebSocket bootstrap, and CCU sync (`test/colab-direct-api.test.mjs`).
- [x] **M2.2 Task Manager (`job` CLI).** `bin/lib/task-store.mjs` and `bin/commands/job.mjs` (`job submit`, `job ls`, `job logs`, `job stop`) storing task state in `~/.orca-colab/tasks/<id>.json` and streaming live output to `~/.orca-colab/tasks/<id>.log`. — Done: implemented foreground/detached task submission, live log streaming, and remote process termination (`test/task-manager.test.mjs`).
- [x] **M2.3 Orca Plugin + Enhanced Task & Output Panel.** `orca-plugin.json` per DESIGN, `worker/main.mjs` (sessions + tasks + live task output streaming + ledger watch, status bar text and tone, `colab.up`/`colab.down`, idle watchdog), `panel/index.html` with GPU runtime control, Task Manager, Live Task Output Console, and Credit stewardship. `orca plugin validate .` → 0. — Done: implemented `orca-plugin.json`, `worker/main.mjs`, and `panel/index.html`; verified `orca plugin validate .` exits 0.
- [x] **M2.4 Idle watchdog (D14) & Budget alerts.** Worker reads `lastActivityAt`/`activePids` and running tasks, samples GPU utilisation over SSH every 5 min, requires three consecutive <5 % samples **and** no activity/live pid for `autoStopIdleMinutes`, then notify → 5-min grace → `down`; `up --keep` exemption; budget alerts at 80 % / 100 %. Test the decision function with hardcoded sample sequences. — Done: implemented `bin/lib/idle-watchdog.mjs` and verified 40-min single-low-sample exemption and budget alerts (`test/idle-watchdog-and-plugin.test.mjs`).
- [~] claude **M2.5 Remote-host bridge (D18).** When the focused Orca workspace lives on a remote Orca server
      (`workspace.list` row has a `hostId`), the worker in the desktop client stops reading its own
      `~/.orca-colab/` and instead drives `orca-colab watch` inside one background terminal of that
      workspace (`terminal.create` / `terminal.send` / `terminal.read`), so sessions, tasks, live output,
      credits and Google sign-in all reflect and land on the server. Local workspaces keep the fs path.
      `bin/lib/bridge-frames.mjs` (gzip+base64 chunked frames that survive pty wrapping and the 2000-line
      read window), `bin/lib/dashboard-snapshot.mjs` and `bin/lib/panel-actions.mjs` (shared by worker and
      `watch`), `bin/commands/watch.mjs`, `auth login --no-browser` + redirect-URL replay for sign-in on the
      server, `terminal:read` capability, `remoteCliCommand` setting, panel mode badge and paste box.
      Verified locally: `node --test` (41), `orca plugin validate .` → 0, `watch` round trip over stdin.
      Human steps: (1) in the desktop Orca, reload the plugin from this branch and approve the new
      fingerprint (it now asks to read terminals); (2) set the plugin setting "orca-colab command on
      remote Orca servers" to `node /Users/user/orca/projects/orca-colab/bin/orca-colab.mjs`; (3) focus
      the server-hosted project: the top bar should show `Server · <host>`, a `Colab Bridge` terminal
      should appear in that workspace within a few seconds (created through the local `orca` CLI), and
      the Agent Runs list should show the server's tasks; if instead a card asks you to run `watch` by
      hand, send the output of `orca plugin dev request . colab.debugWorkspace --data '{}'`;
      (4) click Sign in with Google, open the link, approve, paste the redirected URL, confirm the
      account appears; (5) switch to a local project and confirm the badge says `Local`.
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
- [ ] `pull` for Direct API sessions: it only knows rsync/ssh tar, so a `colab-tty` session (no tailnet IP)
      fails with `root@: Permission denied`. Mirror `sync`'s `colab-tty-tar` path in reverse. Found 2026-11-12.

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
