# mod-guard

A guard for [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview). Before any other mod loads, it
reads the mod's code, asks a model to review it, and refuses what the review doesn't trust. While the session runs, it
blocks any script of a reviewed mod that changed after the review.

I wrote it after measuring what a mod can do from inside a session: read your connectors on a timer, start programs
with your permissions and leave nothing in the session history. The full write-up is on my blog.

## Why

A mod is code that ships inside a Claude Code plugin and runs inside Claude Code, with your permissions. The
documentation says it plainly: mods aren't sandboxed, and the programs they start run outside the sandbox. In a scan of
the public mods in early November 2026, about 40% start programs on your machine and one in three reads environment
variables, which is where many people keep their API keys.

`claude plugin validate` tells you what a mod's code calls. It doesn't tell you whether that matches what the mod says it
does, and it can't see a script the mod runs later.

## What it does

| When | What mod-guard does |
|---|---|
| Another mod is about to load (`plugin.register`) | Reads every file in that plugin's folder, hashes them, and sends the code to a model (Opus by default) with a security review prompt. If the answer is anything but `allow`, the mod doesn't load and the reason shows in the transcript and the debug log |
| The same mod loads again, unchanged | Uses the cached verdict (keyed by the hash of the whole folder). A single changed file means a new review |
| A reviewed mod starts a program (`process.run`, `process.spawn`) | If the command line names a file inside that mod's folder, its hash has to match the one reviewed. A script edited after the review is denied |
| The review or the check itself fails | Fails closed: the mod doesn't load, the program doesn't start. An empty answer from the reviewer is asked again up to five times; if it stays empty, the mod is refused for this session and reviewed again next time (nothing is cached) |

Tested on Claude Code 2.1.316:

- a mod that claims to be a clock and runs a helper script on a timer was **refused**: *"The description says the mod only 'Shows a nice clock under the prompt.' Nothing it actually does needs the clock it shows…"*;
- a mod that only shows a status line was **admitted**;
- an honest mod that runs its own `helper.py` was **admitted**, and when `helper.py` was edited with the session open,
  its next run was **denied**: *"mod-guard: …/helper.py changed after the review"*.

The three test mods are in [`examples/`](examples/).

## Install

mod-guard can only judge the mods that load **after** it. So it has to load first.

**To try it**, load it before the mods you want checked:

```bash
claude --plugin-dir ./mod-guard --plugin-dir ./some-mod
```

**To protect every session**, run it ahead of every mod a user installs, with `prependPlugins` in
[managed settings](https://code.claude.com/docs/en/managed-settings). Claude Code reads that key from managed settings,
and from `~/.claude/settings.json` only on a machine with no managed settings and a session that isn't on a Team or
Enterprise login. A managed mod has to be installed from a local directory marketplace; see
[Install your organization's mods](https://code.claude.com/docs/en/plugins/mods/admin#install-your-organizations-mods).

```json
{
  "extraKnownMarketplaces": {
    "local-guards": { "source": { "source": "directory", "path": "/opt/claude-guards" } }
  },
  "enabledPlugins": { "mod-guard@local-guards": true },
  "prependPlugins": ["mod-guard@local-guards", "sec-default@builtin"]
}
```

Keep `sec-default@builtin` in the list, or you remove Claude Code's built-in guard.

## Limits

- **It judges code, not behaviour.** A careful attacker can write code that reads as innocent. The review raises the bar;
  reading the code yourself still matters.
- **The hash check covers files inside the mod's own folder** that appear on the command line. A mod that runs a script
  from somewhere else, or downloads one, is something the review should catch at load time.
- **It is a mod too.** It runs with your permissions and sees the code of every mod you load. Read it before you trust
  it: it's one file, [`hooks/register.js`](hooks/register.js).
- **Each new or changed mod costs one model call** on your plan or API key.
- **`--safe-mode` and a crashed hooks worker unload every installed mod**, this one included.

## Configure

At the top of `hooks/register.js`: `MODEL` (any alias or model id Claude Code accepts; `opus` by default), `EFFORT` (`high` by default), `MAX_FILES` and `MAX_BYTES`
(how much code goes to the reviewer), and the review prompt in `SYSTEM`.

## License

MIT
