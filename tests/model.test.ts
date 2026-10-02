import { describe, expect, test } from 'claude-code/testing';

import { ago, branchOf, chatOf, flatten, looseOf, orphanOf, plural, reportOf, shortBranch, shortModel, sortKids, summaryOf, titleOf, treeOf } from '../hooks/model';
import { rootOf } from '../hooks/scan';
import type { Kid, Snapshot } from '../types';

const NOW = Date.UTC(2026, 9, 2, 12, 0);

const kid = (over: Partial<Kid> = {}): Kid => ({
  id: 'local_1',
  title: 'Remove Directus',
  isMe: false,
  isRoot: false,
  branch: 'claude/cool-bhaskara-7e0927',
  sourceBranch: 'main',
  worktree: null,
  model: 'claude-opus-5-5',
  turns: 14,
  lastActivityAt: NOW - 3_600_000,
  isArchived: false,
  isLive: false,
  liveStatus: null,
  summary: 'review_ready',
  needsAction: null,
  branchExists: true,
  ahead: 14,
  merged: false,
  dirty: 0,
  lastCommit: 'feat: drop directus bridge',
  children: [],
  ...over,
});

const main = (children: Kid[], over: Partial<Kid> = {}): Kid =>
  kid({ id: 'local_0', title: 'Главный чат', isRoot: true, branch: null, ahead: null, merged: null, lastCommit: null, summary: null, children, ...over });

const snap = (tree: Kid | null, orphans: Snapshot['orphans'] = []): Snapshot => ({
  scannedAt: NOW,
  root: '/Users/me/Projects/Shop',
  tree,
  orphans,
  branches: [],
  error: null,
});

describe('what a child chat is doing', () => {
  test('a live busy session is running, whatever its summary says', () => {
    expect(chatOf(kid({ isLive: true, liveStatus: 'busy', summary: 'completed' })).code).toBe('running');
  });
  test('an archived chat reads as archived, not as finished', () => {
    expect(chatOf(kid({ isArchived: true, summary: 'completed' })).code).toBe('archived');
  });
  test('the app summary decides when nothing else does', () => {
    expect(chatOf(kid({ summary: 'completed' })).code).toBe('done');
    expect(chatOf(kid({ summary: 'review_ready' })).code).toBe('review');
    expect(chatOf(kid({ summary: 'blocked' })).code).toBe('blocked');
    expect(chatOf(kid({ summary: null })).code).toBe('closed');
  });
});

describe('what is left of the work, said as what to do', () => {
  test('a deleted branch is a state, not an error', () => {
    expect(treeOf(kid({ branchExists: false })).label).toBe('ветка удалена');
    expect(treeOf(kid({ branchExists: false, worktree: '/x/.claude/worktrees/a' })).label).toBe('ветка удалена, папка worktree осталась');
  });
  test('merged says whether a folder is left to remove', () => {
    expect(treeOf(kid({ merged: true, worktree: null })).label).toBe('слито в main');
    expect(treeOf(kid({ merged: true, worktree: '/x/.claude/worktrees/a' })).label).toBe('слито в main, папку worktree можно удалить');
  });
  test('unmerged counts commits and dirty files and asks for a review', () => {
    expect(treeOf(kid({ ahead: 14, dirty: 2 })).label).toBe('не слито: 14 коммитов, 2 несохранённых файла, проверь и слей');
    expect(treeOf(kid({ ahead: 1 })).label).toBe('не слито: 1 коммит, проверь и слей');
  });
  test('a branch still at its source tip is fresh, with nothing to merge', () => {
    expect(treeOf(kid({ ahead: 0, merged: false })).label).toBe('коммитов пока нет, сливать нечего');
    expect(treeOf(kid({ ahead: 0, merged: false, dirty: 3 })).label).toBe('коммитов пока нет, 3 несохранённых файла, сливать нечего');
  });
  test('the branch row names the branch; the main chat just sits on its own', () => {
    expect(branchOf(kid())).toBe('ветка cool-bhaskara · не слито: 14 коммитов, проверь и слей');
    expect(branchOf(main([]))).toBe('ветка main');
  });
  test('an orphan folder says what it holds', () => {
    expect(orphanOf({ path: '/r/.claude/worktrees/quirky-shirley-9e1286', branch: 'claude/quirky-shirley-9e1286', ahead: 0, behind: 0, merged: false, isClaude: true })).toBe('quirky-shirley · пустая, можно удалить');
    expect(orphanOf({ path: '/r/.claude/worktrees/x', branch: 'claude/x', ahead: 2, behind: 0, merged: false, isClaude: true })).toBe('x · 2 коммита не слито');
    expect(orphanOf({ path: '/r/wt/blog', branch: 'codex/blog-redesign', ahead: 12, behind: 3, merged: false, isClaude: false })).toBe('codex/blog-redesign · 12 коммитов от main · не из Claude');
    expect(orphanOf({ path: '/r/wt/old', branch: 'codex/old', ahead: 0, behind: 5, merged: false, isClaude: false })).toBe('codex/old · отстала от main, своих коммитов нет · не из Claude');
    expect(orphanOf({ path: '/r/.claude/worktrees/loose', branch: null, ahead: null, behind: null, merged: null, isClaude: true })).toBe('loose · без ветки');
  });
});

