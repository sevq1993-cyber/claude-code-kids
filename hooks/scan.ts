// The collector: reads what the desktop app and git already wrote, through a
// small Host so a test can stand in for the engine. Nothing here changes state
// on disk; git is only asked questions.

import type { Kid, LooseBranch, Orphan, Snapshot } from '../types';

export type Entry = { name: string; kind: string };
export type Ran = { exitCode: number; stdout: string; stderr: string };

export type Host = {
  home: () => Promise<string | undefined>;
  cwd: () => Promise<string>;
  sessionId: () => Promise<string>;
  now: () => Promise<number>;
  list: (path: string) => Promise<Entry[]>;
  read: (path: string) => Promise<string>;
  run: (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<Ran>;
};

type Meta = {
  sessionId: string;
  cliSessionId: string | null;
  cwd: string;
  originCwd: string;
  title: string;
  isArchived: boolean;
  model: string | null;
  completedTurns: number;
  lastActivityAt: number;
  summary: string | null;
  needsAction: string | null;
  spawnedFrom: { sessionId: string; title?: string } | null;
  branch: string | null;
  sourceBranch: string | null;
};

type Live = { pid: number; hostSessionId: string | null; status: string | null };
type Worktree = { path: string; branch: string | null };

const GIT_MS = 8000;
const WORKTREES_DIR = '/.claude/worktrees/';

export async function scan(host: Host): Promise<Snapshot> {
  const now = await host.now();
  const cwd = norm(await host.cwd());
  const empty: Snapshot = { scannedAt: now, root: null, tree: null, orphans: [], branches: [], error: null };
  const home = await host.home();
  if (!home) return { ...empty, error: 'HOME не задан: не найти метаданные приложения' };

  // The project is its main checkout: a chat inside a worktree belongs to the same project.
  const root = rootOf(cwd);
  const trees = await worktreesOf(host, root);
  if (trees === null) return empty;

  let metas: Meta[] = [];
  try {
    metas = await readMetas(host, `${home}/Library/Application Support/Claude/claude-code-sessions`);
  } catch (error) {
    return { ...empty, root, error: `метаданные чатов не прочитаны: ${String(error)}` };
  }
  const live = await readLive(host, `${home}/.claude/sessions`);
  const alive = await alivePids(host, live.map(l => l.pid));
  const liveById = new Map<string, Live>();
  for (const l of live) if (l.hostSessionId && alive.has(l.pid)) liveById.set(l.hostSessionId, l);

  const byId = new Map(metas.map(m => [m.sessionId, m] as const));
  const inProject = metas.filter(m => rootOf(repoOf(m, byId)) === root);
  const childrenOf = (id: string): Meta[] => inProject.filter(m => m.spawnedFrom?.sessionId === id);

  // Every child branch of the project is claimed, whether or not its chat is drawn.
  const claimed = new Set<string>();
  for (const m of inProject) if (m.spawnedFrom && m.branch) claimed.add(m.branch);

  const errors: string[] = [];
  const cliId = await host.sessionId().catch(() => '');
  const me = metas.find(m => m.cliSessionId === cliId) ?? null;
  // Up to the main chat: the chats on that path are always drawn, or the tree would break.
  const lineage = new Set<string>();
  let top = me;
  while (top) {
    lineage.add(top.sessionId);
    const parent = top.spawnedFrom ? byId.get(top.spawnedFrom.sessionId) : undefined;
    if (!parent) break;
    top = parent;
  }
  const build = async (m: Meta, isRoot: boolean): Promise<Kid | null> => {
    const kid = kidOf(m, liveById.get(m.sessionId) ?? null, me?.sessionId ?? '', isRoot);
    if (!isRoot && kid.branch) {
      try {
        await fillGit(host, root, kid, trees);
      } catch (error) {
        errors.push(`${kid.branch}: ${String(error)}`);
      }
    }
    for (const c of childrenOf(m.sessionId)) {
      const child = await build(c, false);
      if (child) kid.children.push(child);
    }
    // A closed chat stays only while something of it remains, or while the tree runs through it.
    if (isRoot || lineage.has(m.sessionId) || kid.children.length > 0 || isActive(kid)) return kid;
    return null;
  };

  let tree: Kid | null = null;
  if (top) {
    tree = await build(top, true);
  } else {
    // Not a chat of the app (a terminal session): every main chat of the project that has children.
    const tops: Kid[] = [];
    for (const m of inProject) {
      if (m.spawnedFrom !== null) continue;
      const kid = await build(m, true);
      if (kid && kid.children.length > 0) tops.push(kid);
    }
    tree = tops.length === 1 ? (tops[0] as Kid) : { ...kidOf(projectMeta(root), null, '', true), title: 'Чаты проекта', children: tops };
  }

  // Every worktree but the root that no chat claims: Claude's own, or one made by hand or by another tool.
  const orphans: Orphan[] = [];
  for (const t of trees) {
    if (t.path === root || (t.branch && claimed.has(t.branch))) continue;
    const stand = t.branch ? await standingOf(host, root, t.branch) : { ahead: null, behind: null, merged: null };
    orphans.push({ path: t.path, branch: t.branch, ...stand, isClaude: t.path.includes(WORKTREES_DIR) });
  }

  // Local branches with neither a folder nor a chat: what git keeps that nothing else shows.
  const branches: LooseBranch[] = [];
  const withFolder = new Set(trees.map(t => t.branch).filter((b): b is string => b !== null));
  for (const branch of await localBranches(host, root)) {
    if (branch === 'main' || withFolder.has(branch) || claimed.has(branch)) continue;
    branches.push({ branch, ...(await standingOf(host, root, branch)) });
  }

  return {
    scannedAt: now,
    root,
    tree,
    orphans,
    branches,
    error: errors.length ? `git не ответил: ${errors.join('; ')}` : null,
  };
}

/** Where a branch stands against main: commits of its own, commits it lacks, and whether main already has it. */
async function standingOf(host: Host, repo: string, branch: string): Promise<{ ahead: number | null; behind: number | null; merged: boolean | null }> {
  const ahead = await count(host, repo, `main..${branch}`);
  const behind = await count(host, repo, `${branch}..main`);
  const tip = await revOf(host, repo, branch);
  const mainTip = await revOf(host, repo, 'main');
  if (tip === null || mainTip === null) return { ahead, behind, merged: null };
  const ancestor = await host.run(['git', '-C', repo, 'merge-base', '--is-ancestor', branch, 'main'], { timeoutMs: GIT_MS });
  return { ahead, behind, merged: ancestor.exitCode === 0 && tip !== mainTip };
}

async function localBranches(host: Host, repo: string): Promise<string[]> {
  const ran = await host.run(['git', '-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { timeoutMs: GIT_MS });
  if (ran.exitCode !== 0) return [];
  return ran.stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

/** A stand-in for the project itself, when no one chat is the root. */
function projectMeta(root: string): Meta {
  return { sessionId: root, cliSessionId: null, cwd: root, originCwd: root, title: '', isArchived: false, model: null, completedTurns: 0, lastActivityAt: 0, summary: null, needsAction: null, spawnedFrom: null, branch: null, sourceBranch: null };
}

function kidOf(m: Meta, l: Live | null, meId: string, isRoot: boolean): Kid {
  return {
    id: m.sessionId,
    title: m.title || m.spawnedFrom?.title || m.sessionId,
    isMe: m.sessionId === meId,
    isRoot,
    branch: m.branch,
    sourceBranch: m.sourceBranch ?? 'main',
    worktree: null,
    model: m.model,
    turns: m.completedTurns,
    lastActivityAt: m.lastActivityAt,
    isArchived: m.isArchived,
    isLive: l !== null,
    liveStatus: l?.status ?? null,
    summary: m.summary,
    needsAction: m.needsAction,
    branchExists: null,
    ahead: null,
    merged: null,
    dirty: null,
    lastCommit: null,
    children: [],
  };
}

/** A closed chat stays listed only while something of it remains: commits not merged, or a folder on disk. */
function isActive(kid: Kid): boolean {
  if (!kid.isArchived) return true;
  if (kid.worktree !== null) return true;
  return kid.merged === false && (kid.ahead ?? 0) > 0;
}

async function readMetas(host: Host, root: string): Promise<Meta[]> {
  const metas: Meta[] = [];
  for (const account of await dirs(host, root)) {
    for (const org of await dirs(host, `${root}/${account}`)) {
      const dir = `${root}/${account}/${org}`;
      for (const entry of await host.list(dir)) {
        if (entry.kind !== 'file' || !entry.name.startsWith('local_') || !entry.name.endsWith('.json')) continue;
        try {
          const meta = metaOf(JSON.parse(await host.read(`${dir}/${entry.name}`)));
          if (meta) metas.push(meta);
        } catch {
          // A half-written file while the app saves: skipped this scan, read the next.
        }
      }
    }
  }
  return metas;
}

function metaOf(raw: unknown): Meta | null {
  if (!isRecord(raw) || typeof raw.sessionId !== 'string') return null;
  const summary = isRecord(raw.postTurnSummary) ? raw.postTurnSummary : null;
  const spawned = isRecord(raw.spawnedFrom) && typeof raw.spawnedFrom.sessionId === 'string' ? raw.spawnedFrom : null;
  return {
    sessionId: raw.sessionId,
    cliSessionId: str(raw.cliSessionId),
    cwd: norm(str(raw.cwd) ?? ''),
    originCwd: norm(str(raw.originCwd) ?? str(raw.cwd) ?? ''),
    title: str(raw.title) ?? '',
    isArchived: raw.isArchived === true,
    model: str(raw.model),
    completedTurns: typeof raw.completedTurns === 'number' ? raw.completedTurns : 0,
    lastActivityAt: typeof raw.lastActivityAt === 'number' ? raw.lastActivityAt : 0,
    summary: summary ? str(summary.status_category) : null,
    needsAction: summary ? str(summary.needs_action) || null : null,
    spawnedFrom: spawned ? { sessionId: spawned.sessionId as string, title: str(spawned.title) ?? undefined } : null,
    branch: str(raw.branch),
    sourceBranch: str(raw.sourceBranch),
  };
}

async function readLive(host: Host, dir: string): Promise<Live[]> {
  const out: Live[] = [];
  let entries: Entry[] = [];
  try {
    entries = await host.list(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
    try {
      const raw: unknown = JSON.parse(await host.read(`${dir}/${entry.name}`));
      if (!isRecord(raw) || typeof raw.pid !== 'number') continue;
      out.push({ pid: raw.pid, hostSessionId: str(raw.hostSessionId), status: str(raw.status) });
    } catch {
      // skipped
    }
  }
  return out;
}

async function alivePids(host: Host, pids: number[]): Promise<Set<number>> {
  const alive = new Set<number>();
  if (pids.length === 0) return alive;
  const ran = await host.run(['ps', '-o', 'pid=', '-p', pids.join(',')], { timeoutMs: 5000 }).catch(() => null);
  if (!ran) return alive;
  for (const line of ran.stdout.split('\n')) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(n)) alive.add(n);
  }
  return alive;
}

async function worktreesOf(host: Host, repo: string): Promise<Worktree[] | null> {
  const ran = await host.run(['git', '-C', repo, 'worktree', 'list', '--porcelain'], { timeoutMs: GIT_MS }).catch(() => null);
  if (!ran || ran.exitCode !== 0) return null;
  const trees: Worktree[] = [];
  let current: Worktree | null = null;
  for (const line of ran.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: norm(line.slice('worktree '.length)), branch: null };
      trees.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return trees;
}

async function fillGit(host: Host, repo: string, kid: Kid, trees: Worktree[]): Promise<void> {
  const branch = kid.branch as string;
  kid.worktree = trees.find(t => t.branch === branch)?.path ?? null;
  const tip = await revOf(host, repo, `refs/heads/${branch}`);
  kid.branchExists = tip !== null;
  if (tip === null) return;
  const sourceTip = await revOf(host, repo, kid.sourceBranch);
  kid.ahead = await count(host, repo, `${kid.sourceBranch}..${branch}`);
  // A branch still at its source's tip has no commits of its own: fresh, not merged.
  const ancestor = await host.run(['git', '-C', repo, 'merge-base', '--is-ancestor', branch, kid.sourceBranch], { timeoutMs: GIT_MS });
  kid.merged = ancestor.exitCode === 0 && tip !== sourceTip;
  // The last commit is the child's own only once it has one; before that it would be the source's.
  if (kid.ahead) {
    const log = await host.run(['git', '-C', repo, 'log', '-1', '--format=%s', branch], { timeoutMs: GIT_MS });
    kid.lastCommit = log.exitCode === 0 ? log.stdout.trim().slice(0, 80) || null : null;
  }
  if (kid.worktree) {
    const status = await host.run(['git', '-C', kid.worktree, 'status', '--porcelain'], { timeoutMs: GIT_MS });
    kid.dirty = status.exitCode === 0 ? status.stdout.split('\n').filter(l => l.trim()).length : null;
  }
}

async function revOf(host: Host, repo: string, ref: string): Promise<string | null> {
  const ran = await host.run(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref], { timeoutMs: GIT_MS });
  return ran.exitCode === 0 ? ran.stdout.trim() || null : null;
}

async function count(host: Host, repo: string, range: string): Promise<number | null> {
  const ran = await host.run(['git', '-C', repo, 'rev-list', '--count', range], { timeoutMs: GIT_MS });
  if (ran.exitCode !== 0) return null;
  const n = Number.parseInt(ran.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

async function dirs(host: Host, path: string): Promise<string[]> {
  return (await host.list(path)).filter(e => e.kind === 'dir').map(e => e.name);
}

function repoOf(m: Meta, byId: Map<string, Meta>): string {
  if (m.originCwd) return m.originCwd;
  const parent = m.spawnedFrom ? byId.get(m.spawnedFrom.sessionId) : undefined;
  return parent?.cwd ?? m.cwd;
}

/** The main checkout a path belongs to: a worktree folder maps to the project above it. */
export function rootOf(path: string): string {
  const at = path.indexOf(WORKTREES_DIR);
  return at === -1 ? path : path.slice(0, at);
}

export function norm(path: string): string {
  return path.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
