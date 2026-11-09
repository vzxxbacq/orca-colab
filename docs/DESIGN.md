# Design

## Goal

Make a Google Colab runtime usable as an Orca remote host, so a workspace created in Orca lives on
Colab's machine and every terminal and agent Orca launches runs there, next to the GPU. "Maximum use of
Colab compute" means: Orca's own server (orcad) runs on the Colab VM and the local app is only the UI.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Integrate as a **VM recipe** (`contributes.vmRecipes`), not as a custom host kind. | Orca already turns a recipe result into a managed remote host: SSH connect, orcad deploy, terminals, ports, agents. No core changes needed. |
| D2 | Return an **`ssh` connection**, not `orca-server`. | orcad is not downloadable on its own; Orca uploads it from the local app over SSH. With `ssh`, Orca owns orcad's lifecycle and upgrades. |
| D3 | Reach Colab over **Tailscale** with a plain **`sshd`** inside Colab (not Tailscale SSH). | Colab allows no inbound connections; Tailscale in userspace mode forwards inbound tailnet traffic to local ports. Tailscale SSH's default ACL is `check` mode, which blocks non-interactive SSH clients. |
| D4 | The only thing pasted into Colab is the **SSH public key line**; its comment carries the host name `orca-colab-<id>`. | One paste, no secrets. The recipe puts that line on the clipboard and opens Colab, so the user only presses paste and run. |
| D5 | Tailscale login inside Colab is **interactive browser login** (`tailscale up` prints a URL). | Avoids a second paste (auth key). Devices accumulate in the tailnet; D10 handles cleanup later. |
| D6 | Repo gets to Colab by **`git push` from the local machine over the new SSH link**, then the recipe reports `checkoutMode: provisioned-root`. | Works for private repos without putting any Git credential on Colab. The pushed commit is `ORCA_REPO_REF_HEAD`, so Orca's provisioned-root verification matches. |
| D7 | Recipe commands are `npx -y github:vzxxbacq/orca-colab#<tag> <mode>`. | Recipes get no plugin-root path or env var; `cwd` is the user's repo and the shell is OS-native. npx on a pinned tag is the one cross-platform, zero-install way to reach our code. |
| D8 | **No Google OAuth in milestone 1.** The user's existing browser session is the login. | Consumer Colab has no runtime API; OAuth buys nothing until Drive (M3) or Colab Enterprise (M4). |
| D9 | `suspend` is a no-op that succeeds; `resume` only re-checks reachability. | Colab cannot pause a VM. A dead runtime must be destroyed and recreated; the error text says so. |
| D10 | `destroy` best-effort runs `google.colab.runtime.unassign()` over SSH, then deletes local state. Tailscale device removal is deferred (needs an API key). | Frees the Colab quota promptly without extra credentials. |

## Components

### 1. Recipe (`recipes/colab-gpu.json`)

```json
{
  "schemaVersion": 1,
  "id": "colab-gpu",
  "name": "Google Colab (GPU)",
  "description": "Runs this workspace on a Google Colab GPU runtime reached over Tailscale.",
  "checkoutMode": "provisioned-root",
  "create":  "npx -y github:vzxxbacq/orca-colab#v0.1.0 create",
  "suspend": "npx -y github:vzxxbacq/orca-colab#v0.1.0 suspend",
  "resume":  "npx -y github:vzxxbacq/orca-colab#v0.1.0 resume",
  "destroy": "npx -y github:vzxxbacq/orca-colab#v0.1.0 destroy",
  "timeoutSeconds": { "create": 900, "resume": 120, "destroy": 120 }
}
```

The tag is bumped on every release together with `version` in `orca-plugin.json`. During local
development the recipe may point at `node /abs/path/bin/orca-colab.mjs` but that never ships.

### 2. Recipe CLI (`bin/orca-colab.mjs` + `bin/lib/*.mjs`)

Plain Node ≥ 20, no dependencies, `package.json` with `"bin": { "orca-colab": "bin/orca-colab.mjs" }`.
State lives in `~/.orca-colab/<ORCA_VM_INSTANCE_ID>/` (`os.homedir()`, never `$HOME`):

