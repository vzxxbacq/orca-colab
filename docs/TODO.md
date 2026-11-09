# TODO

Legend: `[ ]` open · `[~] name` in progress · `[x]` done (one-line result). Work top to bottom within a
milestone. Each item is one PR. Keep items small; split when a PR would touch more than ~300 lines.

## M1 — End to end on macOS

- [ ] **M1.1 Scaffold.** `package.json` (`"type": "module"`, `"bin"`, `"engines": {"node": ">=20"}`,
      no dependencies), `orca-plugin.json` per DESIGN §5, `recipes/colab-gpu.json` per DESIGN §1 with
      the tag placeholder `v0.1.0`, empty `worker/main.mjs` exporting `activate`, placeholder
      `panel/index.html`. Exit: `orca plugin validate .` → 0.
- [ ] **M1.2 Recipe CLI skeleton.** `bin/orca-colab.mjs` dispatching `create|suspend|resume|destroy|doctor`
      from argv; `bin/lib/colab-state-dir.mjs` (home dir, instance dir, atomic `state.json` write/read);
      `bin/lib/recipe-env.mjs` (typed read of the `ORCA_*` env with defaults); stderr logger with
      `[colab]` prefix; exit codes. `node --test` for the state writer (atomic, round-trips).
- [ ] **M1.3 Doctor.** `bin/lib/doctor.mjs`: locate `tailscale` (PATH, macOS app bundle, Windows path),
      parse `tailscale status --json` (`BackendState`, `Self.TailscaleIPs`), check `ssh-keygen`, `git`,
      clipboard tool. Returns structured results; CLI prints ✓/✗ lines. Test with a fake status JSON.
- [ ] **M1.4 Key pair + clipboard + open browser.** `bin/lib/ssh-keypair.mjs` (ed25519, comment
      `orca-colab-<id>`, id = 6 base32 chars from `crypto.randomBytes`), `bin/lib/clipboard.mjs`
      (pbcopy / wl-copy / xclip / clip.exe, graceful fallback), `bin/lib/open-url.mjs`
      (open / xdg-open / `cmd /c start "" url`).
- [ ] **M1.5 Tailscale peer wait + SSH probe.** `bin/lib/tailscale-peer-wait.mjs`: poll every 3 s for
      `Peer[*].HostName == hostname && Online`, return IPv4; `bin/lib/ssh-banner-probe.mjs`: TCP connect to
      port 22 and read an `SSH-` banner, with deadline. Both accept an `AbortSignal`. Tests with a fake
      `tailscale status` runner and a local fake banner server.
- [ ] **M1.6 Repo push over SSH.** `bin/lib/repo-push.mjs`: `git init` remote root, push
      `ORCA_REPO_REF_HEAD` to `refs/heads/<branch>`, checkout, set `origin` to `ORCA_REPO_URL`. Uses the
      instance key with `IdentitiesOnly`, `BatchMode`, per-instance `known_hosts`. Handles the case where
      `ORCA_REPO_REF_HEAD` is empty (fall back to `HEAD` of the local repo).
- [ ] **M1.7 `create` orchestration + result JSON.** Wire M1.3–M1.6 in order, overall deadline =
      `timeoutSeconds.create − 30 s` (read from env? no: hardcode 870 s and keep in sync with the recipe),
      write `state.json`, print the schema-2 result as the last stdout line. Test: result validates against
      the shape in facts doc (hardcoded expected JSON for fixed inputs).
- [ ] **M1.8 `resume`, `suspend`, `destroy`.** Per DESIGN §2. `destroy` runs `runtime.unassign()` over
      SSH best-effort (20 s), removes the state dir.
- [ ] **M1.9 Bootstrap notebook.** `notebooks/orca-colab-bootstrap.ipynb` per DESIGN §3. Validate the key
      format, hostname from comment, sshd config, tailscaled userspace, `tailscale up` output streaming,
      GPU report. No outputs committed. Include a second, not-auto-run keepalive cell.
- [ ] **M1.10 Worker + panel (minimal).** Status bar count from state dirs (30 s poll + `fs.watch`),
      `colab.showPanel` command, panel with doctor results, runtime list, "Open bootstrap notebook" button
      and the three steps. Inline assets only.
- [ ] **M1.11 Release v0.1.0.** Bump version + recipe tag, `git tag v0.1.0`, push, add topic
      `orca-plugin`. Verify `npx -y github:vzxxbacq/orca-colab#v0.1.0 doctor` works from an empty dir.
- [ ] **M1.12 Live test (human).** Install the plugin in Orca from the Git URL, create a workspace from a
      small repo with the Colab recipe, run the notebook with a T4 runtime, confirm Orca opens the
      workspace and `nvidia-smi` works in an Orca terminal. Record findings here.

## M2 — Robustness and platforms

- [ ] Linux: `xdg-open`, `wl-copy`/`xclip`, `orca-ide` naming in docs. Windows: `clip.exe`, `start`,
      `cmd.exe` quoting of the recipe command, `taskkill` abort path.
- [ ] Abort handling: SIGTERM mid-wait leaves no partial state; verify with a test that aborts the signal.
- [ ] Panel: show session age and a warning after 60 min of no Colab browser activity (we cannot see
      that; show age and the idle-timeout rule instead).
- [ ] Optional Tailscale API key setting (`settings:own` + `secrets:own`) to delete the device on destroy.
- [ ] Optional `ORCA_COLAB_NOTEBOOK_URL` override so forks can point to their own notebook.
- [ ] CI: GitHub Action that checks out `stablyai/orca` sparse (`docs/schemas`) and validates the manifest
      against the JSON schema with a tiny Node script; `node --test`.

## M3 — Zero-paste via Google Drive

- [ ] OAuth PKCE loopback in the recipe CLI (scopes `drive.file`), token stored through the worker's
      `secrets.set`; design how the CLI reaches the secret (worker-written file in the state dir with
      0600, or a one-shot `plugin.request`). Decide and document first.
- [ ] Copy the notebook into Drive with the key prefilled; open its Colab URL; poll the saved notebook's
      outputs via the Drive API to detect the tailnet IP without the Tailscale CLI.

## M4 — Colab Enterprise (Vertex AI)

- [ ] `notebookRuntimeTemplates` list → setting for template; `notebookExecutionJobs` to run the
      bootstrap with no browser; map GPU type to template.

## M5 — Remote notebook kernel (Orca core)

- [ ] Proposal PR in `stablyai/orca`: let `ipynb-execution-host` start a kernel through orcad on a remote
      workspace. Out of scope for this repo; track the upstream issue link here.

## Decisions pending

- Where does `create` get `timeoutSeconds` from? Env does not carry it. Current answer: hardcode and keep
  in sync with the recipe JSON; add a test that reads the recipe file and compares.
- Should `projectRoot` be `/content/orca/<repo>` or `/content/<repo>`? `/content/orca/` keeps Colab's
  sample data and Drive mounts separate. Current answer: `/content/orca/<repo>`.
