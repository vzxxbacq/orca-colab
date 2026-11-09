# Verified facts about Orca's plugin and VM recipe runtime

Checked against the Orca source at `stablyai/orca` (local checkout, version 1.4.254, 2026-11-09). Paths
are relative to that repo. When something here conflicts with what you remember, trust this file; when
it conflicts with the current Orca source, fix this file.

## Plugin manifest and docs

- Reference docs: `docs/reference/plugin-authoring.md`, `plugin-manifest.md`, `plugin-host-api.md`,
  `plugin-isolated-frames.md`. JSON schema:
  `https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json`.
- Manifest format 2 is strict: unknown keys at any level are refused.
- `execution` must be the highest profile used: `trusted-worker` is required by `main`, events, hooks and
  by any command without a built-in `action`.
- Leave `publisher` out; Orca derives it from the repository owner (`vzxxbacq` for
  `github.com/vzxxbacq/orca-colab`). Plugin ids starting with `orca-` and reserved owners
  (`stablyai`, `official`, `anthropic`, `openai`, `github`, `orca*`) install only from the official catalog.
- `engines.orca` must be ≥ the newest `Since` of any field used. `statusBarItems`, `hooks`, `replaces`:
  1.4.248. `settings`, `.ts` entries, no `publisher`: 1.4.246. `fonts`: 1.4.253.
- Capabilities (`kind`): `workspace:read`, `workspace:write`, `agent:read`, `agent:launch`,
  `terminal:send`, `terminal:read`, `notifications:show`, `storage:own`, `secrets:own`, `settings:own`,
  `appearance:write`. `terminal:send` needs `trusted-worker`.
- Panel icons are a fixed set; `cloud`, `rocket`, `zap`, `terminal`, `plug` exist.
- Validation: `pnpm validate:plugin <dir>` from an Orca checkout or `orca plugin validate <dir>` with the
  CLI (exit 0 ok, 2 invalid, 3 approval needed). Dev loop: `orca plugin dev watch .` (prints the
  `--approve <fingerprint>` command on first load; never approves by itself).
- Listing in the directory: push to GitHub, tag `vX.Y.Z` matching `version`, add the GitHub topic
  `orca-plugin` (`gh repo edit vzxxbacq/orca-colab --add-topic orca-plugin`).

## Worker

- `main` is an ES module whose **default export** is `activate(orca)`; a named `activate` is not called.
  Optional `export function deactivate()`.
- `orca.host.call(method, params)`, `orca.host.has(method)`, `orca.commands.register(id, handler)`,
  `orca.events.on`, `orca.panels.handle(name, async (input, { panel, signal }) => …)`,
  `orca.panels.post(name, payload)`, `orca.storage/settings/secrets.get|set`, `orca.log(message)`.
- A worker with `main` **and** `contributes.statusBarItems` is started when the plugin is enabled and kept
  running; otherwise it starts on demand and may be stopped when idle.
- `statusBar.update` params: `{ id, text?, icon?, tone?, tooltip?, visible? }` (host API 1.2, worker only).
- `node:` builtins resolve as in plain Node. `import type … from 'orca/worker'` for typings only.
- Logs: `orca plugin logs`; fire a handler without a panel: `orca plugin dev request . <name> --data '{}'`.

## Panel frame (`panel/index.html`)

- Orca injects a frozen `window.orca` before scripts run: `orca.host.call`, `orca.plugin.request(name,
  input, { timeoutMs })`, `orca.plugin.on`, `orca.on(event)`, `orca.shell.openExternal(url)` (needs a
  click within a few seconds; desktop only; Orca asks once per new host), `orca.files.saveAs`.
- The frame has **no network**: nothing outside the plugin folder, `data:` or `blob:` loads. Inline
  everything. Browser clients load the frame with `connect-src 'none'` and an opaque origin, so do not rely
  on storage or workers.
- Theme tokens arrive as CSS variables: `--orca-background`, `--orca-foreground`,
  `--orca-muted-foreground`, `--orca-border`, `--orca-secondary`, `--orca-primary`.
- Example: `examples/plugins/hello-orca/panel.html`, `examples/plugins/hello-worker-panel/`.

## Skills

- `orca skills install` installs only the skills bundled with the Orca build (via the community skills
  CLI). Third-party skills install with `npx skills add <owner>/<repo>`, which expects the agentskills
  layout: `skills/<name>/SKILL.md` with frontmatter `name` and `description`. Orca's `contributes.skills`
  manifest point is reserved and must stay empty, so a plugin cannot ship a skill yet.
- Orca terminals: a worker can open one in the focused workspace with `terminal.create` (`terminal:send`,
  host API 1.3) and read it with `terminal.read` (`terminal:read`).

## VM recipes (reference for the optional remote-workspace mode, M5)

- Contribution: `"contributes.vmRecipes": [{ "path": "recipes/x.json" }]` (`declarative` or higher).
  Recipe JSON type `OrcaVmRecipe` in `src/shared/orca-yaml-hook-types.ts:31`:
  `{ id, name, create, description?, checkoutMode?: 'orca-worktree'|'provisioned-root', suspend?, resume?,
  destroy?, destroyDisabled?, timeoutSeconds?: number | { create?, suspend?, resume?, destroy? } }`.
