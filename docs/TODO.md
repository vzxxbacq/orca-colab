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
- [x] **M2.5 Remote-host bridge (D18).** Worker drives `orca-colab watch` inside one background `Colab Bridge`
      terminal on remote Orca servers (`bin/lib/bridge-frames.mjs`, `bin/commands/watch.mjs`,
      `bin/lib/credential-envelope.mjs` X25519+AES-256-GCM sealed OAuth import, `test/watch-bridge.test.mjs`). — Done (`v0.2.0`–`v0.2.5`).
- [x] **M2.6 Community catalog review fixes (`v0.3.0`, issue #2).** Own Desktop OAuth client (`orca-colab-community`)
      with non-spoofed `User-Agent`, public Colab + `/tun/m/ccu-info` endpoints (`docs/colab-internal-endpoints.md`),
      Tailscale/SSH/notebook paths dropped (D19, D20), opt-in skill install & removal in the panel, personal Headscale preset removed, `npx` commands pinned to full commit SHA, and
      unofficial `Orca Colab Community` naming/disclaimer. — Done (`v0.3.0`).
- [x] ~~Orca browser notebook research (D16) & browser DOM calibration~~ — Superseded 2026-11-12: notebook path
      removed in D19; CCU balance and burn rate come directly from `GET /tun/m/ccu-info?authuser=0` over OAuth.
- [x] **Multiple accounts (D15).** `auth login --add`, `auth switch`, `up --account`, `creditsByAccount` in
      `DashboardSnapshotBuilder`, and per-account balance + active runtime count in the panel. — Done.
- [x] ~~`doctor` auth-key age warning; Headscale `loginServer`~~ — Dropped 2026-11-12 with the Tailscale path (DESIGN D19).
- [x] **Add the `orca-plugin` GitHub topic.** — Done (`vzxxbacq/orca-colab` carries topic `orca-plugin`).
- [x] **`pull` for Direct API sessions.** — Done 2026-11-12: packs on the runtime, downloads from Jupyter
      `/files` over HTTPS (DESIGN D20); Tailscale/SSH paths, `setup`, `forward` and the notebook removed (D19).
- [ ] **Abort handling**: wire `SIGINT`/`SIGTERM` in `bin/orca-colab.mjs` to an `AbortController` signal so
      aborting `up` cleans up `assign.lock` and leaves no partial session file; add unit test.
- [x] **CI/CD.** — Done 2026-11-12 (#9): `node --test` on Ubuntu/macOS/Windows × Node 20/22, manifest schema
      check, backward-compatibility diff on PRs (`breaking-change` label), Release and tag-verify workflows.
- [ ] **Cross-platform verification**: Linux (`xdg-open`, `orca-ide` binary lookup) and Windows (`bsdtar` path handling for `sync`/`pull`).

## M3 — Drive automation
- [x] ~~Drive copy of the bootstrap notebook~~ — Dropped 2026-11-12: no notebook since `v0.3.0`.

## M4 — Colab Enterprise
- [ ] Runtime templates listing, `up --enterprise --gpu a100`.

## M5 — Remote-workspace mode (only if asked)
- [ ] Second recipe `recipes/colab-remote-workspace.json`; needs a new bootstrap (the notebook was removed in `v0.3.0`); see facts § VM recipes.
