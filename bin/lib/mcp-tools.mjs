import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execCommandOverTty } from "./colab-api-client.mjs";
import { listOAuthAccounts, remoteBrowserSignInNote } from "./colab-oauth.mjs";
import { openUrlInSystemBrowser } from "./open-url.mjs";
import { liveForwards } from "./port-forward.mjs";
import { listSessions } from "./session-store.mjs";
import { isProcessAlive, listTasks, readTask, readTaskLog, taskLogPath } from "./task-store.mjs";

const CLI_ENTRY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "orca-colab.mjs");

const SIGN_IN_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT_CHARS = 40_000;
const LOG_CHUNK_BYTES = 65_536;
// Codex gives a tool call 60 s unless the user raises tool_timeout_sec, so waits default to less.
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 600;

const REMOTE_BROWSER_NOTE = remoteBrowserSignInNote("give it to you for the auth_redirect tool");

export const MCP_INSTRUCTIONS = `Colab GPU: use a Google Colab runtime (T4, L4, A100 and other GPUs, or CPU) as a remote compute backend. The workspace, the agent and the Google credentials stay on this machine; the runtime is a disposable box reached over public HTTPS. Reach for it when a task needs a GPU or CUDA, training, fine-tuning or inference too heavy for this machine, or when the user mentions Colab.

Order of work
1. doctor: needs ok true. Read policy.allowedGpus and policy.maxConcurrentSessions: the owner's guardrails, set in the Colab GPU panel in Orca together with the monthly budget; they are not yours to change. If checks.oauth.ok is false, sign in (below).
2. status: reuse a runtime that is already reachable instead of starting another. It lists every runtime of the signed-in Google account, also ones started from another machine (startedHere false, origin names the machine and agent; origin null is a runtime of unknown origin, for example a notebook the owner has open in Colab). All tools work on any of them by session name, and jobs submitted elsewhere appear in job_list.
3. credits: approximate balance (estimatedBalanceCu), burn rate and monthly budget. Every figure is an estimate. The monthly budget is a hard limit: once estimatedMonthlyUsedCu reaches budgetCu, up refuses to start a new runtime (reusing a running one still works). If the balance is close to zero, ask the owner before up.
4. up with an allowed GPU: T4 for inference and debugging, L4 or A100 for training, CPU for checks that need no GPU. It returns when the runtime is ready, and the runtime bills compute units until down. Tell the owner the rate (estimatedCuPerHour) before long work.
5. sync the workspace (pass workspace_path), then job_submit for anything longer than a minute (it returns a job id at once; follow with job_wait or job_logs) or run for short commands.
6. pull results as soon as they exist: runtimes die (about 90 minutes idle on the free tier, 12 hours at most) and nothing on them persists.
7. down as soon as the GPU work is finished, for the runtimes you started. A runtime another machine is using is left alone (reason "in-use-elsewhere"); tell the owner who is using it and pass force only when they say so.

Sign-in
Call auth_login. It opens Google's consent page in the owner's browser on this machine and returns the URL; show the owner the URL in case the browser did not open. Tell them to tick the Colab permission ("Read, write and delete your Colab resources", or Select all): it starts unticked and sign-in fails without it. Then call auth_wait until state is "signed_in". Always tell the owner this too, because you cannot know where their browser runs: ${REMOTE_BROWSER_NOTE}

Hygiene
- sync is for code (256 MB cap; honours .gitignore and .colabignore). Have the runtime download datasets and weights itself.
- Commands on one runtime may run at the same time (a run while a job runs, several jobs); they share its GPU and memory.
- To query a service on the runtime once, use run, for example "curl -s localhost:8000/metrics". To make an HTTP service on the runtime reachable from this machine, use forward_start: it listens on 127.0.0.1 here and forwards each request (about half a second on top, no streaming or WebSockets). Never run a tunnel (cloudflared, ngrok, ssh -R) on the runtime: Colab takes such runtimes away. A public tunnel, if the owner wants one, runs on this machine in front of the forward.
- Pass secrets with env only when the owner agrees, and never write them to files on the runtime.
- The owner sees every runtime, run and job live in the Colab GPU panel in Orca, and may stop them, switch account or change the guardrails there at any time; your next call sees the result.
- Results carry ok; failures carry error and often hint. Error texts name CLI commands: "orca-colab auth login" is the auth_login tool, "orca-colab job logs" is job_logs, and so on.

Failures
- up with step "prerequisites": not signed in, or the Colab permission was not ticked. Call auth_login.
- up with step "policy": pick a GPU from allowedGpus; or the runtime cap is reached, so reuse a runtime or stop one.
- up with step "budget" (code "BUDGET_REACHED"): the owner's monthly budget is used up (budgetCu, estimatedMonthlyUsedCu; estimates). Do not retry and do not change the budget yourself. Tell the owner the figures; they can raise it under Guardrails & CU in the Colab GPU panel, or tell you a new number for credits_budget. A runtime that is already running stays usable.
- up with code "PROVISIONING_IN_PROGRESS": another agent is creating a runtime. Wait retryAfterSeconds and call up again.
- up failing at another step: Colab refused (quota, GPU not available). Read error; try another allowed GPU or wait. "no <GPU> runtime available right now" and "still allocating ... withdrawn" mean Colab has no free machine of that type: nothing was started; offer to retry in a few minutes or to use another allowed GPU.
- run, sync or pull failing with a WebSocket or HTTP error: the runtime died or was recycled. Call status, then offer down, up and sync again.
- "no Colab runtime proxy": the session comes from an old version. Call down for that session, then up.
- down with reason "api-delete-failed": the runtime may still be running and billing. Call auth_login and down again, or ask the owner to delete it at colab.research.google.com (Runtime > Disconnect and delete runtime).`;

const SIGN_IN_HINT =
  "Not signed in to Google. Call the auth_login tool: it opens Google's consent page in the owner's browser and returns the URL. Ask the owner to tick the Colab permission (it starts unticked), then call auth_wait.";

