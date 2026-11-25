# Plan: `@jpisgeek/herdr-windows`, herdr-core on a Windows machine

Status: ready for implementation, **revision 2** · Owner of plan and acceptance tests: reviewer · Implementer: assigned worker

Revision 1 (2026-11-25): live step 4 is rewritten. On hc 0.1.22, `hc machine add` does not persist an entry that
fails to log in, so the stale pin is now replayed on an existing entry by dropping its live connection. Also
settled: `hc machine update` refuses a Windows `--via` machine without a TTY and gives a manual-install hint.
`update` must surface that hint verbatim as its result (`status: manual`, with the exact command) rather than
fail. The acceptance tests are unchanged.

Revision 2 (2026-11-25): live step 8 runs PowerShell Direct as the standard user (member of Remote Management
Users only). The standard-account bootstrap must not need elevation: when it is not elevated it skips the sshd
and firewall changes with a message, and still writes the user's keys file and prints the fingerprint. The
acceptance tests are unchanged.

## Goal

Getting a Windows machine onto a herdr-core client as an `hc machine` takes about a dozen manual steps today, and
several of them fail silently. This extension does the setup in one idempotent method, explains anything it can't
fix, and doesn't break when the client's IP address changes.

Each problem below was hit while setting up the first machine by hand. Every one of them is a requirement here.

| What went wrong | Requirement |
|---|---|
| The client key was pinned with `from="<one IP>"`. DHCP moved the client, sshd rejected the key ("not from a permitted host"), and hc showed `needs_login`. | `allowFrom` is a required list of networks. `setup` repairs a stale pin in place. `preflight` reports the sshd log reason for a rejection. |
| Members of Administrators are matched against `%ProgramData%\ssh\administrators_authorized_keys`, not `~\.ssh\authorized_keys`, and sshd ignores the file unless its ACL is exactly SYSTEM plus Administrators. | Pick the file from the account's real group membership and set the ACL by SID. Check it in `preflight`. |
| cmd.exe is the default sshd shell, so quoted PowerShell broke twice. | Every remote command is `powershell -NoProfile -NonInteractive -EncodedCommand`. |
| hc's first connect probe assumes a Unix shell, and its Windows fallback runs `herdr-core.exe` by a relative path. A stale PATH or startup directory breaks it. | A per-machine `--via` wrapper rewrites hc's connect probe to the absolute installed exe, in the remote shell's syntax. |
| The client's `~/.ssh/config` is hand-maintained and must not change. | The wrapper uses `-F /dev/null`, its own pinned known_hosts file and an explicit identity. Nothing outside the extension's state directory is written. |
| Nothing on Windows starts the core at boot. The first SSH client starts it. | Documented, and `status` says when the core is not running. No autostart is installed. |
| `hc machine login` needs a real TTY, and hc retries `needs_login` only every 10 minutes or so. | `setup` waits for `connected` itself (bounded) and prints the exact command for a person if it has to give up. |

## Where it runs

On the swamp host (macOS or Linux) that runs the herdr-core client, which owns `hc`. The extension shells out to
local `hc` (JSON output) and `ssh`. It never handles private key material: `identityFile` names a key (or the
`.pub` of an agent-held key), and an optional `sshPrefix` runs ssh through an operator-supplied helper, for
example one that loads a vault-held key into a short-lived, destination-bound agent.

## Global arguments

| Arg | Required | Notes |
|---|---|---|
| `machineName` | yes | hc machine name. `[a-z0-9-]`, 1–32 characters, not `t<digits>`. |
| `host`, `user` | yes | Sensitive and vault-sourced. `host` uses the same validation as `@jpisgeek/hyperv`. |
| `port` | no | Default 22. |
| `hostKeyFingerprint` | yes | `SHA256:...`. No trust-on-first-use: `preflight` and `bootstrapScript` print the observed value for a person to confirm. |
| `allowFrom` | yes | Networks for the key's `from=`. No `/0`, no hostnames, no host bits set. |
| `identityFile` | yes | Absolute path. The public key is read from `<identityFile>.pub`, or from the file itself if it ends in `.pub`. |
| `sshPrefix` | no | argv prefix of absolute program paths. |
| `sshPath` | no | Default `/usr/bin/ssh`. |
| `hcPath` | no | Default `hc`. |
| `stateDir` | no | Default `$HOME/.config/herdr-windows`. Each machine gets `<stateDir>/<machineName>/{connect,known_hosts}`, mode 0700/0600. |
| `remoteShell` | no | `cmd` or `powershell`. Detected by `preflight` from `HKLM:\SOFTWARE\OpenSSH\DefaultShell` when omitted. |