```
id_ed25519, id_ed25519.pub      key pair, comment "orca-colab-<id>"
state.json                      { id, hostname, ip, projectRoot, createdAt, repoUrl }
```

`create` flow, with stderr progress lines prefixed `[colab]`:

1. `doctor` checks: `tailscale` CLI reachable (PATH, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
   then `C:\Program Files\Tailscale\tailscale.exe`), `tailscale status --json` has `BackendState == "Running"`,
   `ssh-keygen`, `git`. Any failure exits 1 with one actionable line.
2. `id` = 6 lowercase base32 chars. `ssh-keygen -t ed25519 -N "" -C orca-colab-<id>`.
3. Clipboard: `pbcopy` / `wl-copy` or `xclip -selection clipboard` / `clip.exe`. If none works, print the
   line to stderr in a clearly marked block and continue.
4. Open `https://colab.research.google.com/github/vzxxbacq/orca-colab/blob/main/notebooks/orca-colab-bootstrap.ipynb`
   with `open` / `xdg-open` / `cmd /c start "" <url>`.
5. Poll `tailscale status --json` every 3 s until a peer has `HostName == "orca-colab-<id>"` and `Online`.
   Take `TailscaleIPs[0]` (IPv4 preferred).
6. Probe TCP 22 on that IP until it answers with an `SSH-` banner.
7. Push the repo: `ssh root@ip 'git init -q <root> && git -C <root> config receive.denyCurrentBranch updateInstead'`,
   then `git push -q ssh://root@ip<root> <ORCA_REPO_REF_HEAD>:refs/heads/<branch>`, then
   `ssh root@ip 'git -C <root> checkout -q <branch> && git -C <root> remote add origin <ORCA_REPO_URL>'`.
   `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=<state>/known_hosts -o BatchMode=yes"`.
   `<root>` = `/content/orca/<repo basename>`; `<branch>` = `ORCA_REPO_BRANCH` or `ORCA_REPO_REF` or `main`.
8. Write `state.json`, then print the result as the **last stdout line**:

```json
{"schemaVersion":2,"checkoutMode":"provisioned-root",
 "connection":{"type":"ssh","projectRoot":"/content/orca/<repo>",
   "target":{"label":"Colab orca-colab-<id>","host":"100.x.y.z","port":22,"username":"root",
             "identityFile":"/Users/me/.orca-colab/<instance>/id_ed25519","identitiesOnly":true}},
 "userData":{"id":"<id>","hostname":"orca-colab-<id>"}}
```

Timeouts: Orca kills the process group at `timeoutSeconds.create`; the CLI also stops itself 30 s
earlier with a message naming the step it was waiting on. On abort, keep the state dir only if
`state.json` was written.

`resume`: read `state.json`, re-run steps 5–6 with a 90 s budget, print the same JSON. On failure exit 1
with "Colab runtime is gone. Destroy this workspace's environment and create it again."
`suspend`: print a note to stderr, exit 0.
`destroy`: `ssh root@ip "python3 -c 'from google.colab import runtime; runtime.unassign()'"` with a 20 s
timeout, ignore failures, remove the state dir, exit 0.

### 3. Bootstrap notebook (`notebooks/orca-colab-bootstrap.ipynb`)

One markdown cell (what this does, pick a GPU runtime first) and one form cell:

```python
#@title Connect this runtime to Orca
SSH_PUBLIC_KEY = ""  #@param {type:"string"}
```

followed by a code cell that, as root (Colab default):

1. Parses the hostname from the key comment (`orca-colab-<id>`), fails loudly if the format is wrong.
2. `apt-get install -y openssh-server`; writes `/root/.ssh/authorized_keys` (0600); sets
   `PermitRootLogin prohibit-password`, `PasswordAuthentication no`; starts `sshd`.
