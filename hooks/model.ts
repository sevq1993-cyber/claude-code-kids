// Pure functions over a Snapshot: no engine, no I/O. Everything the drawing and
// the /kids report say is computed here, so a test can check the words.

import type { Kid, KidChat, LooseBranch, Orphan, Snapshot } from '../types';

export type Chip = { code: KidChat; label: string; color: string; dim?: boolean };

/** What the child chat is doing right now, from the most certain fact to the least. */
export function chatOf(kid: Kid): Chip {
  if (kid.isLive && kid.liveStatus === 'busy') return { code: 'running', label: '⟳ работает', color: 'yellow' };
  if (kid.isLive) return { code: 'idle', label: '● открыт, ждёт тебя', color: 'cyan' };
  if (kid.isArchived) return { code: 'archived', label: '■ чат в архиве', color: 'gray', dim: true };
  if (kid.summary === 'completed') return { code: 'done', label: '✓ закончил', color: 'green' };
  if (kid.summary === 'review_ready') return { code: 'review', label: '✓ готов к проверке', color: 'green' };
  if (kid.summary === 'blocked') return { code: 'blocked', label: '? ждёт ответа', color: 'magenta' };
  return { code: 'closed', label: '■ чат закрыт', color: 'gray', dim: true };
}

export type TreeChip = { code: 'gone' | 'merged' | 'unmerged' | 'fresh' | 'unknown'; label: string; color: string; dim?: boolean };

/** What is left of the child's work in git, said as what a person does about it. */
export function treeOf(kid: Kid): TreeChip {
  if (kid.branch === null) return { code: 'unknown', label: 'ветки нет', color: 'gray', dim: true };
  const folder = kid.worktree ? ', папка worktree осталась' : '';
  if (kid.branchExists === false) return { code: 'gone', label: `ветка удалена${folder}`, color: 'gray', dim: true };
  if (kid.merged === true) {
    const tail = kid.worktree ? ', папку worktree можно удалить' : '';
    return { code: 'merged', label: `слито в ${kid.sourceBranch}${tail}`, color: 'green' };
  }
  const dirty = kid.dirty ? `, ${plural(kid.dirty, 'несохранённый файл', 'несохранённых файла', 'несохранённых файлов')}` : '';
  if (kid.ahead !== null && kid.ahead > 0) {
    return { code: 'unmerged', label: `не слито: ${plural(kid.ahead, 'коммит', 'коммита', 'коммитов')}${dirty}, проверь и слей`, color: 'red' };
  }
  if (kid.ahead === 0) return { code: 'fresh', label: `коммитов пока нет${dirty}, сливать нечего`, color: 'gray', dim: true };
  return { code: 'unknown', label: 'git не прочитан', color: 'gray', dim: true };
}

export function isUnmerged(kid: Kid): boolean {
  return treeOf(kid).code === 'unmerged';
}

/** Where a branch nobody's chat owns stands against main, said as what to do with it. */
export function standingLabel(b: { ahead: number | null; behind: number | null; merged: boolean | null }): string {
  if (b.merged === true) return 'всё уже в main, можно удалить';
  if (b.ahead === null) return 'git не прочитан';
  if (b.ahead > 0) return `${plural(b.ahead, 'коммит', 'коммита', 'коммитов')} от main`;
  if ((b.behind ?? 0) > 0) return 'отстала от main, своих коммитов нет';
  return 'совпадает с main';
}

/** One line per unclaimed worktree folder: what it holds and what to do with it. */
export function orphanOf(o: Orphan): string {
  const name = o.branch ? (o.isClaude ? shortBranch(o.branch) : o.branch) : o.path.split('/').pop() ?? o.path;
  if (o.branch === null) return `${name} · без ветки${o.isClaude ? '' : ' · не из Claude'}`;
  if (o.isClaude) {
    if (o.merged === true) return `${name} · слито в main, папку можно удалить`;
    if (o.ahead === null) return `${name} · git не прочитан`;
    if (o.ahead > 0) return `${name} · ${plural(o.ahead, 'коммит', 'коммита', 'коммитов')} не слито`;
    return `${name} · пустая, можно удалить`;
  }
  return `${name} · ${standingLabel(o)} · не из Claude`;
}

/** One line per branch that has neither a folder nor a chat. */
export function looseOf(b: LooseBranch): string {
  return `${b.branch} · ${standingLabel(b)}`;
}

/** Every chat of the tree, parents before children, with its depth. */
export function flatten(tree: Kid | null): Array<{ kid: Kid; depth: number }> {
  const out: Array<{ kid: Kid; depth: number }> = [];
  const walk = (kid: Kid, depth: number): void => {
    out.push({ kid, depth });
    for (const c of sortKids(kid.children)) walk(c, depth + 1);
  };
  if (tree) walk(tree, 0);
  return out;
}

export type Totals = { kids: number; running: number; waiting: number; unmerged: number; orphans: number };

/** Counts over the child chats: the main chat and the chat drawing the pane are not counted. */
export function totalsOf(snapshot: Snapshot): Totals {
  const kids = flatten(snapshot.tree).map(r => r.kid).filter(k => !k.isRoot && !k.isMe);
  const chats = kids.map(chatOf);
  return {
    kids: kids.length,
    running: chats.filter(c => c.code === 'running').length,
    waiting: chats.filter(c => c.code === 'blocked' || c.code === 'idle').length,
    unmerged: kids.filter(isUnmerged).length,
    orphans: snapshot.orphans.length,
  };
}