- Shipped example: `resources/plugins/launch/stablyai.orca-multipass-recipes/`.
- Commands run through the OS shell (`shell: true`) with **`cwd` = the local repo path**
  (`src/shared/ephemeral-vm-recipe-process.ts:57`). **No plugin-root path or env var is provided** to the
  command. On Windows the shell is `cmd.exe`.
- Environment passed to every mode (`ephemeral-vm-recipe-process.ts:258`):
  `ORCA_VM_MODE` (`create|suspend|resume|destroy`), `ORCA_VM_INSTANCE_ID` (set on create too),
  `ORCA_RECIPE_ID`, `ORCA_PROJECT_ID`, `ORCA_WORKSPACE_ID`, `ORCA_WORKSPACE_NAME`, `ORCA_REPO_PATH`,
  `ORCA_REPO_URL`, `ORCA_REPO_BRANCH`, `ORCA_REPO_REF`, `ORCA_REPO_REF_HEAD`,
  `ORCA_RECIPE_RESULT_SCHEMA_VERSION` (`1`, or `2` when `checkoutMode` is `provisioned-root`), `ORCA_VERSION`.
  Legacy `ORCA_VM_NAME` is also present (Multipass example uses it).
- Result parsing (`src/shared/ephemeral-vm-recipes.ts:36-133`): Orca parses **stdout**; stderr is streamed
  to the UI log. `create` and `resume` must print one of (all objects are `.strict()`):

  ```
  { schemaVersion: 1, connection, userData? }
  { schemaVersion: 2, checkoutMode: "provisioned-root", connection, userData? }
  connection = { type: "orca-server", pairingCode, projectRoot }
             | { type: "ssh", projectRoot, target }
  target = { label, host, port, username, configHost?, identityFile?, identityAgent?, identitiesOnly?,
             proxyCommand?, jumpHost?, relayGracePeriodSeconds?, portForwards? }
  ```

  The `schemaVersion`/`checkoutMode` of the result must match the recipe's `checkoutMode`
  (`src/shared/ephemeral-vm-recipe-checkout-mode.ts`), otherwise the start fails with
  `provisionedRootResultRequired` / `provisionedRootNotConfigured`.
- `provisioned-root`: Orca adopts `projectRoot` on the host as the workspace's main checkout and creates no
  linked worktree (`src/main/runtime/workspaces/creation/runtime-provisioned-root-adoption.ts`); it
  verifies the checkout matches the imported Git root. Sparse checkout is refused in this mode.
- `orca-worktree` (default): Orca manages the checkout under `projectRoot` itself on the host, which needs
  the host to be able to clone `ORCA_REPO_URL`. We use `provisioned-root` (D6).
- Timeouts: per-mode wall clock from `timeoutSeconds`; on timeout or non-zero exit Orca reports
  `ephemeralVmTimeoutFailure` / `ephemeralVmExitFailure`. Processes are killed as a group
  (`taskkill /t /f` on Windows).
- Suspend is triggered by Orca when the workspace sleeps (`src/main/ephemeral-vm/workspace-suspend.ts`);
  a successful suspend marks the VM resume-eligible even if local SSH teardown fails. A skipped suspend
  leaves the SSH connection live.
- After a `ssh` result Orca registers the target (`src/main/ephemeral-vm/runtime-ssh.ts`), connects, and
  deploys orcad over that connection (`src/main/managed-server/install/orcad-remote-*.ts`). orcad is a
  Node bundle shipped inside the desktop app plus a pinned Node runtime the host downloads or receives;
  there is **no standalone orcad download**, so a recipe would return `ssh` and not `orca-server`.
- `orca serve --project-root <path> --pairing-address <addr> --recipe-json` exists for the `orca-server`
  path (`src/cli/specs/serve.ts`); keep it in mind for M3/M4 if a standalone server build ever ships.

## Remote hosts and Tailscale

- Orca's docs recommend Tailscale for remote servers (`docs/site/content/docs/remote-servers.mdx`). Host
  kinds: `src/shared/remote-runtime/host-catalog/runtime-environment-host-kind.ts` (`network`, `ssh`, `wsl`).
- Remote hosts use their own home, PATH and credentials; agent CLI logins on the laptop do not carry over
  (`remote-servers.mdx:30`). This is one reason agents stay local in this project (D1).
- On Linux the Orca CLI is `orca-ide`, not `orca` (GNOME screen reader owns `orca`).

## Notebook kernels

- Orca runs `.ipynb` kernels only on the local machine (`src/main/notebook/notebook-kernel.ts`,
  `src/renderer/src/components/editor/notebook/kernel/ipynb-execution-host.ts` reports remote workspaces as
  `'remote'` and starts no kernel). Running a Colab kernel from Orca needs a core change (M5).

## Local environment of the project owner (for test plans)

- macOS, Orca 1.4.254 at `/Applications/Orca.app`, CLI at `/Applications/Orca.app/Contents/Resources/bin/orca`.
- Node v22 on PATH, Tailscale CLI at `/usr/local/bin/tailscale`, signed in to tailnet `fhq`.
- GitHub account `vzxxbacq`; this repo is public so Colab can open the notebook via the `github/` URL.