describe('branches nothing else shows', () => {
  test('a loose branch says where it stands against main', () => {
    expect(looseOf({ branch: 'codex/try', ahead: 3, behind: 0, merged: false })).toBe('codex/try · 3 коммита от main');
    expect(looseOf({ branch: 'codex/done', ahead: 0, behind: 2, merged: true })).toBe('codex/done · всё уже в main, можно удалить');
    expect(looseOf({ branch: 'codex/same', ahead: 0, behind: 0, merged: false })).toBe('codex/same · совпадает с main');
  });
});

describe('the project a path belongs to', () => {
  test('a worktree folder maps to the checkout above it', () => {
    expect(rootOf('/Users/me/Projects/Shop/.claude/worktrees/hungry-kapitsa-6f0165')).toBe('/Users/me/Projects/Shop');
    expect(rootOf('/Users/me/Projects/Shop')).toBe('/Users/me/Projects/Shop');
  });
});

describe('the tree', () => {
  test('parents come before children, each with its depth', () => {
    const tree = main([kid({ id: 'a', children: [kid({ id: 'aa' })] }), kid({ id: 'b' })]);
    expect(flatten(tree).map(r => `${r.kid.id}:${r.depth}`)).toEqual(['local_0:0', 'a:1', 'aa:2', 'b:1']);
  });
  test('the chat drawing the pane is marked, and only it', () => {
    expect(titleOf(kid({ isMe: true }))).toBe('Remove Directus · Opus 5.5 · этот чат');
    expect(titleOf(kid())).toBe('Remove Directus · Opus 5.5');
  });
  test('the count row counts child chats, not the main chat and not this one', () => {
    const s = snap(
      main([kid({ isLive: true, liveStatus: 'busy' }), kid({ id: 'local_2', summary: 'blocked', ahead: 0 }), kid({ id: 'local_3', isMe: true })]),
      [{ path: '/r/.claude/worktrees/quirky-shirley-9e1286', branch: 'claude/quirky-shirley-9e1286', ahead: 0, behind: 0, merged: false, isClaude: true }],
    );
    expect(summaryOf(s)).toBe('дочерних 2 · 1 работает · 1 ждёт · 1 не слито · 1 папка без чата');
  });
  test('running first, then waiting, then unmerged, then finished', () => {
    const order = sortKids([
      kid({ id: 'done', summary: 'completed', merged: true, ahead: 0 }),
      kid({ id: 'unmerged' }),
      kid({ id: 'running', isLive: true, liveStatus: 'busy' }),
      kid({ id: 'blocked', summary: 'blocked', ahead: 0 }),
    ]).map(k => k.id);
    expect(order).toEqual(['running', 'blocked', 'unmerged', 'done']);
  });
  test('the report draws the tree from the main chat down', () => {
    const text = reportOf(snap(main([kid({ children: [kid({ id: 'aa', title: 'Внук', isMe: true, ahead: 0 })] })], { isMe: false })), NOW);
    expect(text).toContain('Проект Shop · дочерних 1 · 1 не слито');
    expect(text).toContain('Главный чат · Opus 5.5\nветка main\n└─ Remove Directus · Opus 5.5\n   ✓ готов к проверке · 14 ходов · 1 ч назад\n   ветка cool-bhaskara · не слито: 14 коммитов, проверь и слей · «feat: drop directus bridge»\n   └─ Внук · Opus 5.5 · этот чат');
    expect(text).toContain('Мод ничего не сливает и не удаляет сам.');
  });
  test('no children and no project are said in words', () => {
    expect(reportOf(snap(main([])), NOW)).toContain('Дочерних чатов нет.');
    expect(reportOf({ ...snap(null), root: null }, NOW)).toContain('не в git-проекте');
    expect(reportOf(snap(null), NOW)).toContain('не найден в истории приложения');
  });
});

describe('small words', () => {
  test('russian plurals', () => {
    expect(plural(1, 'коммит', 'коммита', 'коммитов')).toBe('1 коммит');
    expect(plural(3, 'коммит', 'коммита', 'коммитов')).toBe('3 коммита');
    expect(plural(11, 'коммит', 'коммита', 'коммитов')).toBe('11 коммитов');
    expect(plural(22, 'коммит', 'коммита', 'коммитов')).toBe('22 коммита');
  });
  test('branches and models are shortened for the eye', () => {
    expect(shortBranch('claude/cool-bhaskara-7e0927')).toBe('cool-bhaskara');
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5');
  });
  test('time ago in minutes, hours, days', () => {
    expect(ago(NOW - 30_000, NOW)).toBe('только что');
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5 мин назад');
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 ч назад');
    expect(ago(NOW - 3 * 86_400_000, NOW)).toBe('3 дн назад');
  });
});
