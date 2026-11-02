# @jpisgeek/herdr-swamp-fixtures

Two harmless workflows for testing a swamp dashboard, such as the
[Herdr swamp layout](https://github.com/jpisgeek/herdr-swamp-layout). They
change nothing.

| Workflow    | What it does                                                        |
| ----------- | ------------------------------------------------------------------- |
| `@jpisgeek/gate-test` | Stops at a `manual_approval` step. Approve it, then resume the run. |
| `@jpisgeek/fail-test` | Sleeps `seconds` (default 30), then exits with code 3.              |

`@jpisgeek/fail-test` runs a `command/shell` behavior named `herdr-test`. Create it once
in the repo where you pull the extension:

```sh
swamp behavior create command/shell herdr-test
```

Use a scratch repo (`swamp init` in an empty folder), not one that reaches real
systems.

```sh
swamp workflow run @jpisgeek/gate-test
swamp workflow run @jpisgeek/fail-test --input '{"seconds":25}'
```