3. Installs Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh`), starts
   `tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --state=/root/tailscaled.state`
   in the background, then `tailscale up --hostname <hostname> --accept-dns=false --accept-routes=false`
   and streams its output so the login URL is visible.
4. Prints `nvidia-smi -L` (or "no GPU: Runtime → Change runtime type"), the tailnet IP and "Orca can
   connect now. Keep this tab open."
5. Optionally starts a keepalive loop cell (separate cell, documented, not auto-run).

No outputs committed. Python 3, no extra pip packages.

### 4. Worker (`worker/main.mjs`) and panel (`panel/index.html`)

The worker exists for status and help, not for provisioning. Because the manifest declares a status bar
item together with `main`, Orca keeps the worker running while the plugin is enabled.

- Status bar item `colab-runtimes`: text `Colab: n` where n = state dirs under `~/.orca-colab`, hidden
  when 0; refreshed every 30 s and on `fs.watch` of that dir. Pressing it opens the panel command.
- Panel requests (`orca.panels.handle`): `colab.list` → runtimes from state files; `colab.doctor` → same
  checks as the CLI (import the same module); `colab.openNotebook` is not needed, the panel uses
  `orca.shell.openExternal` directly on click.
- Panel: prerequisites with ✓/✗, list of runtimes (id, ip, project root, age), a "Open bootstrap notebook"
  button, and the three-step instructions. Inline CSS/JS only, Orca frame tokens for colours
  (`--orca-background`, `--orca-foreground`, `--orca-muted-foreground`, `--orca-border`).

### 5. Manifest (`orca-plugin.json`)

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "colab",
  "name": "Google Colab",
  "version": "0.1.0",
  "description": "Run Orca workspaces and agents on a Google Colab GPU runtime reached over Tailscale.",
  "repository": "https://github.com/vzxxbacq/orca-colab",
  "license": "MIT",
  "engines": { "orca": ">=1.4.248" },
  "pluginApi": 1,
  "main": "worker/main.mjs",
  "contributes": {
    "vmRecipes": [{ "path": "recipes/colab-gpu.json" }],
    "panels": [{ "id": "colab", "title": "Colab", "icon": "cloud", "entry": "panel/index.html" }],
    "commands": [{ "id": "colab.showPanel", "title": "Colab: Show runtimes" }],
    "statusBarItems": [{ "id": "colab-runtimes", "icon": "cloud", "text": "Colab", "command": "colab.showPanel" }]
  },
  "capabilities": [{ "kind": "notifications:show" }, { "kind": "storage:own" }]
}
```

Install identity will be `vzxxbacq.colab` (publisher derived from the repository owner; ids starting
with `orca-` are reserved). The plugin needs no `secrets:own` in M1.

## Milestones

- **M1 — Works end to end on one machine (macOS), manual Colab step.** Recipe CLI, notebook, manifest,
  validation passing, documented happy path. Exit: a workspace created from the recipe opens on Colab and
  `nvidia-smi` works in an Orca terminal.
- **M2 — Robustness and platforms.** Linux and Windows paths of the CLI, abort/timeout behaviour,
  idle-timeout warnings in the panel, destroy via `runtime.unassign()`, release tagging and the
  `orca-plugin` GitHub topic.
- **M3 — Zero-paste via Drive.** Optional Google OAuth (PKCE loopback in the recipe CLI, token in the OS
  keychain via the worker's `secrets.set`): the CLI copies the notebook into the user's Drive with the key
  prefilled and polls the saved notebook's outputs through the Drive API, removing the paste.
- **M4 — Colab Enterprise.** `notebookRuntimeTemplates` / `notebookExecutionJobs` on Vertex AI for a fully
  automatic, GPU-selectable path with no browser interaction.
- **M5 — Remote notebook kernel (Orca core change).** Let `.ipynb` files in a Colab workspace execute on
  the Colab kernel; today Orca runs kernels only locally.

## Known limits

- Free/Pro Colab disconnects idle sessions (about 90 min without browser activity on free tier) and caps
  session length. The Colab tab must stay open. The panel will surface this (M2).
- The GPU type is chosen in Colab's UI, not by the recipe (until M4).
- Each Colab session adds a device to the tailnet until removed manually (until a Tailscale API key is
  optionally configured).
- Tailscale must be installed and signed in on the local machine.