## Methods

| Method | Mutates | What it does |
|---|---|---|
| `preflight` | no | TCP reach. Host key matches `hostKeyFingerprint` (refuse on mismatch). The client key authenticates; if not, the sshd log reason when readable. Windows build. Administrators membership. Which keys file applies and whether its ACL is correct. sshd DefaultShell. herdr-core install path and version, and the local `hc` version. Whether the install directory is on the user PATH. The hc machine entry and its state. `planSetup`'s action list. Writes one `preflight` resource. |
| `bootstrapScript` | no | Renders the PowerShell a person pastes on a machine the client cannot reach yet. It enables sshd, opens 22/TCP, writes the key line to the right file with the right ACL, and prints the host key fingerprint to paste back. Stored as a `bootstrap` resource. |
| `setup` | yes | Runs `preflight`, then executes `planSetup`'s actions in order: **authorize** (upsert the key line, back up the file first, re-verify login), **install** (prefer `hc machine add --install`; see "establish with evidence"), **update**, **write-wrapper** (render, write atomically, `chmod 700`), **add-machine** or **replace-machine** (`hc machine rm`, then `add`), **await-reconnect** (poll `hc machine ls` up to 3 minutes). Ends with a smoke `hc exec --on <machine> -- cmd /d /c ver`. Running it twice in a row makes no changes the second time. |
| `status` | no | hc machine state, versions, wrapper drift, and whether the remote core is running. |
| `adopt` | no | Records an existing hc machine and its existing `--via` wrapper as this extension's resource without changing either. This is how machines set up by hand get backfilled. Reports drift from what `setup` would render; it does not fix it. |
| `teardown` | yes | Requires `confirm` equal to `machineName`. Runs `hc machine rm` (remote terminals keep running), removes the key line (backup first), and deletes `<stateDir>/<machineName>/`. With `uninstall: true` (default false) it also stops the core and removes the install directory. It never removes other keys or other machines. |

`--session` is not supported in v1. Machines added with a non-default session are reported, not managed.

## Contract: exported surface

The acceptance tests import these from `windows/extensions/herdr_windows.ts`:

`MachineName`, `CidrList`, `HostKeyFingerprint`, `GlobalArgsSchema`, `authorizedKeyLine`, `upsertAuthorizedKey`
(→ `{ text, changed, replaced, bomRemoved }`), `removeAuthorizedKey` (→ `{ text, removed }`),
`classifyRemoteLine` (→ `"connect" | "passthrough"`), `renderWrapper`, `renderKnownHosts`, `fingerprint`
(async, matches `ssh-keygen -l`), `renderBootstrapScript`, `parseMachines`, `planSetup`, `shQuote`.

`renderWrapper` options: `host`, `user`, `port`, `knownHostsFile`, `identityFile`, `sshPath`, optional
`sshPrefix`, `remoteExe` (absolute Windows path, discovered by `preflight` from `$env:LOCALAPPDATA`) and
`remoteShell`. The connect line is `"<exe>" connect` for cmd and `& '<exe>' connect` (PowerShell single-quote
escaping) for powershell.

`planSetup` input: `{ keyAuthorized, keyOptionsCurrent, remoteVersion, localVersion, wrapperCurrent, machine, wrapperPath }`.
Output: an ordered subset of `authorize, install, update, write-wrapper, add-machine | replace-machine, await-reconnect`.
Versions compare numerically per dotted component.

Package layout follows the repo's other extensions: `windows/manifest.yaml` (`@jpisgeek/herdr-windows`, behavior
spelling, platforms darwin-aarch64, darwin-x86_64, linux-x86_64, linux-aarch64), `windows/extensions/herdr_windows.ts`,
`windows/README.md`, `windows/LICENSE`. Add a step for it to `workflows/workflow-verify-extensions.yaml`.

## Acceptance

### Offline: `windows/extensions/herdr_windows_acceptance_test.ts`

The reviewer owns this file. Do not edit it. Its SHA-256 is recorded in the private build brief. Run
`~/.swamp/deno/deno test --allow-all windows/extensions/` along with `fmt --check`, `lint`, `check`,
`swamp extension fmt --check` and `swamp extension quality` (report the score).

### Live: against a fresh Windows Server guest

Use a guest created by `@jpisgeek/hyperv`'s `createVm` (name `e2e-*`) with a **bootstrap** key injected by
`createVm`, and a **separate client** key that only `setup` authorizes. Run from a scratch swamp repo on the
client machine. The machine name is `e2e-*`, added with `--temp` semantics where hc supports it.

