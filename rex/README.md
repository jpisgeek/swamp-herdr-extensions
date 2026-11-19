# @jpisgeek/rex-herdr

Adds [herdr-core](https://herdr.dev) and swamp to the command palette of Rex,
the terminal multiplexer.

| Palette entry | What it does |
|---|---|
| **Herdr: Pick Terminal** (`cmd+shift+h`) | Opens herdr-core's own picker (`hc`) in a floating pane. Pick any terminal or agent, on this machine or on one added with `hc machine add`, and the pane attaches to it. `ctrl+\` detaches and closes the pane. The program keeps running. |
| **Herdr: New Kept Agent** | Opens a tab running Amp with its saved model/provider settings that herdr-core owns. Closing the tab only detaches it, so the agent stays reachable from the picker and from the Herdr app. |
| **Swamp: Approvals** | Lists the gates waiting in the nearest swamp repo. You can approve or reject one, then resume its run. |
| **Swamp: Recent Runs** | Shows `swamp run history` for the last 24 hours. |
| **Swamp: Run Workflow** | Lists the repo's workflows and runs the one you pick, with optional JSON inputs. |
| **Swamp: Stats** | The last 7 days, or 30 on request, from `swamp summarise`: workflow and method runs, success rate, median durations, the most frequent failures, and data items and versions. It also says whether `swamp serve` runs on this machine, and never starts it. These are the same numbers as the Herdr swamp-stats window. |

Every entry starts in the folder of the focused pane. The swamp entries find
their repo by walking up from it to the nearest `.swamp.yaml`. Anything that
changes a run asks you to type `yes`.

## Install

```sh
swamp extension pull @jpisgeek/rex-herdr
swamp behavior create @jpisgeek/rex-herdr rex-herdr
swamp behavior run @jpisgeek/rex-herdr install rex-herdr
```

`install` copies three files into the Rex config folder (`$REX_CONFIG`'s folder,
else `$XDG_CONFIG_HOME/rex`, else `~/.config/rex`):

- `rex_herdr.lua`, the palette entries
- `rex-herdr-swamp`, the swamp menus (POSIX `sh` and `jq`)
- `swamp-club`, the Swamp Club color theme in Ghostty's format

When there is no `init.lua`, `install` writes one that loads the module. An
existing `init.lua` is never edited. Instead, the install result's `addLine`
gives the line to add:

```lua
require("rex_herdr").setup({})
```

`install` then runs `rex config check` and, when the check is clean, asks the
running Rex server to reload its config. Pass `--input reload=false` to skip
the reload. Running `install` again is safe. A file that is already current is
left alone, and one that differs from the bundled copy stops the install before
anything is copied.

Linked config directories or destination files, including dangling symlinks,
are refused before copying. This is not a security boundary against hostile
concurrent filesystem changes.

`status` reports whether all three files are installed and current, whether
`init.lua` loads them, and what `rex config check` says. It changes nothing.

```sh
swamp behavior run @jpisgeek/rex-herdr status rex-herdr
```

## Configure

`setup` takes these fields, all optional:

```lua
require("rex_herdr").setup({
  hc = "/path/to/hc",                 -- default ~/.local/bin/hc
  agent = { "amp" },                  -- uses your saved Amp settings
  bounds = { 0.08, 0.06, 0.84, 0.84 }, -- floating pane: x, y, w, h as fractions
  theme = "swamp-club",               -- or false, or a path to a Ghostty theme file
  keys = { herdr_pick = "cmd+shift+h", swamp_approvals = "cmd+shift+a" },
})
```

`keys` maps an action name to a key. The action names are `herdr_pick`,
`herdr_agent`, `swamp_approvals`, `swamp_runs`, `swamp_workflow` and
`swamp_stats`. Set a key to
`false` to leave that action unbound.

## Theme

The panes this module opens use the **Swamp Club** palette by Don O'Neill
([sntxrr/ghostty-swamp-club](https://github.com/sntxrr/ghostty-swamp-club),
the companion to [sntxrr/herdr-swamp-club](https://github.com/sntxrr/herdr-swamp-club),
MIT). It's the swamp-club.com colors: a black canvas, neutral gray text, a
`#39ff14` neon cursor, and the site's cyan, magenta and glitch red. The file
ships unchanged as `swamp-club` beside the module. The module reads it when
Rex loads its config and passes the colors to each pane it creates, so your
other panes keep their own theme.

Set `theme = false` for Rex's own colors, or point `theme` at any Ghostty
theme file. The module reads `palette = N=#rrggbb`, `background`,
`foreground` and `cursor-color`, and ignores everything else. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the license.

## How it works

Rex can't render a herdr-core terminal by itself, and herdr-core has no Rex
client, so the bridge is `hc attach` running in an ordinary Rex terminal.
herdr-core keeps the program alive. Rex only shows it. An agent started with
**New Kept Agent** gets `--keep` (lost programs come back as a shell), no
parent, a name like `rex-091624`, and the label `rex.session=<id>` so you can
find it with `hc ls`.

The module and helper make no network requests. They run `hc`, `swamp` and
`jq`, and they call Rex's own API (`session.view`, `session.new_layer`,
`session.new_window` and the terminal's `process` method).

## Remove

There is no `uninstall` method. To remove it, delete `rex_herdr.lua` and
`rex-herdr-swamp` from the Rex config folder, remove the `require("rex_herdr")`
line from `init.lua`, and run `rex config reload`. Agents started with
**New Kept Agent** belong to herdr-core. They keep running until you end them
(`hc ls`, then `hc kill <terminal>`).

## Requires

- Rex with Lua config support (tested with Rex Beta 0.1.0 build 2042,
  server API revision 7); its `rex` CLI must be on `PATH` for config checks
  and reloads
- herdr-core 0.1.19 or later (`hc`)
- swamp and `jq` for the swamp entries
- macOS or Linux

Pair it with [`@jpisgeek/herdr-swamp-layout`](../layout) for the same swamp
panels inside the Herdr app, and with
[`@jpisgeek/herdr-swamp-fixtures`](../fixtures) to try the approvals entry on a
harmless gate.
