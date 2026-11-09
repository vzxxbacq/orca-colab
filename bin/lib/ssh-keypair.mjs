import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import { ensureColabHome } from "./colab-home.mjs";

export function ensureSshKeypair(
  homeDir = os.homedir(),
  { runKeygen = null } = {},
) {
  const { privateKeyPath, publicKeyPath } = ensureColabHome(homeDir);
  const hasPrivate = existsSync(privateKeyPath);
  const hasPublic = existsSync(publicKeyPath);

  let created = false;
  if (!hasPrivate || !hasPublic) {
    if (hasPrivate) {
      try {
        unlinkSync(privateKeyPath);
      } catch {
        // Ignore if already absent.
      }
    }
    if (hasPublic) {
      try {
        unlinkSync(publicKeyPath);
      } catch {
        // Ignore if already absent.
      }
    }

    const args = [
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "orca-colab",
      "-f",
      privateKeyPath,
      "-q",
    ];
    if (runKeygen) {
      runKeygen("ssh-keygen", args, { privateKeyPath, publicKeyPath });
    } else {
      execFileSync("ssh-keygen", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    chmodSync(privateKeyPath, 0o600);
    chmodSync(publicKeyPath, 0o644);
    created = true;
  }

  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  return {
    created,
    privateKeyPath,
    publicKeyPath,
    publicKey,
  };
}
