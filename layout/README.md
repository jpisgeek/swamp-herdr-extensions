# @jpisgeek/herdr-swamp-layout

Installs the [Herdr swamp layout](https://github.com/jpisgeek/swamp-herdr-extensions/tree/main/layout)
into the Herdr desktop app: approvals, runs and quick-run panels for the swamp
CLI, a filterable go-to popup, on-demand stats, a status item, and the swamp-club theme.

```sh
swamp extension pull @jpisgeek/herdr-swamp-layout
swamp behavior create @jpisgeek/herdr-swamp-layout herdr-swamp-layout
swamp behavior run @jpisgeek/herdr-swamp-layout install herdr-swamp-layout
```

Then check and switch:

```sh
for m in swamp-approvals swamp-runs swamp-quickrun swamp-tabs swamp-status swamp-goto swamp-stats; do
  herdr-app check ~/.config/herdr-app/mods/$m
done
herdr-app do layout.switch '{"name":"swamp"}'
```

`install` never overwrites. If a target already exists it stops before copying
anything. It targets `$HERDR_APP_HOME`, else `~/.config/herdr-app`; set
`herdrHome` in the behavior's global arguments to override.

The panels watch every local open Herdr space whose folder has a `.swamp.yaml`.
Use the local JSON setting below to watch a local repo without an open space.
Remote spaces are not silently read through matching local paths.

The mods run programs (`swamp`, through `exec`) and read each watched repo's
`.swamp.yaml`. They make no network requests. Every action that changes a run
needs a second click on Confirm.

Pair it with [`@jpisgeek/herdr-swamp-fixtures`](../fixtures) to try the panels
safely.

## Optional safe updates

Updating the extension package and updating Herdr's installed files are separate
steps. `swamp extension update` fetches the package. It does not change your
Herdr layout. Run the `upgrade` method only when you want to change those files.
The backup and restore code lives in this extension package, not in watched
repositories. It never changes Git files, commits, remotes, or watched repo data.
Users who copy the layout files directly do not need this update mechanism.

Keep extra watched targets in `~/.config/herdr-app/swamp.json`, rather than
editing the runs panel's JavaScript:

```json
{"repos":["~/projects/example-swamp-repo"]}
```

The panels read this file, add layout-provided targets and local open Swamp
spaces, and remove duplicates. Missing or invalid JSON is treated as an empty
list. Stats reads only when opened, refreshed or switched between 7 and 30 days;
it never starts Swamp serve. The file is personal data. Do not commit
it to a public repository.

For an existing model named `herdr-swamp-layout`:

```sh
swamp extension update @jpisgeek/herdr-swamp-layout --check
swamp extension update @jpisgeek/herdr-swamp-layout
swamp behavior run @jpisgeek/herdr-swamp-layout upgrade herdr-swamp-layout
```

Before replacing files, `upgrade` verifies all managed files against the previous
install receipt or bundled known-release checksums. Unknown or edited files stop
the operation before it writes any managed files. There is no force-overwrite
option. Back up and explicitly merge local edits, or keep your current install.
Do not restore an old JavaScript file over a new release to recover a config:
that can remove the fix you just installed.

The method saves a local rollback copy of managed files and a separate snapshot
of `swamp.json`. It leaves the live `swamp.json` unchanged. It stores its receipt
in `.swamp-layout-state.json` and backups in `.swamp-layout-backup` beneath Herdr's
home. Previous backup directories are retained with unique suffixes. These are
local only, may contain private paths, and must not be published. Backups can
accumulate; review them locally when you no longer need a recovery point.

Run each mod through `herdr-app check`, then reload the layout and check that
your watched repositories still appear. Do not call an update verified just
because package download or schema validation passed.

To undo the most recent managed-file change:

```sh
swamp behavior run @jpisgeek/herdr-swamp-layout rollback herdr-swamp-layout
```

Rollback verifies the saved files' checksums and refuses to overwrite later
edits. It does not replace your personal config with an older copy. Recover
that separate snapshot manually only if you need it. A repeated upgrade to the
same bytes makes no changes and preserves the rollback point.

### Limits and recovery

- Use this only in a trusted local Herdr home. Close Herdr and stop editors,
  sync clients, and other processes that can change this tree during updates.
  A lock prevents two extension operations at once. Other programs do not honor
  it. This updater is not a security boundary against a hostile concurrent writer.
- The update preflights all files and uses atomic replacement per file. It is
  not an atomic directory swap. An ordinary write failure attempts to restore
  only the files it wrote, unless another process has edited them.
- A power loss or killed process can leave a partial update and a lock directory.
  Do not simply remove the lock and retry. Compare the local receipt, backup,
  and installed files, then recover the interrupted operation explicitly.
- The updater checks for symbolic links before filesystem operations and refuses
  links it observes. Use a physical Herdr home directory. Portable Deno path APIs
  cannot make those checks atomic with writes, so concurrent directory swaps are
  not supported. Do not run it in a tree writable by an untrusted process.
- Older manually edited installs need an explicit migration. Saving a config
  backup alone cannot make an old code customization compatible with new code.
- This mechanism does not restart services, switch layouts, install software,
  sync across machines, or edit your GitHub repositories.

If Swamp cannot save its resource receipt after files were committed, the method
reports `FILES COMMITTED` rather than implying no change occurred. Inspect the
local state and backup; do not rerun `install` blindly. `upgrade` can safely
recheck unchanged managed bytes. Rollback receipts report the restored version,
or `unmanaged`/`uninstalled` when no prior managed-version receipt existed.
