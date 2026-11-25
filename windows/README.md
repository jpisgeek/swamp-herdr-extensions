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
   and TCP 22 and sets the shared administrators key file. For a standard user,
   have an administrator enable sshd and the firewall first, then run the script
   as the target user to update that user's key file. If SSH has never been
   enabled, bootstrap can render the script using a syntactically valid
   placeholder fingerprint. Replace the placeholder with the console fingerprint
   before connecting.

## Connect and check status

Set `machineName`, `host`, `user`, `allowFrom`, `identityFile`, and
`hostKeyFingerprint` in a Swamp behavior definition. Source `host` and `user`
from vault expressions. The default port is 22. Set `remoteShell` explicitly
when you need to override the detected OpenSSH default shell.

Run `preflight` to check pinning, login, key ACLs, versions, and the planned
changes. If a separate bootstrap key already works for this Windows account,
pass its absolute path as `bootstrapIdentityFile` to `preflight` and `setup`.
Use `bootstrapSshPrefix` when it needs a different agent helper.

Run `setup` to apply the plan and check the resulting connection. Set
`temporary: true` for a scratch machine entry. The transport stores its wrapper
and pinned known_hosts file under `~/.config/herdr-windows/<machineName>/` by
default and ignores global and user SSH configuration.

When an old source restriction causes `needs_login`, supply the working
bootstrap identity so setup can repair the client key line and verify that the
client authenticates. Setup waits up to three minutes for the machine to connect
and returns the local `hc machine login` command if it times out.

Use `status` for connection and core state, or `adopt` for a read-only receipt
and drift report for an existing registration. Named Herdr sessions can be
inspected with these methods.

## Remove a managed machine

Run `teardown` with `confirm` set to the exact machine name. It forgets the
local registration, backs up the Windows keys file before removing the client
key, and removes its local wrapper and known_hosts file. The Windows core and
its terminals continue running by default. Set `uninstall: true` to stop the
core and remove the per-user Herdr installation. Keep a separate bootstrap
identity available if you may need to retry after the client key has been
removed.

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
Windows operations, and `hc` for registration. If a managed connection needs an
immediate login retry, setup can give the local hc client a pseudo-terminal
through `script`. Set `sshPath` and `hcPath` only to executables you trust.
