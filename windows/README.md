# Herdr on Windows

`@jpisgeek/herdr-windows` manages a Windows SSH target from the macOS or Linux
machine running the local Herdr core. The Windows fallback installer supports
x64 releases. Windows starts its core on the first Herdr SSH connection. Setup
adds no Windows core autostart entry.

## Bootstrap SSH

1. Prepare a client SSH key. Set `identityFile` to its absolute path or to the
   public-key path for an agent-held identity. Swamp reads only the public key.
   An optional `sshPrefix` supplies a chain of absolute executable paths, such
   as a helper that makes an agent-held key available to SSH.
2. Choose the source networks in `allowFrom`. Use CIDR network addresses or
   individual IP addresses. Cover the client's expected addresses after DHCP
   changes. The generated authorized key is restricted to these networks.
3. Verify the host fingerprint at the Windows console with
   `ssh-keygen -lf "$env:ProgramData\ssh\ssh_host_ed25519_key.pub"`. Compare it
   with the fingerprint reported by `preflight` or `bootstrapScript`. Set
   `hostKeyFingerprint` to the console value.
4. If SSH needs to be configured, run `bootstrapScript` with
   `account: administrator` or `account: standard` and paste the returned script
   into Windows PowerShell. The administrator script enables the OpenSSH server
   and TCP 22 and sets the shared administrators key file. Run the standard
   script as the target user. It secures that user's key file and its directory,
   prints the host fingerprint, and leaves sshd and firewall setup to an
   administrator. If SSH has never been enabled, bootstrap can render the script
   using a syntactically valid placeholder fingerprint. Replace the placeholder
   with the console fingerprint before connecting.

   On default Windows OpenSSH, a standard account must be in **OpenSSH Users**
   to log in. If the host uses a custom admission policy, have an administrator
   check its SSH admission rules for that account.

## Connect and check status

Set `machineName`, `host`, `user`, `allowFrom`, `identityFile`, and
`hostKeyFingerprint` in a Swamp behavior definition. Source `host` and `user`
from vault expressions. The default port is 22. Set `remoteShell` explicitly
when you need to override the detected OpenSSH default shell.

Run `preflight` to check pinning, login, key ACLs, versions, and the planned
changes. If a separate bootstrap key already works for this Windows account,
pass its absolute path as `bootstrapIdentityFile` to `preflight` and `setup`.
Use `bootstrapSshPrefix` when it needs a different agent helper. If SSH policy
blocks the target account itself, pass a separate admitted local administrator
with `bootstrapUser` and its `bootstrapIdentityFile`. Preflight uses that
identity only to inspect the target account's admission policy.

Run `setup` to apply the plan and check the resulting connection. Set
`temporary: true` for a scratch machine entry. The transport stores its wrapper
and pinned known_hosts file under `~/.config/herdr-windows/<machineName>/` by
default and ignores global and user SSH configuration. The wrapper replaces hc
0.1.22's relative Windows connect probe with the installed executable's absolute
path. The relative probe depends on sshd's starting directory.

On hc 0.1.22, `hc machine add --install` refuses Windows targets reached through
`--via`. The fallback downloads the x64 release for the local hc version from
the official, versioned release manifest over HTTPS. It checks the archive
SHA-256 for integrity. Before running or installing the unpacked executable, it
requires Windows Authenticode status `Valid` and the exact signer subject
`CN=herdr, O=herdr, L=Wilmington, S=Delaware, C=US`. This check uses Windows
certificate trust in addition to the checksum supplied by the release host.

When an old source restriction causes `needs_login`, supply the working
bootstrap identity so setup can repair the client key line and verify that the
client authenticates. Setup polls for up to three minutes while hc retries the
connection. On timeout, it prints the local `hc machine login` command. If the
Windows transport requires a manual update, setup records hc's hint and the
PowerShell command to run on Windows.

Use `status` for connection and core state, or `adopt` for a read-only receipt
and drift report for an existing registration. Named Herdr sessions can be
inspected with these methods.

## Remove a managed machine

Run `teardown` with `confirm` set to the exact machine name. It forgets the
local registration, backs up the Windows keys file before removing the client
key, and removes its local wrapper and known_hosts file. The Windows core and
its terminals continue running by default. Setting `uninstall: true` stops the
core, **ends all Herdr terminals for every client of that machine**, and removes
the per-user Herdr installation. Use it only on a machine this client alone
uses. Keep a separate bootstrap identity available if you may need to retry
after the client key has been removed.

Each change to an existing keys file leaves a `<keys>.herdr-<id>.bak` backup
beside it. Backups contain public keys only and have the same restricted ACL.
They accumulate without automatic pruning, including during teardown. Set
`$keys` to the Windows authorized keys file path and list its backups in
PowerShell.

```powershell
Get-ChildItem -LiteralPath (Split-Path -Parent $keys) -Filter "$(Split-Path -Leaf $keys).herdr-*.bak"
```

## CLI examples

Given a configured behavior named `windows-lab`, inspect and connect it from the
Swamp repository.

```sh
swamp behavior run windows-lab preflight
swamp behavior run windows-lab setup --input temporary=true
swamp behavior run windows-lab status
```

Once the machine is no longer needed, confirm the machine name configured in its
definition.

```sh
swamp behavior run windows-lab teardown --input confirm=windows-lab
```

The behavior uses local `ssh-keyscan` to observe host keys, `ssh` for pinned
Windows operations, and `hc` for registration. Set `sshPath` and `hcPath` only
to executables you trust.
