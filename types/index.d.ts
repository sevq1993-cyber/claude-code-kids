// Type contract of the kids mod: every value it keeps in $.state.
// Self-contained on purpose: claude plugin validate reads it as the engine does.

export type KidChat = 'running' | 'idle' | 'done' | 'review' | 'blocked' | 'archived' | 'closed';

/** One chat in the tree: the main chat at the root, child chats below it, any depth. */
export type Kid = {
  /** The desktop app's session id of the chat (local_...). */
  id: string;
  title: string;
  /** True for the chat the pane is drawn in. */
  isMe: boolean;
  /** True for the chat at the top of the tree, the one nobody spawned. */
  isRoot: boolean;
  branch: string | null;
  sourceBranch: string;
  /** The worktree path while git still lists one for the branch. */
  worktree: string | null;
  model: string | null;
  turns: number;
  lastActivityAt: number;
  isArchived: boolean;
  isLive: boolean;
  liveStatus: string | null;
  summary: string | null;
  needsAction: string | null;
  branchExists: boolean | null;
  /** Commits on the branch that the source branch does not have. */
  ahead: number | null;
  /** True when the branch's commits are all in the source branch and it has some: merged, not merely fresh. */
  merged: boolean | null;
  dirty: number | null;
  lastCommit: string | null;
  children: Kid[];
};

/** A worktree folder no chat of the project claims: one of Claude's (.claude/worktrees) or somebody else's. */
export type Orphan = {
  path: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  merged: boolean | null;
  isClaude: boolean;
};

/** A local branch with no worktree folder and no chat: made by hand or by another tool, then left. */
export type LooseBranch = {
  branch: string;
  ahead: number | null;
  behind: number | null;
  merged: boolean | null;
};

export type Snapshot = {
  scannedAt: number;
  /** The main checkout of the project this chat is in; null outside a git project. */
  root: string | null;
  /** The tree from the main chat down; null when this chat is not in the app's history. */
  tree: Kid | null;
  orphans: Orphan[];
  branches: LooseBranch[];
  error: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    kids: {
      snapshot: Snapshot | null;
    };
  }
}
