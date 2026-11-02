# @jpisgeek/herdr-swamp-layout

Installs the [Herdr swamp layout](https://github.com/jpisgeek/herdr-swamp-layout)
into the Herdr desktop app: approvals, runs and quick-run panels for the swamp
CLI, a status item, and the swamp-club theme.

```sh
swamp extension pull @jpisgeek/herdr-swamp-layout
swamp behavior create @jpisgeek/herdr-swamp-layout herdr-swamp-layout
swamp behavior run @jpisgeek/herdr-swamp-layout install herdr-swamp-layout
```

Then check and switch:

```sh
for m in swamp-approvals swamp-runs swamp-quickrun swamp-tabs swamp-status; do
  herdr-app check ~/.config/herdr-app/mods/$m
done
herdr-app do layout.switch '{"name":"swamp"}'
```

`install` never overwrites. If a target already exists it stops before copying
anything. It targets `$HERDR_APP_HOME`, else `~/.config/herdr-app`; set
`herdrHome` in the behavior's global arguments to override.

The panels watch every open Herdr space whose folder has a `.swamp.yaml`. To
watch a repo with no open space, add its path to `REPOS` in the three panel mods.

The mods run programs (`swamp`, through `exec`) and read each watched repo's
`.swamp.yaml`. They make no network requests. Every action that changes a run
needs a second click on Confirm.

Pair it with [`@jpisgeek/herdr-swamp-fixtures`](../fixtures) to try the panels
safely.