1. `preflight` on the fresh guest → herdr-core absent, client key not authorized, plan
   `[authorize, install, write-wrapper, add-machine]`.
2. `setup` (using the bootstrap identity for the authorize step) → hc shows `connected`. `hc exec --on <m> -- cmd /d /c ver`
   succeeds. The guest's keys file has exactly one line for the client key, with the requested `from=`.
3. `setup` again → plan `[]`, no file on either side changes (compare hashes).
4. Replay the real outage. The hc machine entry is never removed in this step. On hc 0.1.22, `hc machine add`
   persists an entry only after a successful login, so remove-then-add cannot produce a stale `needs_login`
   entry. In the real outage the entry already existed, its live connection dropped, and the reconnect failed.
   1. With the entry from step 2 `connected`, use the **bootstrap** identity to rewrite the client key's `from=`
      on the guest to one unrelated address.
   2. Drop the live connection without touching hc's entry. On the guest, stop the `herdr-core.exe` processes
      whose command line ends in ` connect` (the per-client connection processes, not `serve` or `hold`). The
      guest is run-owned, so stopping them is in scope.
   3. Within 3 minutes, `hc machine ls` shows the entry as `needs_login`, with `target` unchanged. Record the
      transition time. If hc never gets there, stop and report the observed state; don't improvise.
   4. `preflight` names the rejection reason from the guest's OpenSSH log ("not from a permitted host" or
      equivalent), and its plan is `[authorize, await-reconnect]`.
   5. `setup` repairs the pin and ends `connected` with no person and no `hc machine login`. hc retries
      `needs_login` machines only every 10 minutes or so, so the acceptance bound is **11 minutes from the repair**.
      `setup`'s own await may give up sooner and print the manual command. The run then keeps polling
      `hc machine ls` (read-only) up to the bound, and records both setup's result and the time to `connected`.
5. `status` → connected, versions equal.
6. `adopt` on a second machine entry added by hand through a hand-written wrapper → recorded, drift reported,
   nothing changed.
7. `teardown` with `confirm` → hc entry gone, key line gone (other lines byte-identical), state directory gone.
8. Standard-user bootstrap on the second fresh guest. The harness is PowerShell Direct **as that user**: no child
   process launched from an admin session, no scheduled task.
   1. As Administrator (`guestExec`): create local user `e2e-std` with a generated password from the `e2e`
      vault, and add it to **Remote Management Users** (`S-1-5-32-580`) only, never Administrators. This group
      is what lets a non-admin open a PowerShell Direct session.
   2. `guestExec` with `user: e2e-std` → `whoami /groups` shows no Administrators SID, and `$env:USERPROFILE`
      exists (the first PowerShell Direct logon creates the profile).
   3. Run the `account: "standard"` `bootstrapScript` in that session. The non-elevated path writes
      `%USERPROFILE%\.ssh\authorized_keys` with the client key line and ACL, and prints the host key
      fingerprint. It **skips** the sshd and firewall changes with a message that an administrator must make
      them. On this guest they are already in place from first boot.
   4. Readback as Administrator: exactly one line for the client key, with the requested `from=`; the file and
      its `.ssh` folder are owned by and limited to e2e-std, SYSTEM and Administrators.
   5. SSH as `e2e-std` with the client key → `whoami` returns e2e-std.
   If step 8.2 shows PowerShell Direct refusing a non-admin member of Remote Management Users on this build,
   stop and report the exact error. Don't switch to another launch path.

### Things the implementer must establish with evidence, not assume

- What hc actually sends through `--via` for each probe and for install. Log the argv with a temporary logging
  wrapper, include the redacted log in the report, and make `classifyRemoteLine` match exactly that.
- Whether `hc machine add --install` installs herdr-core on a Windows target through a `--via` wrapper. If it
  does not, `install` downloads the official Windows release for the local hc version, verifies it, and unpacks
  it to `%LOCALAPPDATA%\Programs\herdr-core` (exe plus `conpty\`), adding that directory to the user PATH. Record
  which path was taken.
- Whether `hc machine update` works without a TTY. If not, `update` reports the exact command for a person
  instead of failing silently.

## Definition of done

Offline and live acceptance are green with evidence. README covers setup end to end: bootstrap, setup, the
no-autostart note, `needs_login` behaviour, and teardown. Nothing is pushed to any remote and nothing is
published until the reviewer's PASS and a human's go.
