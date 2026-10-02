// kids: the child chats (spawned through task cards), what they are doing, and
// what of their work is still not merged. A pane, opened by /kids. Read-only: it asks git
// questions and reads the app's own metadata; merging stays with a person.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { Kid, Snapshot } from '../types';
import { ago, branchOf, chatOf, flatten, isUnmerged, looseOf, mergePromptOf, orphanOf, plural, projectOf, reportOf, shortModel, summaryOf, treeOf } from './model';
import { scan, type Host } from './scan';

const PANE = 'kids';
const PANE_TITLE = 'Дочерние чаты';
const REFRESH_MS = 30_000;
/** $.store key: the projects whose pane opens by itself in every chat, until a person closes it. */
const AUTO_OPEN = 'autoOpen';

const snapshot = atom({ plugin: 'kids', key: 'snapshot' } as const, null);

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await $.command.register({
      name: 'kids',
      description: 'Дочерние чаты проекта: панель с тем, что они делают и что не слито',
    });
    $.clock.every(REFRESH_MS, () => {
      void refresh($);
    });
    await refresh($);
    // Unasked: a surface that places panes seats it, any other leaves it waiting.
    if (await isAutoOpen($)) void $.ui.open({ id: PANE, title: PANE_TITLE, closeOnEscape: true });
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) void refresh($);
    return result;
  });

  on('command.run', { command: 'kids' }, async $ => {
    await refresh($);
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true });
    await setAutoOpen($, true);
    return { text: opened.isPlaced ? 'Панель «Дочерние чаты» открыта.' : 'Панель не поместилась на этом экране, вот текстом:\n\n' + (await textOf($)) };
  });

  // Closed by hand, the pane stops coming back in this project's chats.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await setAutoOpen($, false);
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const snap = await read($, snapshot);
    const now = Date.now();
    if (snap === null) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Читаю дочерние чаты…</Text>
        </Box>
      );
    }
    const narrow = e.props.bodyColumns < 48;
    const row = (kid: Kid, depth: number) => {
      const chat = chatOf(kid);
      const tree = treeOf(kid);
      return (
        <Box key={kid.id} flexDirection="column" marginTop={depth === 0 ? 0 : 1} paddingLeft={depth === 0 ? 0 : 3 * (depth - 1)}>
          <Box flexDirection="row">
            {depth > 0 && <Text dimColor>└─ </Text>}
            <Text bold>{kid.title}</Text>
            {!narrow && kid.model && <Text dimColor> · {shortModel(kid.model)}</Text>}
            {kid.isMe && <Text color="cyan"> · этот чат</Text>}
          </Box>
          <Box flexDirection="column" paddingLeft={depth > 0 ? 3 : 0}>
            {!kid.isRoot && (
              <Box flexDirection="row">
                <Text color={chat.color} dimColor={chat.dim}>
                  {chat.label}
                </Text>
                <Text dimColor>
                  {' '}· {plural(kid.turns, 'ход', 'хода', 'ходов')} · {ago(kid.lastActivityAt, now)}
                </Text>
              </Box>
            )}
            <Text color={kid.isRoot ? undefined : tree.color} dimColor={kid.isRoot || tree.dim}>
              {branchOf(kid)}
            </Text>
            {kid.lastCommit && !narrow && <Text dimColor>«{kid.lastCommit}»</Text>}
            {kid.needsAction && chat.code === 'blocked' && <Text color="magenta">вопрос: {kid.needsAction}</Text>}
            {isUnmerged(kid) && (
              <Box flexDirection="row">
                <Button
                  key={`merge-${kid.id}`}
                  label="в промпт: проверить и слить"
                  onPress={() => {
                    void $.prompt.fill({ text: mergePromptOf(kid, snap.root) });
                  }}
                />
              </Box>
            )}
          </Box>
        </Box>
      );
    };
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>
          {projectOf(snap)} · {summaryOf(snap)} · {ago(snap.scannedAt, now)}
        </Text>
        {snap.error && <Text color="yellow">⚠ {snap.error}</Text>}
        {snap.root === null && <Text>Этот чат не в git-проекте, а дочерние чаты ищутся по проекту.</Text>}
        {snap.root !== null && snap.tree === null && <Text>Этот чат не найден в истории приложения, дерево построить не из чего.</Text>}
        {snap.tree !== null && <Box flexDirection="column" marginTop={1}>{flatten(snap.tree).map(r => row(r.kid, r.depth))}</Box>}
        {snap.tree !== null && snap.tree.children.length === 0 && (
          <Text dimColor>Дочерних чатов нет. Карточка «Открой новый чат» создаёт их.</Text>
        )}
        {snap.orphans.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="red">
              Папки worktree без чата Claude
            </Text>
            {snap.orphans.map(o => (
              <Box key={o.path} flexDirection="row">
                <Text dimColor>{orphanOf(o)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {snap.branches.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Ветки без папки и без чата</Text>
            {snap.branches.map(b => (
              <Box key={b.branch} flexDirection="row">
                <Text dimColor>{looseOf(b)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  });
};

let scanning: Promise<void> | null = null;

/** One scan at a time; every caller awaits the same run. */
function refresh($: EngineInterface): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      const next = await scan(hostOf($));
      await update($, snapshot, () => next);
    } catch (error) {
      const now = Date.now();
      await update($, snapshot, (old: Snapshot | null) => ({
        scannedAt: now,
        root: old?.root ?? null,
        tree: old?.tree ?? null,
        orphans: old?.orphans ?? [],
        branches: old?.branches ?? [],
        error: `сканирование упало: ${String(error)}`,
      }));
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

async function textOf($: EngineInterface): Promise<string> {
  const snap = await read($, snapshot);
  if (snap === null) return 'Дочерние чаты ещё не прочитаны, попробуйте через секунду.';
  return reportOf(snap, Date.now());
}

async function rootOf($: EngineInterface): Promise<string | null> {
  return (await read($, snapshot))?.root ?? null;
}

async function autoOpenList($: EngineInterface): Promise<string[]> {
  const raw = await $.store.get(AUTO_OPEN);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

async function isAutoOpen($: EngineInterface): Promise<boolean> {
  const root = await rootOf($);
  return root !== null && (await autoOpenList($)).includes(root);
}

async function setAutoOpen($: EngineInterface, enabled: boolean): Promise<void> {
  const root = await rootOf($);
  if (root === null) return;
  const list = (await autoOpenList($)).filter(r => r !== root);
  await $.store.set(AUTO_OPEN, enabled ? [...list, root] : list);
}

function hostOf($: EngineInterface): Host {
  return {
    home: () => $.env.get('HOME'),
    cwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    now: () => $.clock.now(),
    list: (path: string) => $.fs.list(path),
    read: (path: string) => $.fs.read(path),
    run: (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => $.process.run(argv, init),
  };
}
