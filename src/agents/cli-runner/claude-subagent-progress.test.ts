import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeClaudeProjectDir,
  resolveClaudeSubagentsDir,
  startClaudeSubagentActivityMonitor,
} from "./claude-subagent-progress.js";

describe("encodeClaudeProjectDir", () => {
  it("encodes slashes and dots the way the Claude CLI does", () => {
    expect(encodeClaudeProjectDir("/home/bakhtiyar/.openclaw/workspace")).toBe(
      "-home-bakhtiyar--openclaw-workspace",
    );
  });
});

describe("resolveClaudeSubagentsDir", () => {
  it("joins ~/.claude/projects/<encoded>/<cliSessionId>/subagents", () => {
    expect(
      resolveClaudeSubagentsDir({
        workspaceDir: "/home/bakhtiyar/.openclaw/workspace",
        cliSessionId: "e20c5ca6-3197-4641-979c-6a932f589d7f",
        homeDir: "/home/bakhtiyar",
      }),
    ).toBe(
      "/home/bakhtiyar/.claude/projects/-home-bakhtiyar--openclaw-workspace/e20c5ca6-3197-4641-979c-6a932f589d7f/subagents",
    );
  });
});

describe("startClaudeSubagentActivityMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps(overrides: {
    readDir?: (dir: string) => Promise<string[]>;
    statFile?: (file: string) => Promise<{ mtimeMs: number } | null>;
    now?: () => number;
  }) {
    const emit = vi.fn();
    return {
      emit,
      readDir: overrides.readDir ?? (async () => []),
      statFile: overrides.statFile ?? (async () => null),
      now: overrides.now ?? (() => 1_000_000),
    };
  }

  it("emits run.progress when a subagent JSONL was modified within the freshness window", async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      readDir: async () => ["agent-abc.jsonl", "agent-old.jsonl", "ignore.txt"],
      statFile: async (file) => {
        if (file.endsWith("agent-abc.jsonl")) {
          return { mtimeMs: now - 5_000 };
        }
        if (file.endsWith("agent-old.jsonl")) {
          return { mtimeMs: now - 60_000 };
        }
        return null;
      },
      now: () => now,
    });
    const monitor = startClaudeSubagentActivityMonitor({
      sessionId: "sess-1",
      sessionKey: "agent:main:invio",
      workspaceDir: "/home/test/workspace",
      cliSessionId: "cli-sid",
      intervalMs: 1_000,
      freshnessMs: 30_000,
      deps,
    });
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(deps.emit).toHaveBeenCalledTimes(1);
      expect(deps.emit).toHaveBeenCalledWith({
        sessionId: "sess-1",
        sessionKey: "agent:main:invio",
        runId: undefined,
      });
    } finally {
      monitor.stop();
    }
  });

  it("does not emit when every JSONL is older than the freshness window", async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      readDir: async () => ["agent-a.jsonl", "agent-b.jsonl"],
      statFile: async () => ({ mtimeMs: now - 120_000 }),
      now: () => now,
    });
    const monitor = startClaudeSubagentActivityMonitor({
      workspaceDir: "/w",
      cliSessionId: "sid",
      intervalMs: 1_000,
      freshnessMs: 30_000,
      deps,
    });
    try {
      await vi.advanceTimersByTimeAsync(3_500);
      expect(deps.emit).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it("does not emit when the subagents directory does not exist or is empty", async () => {
    const deps = makeDeps({
      readDir: async () => [],
    });
    const monitor = startClaudeSubagentActivityMonitor({
      workspaceDir: "/w",
      cliSessionId: "sid",
      intervalMs: 1_000,
      deps,
    });
    try {
      await vi.advanceTimersByTimeAsync(3_500);
      expect(deps.emit).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it("emits against the new directory after the monitor is swapped to the real session id", async () => {
    // Simulate the gap fix: a fresh session starts a monitor with argv sid A,
    // then JSONL stdout reveals the real sid B.  The live-session code stops
    // the A monitor and starts a fresh B monitor.  Only B's directory should
    // receive emit calls once the swap has happened.
    const now = 1_000_000;
    const workspaceDir = "/home/test/workspace";

    const emitA = vi.fn();
    const depsA = {
      emit: emitA,
      readDir: async (dir: string) => {
        if (dir.includes("sid-argv")) {
          return ["agent-a.jsonl"];
        }
        return [];
      },
      statFile: async () => ({ mtimeMs: now - 5_000 }),
      now: () => now,
    };
    const monitorA = startClaudeSubagentActivityMonitor({
      sessionId: "sess-1",
      workspaceDir,
      cliSessionId: "sid-argv",
      intervalMs: 1_000,
      freshnessMs: 30_000,
      deps: depsA,
    });

    // Advance so A emits once while it is the active monitor.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(emitA).toHaveBeenCalledTimes(1);

    // Simulated swap: JSONL stdout gave us the real session id "sid-real".
    monitorA.stop();

    const emitB = vi.fn();
    const depsB = {
      emit: emitB,
      readDir: async (dir: string) => {
        if (dir.includes("sid-real")) {
          return ["agent-b.jsonl"];
        }
        return [];
      },
      statFile: async () => ({ mtimeMs: now - 5_000 }),
      now: () => now,
    };
    const monitorB = startClaudeSubagentActivityMonitor({
      sessionId: "sess-1",
      workspaceDir,
      cliSessionId: "sid-real",
      intervalMs: 1_000,
      freshnessMs: 30_000,
      deps: depsB,
    });

    try {
      // Advance enough for B to fire once.
      await vi.advanceTimersByTimeAsync(1_500);
      // A is stopped, so emitA must not have gained any new calls.
      expect(emitA).toHaveBeenCalledTimes(1);
      // B should have emitted once, watching the sid-real directory.
      expect(emitB).toHaveBeenCalledTimes(1);
      expect(emitB).toHaveBeenCalledWith({
        sessionId: "sess-1",
        sessionKey: undefined,
        runId: undefined,
      });
    } finally {
      monitorB.stop();
    }
  });

  it("stops emitting after stop() is called", async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      readDir: async () => ["agent-fresh.jsonl"],
      statFile: async () => ({ mtimeMs: now - 1_000 }),
      now: () => now,
    });
    const monitor = startClaudeSubagentActivityMonitor({
      workspaceDir: "/w",
      cliSessionId: "sid",
      intervalMs: 1_000,
      freshnessMs: 30_000,
      deps,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(deps.emit).toHaveBeenCalledTimes(1);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.emit).toHaveBeenCalledTimes(1);
  });
});