/** The one-line count at the top of the pane. */
export function summaryOf(snapshot: Snapshot): string {
  const t = totalsOf(snapshot);
  if (t.kids === 0 && t.orphans === 0) return 'дочерних чатов нет';
  const parts = [`дочерних ${t.kids}`];
  if (t.running) parts.push(`${t.running} работает`);
  if (t.waiting) parts.push(`${t.waiting} ждёт`);
  if (t.unmerged) parts.push(`${t.unmerged} не слито`);
  if (t.orphans) parts.push(`${plural(t.orphans, 'папка без чата', 'папки без чата', 'папок без чата')}`);
  return parts.join(' · ');
}

export function projectOf(snapshot: Snapshot): string {
  return snapshot.root ? snapshot.root.split('/').pop() || snapshot.root : 'не git-проект';
}

/** The title row of a chat: name, model, and the mark of the chat the pane is drawn in. */
export function titleOf(kid: Kid): string {
  const who = kid.model ? ` · ${shortModel(kid.model)}` : '';
  return `${kid.title}${who}${kid.isMe ? ' · этот чат' : ''}`;
}

/** The branch row of a chat: the main chat sits on its branch, a child says what is left to merge. */
export function branchOf(kid: Kid): string {
  if (kid.isRoot) return kid.model === null && kid.turns === 0 ? 'все главные чаты проекта' : `ветка ${kid.branch ?? 'main'}`;
  return `${kid.branch ? `ветка ${shortBranch(kid.branch)} · ` : ''}${treeOf(kid).label}`;
}

/** The /kids answer: plain text that reads the same in a terminal and in the app. */
export function reportOf(snapshot: Snapshot, now: number): string {
  const lines: string[] = [];
  if (snapshot.error) lines.push(`⚠ ${snapshot.error}`);
  if (snapshot.root === null) {
    lines.push('Этот чат не в git-проекте, а дочерние чаты ищутся по проекту.');
    return lines.join('\n');
  }
  if (snapshot.tree === null) {
    lines.push('Этот чат не найден в истории приложения, дерево построить не из чего.');
    return lines.join('\n');
  }
  lines.push(`Проект ${projectOf(snapshot)} · ${summaryOf(snapshot)}`);
  lines.push('');
  for (const { kid, depth } of flatten(snapshot.tree)) {
    const pad = '   '.repeat(Math.max(0, depth - 1)) + (depth > 0 ? '└─ ' : '');
    const under = ' '.repeat(pad.length);
    lines.push(`${pad}${titleOf(kid)}`);
    const chat = chatOf(kid);
    if (!kid.isRoot) lines.push(`${under}${chat.label} · ${plural(kid.turns, 'ход', 'хода', 'ходов')} · ${ago(kid.lastActivityAt, now)}`);
    lines.push(`${under}${branchOf(kid)}${kid.lastCommit ? ` · «${kid.lastCommit}»` : ''}`);
    if (kid.needsAction && chat.code === 'blocked') lines.push(`${under}вопрос: ${oneLine(kid.needsAction)}`);
  }
  if (snapshot.tree.children.length === 0) lines.push('   Дочерних чатов нет. Карточка «Открой новый чат» создаёт их.');
  if (snapshot.orphans.length) {
    lines.push('');
    lines.push('Папки worktree без чата Claude:');
    for (const o of snapshot.orphans) lines.push(`  ${orphanOf(o)} · ${o.path}`);
  }
  if (snapshot.branches.length) {
    lines.push('');
    lines.push('Ветки без папки и без чата:');
    for (const b of snapshot.branches) lines.push(`  ${looseOf(b)}`);
  }
  lines.push('');
  lines.push('Мод ничего не сливает и не удаляет сам.');
  return lines.join('\n');
}

export function sortKids(kids: readonly Kid[]): Kid[] {
  const rank = (kid: Kid): number => {
    const c = chatOf(kid).code;
    if (c === 'running') return 0;
    if (c === 'blocked' || c === 'idle') return 1;
    if (isUnmerged(kid)) return 2;
    if (c === 'done' || c === 'review') return 3;
    return 4;
  };
  return [...kids].sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt);
}

/** Text for the prompt box: a human presses Enter, the mod never merges. */
export function mergePromptOf(kid: Kid, root: string | null): string {
  const branch = kid.branch ?? '';
  const where = root ? ` в ${root}` : '';
  return `Проверь ветку ${branch}${where} (чат «${kid.title}»): прогони проверки, покажи что изменилось, и если всё хорошо, слей её в ${kid.sourceBranch} и убери папку worktree. Перед слиянием спроси подтверждение.`;
}

export function ago(at: number, now: number): string {
  if (!at) return 'когда, неизвестно';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? few : many;
  return `${n} ${word}`;
}

export function shortBranch(branch: string): string {
  return branch.replace(/^claude\//, '').replace(/-[0-9a-f]{6}$/, '');
}

export function shortModel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  if (!m) return model;
  const name = (m[1] ?? '').replace(/^./, c => c.toUpperCase());
  return `${name} ${m[2]}.${m[3]}`;
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
