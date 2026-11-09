import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CliError, EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { copyToClipboard } from "../lib/clipboard.mjs";
import {
  getColabPaths,
  isValidAuthKey,
  readConfig,
  resolveAccount,
  writeConfig,
} from "../lib/colab-home.mjs";
import { BOOTSTRAP_NOTEBOOK_COLAB_URL, openUrl } from "../lib/open-url.mjs";
import { ensureSshKeypair } from "../lib/ssh-keypair.mjs";
import { getTailscaleStatus } from "../lib/tailscale-cli.mjs";

function isPublicGithubNotebookUrl(url) {
  if (!url) return false;
  return (
    url === BOOTSTRAP_NOTEBOOK_COLAB_URL ||
    url.includes("colab.research.google.com/github/")
  );
}

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    env,
    homeDir,
    promptLine = null,
    isTTY = Boolean(process.stdin.isTTY),
    runKeygen = null,
    openBrowser = openUrl,
    copyClipboard = copyToClipboard,
    now = () => new Date().toISOString(),
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "auth-key": { type: "string" },
        "login-server": { type: "string" },
        "notebook-url": { type: "string" },
        account: { type: "string" },
        "non-interactive": { type: "boolean", default: false },
        "no-open": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const interactive = !opts["non-interactive"] && (Boolean(promptLine) || isTTY);
  const existing = readConfig(homeDir);
  const paths = getColabPaths(homeDir);
  const keypair = ensureSshKeypair(homeDir, { runKeygen });

  let rl = null;
  const ask = async (question) => {
    if (promptLine) {
      return (await promptLine(question)).trim();
    }
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: stderr });
    }
    const answer = await rl.question(`[colab] ${question}`);
    return answer.trim();
  };

  try {
    let detectedLoginServer = null;
    if (opts["login-server"] === undefined && !existing?.loginServer) {
      try {
        const ts = getTailscaleStatus({ env });
        detectedLoginServer = ts?.detectedLoginServer ?? null;
      } catch {
        // Ignore if tailscale status cannot be queried during setup.
      }
    }

    let loginServer =
      opts["login-server"] !== undefined
        ? opts["login-server"].trim()
        : (existing?.loginServer ?? detectedLoginServer ?? "");

    if (
      opts["login-server"] === undefined &&
      interactive &&
      (existing?.loginServer || detectedLoginServer)
    ) {
      const defSrv = existing?.loginServer || detectedLoginServer;
      const enteredSrv = await ask(
        `Tailscale/Headscale login server [${defSrv}]: `,
      );
      loginServer = enteredSrv || defSrv;
    }

    let authKey = opts["auth-key"]?.trim() ?? "";
    if (!authKey && interactive) {
      const hint = existing?.authKey ? " [Enter to keep existing]" : "";
      const entered = await ask(
        `Paste Tailscale/Headscale auth key (reusable, ephemeral)${hint}: `,
      );
      authKey = entered || existing?.authKey || "";
    } else if (!authKey && existing?.authKey) {
      authKey = existing.authKey;
    }

    if (!isValidAuthKey(authKey, loginServer)) {
      throw new CliError(
        loginServer
          ? "Tailscale/Headscale pre-auth key is required (at least 16 non-whitespace chars; pass --auth-key or run interactively)."
          : "Tailscale auth key is required and must start with 'tskey-' (or pass --login-server for Headscale).",
      );
    }

    const accountLabel = opts.account?.trim() || existing?.defaultAccount || "default";
    const existingAccount = existing ? resolveAccount(existing, accountLabel) : null;

    log(`SSH public key (${keypair.publicKeyPath}):`, stderr);
    log(`  SSH_PUBLIC_KEY = "${keypair.publicKey}"`, stderr);
    if (loginServer) {
      log(`  TAILSCALE_LOGIN_SERVER = "${loginServer}"`, stderr);
    }
    log(`Bootstrap notebook: ${BOOTSTRAP_NOTEBOOK_COLAB_URL}`, stderr);

    const pasteLine = loginServer
      ? `${authKey} ${loginServer} ${keypair.publicKey}`
      : `${authKey} ${keypair.publicKey}`;
    const clip = copyClipboard(pasteLine, { env });
    if (clip.copied) {
      log(
        loginServer
          ? "Copied '<authkey> <loginServer> <pubkey>' to clipboard for the Colab PASTE field."
          : "Copied '<authkey> <pubkey>' to clipboard for the Colab PASTE field.",
        stderr,
      );
    }

    let notebookUrl =
      opts["notebook-url"] !== undefined
        ? opts["notebook-url"].trim()
        : (existingAccount?.notebookUrl ?? "");

    if (opts["notebook-url"] === undefined && interactive) {
      if (!opts["no-open"]) {
        const shouldOpen = await ask(
          "Open the bootstrap notebook now to 'Save a copy in Drive'? [Y/n]: ",
        );
        if (!shouldOpen || /^y(es)?$/i.test(shouldOpen)) {
          openBrowser(BOOTSTRAP_NOTEBOOK_COLAB_URL, { env });
        }
      }
      const urlHint =
        notebookUrl && !isPublicGithubNotebookUrl(notebookUrl)
          ? ` [Enter to keep ${notebookUrl}]`
          : " [optional, Enter to skip]";
      const enteredUrl = await ask(`Paste your Drive notebook copy URL${urlHint}: `);
      if (enteredUrl) {
        notebookUrl = enteredUrl;
      }
    }

    if (isPublicGithubNotebookUrl(notebookUrl)) {
      log(
        "Note: ignoring public GitHub notebook URL (not a personal Google Drive '/drive/' copy); 'up' will open the bootstrap notebook and copy PASTE credentials to your clipboard.",
        stderr,
      );
      notebookUrl = "";
    }

    const accounts = existing?.accounts ? [...existing.accounts] : [{ label: "default" }];
    const idx = accounts.findIndex((a) => a.label === accountLabel);
    const updatedAccount = notebookUrl
      ? { label: accountLabel, notebookUrl }
      : { label: accountLabel };
    if (idx >= 0) {
      accounts[idx] = updatedAccount;
    } else {
      accounts.push(updatedAccount);
    }

    const authKeyChanged = authKey !== existing?.authKey;
    const authKeyCreatedAt =
      authKeyChanged || !existing?.authKeyCreatedAt
        ? now()
        : existing.authKeyCreatedAt;

    const saved = writeConfig(
      {
        authKey,
        authKeyCreatedAt,
        loginServer: loginServer || undefined,
        tags: existing?.tags ?? ["tag:orca-colab"],
        remoteRootBase: existing?.remoteRootBase ?? "/content/orca",
        accounts,
        defaultAccount: existing?.defaultAccount ?? accountLabel,
      },
      homeDir,
    );

    const activeAccount = resolveAccount(saved, accountLabel);
    log(`Saved config to ${paths.configPath} (0600).`, stderr);

    if (json) {
      writeJson(
        {
          ok: true,
          configPath: paths.configPath,
          publicKeyPath: keypair.publicKeyPath,
          publicKey: keypair.publicKey,
          sshKeyCreated: keypair.created,
          account: activeAccount.label,
          notebookUrl: activeAccount.notebookUrl ?? null,
          loginServer: saved.loginServer ?? null,
          bootstrapNotebookUrl: BOOTSTRAP_NOTEBOOK_COLAB_URL,
        },
        stdout,
      );
    }

    return EXIT_OK;
  } finally {
    if (rl) {
      rl.close();
    }
  }
}