const SESSION_PROP = {
  type: "string",
  description: "Session name from status. Default: the only session, or the newest.",
};
const ACCOUNT_PROP = {
  type: "string",
  description: "Account label or email from auth_list. Default: the default account.",
};
const WORKSPACE_PROP = {
  type: "string",
  description:
    "Absolute path of the workspace directory on this machine. This server does not run in your working directory, so pass it unless the client exposes exactly one MCP root.",
};
const COMMAND_PROPS = {
  command: {
    type: "string",
    description: "Shell command line to run on the runtime, e.g. \"python3 train.py --epochs 3\". Give this or argv.",
  },
  argv: {
    type: "array",
    items: { type: "string" },
    description: "The command as separate arguments, each passed literally (no shell expansion). Give this or command.",
  },
  cwd: {
    type: "string",
    description: "Directory on the runtime. Default: where the last sync unpacked (remoteRoot).",
  },
  env: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Environment variables for the command. Secrets only with the owner's agreement.",
  },
};
const WAIT_PROP = (what) => ({
  type: "integer",
  minimum: 1,
  maximum: MAX_WAIT_SECONDS,
  description: `Seconds to wait for ${what}. Default ${DEFAULT_WAIT_SECONDS}; stay under your client's tool timeout.`,
});

const schema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const READ_ONLY = { readOnlyHint: true };
const DESTRUCTIVE = { destructiveHint: true };

