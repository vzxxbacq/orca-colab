export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_TIMEOUT = 2;
export const EXIT_ABORTED = 3;
export const EXIT_ZOMBIE = 4;

export class CliError extends Error {
  constructor(message, { exitCode = EXIT_ERROR, payload = null } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.payload = payload;
  }
}

export function log(message, stderr = process.stderr) {
  stderr.write(`[colab] ${message}\n`);
}

export function logError(message, stderr = process.stderr) {
  stderr.write(`[colab] error: ${message}\n`);
}

export function writeJson(payload, stdout = process.stdout) {
  stdout.write(`${JSON.stringify(payload)}\n`);
}
