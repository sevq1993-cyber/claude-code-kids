# Kids: child chats for Claude Code

A mod for Claude Code: one command, `/kids`, opens a pane with the tree of
child chats spawned from the current chat, from the main chat down.

```
Shop · 2 children · 1 waiting

Main chat · Opus 5.5 · this chat
branch main
└─ Remove Directus · Opus 5.5
   ✓ ready for review · 14 turns · 1 h ago
   branch cool-bhaskara · not merged: 14 commits, review and merge
└─ Fix checkout form · Opus 5.5
   ● open, waiting for you · 3 turns · 5 min ago
   branch quirky-shirley · no commits yet, nothing to merge

Worktree folders with no Claude chat
  codex/blog-redesign · everything already in main, safe to delete · not Claude's
```

For every chat in the tree it shows what the chat is doing (running, waiting
for you, ready for review, archived), its branch, and what is left of its
work in git: not merged and how many commits, merged and the folder can go,
or no commits yet. The chat the pane is drawn in is marked "this chat", so
you always know where you are. Below the tree: worktree folders no chat
claims, and local branches with neither a folder nor a chat.

The mod reads the desktop app's own chat metadata and asks git questions. It
never merges, deletes, or calls the model. The only button, "to prompt: review
and merge", fills the prompt box with a request you send yourself.

## What it reads, runs and sends

- Reads: the chat metadata files of the Claude desktop app under
  `~/Library/Application Support/Claude/claude-code-sessions/` (chat titles,
  working directories, branches, status) and the session files under
  `~/.claude/sessions/` (process ids). It does not read the conversation.
- Runs: only `git` and `ps`, on this machine, in read-only mode. The `git`
  subcommands are fixed in `hooks/scan.ts`: `worktree list`, `for-each-ref`,
  `rev-parse`, `rev-list --count`, `merge-base --is-ancestor`, `log -1` and
  `status --porcelain`; the only variable parts are the repository path, a
  worktree path and branch names taken from the metadata above. `ps` is run
  with `-o pid= -p <pids>` to see which chats still have a live process.
- Sends: nothing. No network calls, no model calls, no writes outside the
  plugin's own store, which keeps one list: the projects where the pane opens
  by itself.
- Hooks: `ui.close` on its own pane, only to remember that you closed it by
  hand so it stops opening by itself in that project. It does not change the
  close call.

The text of the pane is in Russian. The words live in one file,
`hooks/model.ts`, so translating is a small change.

## Requirements

- Claude Code 2.1.28x with mods (function hooks) enabled: add
  `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` to `~/.claude/settings.json`.
  Mods are early access; without the flag the command is simply absent.
- The Claude desktop app on macOS. Child chats are the ones the app opens from
  task cards; their metadata lives under
  `~/Library/Application Support/Claude/claude-code-sessions/`. In a plain
  terminal session the pane still works, rooted at every main chat of the project.
- A git project. Worktrees are expected under `<repo>/.claude/worktrees/`,
  which is where the desktop app puts them.

## Install

From this repository as a marketplace:

```bash
claude plugin marketplace add sevq1993-cyber/claude-code-kids
claude plugin install kids@claude-code-kids
```

Or load it for every session without a marketplace: clone the repository and
symlink or move it to `~/.claude/skills/kids`. Or for one terminal session:
`claude --plugin-dir ./claude-code-kids`.

Then open a new chat in a project and type `/kids`. Once opened in a project,
the pane opens by itself in every new chat of that project until you close it.

## Development

```bash
claude plugin validate --strict .
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
claude -p "/plugin-types ."    # writes .claude/types/claude-code.d.ts for tsc
bun x tsc -p .
```

Layout: `hooks/register.tsx` (hooks and the pane), `hooks/scan.ts` (the
collector: metadata, live sessions, git), `hooks/model.ts` (every sentence the
pane shows, pure functions), `types/index.d.ts` (the state contract),
`tests/model.test.ts`.

## License

MIT