const TOOL_SPECS = [
  {
    name: "doctor",
    title: "Check prerequisites and guardrails",
    description:
      "Checks Node, git, tar and the Google sign-in, and returns the owner's guardrails in policy (allowedGpus, maxConcurrentSessions). Call it first. mode is \"direct-api\" once signed in; when checks.oauth.ok is false, call auth_login.",
    inputSchema: schema(),
    annotations: READ_ONLY,
  },
  {
    name: "auth_status",
    title: "Google sign-in status",
    description:
      "Whether a Google account is signed in, with its email, Colab tier, approximate balance and the number of runtimes assigned at Colab. Also reports a sign-in started with auth_login that is still waiting (signIn).",
    inputSchema: schema({ account: ACCOUNT_PROP }),
    annotations: READ_ONLY,
  },
  {
    name: "auth_login",
    title: "Sign in with Google",
    description:
      "Starts Google sign-in for the owner in one step: opens the consent page in the default browser on this machine, and returns at once with state \"waiting_for_owner\" and the url (show it to the owner in case the browser did not open). The owner must tick the Colab permission (\"Read, write and delete your Colab resources\", or Select all); it starts unticked. Then call auth_wait. Always pass on the note about a browser on another machine that comes back in next. The page is valid for 5 minutes; calling again while one is waiting returns that same sign-in (alreadyPending true, with a note saying whether its page was opened), not a new one. Use add to connect another account next to the existing ones.",
    inputSchema: schema({
      account: { type: "string", description: "Label to store the sign-in under. Default: the default account." },
      add: { type: "boolean", description: "Add another Google account instead of replacing the default one." },
      open_browser: {
        type: "boolean",
        description: "Open the browser on this machine (default true). False only returns the url, for a browser elsewhere.",
      },
      wait_seconds: {
        type: "integer",
        minimum: 0,
        maximum: 280,
        description: "Also wait this long for the owner to finish before returning (default 0: return the url at once).",
      },
    }),
  },
  {
    name: "auth_wait",
    title: "Wait for the Google sign-in to finish",
    description:
      "Waits for the sign-in started by auth_login. state is \"signed_in\" (with account, email, tier and approximate balance), \"failed\" (with error; usually the Colab permission was not ticked or the page expired: call auth_login again), or still \"waiting_for_owner\" when the wait ran out (call auth_wait again).",
    inputSchema: schema({ timeout_seconds: WAIT_PROP("the owner to finish") }),
    annotations: READ_ONLY,
  },
  {
    name: "auth_redirect",
    title: "Finish a sign-in from a browser on another machine",
    description:
      "When the owner's browser is not on the machine this server runs on, the sign-in ends on an http://127.0.0.1:PORT/... page that does not load there, which is expected: pass the full http://127.0.0.1:PORT/?state=...&code=... address from the browser's address bar. It is a one-time key to the owner's Colab; send it nowhere else. Then call auth_wait.",
    inputSchema: schema({ url: { type: "string", description: "The http://127.0.0.1:... address the browser was redirected to." } }, ["url"]),
  },
  {
    name: "auth_list",
    title: "List signed-in Google accounts",
    description:
      "Every signed-in Google account with its approximate balance and assigned runtimes, and which one is the default. Each account is its own pool of compute units.",
    inputSchema: schema(),
    annotations: READ_ONLY,
  },
  {
    name: "auth_switch",
    title: "Switch the default Google account",
    description:
      "Makes another signed-in account the default for up and credits. The owner can switch in the panel too; only switch when they ask or when the default account has no balance and they agreed.",
    inputSchema: schema({ account: { type: "string", description: "Account label or email from auth_list." } }, ["account"]),
  },
  {
    name: "auth_logout",
    title: "Sign out of Google",
    description:
      "Revokes the Google token and removes it from this machine. Only when the owner asks. Stop runtimes with down first: without a sign-in they cannot be released from here.",
    inputSchema: schema({
      account: ACCOUNT_PROP,
      all: { type: "boolean", description: "Sign out every account." },
    }),
    annotations: DESTRUCTIVE,
  },
  {
    name: "status",
    title: "List Colab runtimes",
    description:
      "Lists the runtimes of the Google account signed in on this machine, including ones started from other machines (asked from Colab on every call; local: true skips that): name, gpu, rateKey, cuPerHour, account, remoteRoot, ageSeconds, state and reachable. startedHere false means another machine started it; origin then names that machine and agent, or is null for a runtime without an orca-colab record (unknown origin: an older version, or a notebook the owner has open in Colab; leave it alone unless the owner says otherwise). Every command works on any listed runtime by its name. Same as the CLI's status and ls. forwards lists active port forwards (listen address, remote port, pid). A session with reachable false is a zombie: call down for it. recentlyEnded lists the sessions that ended in the last 24 hours with endedAt, cause (user, idle-watchdog, colab-died) and a reason, so a session that is missing is explained: tell the owner the cause instead of guessing.",
    inputSchema: schema({
      local: { type: "boolean", description: "Only what this machine already knows; no call to Colab." },
    }),
    annotations: READ_ONLY,
  },
  {
    name: "up",
    title: "Start or reuse a Colab runtime",
    description:
      "Assigns a Colab runtime (or reuses the one already assigned), queries its GPU and records the session. Usually takes under a minute, up to a few minutes while Colab is allocating a scarce GPU; if your client times out first the call still finishes, so call status. The runtime bills compute units (estimatedCuPerHour) until down. The owner's guardrails apply: gpu must be in policy.allowedGpus and new is refused beyond policy.maxConcurrentSessions (step \"policy\"), and a new runtime is refused once the estimated use this month has reached the monthly budget (step \"budget\", with budgetCu and estimatedMonthlyUsedCu; only the owner raises it). step \"prerequisites\" means sign in with auth_login.",
    inputSchema: schema({
      gpu: {
        type: "string",
        description: "One of policy.allowedGpus from doctor (T4, L4, A100, G4, H100, CPU), or auto: T4 when allowed, else the first allowed GPU. Default auto.",
      },
      name: { type: "string", description: "Session name (stored as orca-colab-<name>)." },
      account: ACCOUNT_PROP,
      high_ram: { type: "boolean", description: "Ask for the high-RAM machine shape." },
      new: {
        type: "boolean",
        description: "Start an additional runtime next to the running ones instead of reusing one.",
      },
      keep: { type: "boolean", description: "Exempt this session from the idle auto-stop. Only when the owner asks." },
    }),
  },
  {
    name: "sync",
    title: "Push the workspace to the runtime",
    description:
      "Packs a local directory with tar (honouring .gitignore and .colabignore, without .git) and unpacks it on the runtime at /content/orca/<basename>, which becomes the session's remoteRoot: the default directory for run and job_submit. For code, not datasets (256 MB cap).",
    inputSchema: schema({
      workspace_path: WORKSPACE_PROP,
      path: {
        type: "string",
        description: "Directory to push, absolute or relative to the workspace. Default: the workspace itself.",
      },
      session: SESSION_PROP,
      to: { type: "string", description: "Directory on the runtime to unpack into instead of /content/orca/<basename>." },
    }),
  },
  {
    name: "run",
    title: "Run a short command on the runtime",
    description:
      "Runs a command on the runtime and returns { ok, exitCode, stdout } when it exits. For short commands (installs, nvidia-smi, quick scripts, curl against a service on the runtime). A command still running after timeout_seconds keeps running as a task: the result then has timedOut true and taskId; follow it with job_wait or job_logs, stop it with job_stop. Use job_submit for training and anything else that takes minutes. The owner sees the run and its output in the panel. An interactive shell and tmux attach need a terminal; read a detached tmux session with \"tmux capture-pane -p -t NAME\".",
    inputSchema: schema({
      ...COMMAND_PROPS,
      session: SESSION_PROP,
      detach: {
        type: "string",
        description: "Start the command in a detached tmux session of this name on the runtime and return at once.",
      },
      timeout_seconds: WAIT_PROP("the command to exit"),
    }),
  },
  {
    name: "job_submit",
    title: "Submit a long-running job",
    description:
      "Starts a command on the runtime as a managed job and returns at once with task.id. It runs detached on the runtime with its record and complete output there, which the owner watches live in the panel (on any machine signed in to the account); read it with job_logs, wait for the end with job_wait, stop it with job_stop. The job keeps running if this server, your session or this machine goes away. With sync true the workspace is pushed first, inside the job.",
    inputSchema: schema({
      ...COMMAND_PROPS,
      name: { type: "string", description: "Short title shown in the panel." },
      session: SESSION_PROP,
      sync: { type: "boolean", description: "Push the workspace (workspace_path) to the runtime before the command starts." },
      workspace_path: WORKSPACE_PROP,
    }),
  },
  {
    name: "job_list",
    title: "List jobs and runs",
    description:
      "Lists jobs and runs, newest first, with status (running, succeeded, failed, stopped), exitCode and session. Includes those started from the panel or the CLI.",
    inputSchema: schema({
      session: { type: "string", description: "Only tasks of this session." },
      status: { type: "string", enum: ["running", "succeeded", "failed", "stopped"], description: "Only tasks in this state." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Newest N tasks (default 30)." },
    }),
    annotations: READ_ONLY,
  },
  {
    name: "job_logs",
    title: "Read a job's output",
    description:
      "Returns the output of a job or run with its current status. Without since_bytes: the last tail lines. To follow a job, pass the nextSinceBytes of the previous call as since_bytes and only the new output comes back.",
    inputSchema: schema(
      {
        id: { type: "string", description: "Task id from job_submit, run or job_list." },
        tail: { type: "integer", minimum: 1, maximum: 2000, description: "Number of lines from the end (default 200)." },
        since_bytes: { type: "integer", minimum: 0, description: "Return output from this byte offset on." },
      },
      ["id"],
    ),
    annotations: READ_ONLY,
  },
  {
    name: "job_wait",
    title: "Wait for a job to finish",
    description:
      "Waits until the job or run leaves the running state, or until timeout_seconds. Returns finished, the task (status, exitCode) and the last lines of output. When finished is false, call it again.",
    inputSchema: schema(
      {
        id: { type: "string", description: "Task id from job_submit, run or job_list." },
        timeout_seconds: WAIT_PROP("the job to finish"),
        tail: { type: "integer", minimum: 1, maximum: 2000, description: "Lines of output to return (default 50)." },
      },
      ["id"],
    ),
    annotations: READ_ONLY,
  },
  {
    name: "job_stop",
    title: "Stop a job",
    description: "Terminates a running job or run on the runtime and marks it stopped. The runtime itself keeps running.",
    inputSchema: schema({ id: { type: "string", description: "Task id." } }, ["id"]),
    annotations: DESTRUCTIVE,
  },
  {
    name: "pull",
    title: "Fetch results from the runtime",
    description:
      "Downloads a file or directory from the runtime into <local_dir>/<basename> on this machine over HTTPS; binary files arrive intact. Pull checkpoints and results as soon as they exist: nothing on a runtime persists.",
    inputSchema: schema(
      {
        remote_path: { type: "string", description: "File or directory on the runtime, absolute or relative to remoteRoot." },
        local_dir: { type: "string", description: "Local directory to unpack into, absolute or relative to the workspace." },
        workspace_path: WORKSPACE_PROP,
        session: SESSION_PROP,
      },
      ["remote_path", "local_dir"],
    ),
  },
  {
    name: "down",
    title: "Release a Colab runtime",
    description:
      "Deletes the runtime at Colab so it stops billing, and removes the session. Call it as soon as the GPU work is finished and the results are pulled. Succeeds when the runtime is already gone. reason \"api-delete-failed\" means it may still be running: sign in with auth_login and call down again, or have the owner delete it at colab.research.google.com. reason \"in-use-elsewhere\" means another machine has a command or job running on it right now (inUseBy lists who): it was not released; wait, or ask the owner before passing force. reason \"use-unknown\" means the runtime did not answer, so that could not be checked: try again, and pass force only when the owner says so. Release only runtimes you started unless the owner asks.",
    inputSchema: schema({
      session: SESSION_PROP,
      all: { type: "boolean", description: "Release every session." },
      force: { type: "boolean", description: "Release it even while another machine is using it. Only when the owner asks." },
    }),
    annotations: DESTRUCTIVE,
  },
  {
    name: "forward_start",
    title: "Forward a local HTTP port to the runtime",
    description:
      "Starts a listener on this machine (http://127.0.0.1:<local port> by default) that forwards every HTTP request to a port on the runtime and returns the response: method, path, query, headers, body and status pass through unchanged. Use it to reach an HTTP service running on the runtime (an API, a dashboard) from this machine, or to put a tunnel in front of it here; nothing tunnel-like has to run on Colab. It keeps running in the background after this call, also when this server stops, and keeps the session from being auto-stopped; stop it with forward_stop. Each request costs about half a second on top; responses arrive when complete (no streaming, no WebSockets); bodies up to about 250 MB. status lists active forwards.",
    inputSchema: schema(
      {
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Port the service listens on, on the runtime (127.0.0.1)." },
        listen: {
          type: "string",
          description: "Local address to listen on, as host:port or a port. Default 127.0.0.1:<port>. Bind anything but 127.0.0.1 only when the owner asks.",
        },
        session: SESSION_PROP,
        timeout_seconds: { type: "integer", minimum: 1, maximum: 3600, description: "Longest a single request may take (default 300)." },
      },
      ["port"],
    ),
  },
  {
    name: "forward_stop",
    title: "Stop a port forward",
    description: "Stops a forward started with forward_start or 'orca-colab forward'. Give its pid (from forward_start or status) or its listen address.",
    inputSchema: schema({
      pid: { type: "integer", minimum: 1, description: "pid of the forward." },
      listen: { type: "string", description: "Its local address, e.g. 127.0.0.1:8000." },
    }),
    annotations: DESTRUCTIVE,
  },
  {
    name: "credits",
    title: "Compute-unit balance and budget",
    description:
      "Approximate balance (estimatedBalanceCu), burn rate (estimatedBurnCuPerHour), hours left (estimatedHoursRemaining) and monthly budget use (budgetCu, estimatedMonthlyUsedCu, estimatedBudgetUsedPercent) for an account. At 100 percent up refuses new runtimes. Refreshes from Colab when signed in. Every figure is an estimate; say so when you quote one.",
    inputSchema: schema({ account: ACCOUNT_PROP }),
  },
  {
    name: "credits_calibrate",
    title: "Re-read the balance from Colab",
    description:
      "Fetches the real compute-unit balance from Colab and records it as the new calibration, then returns the same figures as credits. With browser true it reads the balance through Orca's embedded browser instead (needs Orca and a Google login there).",
    inputSchema: schema({
      account: ACCOUNT_PROP,
      browser: { type: "boolean", description: "Read the balance through Orca's embedded browser." },
    }),
  },
  {
    name: "credits_set",
    title: "Enter the balance by hand",
    description:
      "Records a balance the owner read from Colab's Resources pane, for when credits_calibrate cannot reach Colab. Only with a number the owner gave you.",
    inputSchema: schema({ cu: { type: "number", minimum: 0, description: "Balance in compute units." }, account: ACCOUNT_PROP }, ["cu"]),
  },
  {
    name: "credits_budget",
    title: "Set the monthly compute-unit budget",
    description:
      "Sets the owner's monthly budget for an account in compute units; 0 removes it. It is a hard limit: up refuses to start a new runtime once the estimated use this month reaches it. It is the owner's guardrail: change it only when the owner asks, with the number they gave, never to get past a refusal.",
    inputSchema: schema({ cu: { type: "number", minimum: 0, description: "Monthly budget in compute units." }, account: ACCOUNT_PROP }, ["cu"]),
  },
  {
    name: "ledger",
    title: "Session and calibration history",
    description:
      "Raw credit ledger events (session.start, session.end with its cause, calibrate, budget.set), oldest first: what ran, for how long, on which account.",
    inputSchema: schema({
      month: { type: "string", description: "Only this month, as YYYY-MM." },
      account: { type: "string", description: "Only this account." },
      limit: { type: "integer", minimum: 1, maximum: 5000, description: "Newest N events (default 200)." },
    }),
    annotations: READ_ONLY,
  },
  {
    name: "rates",
    title: "Compute-unit rate table",
    description:
      "Approximate compute units per hour for each GPU (T4, L4, A100, ..., CPU, unknown), used for estimates. set overrides entries; up already updates them from Colab's live rate, so set one only when the owner gives the number.",
    inputSchema: schema({
      set: {
        type: "object",
        additionalProperties: { type: "number" },
        description: "Rates to override, e.g. {\"T4\": 2.0}.",
      },
    }),
  },
];

// Which tools stand for each CLI command and flag. test/mcp-server.test.mjs compares this with
// bin/commands/, so a new command or flag cannot ship without a decision here.
export const CLI_COVERAGE = {
  doctor: { tools: ["doctor"], flags: [] },
  auth: {
    tools: ["auth_status", "auth_login", "auth_wait", "auth_redirect", "auth_list", "auth_switch", "auth_logout"],
    flags: ["account", "add", "all", "no-browser"],
  },
  up: { tools: ["up"], flags: ["name", "account", "gpu", "high-ram", "new", "keep"] },
  status: { tools: ["status"], flags: ["local"] },
  ls: { tools: ["status"], flags: [] },
  run: {
    tools: ["run"],
    flags: ["session", "cwd", "env", "detach"],
    notExposed: { attach: "attaching to tmux needs a terminal" },
  },
  job: {
    tools: ["job_submit", "job_list", "job_logs", "job_wait", "job_stop"],
    flags: ["session", "name", "cwd", "env", "sync", "sync-path", "status", "tail", "wait", "follow"],
    notExposed: { "internal-exec": "runs a detached job", "home-dir": "used by the detached job runner" },
  },
  sync: { tools: ["sync"], flags: ["session", "to"] },
  pull: { tools: ["pull"], flags: ["session"] },
  down: {
    tools: ["down"],
    flags: ["session", "all", "force"],
    notExposed: { cause: "ledger cause set by the idle watchdog" },
  },
  credits: { tools: ["credits", "credits_calibrate", "credits_set", "credits_budget"], flags: ["account", "browser"] },
  ledger: { tools: ["ledger"], flags: ["month", "account"] },
  rates: { tools: ["rates"], flags: ["set"] },
  mcp: { tools: [], flags: [] },
  forward: { tools: ["forward_start", "forward_stop"], flags: ["session", "port", "listen", "timeout"] },
};

class ToolInputError extends Error {}

function typeProblem(value, spec, at) {
  const kind = spec.type;
  const ok =
    kind === "string"
      ? typeof value === "string"
      : kind === "boolean"
        ? typeof value === "boolean"
        : kind === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : kind === "integer"
            ? Number.isInteger(value)
            : kind === "array"
              ? Array.isArray(value)
              : value !== null && typeof value === "object" && !Array.isArray(value);
  if (!ok) {
    return `${at} must be ${kind === "integer" ? "an integer" : kind === "array" || kind === "object" ? `an ${kind}` : `a ${kind}`}`;
  }
  if (spec.enum && !spec.enum.includes(value)) {
    return `${at} must be one of ${spec.enum.join(", ")}`;
  }
  if (typeof spec.minimum === "number" && value < spec.minimum) {
    return `${at} must be at least ${spec.minimum}`;
  }
  if (typeof spec.maximum === "number" && value > spec.maximum) {
    return `${at} must be at most ${spec.maximum}`;
  }
  if (kind === "array") {
    for (const [i, item] of value.entries()) {
      const problem = typeProblem(item, spec.items, `${at}[${i}]`);
      if (problem) return problem;
    }
  }
  if (kind === "object" && spec.additionalProperties) {
    for (const [key, item] of Object.entries(value)) {
      const problem = typeProblem(item, spec.additionalProperties, `${at}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

function argumentProblem(inputSchema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }
  for (const key of inputSchema.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      return `missing required argument: ${key}`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = inputSchema.properties[key];
    if (!spec) {
      return `unknown argument: ${key} (expected ${Object.keys(inputSchema.properties).join(", ") || "none"})`;
    }
    if (value === undefined || value === null) continue;
    const problem = typeProblem(value, spec, key);
    if (problem) return problem;
  }
  return null;
}

function parseJsonObject(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { ok: false, error: `unexpected output: ${trimmed.slice(0, 500)}` };
  }
}

function clip(text) {
  const value = String(text ?? "");
  return value.length > OUTPUT_LIMIT_CHARS
    ? { text: value.slice(-OUTPUT_LIMIT_CHARS), truncated: true }
    : { text: value, truncated: false };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// `run` goes through a child CLI process: the task record's localPid is what the panel's Stop button and
// `job stop` terminate, and in-process that pid would be this server.
export function runCliInChildProcess(argv, { env, timeoutMs, signal, untilFirstLine = false, spawnChild = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnChild(process.execPath, [CLI_ENTRY_PATH, ...argv], {
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pid: child.pid ?? null, stdout, stderr, exitCode: null, timedOut: false, aborted: false, ...extra });
    };
    const timer = setTimeout(() => {
      // Left running on purpose: the caller hands the task id back so the agent can follow or stop it.
      child.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (untilFirstLine && stdout.includes("\n")) {
        child.unref?.();
        child.stdout?.unref?.();
        child.stderr?.unref?.();
        finish({ exitCode: 0 });
      }
    });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => finish({ exitCode: 1, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => finish({ exitCode: code ?? 1 }));
    signal?.addEventListener(
      "abort",
      () => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish({ aborted: true });
      },
      { once: true },
    );
  });
}

export function createColabMcpTools({
  runMain,
  homeDir = os.homedir(),
  env = process.env,
  commandContext = {},
  openBrowser = openUrlInSystemBrowser,
  runCliChild = runCliInChildProcess,
  stopProcess = (pid) => process.kill(pid, "SIGTERM"),
  execTty = execCommandOverTty,
  signInTimeoutMs = SIGN_IN_TIMEOUT_MS,
  taskPollMs = 500,
} = {}) {
  let signIn = null;
  const unstoppable = new Set();

  async function runCli(argv, { cwd, signal, context = {}, onProgress } = {}) {
    let out = "";
    let partial = "";
    const log = [];
    const stderr = {
      write(chunk) {
        partial += String(chunk);
        for (let nl = partial.indexOf("\n"); nl !== -1; nl = partial.indexOf("\n")) {
          const line = partial.slice(0, nl).replace(/^\[colab\]\s*/, "").trim();
          partial = partial.slice(nl + 1);
          if (line) {
            log.push(line);
            onProgress?.(line);
          }
        }
      },
    };
    const [command, ...rest] = argv;
    const exitCode = await runMain([command, "--json", ...rest], {
      stdout: { write: (chunk) => { out += chunk; } },
      stderr,
      env,
      cwd,
      homeDir,
      signal,
      commandContext: { stdinIsTTY: false, ...commandContext, ...context },
    });
    return { exitCode, payload: parseJsonObject(out), log };
  }

  function toResult({ exitCode, payload, log }, { signInHint = true } = {}) {
    const result = { ok: payload.ok ?? exitCode === 0, ...payload };
    if (exitCode !== 0 && result.exitCode === undefined) {
      result.exitCode = exitCode;
    }
    if (signInHint && /orca-colab auth login|Not signed in/.test(JSON.stringify(payload))) {
      result.hint = SIGN_IN_HINT;
    }
    const lines = log.filter((line) => line !== `error: ${result.error}`);
    if (!result.ok && lines.length > 0) {
      result.log = lines.slice(-20);
    }
    return result;
  }

  // A job no process on this machine follows (another machine submitted it, or its follower ended) has
  // its state and output on the runtime; `job logs` copies both here.
  async function refreshFromRuntime(id, ctx) {
    const task = readTask(id, homeDir, { reconcile: false });
    const followed = task?.localPid && isProcessAlive(task.localPid);
    if (!task || (task.runtimeBacked && !task.logComplete && !followed)) {
      await runCli(["job", "logs", id, "--tail=1"], ctx).catch(() => {});
    }
  }

  const boundedTty = (seconds, signal) => (options) =>
    execTty({
      ...options,
      signal: options.signal ?? signal,
      timeoutMs: Math.min(options.timeoutMs ?? seconds * 1000, seconds * 1000),
    });

  // Finishes even when the client cancels or disconnects: an interrupted up can leave a billing runtime
  // with no session file, and an interrupted down a session file with no runtime.
  function toCompletion(promise) {
    unstoppable.add(promise);
    const forget = () => unstoppable.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  async function resolveWorkspace(args, ctx) {
    if (args.workspace_path) {
      if (!path.isAbsolute(args.workspace_path)) {
        throw new ToolInputError("workspace_path must be an absolute path.");
      }
      return requireDirectory(args.workspace_path, "workspace_path");
    }
    const roots = (await ctx.listRoots?.()) ?? [];
    if (roots.length === 1) {
      return requireDirectory(roots[0], "workspace root");
    }
    throw new ToolInputError(
      roots.length > 1
        ? `The client exposes several workspace roots (${roots.join(", ")}); pass workspace_path.`
        : "Pass workspace_path: the absolute path of the workspace directory on this machine (this server does not run in your working directory).",
    );
  }

  function requireDirectory(dir, label) {
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new ToolInputError(`${label} is not a directory on this machine: ${dir}`);
    }
    return dir;
  }

  async function resolveLocalPath(value, args, ctx) {
    return path.isAbsolute(value) ? value : path.resolve(await resolveWorkspace(args, ctx), value);
  }

  function commandArgs(args) {
    const hasArgv = Array.isArray(args.argv) && args.argv.length > 0;
    const hasCommand = typeof args.command === "string" && args.command.trim() !== "";
    if (hasArgv === hasCommand) {
      throw new ToolInputError("Give exactly one of command (a shell line) or argv (separate arguments).");
    }
    return hasArgv ? args.argv : [args.command.trim()];
  }

  function remoteFlags(args) {
    const flags = [];
    if (args.session) flags.push(`--session=${args.session}`);
    if (args.cwd) flags.push(`--cwd=${args.cwd}`);
    for (const [key, value] of Object.entries(args.env ?? {})) {
      flags.push(`--env=${key}=${value}`);
    }
    return flags;
  }

  function accountFlags(args) {
    return args.account ? [`--account=${args.account}`] : [];
  }

  function taskId(args) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.id)) {
      throw new ToolInputError(`invalid task id: ${args.id}`);
    }
    return args.id;
  }

  function readLogFrom(id, sinceBytes) {
    const file = taskLogPath(id, homeDir);
    if (!existsSync(file)) {
      return { output: "", totalBytes: 0, nextSinceBytes: 0, truncated: false };
    }
    const totalBytes = statSync(file).size;
    const start = Math.min(sinceBytes, totalBytes);
    const buffer = Buffer.alloc(Math.min(totalBytes - start, LOG_CHUNK_BYTES));
    const fd = openSync(file, "r");
    let read = 0;
    try {
      read = buffer.length > 0 ? readSync(fd, buffer, 0, buffer.length, start) : 0;
    } finally {
      closeSync(fd);
    }
    return {
      output: buffer.subarray(0, read).toString("utf8"),
      totalBytes,
      nextSinceBytes: start + read,
      truncated: start + read < totalBytes,
    };
  }

  function describeSignIn(state) {
    if (!state) {
      const accounts = listOAuthAccounts(homeDir);
      return {
        ok: true,
        state: accounts.length > 0 ? "signed_in" : "not_started",
        accounts,
        ...(accounts.length > 0 ? {} : { hint: SIGN_IN_HINT }),
      };
    }
    if (!state.outcome) {
      const secondsLeft = Math.max(0, Math.round((state.startedAt + signInTimeoutMs - Date.now()) / 1000));
      return {
        ok: true,
        state: "waiting_for_owner",
        url: state.url,
        browserOpened: state.browserOpened,
        secondsLeft,
        next: `${
          state.browserOpened
            ? "Google's consent page was opened in the default browser of the machine this server runs on. Show the owner the url as well, in case no page appeared."
            : "No browser was opened. Give the owner the url to open in any browser."
        } Ask them to tick the Colab permission ("Read, write and delete your Colab resources", or Select all; it starts unticked). Tell them: ${REMOTE_BROWSER_NOTE} Then call auth_wait.`,
      };
    }
    const result = toResult(state.outcome, { signInHint: false });
    if (result.ok) {
      return { ...result, state: "signed_in" };
    }
    return {
      ...result,
      state: "failed",
      hint: /Colab access/.test(String(result.error))
        ? "The owner left the Colab permission unticked. Call auth_login again and ask them to tick \"Read, write and delete your Colab resources\" (or Select all) on Google's consent page."
        : "Call auth_login again for a fresh sign-in page.",
    };
  }

  async function startSignIn(args) {
    let pendingNote = null;
    if (!signIn || signIn.outcome) {
      const state = {
        startedAt: Date.now(),
        url: null,
        browserOpened: false,
        outcome: null,
        controller: new AbortController(),
      };
      let announceUrl;
      const urlKnown = new Promise((resolve) => { announceUrl = resolve; });
      const argv = ["auth", "login", ...accountFlags(args), ...(args.add ? ["--add"] : [])];
      state.finished = runCli(argv, {
        signal: state.controller.signal,
        context: {
          loginTimeoutMs: signInTimeoutMs,
          openBrowser: async (url) => {
            state.url = url;
            if (args.open_browser !== false) {
              try {
                state.browserOpened = Boolean((await openBrowser(url))?.opened);
              } catch {
                state.browserOpened = false;
              }
            }
            announceUrl();
          },
        },
      }).then(
        (outcome) => { state.outcome = outcome; },
        (err) => { state.outcome = { exitCode: 1, payload: { ok: false, error: err?.message || String(err) }, log: [] }; },
      );
      signIn = state;
      await Promise.race([urlKnown, state.finished]);
    } else {
      pendingNote = `A sign-in started ${Math.round((Date.now() - signIn.startedAt) / 1000)}s ago is still waiting; this is the same one (same url), not a new one.`;
      if (args.open_browser !== false && !signIn.browserOpened) {
        try {
          signIn.browserOpened = Boolean((await openBrowser(signIn.url))?.opened);
        } catch {
          signIn.browserOpened = false;
        }
      } else if (args.open_browser === false && signIn.browserOpened) {
        pendingNote += " Its page was already opened in a browser on this machine when it started.";
      }
    }
    if (args.wait_seconds) {
      await Promise.race([signIn.finished, sleep(args.wait_seconds * 1000)]);
    }
    const result = describeSignIn(signIn);
    return pendingNote && result.state === "waiting_for_owner"
      ? { ...result, alreadyPending: true, note: pendingNote }
      : result;
  }

  const handlers = {
    doctor: async (_args, ctx) => toResult(await runCli(["doctor"], ctx)),

    auth_status: async (args, ctx) => {
      const result = toResult(await runCli(["auth", "status", ...accountFlags(args)], ctx));
      if (result.authenticated === false) {
        result.hint = SIGN_IN_HINT;
      }
      if (signIn && !signIn.outcome) {
        result.signIn = describeSignIn(signIn);
      }
      return result;
    },

    auth_login: (args) => startSignIn(args),

    auth_wait: async (args, ctx) => {
      if (signIn && !signIn.outcome) {
        await Promise.race([signIn.finished, sleep((args.timeout_seconds ?? DEFAULT_WAIT_SECONDS) * 1000, ctx.signal)]);
      }
      return describeSignIn(signIn);
    },

    auth_redirect: async (args, ctx) => {
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(args.url)) {
        throw new ToolInputError("url must be the http://127.0.0.1:PORT/?state=...&code=... address the browser was redirected to.");
      }
      return toResult(await runCli(["auth", "redirect", args.url], ctx), { signInHint: false });
    },

    auth_list: async (_args, ctx) => toResult(await runCli(["auth", "list"], ctx)),

    auth_switch: async (args, ctx) => toResult(await runCli(["auth", "switch", `--account=${args.account}`], ctx)),

    auth_logout: async (args, ctx) =>
      toResult(await runCli(["auth", "logout", ...accountFlags(args), ...(args.all ? ["--all"] : [])], ctx), {
        signInHint: false,
      }),

    status: async (args, ctx) => toResult(await runCli(["status", ...(args.local ? ["--local"] : [])], ctx)),

    up: async (args, ctx) => {
      const argv = ["up", ...accountFlags(args)];
      if (args.gpu) argv.push(`--gpu=${args.gpu}`);
      if (args.name) argv.push(`--name=${args.name}`);
      if (args.high_ram) argv.push("--high-ram");
      if (args.new) argv.push("--new");
      if (args.keep) argv.push("--keep");
      return toResult(await toCompletion(runCli(argv, { onProgress: ctx.onProgress })));
    },

    sync: async (args, ctx) => {
      const localDir = requireDirectory(
        args.path ? await resolveLocalPath(args.path, args, ctx) : await resolveWorkspace(args, ctx),
        "path",
      );
      const argv = ["sync"];
      if (args.session) argv.push(`--session=${args.session}`);
      if (args.to) argv.push(`--to=${args.to}`);
      argv.push("--", localDir);
      return toResult(
        await runCli(argv, { ...ctx, cwd: localDir, context: { execTty: boundedTty(900, ctx.signal) } }),
      );
    },

    run: async (args, ctx) => {
      const argv = ["run", "--json", ...remoteFlags(args)];
      if (args.detach) argv.push(`--detach=${args.detach}`);
      argv.push("--", ...commandArgs(args));
      const timeoutSeconds = args.timeout_seconds ?? DEFAULT_WAIT_SECONDS;
      const child = await runCliChild(argv, { env, timeoutMs: timeoutSeconds * 1000, signal: ctx.signal });
      const task = child.pid
        ? listTasks(homeDir, { reconcile: false }).find((t) => t.localPid === child.pid)
        : null;
      if (child.timedOut) {
        const tail = task ? readTaskLog(task.id, homeDir, { tailLines: 50 }) : null;
        return {
          ok: false,
          timedOut: true,
          taskId: task?.id ?? null,
          error: `The command was still running after ${timeoutSeconds}s; it keeps running on the runtime.`,
          ...(tail ? { output: tail.text } : {}),
          hint: task
            ? `Follow it with job_wait or job_logs (id ${task.id}); stop it with job_stop. Use job_submit for long commands.`
            : "Find it with job_list. Use job_submit for long commands.",
        };
      }
      const payload = parseJsonObject(child.stdout);
      const log = child.stderr.split(/\r?\n/).map((l) => l.replace(/^\[colab\]\s*/, "").trim()).filter(Boolean);
      if (Object.keys(payload).length === 0) {
        payload.ok = false;
        payload.error = log.at(-1)?.replace(/^error:\s*/, "") || "run produced no result";
      }
      const result = toResult({ exitCode: child.exitCode ?? 1, payload, log });
      for (const stream of ["stdout", "stderr"]) {
        if (typeof result[stream] === "string") {
          const clipped = clip(result[stream]);
          result[stream] = clipped.text;
          if (clipped.truncated) result.truncated = true;
        }
      }
      if (task) {
        result.taskId = task.id;
      }
      if (result.truncated && task) {
        result.hint = `Output cut to its last ${OUTPUT_LIMIT_CHARS} characters; read the rest with job_logs (id ${task.id}).`;
      }
      return result;
    },

    job_submit: async (args, ctx) => {
      const command = commandArgs(args);
      const workspace = args.sync || args.workspace_path ? await resolveWorkspace(args, ctx) : undefined;
      const argv = ["job", "submit", ...remoteFlags(args)];
      if (args.name) argv.push(`--name=${args.name}`);
      if (args.sync) argv.push(`--sync-path=${workspace}`);
      argv.push("--", ...command);
      return toResult(await runCli(argv, { ...ctx, cwd: workspace }));
    },

    job_list: async (args, ctx) => {
      const argv = ["job", "ls"];
      if (args.session) argv.push(`--session=${args.session}`);
      if (args.status) argv.push(`--status=${args.status}`);
      const result = toResult(await runCli(argv, ctx));
      const limit = args.limit ?? 30;
      if (Array.isArray(result.tasks) && result.tasks.length > limit) {
        result.totalTasks = result.tasks.length;
        result.tasks = result.tasks.slice(0, limit);
      }
      return result;
    },

    job_logs: async (args, ctx) => {
      const id = taskId(args);
      if (args.since_bytes !== undefined && args.since_bytes !== null) {
        await refreshFromRuntime(id, ctx);
        const task = readTask(id, homeDir);
        if (!task) {
          throw new ToolInputError(`task not found: ${id}`);
        }
        return { ok: true, task, ...readLogFrom(id, args.since_bytes) };
      }
      const result = toResult(await runCli(["job", "logs", id, `--tail=${args.tail ?? 200}`], ctx));
      if (result.ok) {
        result.nextSinceBytes = result.totalBytes;
      }
      return result;
    },

    job_wait: async (args, ctx) => {
      const id = taskId(args);
      const deadline = Date.now() + (args.timeout_seconds ?? DEFAULT_WAIT_SECONDS) * 1000;
      await refreshFromRuntime(id, ctx);
      let task = readTask(id, homeDir);
      let refreshedAt = Date.now();
      while (task && task.status === "running" && Date.now() < deadline && !ctx.signal?.aborted) {
        await sleep(taskPollMs, ctx.signal);
        if (Date.now() - refreshedAt > 3000) {
          refreshedAt = Date.now();
          await refreshFromRuntime(id, ctx);
        }
        task = readTask(id, homeDir);
      }
      await refreshFromRuntime(id, ctx);
      task = readTask(id, homeDir);
      if (!task) {
        throw new ToolInputError(`task not found: ${id}`);
      }
      const tail = readTaskLog(id, homeDir, { tailLines: args.tail ?? 50 });
      return {
        ok: true,
        finished: task.status !== "running",
        task,
        output: tail.text,
        totalBytes: tail.totalBytes,
        nextSinceBytes: tail.totalBytes,
        truncated: tail.truncated,
      };
    },

    job_stop: async (args, ctx) => toResult(await runCli(["job", "stop", taskId(args)], ctx)),

    pull: async (args, ctx) => {
      const localDir = await resolveLocalPath(args.local_dir, args, ctx);
      const argv = ["pull"];
      if (args.session) argv.push(`--session=${args.session}`);
      argv.push("--", args.remote_path, localDir);
      return toResult(await runCli(argv, { ...ctx, context: { execTty: boundedTty(900, ctx.signal) } }));
    },

    forward_start: async (args) => {
      const argv = ["forward", "--json", `--port=${args.port}`];
      if (args.session) argv.push(`--session=${args.session}`);
      if (args.listen) argv.push(`--listen=${args.listen}`);
      if (args.timeout_seconds) argv.push(`--timeout=${args.timeout_seconds}`);
      // The listener must outlive this call, so it is its own process; it reports once it listens.
      const child = await runCliChild(argv, { env, timeoutMs: 90_000, untilFirstLine: true });
      const payload = parseJsonObject(child.stdout);
      const log = child.stderr.split(/\r?\n/).map((l) => l.replace(/^\[colab\]\s*/, "").trim()).filter(Boolean);
      if (Object.keys(payload).length === 0) {
        payload.ok = false;
        payload.error = log.at(-1)?.replace(/^error:\s*/, "") || "the forward did not start";
      }
      return toResult({ exitCode: payload.ok ? 0 : child.exitCode ?? 1, payload, log });
    },

    forward_stop: async (args) => {
      const forwards = listSessions(homeDir).flatMap((session) =>
        liveForwards(session).map((forward) => ({ session: session.name, ...forward })),
      );
      const target = forwards.find((f) => (args.pid ? f.pid === args.pid : f.listen === args.listen));
      if (!target) {
        throw new ToolInputError(
          forwards.length > 0
            ? `No such forward. Active: ${forwards.map((f) => `pid ${f.pid} on ${f.listen} (${f.session})`).join(", ")}.`
            : "No forward is active.",
        );
      }
      stopProcess(target.pid);
      return { ok: true, stopped: target };
    },

    down: async (args) => {
      const argv = ["down"];
      if (args.session) argv.push(`--session=${args.session}`);
      if (args.all) argv.push("--all");
      if (args.force) argv.push("--force");
      return toResult(await toCompletion(runCli(argv)));
    },

    credits: async (args, ctx) => toResult(await runCli(["credits", ...accountFlags(args)], ctx)),

    credits_calibrate: async (args, ctx) =>
      toResult(
        await runCli(["credits", "calibrate", ...accountFlags(args), ...(args.browser ? ["--browser"] : [])], ctx),
      ),

    credits_set: async (args, ctx) => toResult(await runCli(["credits", "set", String(args.cu), ...accountFlags(args)], ctx)),

    credits_budget: async (args, ctx) =>
      toResult(await runCli(["credits", "budget", String(args.cu), ...accountFlags(args)], ctx)),

    ledger: async (args, ctx) => {
      const argv = ["ledger", ...accountFlags(args)];
      if (args.month) argv.push(`--month=${args.month}`);
      const result = toResult(await runCli(argv, ctx));
      const limit = args.limit ?? 200;
      if (Array.isArray(result.events) && result.events.length > limit) {
        result.totalEvents = result.events.length;
        result.events = result.events.slice(-limit);
      }
      return result;
    },

    rates: async (args, ctx) =>
      toResult(
        await runCli(["rates", ...Object.entries(args.set ?? {}).map(([key, value]) => `--set=${key}=${value}`)], ctx),
      ),
  };

  // A report that says "not ready" or "still running" is an answer, not a failed call.
  const REPORTS = new Set(["doctor", "auth_status", "auth_login", "auth_wait", "job_wait", "job_logs"]);

  async function call(name, args, ctx = {}) {
    const spec = TOOL_SPECS.find((tool) => tool.name === name);
    let result;
    try {
      const problem = argumentProblem(spec.inputSchema, args);
      if (problem) {
        throw new ToolInputError(problem);
      }
      result = await handlers[name](args, { signal: ctx.signal, listRoots: ctx.listRoots, onProgress: ctx.onProgress });
    } catch (err) {
      if (!(err instanceof ToolInputError)) {
        throw err;
      }
      result = { ok: false, error: err.message };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: !result.ok && !(REPORTS.has(name) && result.error === undefined),
    };
  }

  // Resolves once no up or down is in flight; the server waits for it before exiting.
  async function settle() {
    if (signIn && !signIn.outcome) {
      signIn.controller.abort();
    }
    while (unstoppable.size > 0) {
      await Promise.allSettled([...unstoppable]);
    }
  }

  return { tools: TOOL_SPECS, call, settle };
}
