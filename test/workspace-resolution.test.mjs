import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkspaceInfo } from "../worker/main.mjs";

const rows = [
  { id: "identity:a", name: "main", path: "/u/trend_factory", branch: "main", hostId: "local" },
  { id: "identity:b", name: "main", path: "/u/orca-colab", branch: "main", hostId: "local" },
  { id: "identity:c", name: "feat/x", path: "/u/other", branch: "feat/x", hostId: "local" },
];

function fakeOrca(ctx) {
  return {
    host: {
      call: async (method) => (method === "workspace.readContext" ? ctx : { workspaces: rows }),
    },
  };
}

test("a focused terminal owned by a local worktree picks that checkout among same-named rows", async () => {
  const orca = fakeOrca({ displayName: "main", branch: "main", terminals: [{ id: "t1" }] });
  const info = await resolveWorkspaceInfo(orca, { locateTerminals: async () => ({ path: "/u/orca-colab" }) });
  assert.equal(info.workspaceId, "identity:b");
  assert.equal(info.workspacePath, "/u/orca-colab");
  assert.equal(info.hostId, null);
});

test("focused terminals that no local worktree owns mean the workspace is on a server", async () => {
  const orca = fakeOrca({ displayName: "main", branch: "main", terminals: [{ id: "t9" }] });
  const info = await resolveWorkspaceInfo(orca, { locateTerminals: async () => false });
  assert.equal(info.hostId, "unlisted");
  assert.equal(info.workspaceName, "main");
});

test("without terminals the first row matching both name and branch is taken as local", async () => {
  const orca = fakeOrca({ displayName: "main", branch: "main", terminals: [] });
  const info = await resolveWorkspaceInfo(orca, { locateTerminals: async () => null });
  assert.equal(info.workspaceId, "identity:a");
  assert.equal(info.hostId, null);
});

test("a name and branch that no row carries are unlisted, hence remote", async () => {
  const orca = fakeOrca({ displayName: "server-only", branch: "srv/feature", terminals: [] });
  const info = await resolveWorkspaceInfo(orca, { locateTerminals: async () => null });
  assert.equal(info.hostId, "unlisted");
});
