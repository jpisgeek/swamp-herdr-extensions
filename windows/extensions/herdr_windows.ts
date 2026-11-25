/** Windows SSH provisioning and Herdr machine management. */
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { z } from "npm:zod@4";

const host = z.string().max(253).regex(
  /^(?:\[[0-9A-Fa-f:.]+\]|[0-9A-Za-z](?:[0-9A-Za-z-]*[0-9A-Za-z])?(?:\.[0-9A-Za-z](?:[0-9A-Za-z-]*[0-9A-Za-z])?)*)$/,
).meta({ sensitive: true });
const user = z.string().max(64).regex(/^[A-Za-z0-9._][A-Za-z0-9._-]*$/)
  .meta({ sensitive: true });
const abs = z.string().refine((path) =>
  isAbsolute(path) && !/[\r\n\0]/.test(path)
);
const port = z.number().int().min(1).max(65535);
const shell = z.enum(["cmd", "powershell"]);

/** hc machine name without terminal identifiers or path syntax. */
export const MachineName = z.string().max(32).regex(
  /^(?!t\d+$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
);

function network(value: string): string | undefined {
  const [address, prefix, ...extra] = value.split("/");
  const family = isIP(address);
  if (!family || extra.length || address.includes("%")) return;
  const width = family === 4 ? 32 : 128;
  const bits = prefix === undefined ? width : Number(prefix);
  if ((prefix !== undefined && !/^[1-9]\d*$/.test(prefix)) || bits > width) {
    return;
  }
  let parts: number[];
  if (family === 4) {
    parts = address.split(".").map(Number);
  } else {
    const expanded = address.replace(/\d+\.\d+\.\d+\.\d+$/, (suffix) => {
      const [a, b, c, d] = suffix.split(".").map(Number);
      return `${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
    });
    const [left, right] = expanded.split("::");
    const start = left.split(":").filter(Boolean);
    const end = right?.split(":").filter(Boolean) ?? [];
    parts = [
      ...start,
      ...Array(right === undefined ? 0 : 8 - start.length - end.length).fill(
        "0",
      ),
      ...end,
    ]
      .map((part) => parseInt(part, 16));
  }
  const size = family === 4 ? 8n : 16n;
  const number = parts.reduce((n, part) => (n << size) | BigInt(part), 0n);
  const mask = (1n << BigInt(width - bits)) - 1n;
  if ((number & mask) === 0n) return `${family}:${number}/${bits}`;
}

/** Unique IP networks with all host bits clear. */
export const CidrList = z.array(z.string()).min(1).refine((values) => {
  const networks = values.map(network);
  return !networks.includes(undefined) &&
    new Set(networks).size === networks.length;
}, "Use unique IP networks with no host bits set and no /0");

/** OpenSSH SHA-256 host fingerprint. */
export const HostKeyFingerprint = z.string().regex(
  /^SHA256:[A-Za-z0-9+/]{43}$/,
);

/** Connection settings for a Windows machine. */
export const GlobalArgsSchema = z.object({
  machineName: MachineName,
  host,
  user,
  port: port.default(22),
  hostKeyFingerprint: HostKeyFingerprint,
  allowFrom: CidrList,
  identityFile: abs,
  sshPath: abs.default("/usr/bin/ssh"),
  sshPrefix: z.array(abs).min(1).optional(),
  hcPath: z.union([z.literal("hc"), abs]).default("hc"),
  stateDir: abs.optional(),
  remoteShell: shell.optional(),
});

const keyType =
  /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)(?:-cert-v01@openssh\.com)?$/;
function parseKey(key: string) {
  const [type, blob] = key.trim().split(/\s+/);
  if (
    !keyType.test(type) || !blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob) ||
    /[\r\n\0]/.test(key.trim())
  ) throw new Error("Expected an OpenSSH public key");
  const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0));
  if (bytes.length < 4) throw new Error("Invalid public key blob");
  const length = new DataView(bytes.buffer).getUint32(0);
  if (
    bytes.length <= length + 4 ||
    new TextDecoder().decode(bytes.subarray(4, 4 + length)) !== type
  ) {
    throw new Error("Public key type does not match its blob");
  }
  return { type, blob, bytes };
}

/** Render a restricted public key pinned to the specified source networks. */
export function authorizedKeyLine(key: string, allowFrom: string[]): string {
  parseKey(key);
  return `from="${CidrList.parse(allowFrom).join(",")}",restrict ${key.trim()}`;
}

function lineKey(line: string) {
  const fields = line.trimStart().match(/^(?:"(?:\\.|[^"\\])*"|[^"\s])+|.*/)
    ?.[0];
  if (!fields || fields.startsWith("#")) return;
  const body = line.trimStart();
  const [type, blob] =
    (keyType.test(fields) ? body : body.slice(fields.length).trimStart()).split(
      /\s+/,
    );
  if (keyType.test(type) && blob) return blob;
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Upsert one line by public key blob, preserving other rows and line endings. */
export function upsertAuthorizedKey(text: string, line: string) {
  const blob = lineKey(line);
  if (!blob || /[\r\n\0]/.test(line)) {
    throw new Error("Invalid authorized key line");
  }
  const bomRemoved = text.startsWith("\uFEFF");
  let replaced = false;
  const clean = text.replace(/^\uFEFF/, "");
  let next = lines(clean).map((row) => {
    if (lineKey(row) !== blob) return row;
    if (replaced) return "";
    replaced = true;
    return line + (row.match(/\r?\n$/)?.[0] ?? "");
  }).join("");
  if (!replaced) {
    const eol = clean.match(/\r?\n/)?.[0] ?? "\n";
    next += (next && !next.endsWith("\n") ? eol : "") + line + eol;
  }
  return { text: next, changed: next !== text, replaced, bomRemoved };
}

/** Remove every occurrence of a public key while preserving unrelated rows. */
export function removeAuthorizedKey(text: string, key: string) {
  const { blob } = parseKey(key);
  let removed = 0;
  const next = lines(text).filter((row) => {
    if (lineKey(row.replace(/^\uFEFF/, "")) !== blob) return true;
    removed++;
    return false;
  }).join("");
  return { text: next, removed };
}

/** Compute the SHA-256 fingerprint printed by OpenSSH. */
export async function fingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", parseKey(key).bytes);
  return "SHA256:" +
    btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=+$/, "");
}

/** Build a single pinned OpenSSH known_hosts entry. */
export function renderKnownHosts(
  address: string,
  sshPort: number,
  key: string,
): string {
  host.parse(address);
  port.parse(sshPort);
  const name = address.replace(/^\[|\]$/g, "");
  const { type, blob } = parseKey(key);
  return `${sshPort === 22 ? name : `[${name}]:${sshPort}`} ${type} ${blob}\n`;
}

const probes = [
  // Captured as one --via argument each from hc 0.1.22.
  'sh -c \'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; exec "$p" connect\'',
  'cmd /d /c "if exist .\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe (.\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe connect) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"',
  "sh -c 'herdr-core connect'",
  `sh -c '"$HOME"/.local/bin/herdr-core connect'`,
  "cmd /d /c herdr-core.exe connect",
  'cmd /d /c "herdr-core.exe" connect',
];

/** Identify the exact supported hc connect probes. */
export function classifyRemoteLine(line: string): "connect" | "passthrough" {
  return probes.includes(line) ? "connect" : "passthrough";
}

/** Quote one argument for a POSIX shell. */
export function shQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

function sshConfigFileArgument(path: string): string {
  if (path.includes("${")) {
    throw new Error(
      "OpenSSH environment expansion is unsupported in the state directory path",
    );
  }
  if (!/[\s'"\\%]/.test(path)) return path;
  return '"' + path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    .replaceAll("%", "%%") +
    '"';
}

type SshOptions = {
  host: string;
  user: string;
  port: number;
  identityFile: string;
  sshPath: string;
  sshPrefix?: string[];
};
function sshArgs(options: SshOptions, knownHostsFile: string): string[] {
  return [
    "-T",
    "-F",
    "/dev/null",
    ...[
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      `UserKnownHostsFile=${knownHostsFile}`,
      "GlobalKnownHostsFile=/dev/null",
      "PreferredAuthentications=publickey",
      "IdentitiesOnly=yes",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "ControlMaster=no",
      "ControlPath=none",
      "ConnectTimeout=10",
      "CheckHostIP=no",
      "UpdateHostKeys=no",
    ].flatMap((option) => ["-o", option]),
    "-p",
    String(options.port),
    "-i",
    options.identityFile,
    "--",
    `${options.user}@${options.host.replace(/^\[|\]$/g, "")}`,
  ];
}

/** Render a per-machine SSH transport with a pinned key and absolute connect target. */
export function renderWrapper(
  options: SshOptions & {
    knownHostsFile: string;
    remoteExe: string;
    remoteShell: z.infer<typeof shell>;
  },
): string {
  const { remoteExe, remoteShell } = options;
  if (
    !/^[a-z]:\\[^\r\n\0"]+\\herdr-core\.exe$/i.test(remoteExe) ||
    (remoteShell === "cmd" && remoteExe.includes("%"))
  ) {
    throw new Error("Unsafe or non-absolute Herdr executable path");
  }
  const connect = remoteShell === "powershell"
    ? `& ${psQuote(remoteExe)} connect`
    : `"${remoteExe}" connect`;
  const argv = [
    ...(options.sshPrefix ?? []),
    options.sshPath,
    ...sshArgs(options, options.knownHostsFile),
  ];
  return `#!/bin/bash
set -euo pipefail
[[ $# -eq 1 ]] || exit 2
remote=$1
case "$remote" in
  ${probes.map(shQuote).join("|")}) remote=${shQuote(connect)} ;;
esac
exec ${argv.map(shQuote).join(" ")} "$remote"
`;
}

const version = z.string().regex(/^\d+(?:\.\d+)+$/);
const machineRow = z.object({
  name: z.string(),
  state: z.string(),
  target: z.string(),
  version: z.string().nullable().optional(),
  via: z.boolean(),
  session: z.string().nullish(),
});
type Machine = z.infer<typeof machineRow>;

/** Parse hc machine JSON and omit empty optional fields. */
export function parseMachines(json: string): Machine[] {
  return z.object({ machines: z.array(machineRow) }).parse(JSON.parse(json))
    .machines
    .map(({ session, ...row }) => session ? { ...row, session } : row);
}

const actions = z.enum([
  "authorize",
  "install",
  "update",
  "write-wrapper",
  "add-machine",
  "replace-machine",
  "await-reconnect",
]);
type Action = z.infer<typeof actions>;

function older(remote: string, local: string): boolean {
  const a = version.parse(remote).split(".").map(BigInt);
  const b = version.parse(local).split(".").map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0n) - (b[i] ?? 0n);
    if (diff) return diff < 0n;
  }
  return false;
}

/** Compute ordered setup actions from observed state. */
export function planSetup(input: {
  keyAuthorized: boolean;
  keyOptionsCurrent: boolean;
  remoteVersion: string | null;
  localVersion: string;
  wrapperCurrent: boolean;
  machine: {
    state: string;
    target: string;
    session?: string | null;
    via?: boolean;
  } | null;
  wrapperPath: string;
}): Action[] {
  const plan: Action[] = [];
  if (input.machine?.session) return plan;
  if (!input.keyAuthorized || !input.keyOptionsCurrent) plan.push("authorize");
  if (!input.remoteVersion) plan.push("install");
  else if (older(input.remoteVersion, input.localVersion)) plan.push("update");
  if (!input.wrapperCurrent) plan.push("write-wrapper");
  if (!input.machine) plan.push("add-machine");
  else if (
    input.machine.target !== input.wrapperPath || input.machine.via === false
  ) plan.push("replace-machine");
  else if (input.machine.state !== "connected") plan.push("await-reconnect");
  return plan;
}

const psStart = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
`;
const adminKeys =
  "Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'";
const userKeys = "Join-Path $env:USERPROFILE '.ssh\\authorized_keys'";
const aclFunctions = `
function Get-KeyAcl {
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $sids) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      (New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($owner)))
  return $acl
}
function Test-KeyAcl {
  if (!(Test-Path -LiteralPath $keys -PathType Leaf)) { return $false }
  $acl = Get-Acl -LiteralPath $keys
  if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $sids) { return $false }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $sids.Count) { return $false }
  foreach ($sid in $sids) {
    $matching = @($rules | Where-Object {
      $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq 'FullControl'
    })
    if ($matching.Count -ne 1) { return $false }
  }
  return $true
}
function Read-Keys {
  if (!(Test-Path -LiteralPath $keys)) { return '' }
  if ((Get-Item -LiteralPath $keys -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked keys file' }
  return $utf8.GetString([IO.File]::ReadAllBytes($keys))
}
function Write-Keys([string] $before, [string] $after) {
  $parent = Split-Path -Parent $keys
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked keys directory' }
  $lock = [IO.FileStream]::new("$keys.herdr-lock", 'OpenOrCreate', 'ReadWrite', 'None', 4096, 'DeleteOnClose')
  $temp = "$keys.herdr-$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    if ((Read-Keys) -cne $before) { throw 'Keys file changed concurrently' }
    if ($before -ceq $after -and (Test-KeyAcl)) { return }
    $acl = Get-KeyAcl
    $file = [IO.FileStream]::new($temp, 'CreateNew', 'Write', 'None', 4096, 'None', $acl)
    try {
      $bytes = $utf8.GetBytes($after)
      $file.Write($bytes, 0, $bytes.Length)
      $file.Flush($true)
    } finally { $file.Dispose() }
    if (Test-Path -LiteralPath $keys) {
      $backup = "$keys.herdr-$([Guid]::NewGuid().ToString('N')).bak"
      [IO.File]::WriteAllBytes($backup, [IO.File]::ReadAllBytes($keys))
      if ($isAdmin) { Set-Acl -LiteralPath $backup -AclObject $acl }
      else { [IO.File]::SetAccessControl($backup, $acl) }
      [IO.File]::Replace($temp, $keys, [NullString]::Value, $false)
      if ($isAdmin) { Set-Acl -LiteralPath $keys -AclObject $acl }
      else { [IO.File]::SetAccessControl($keys, $acl) }
    } else { [IO.File]::Move($temp, $keys) }
    if (!(Test-KeyAcl)) { throw 'Keys ACL verification failed' }
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
    $lock.Dispose()
  }
}
`;
const adminAcl =
  "$sids = @('S-1-5-18', 'S-1-5-32-544')\n$owner = 'S-1-5-32-544'";
const userAcl =
  "$owner = $identity.User.Value\n$sids = @('S-1-5-18', 'S-1-5-32-544', $owner)";
const standardDirectoryAcl = `
$parent = Split-Path -Parent $keys
[IO.Directory]::CreateDirectory($parent) | Out-Null
if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Refusing linked keys directory'
}
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $sids) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    (New-Object Security.Principal.SecurityIdentifier($sid)),
    'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$acl.SetOwner($identity.User)
[IO.Directory]::SetAccessControl($parent, $acl)
`;
const standardFingerprint = `
$scan = Get-Command ssh-keyscan.exe -ErrorAction SilentlyContinue
if ($scan) {
  $ErrorActionPreference = 'Continue'
  try { $keysOffered = @(& $scan.Source -T 5 -t ed25519 127.0.0.1 2>$null) }
  finally { $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0 }
  foreach ($offered in $keysOffered) {
    if ($offered -cmatch '^[^ ]+ ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$') {
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $digest = $sha.ComputeHash([Convert]::FromBase64String($Matches[1])) }
      finally { $sha.Dispose() }
      Write-Output ('SHA256:' + [Convert]::ToBase64String($digest).TrimEnd('='))
      return
    }
  }
}
Write-Warning 'Could not observe the SSH host fingerprint on loopback. Verify it with an administrator.'
`;
const sshEligibility = String.raw`
function Get-SshEligibility([string] $account, [string[]] $groups) {
  $unknown = @{ status = 'unknown'; message = 'Ask an administrator to check the effective sshd admission rules.' }
  try { $lines = [IO.File]::ReadAllLines((Join-Path $env:ProgramData 'ssh\sshd_config')) }
  catch { return $unknown }
  $rules = @{}
  $sources = @{}
  $conditional = $false
  foreach ($line in $lines) {
    if ($line -notmatch '^\s*([a-z]+)(?:\s+|=)(.*)$') { continue }
    $directive = $Matches[1]
    $arguments = $Matches[2]
    if ($directive -ieq 'Include') { return $unknown }
    if ($directive -ieq 'Match') { $conditional = $true; continue }
    if ($directive -notin @('DenyUsers','AllowUsers','DenyGroups','AllowGroups')) { continue }
    if ($conditional) { return $unknown }
    if ($arguments -notmatch '^\s*(?:"[^"]+"|[^"\s#]+)(?:\s+(?:"[^"]+"|[^"\s#]+))*\s*(?:#.*)?$') { return $unknown }
    $tokens = @([regex]::Matches($arguments, '"[^"]+"|[^"\s#]+|#.*$') |
      Where-Object { !$_.Value.StartsWith('#') } | ForEach-Object { $_.Value.Trim('"') })
    if (@($tokens | Where-Object { $_ -match '[!@,]' }).Count) { return $unknown }
    $rules[$directive] += $tokens
    $sources[$directive] += @($line.Trim())
  }
  foreach ($directive in @('DenyUsers','AllowUsers','DenyGroups','AllowGroups')) {
    if (!$rules.ContainsKey($directive)) { continue }
    $names = if ($directive.EndsWith('Users')) { @($account) } else { $groups }
    $matched = $false
    foreach ($pattern in $rules[$directive]) {
      $re = '^' + [regex]::Escape($pattern).Replace('\*','.*').Replace('\?','.') + '$'
      if (@($names | Where-Object { $_ -match $re }).Count) { $matched = $true; break }
    }
    if (($directive.StartsWith('Deny') -and $matched) -or ($directive.StartsWith('Allow') -and !$matched)) {
      $message = 'The account is not eligible for SSH under ' + ($sources[$directive] -join '; ') + '.'
      if ($directive -eq 'AllowGroups' -and 'openssh users' -in $rules[$directive]) {
        $message += ' Ask an administrator to add the account to OpenSSH Users.'
      } else { $message += ' Ask an administrator to review this admission rule.' }
      return @{ status = 'not eligible'; directive = $directive; message = $message }
    }
  }
  return @{ status = 'eligible' }
}
function Get-TokenSshGroups {
  foreach ($sid in $identity.Groups) {
    try {
      $name = $sid.Translate([Security.Principal.NTAccount]).Value
      $name
      $name.Split('\')[-1]
    } catch {}
  }
}
`;
const keyContext = `if ($isAdmin) {
  $keys = ${adminKeys}
  ${adminAcl}
} else {
  $keys = ${userKeys}
  ${userAcl}
}
${aclFunctions}`;

function psText(text: string): string {
  return "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(" +
    psQuote(base64(new TextEncoder().encode(text))) + "))";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

/** Render an ASCII PowerShell script for first-time access from a console. */
export function renderBootstrapScript(options: {
  clientPublicKey: string;
  allowFrom: string[];
  account: "administrator" | "standard";
}): string {
  const desired = authorizedKeyLine(options.clientPublicKey, options.allowFrom);
  const { blob } = parseKey(options.clientPublicKey);
  const admin = options.account === "administrator";
  const line = /^[ -~]+$/.test(desired) ? psQuote(desired) : psText(desired);
  return `${psStart}
if ($isAdmin -ne ${
    admin ? "$true" : "$false"
  }) { throw 'Run as the requested Windows account with the appropriate elevation' }
${
    admin
      ? `if (!(Get-Service -Name sshd -ErrorAction SilentlyContinue)) {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd
if (!(Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 | Out-Null
} else { Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' }`
      : "Write-Output 'Skipping sshd and firewall changes. An administrator must enable sshd and open TCP 22.'"
  }
$keys = ${admin ? adminKeys : userKeys}
${admin ? adminAcl : userAcl}
# Reset inheritance (/inheritance:r); use exact SID ACLs, equivalent to the
# required full-access grants ${
    admin
      ? "*S-1-5-18:F and *S-1-5-32-544:F"
      : "for the user, SYSTEM and Administrators"
  }.
${admin ? "" : standardDirectoryAcl}
${
    admin ? "" : `${sshEligibility}
$eligibility = Get-SshEligibility $env:USERNAME @(Get-TokenSshGroups)
if ($eligibility.status -ne 'eligible') { Write-Warning $eligibility.message }
`
  }
${aclFunctions}
$before = Read-Keys
$line = ${line}
$clean = $before.TrimStart([char]0xFEFF)
$crlf = [string][char]13 + [char]10
$lf = [string][char]10
$eol = if ($clean.Contains($crlf)) { $crlf } else { $lf }
$found = $false
$after = New-Object Text.StringBuilder
foreach ($row in [regex]::Matches($clean, '[^\\n]*\\n|[^\\n]+$')) {
  $text = $row.Value
  $pattern = ${
    psQuote(
      String.raw`^\s*(?:(?:"(?:\\.|[^"\\])*"|[^"\s])+\s+)?` +
        keyType.source.slice(1, -1) + String.raw`\s+` +
        blob.replace(/[+]/g, "\\+") + String.raw`(?:\s|$)`,
    )
  }
  if ($text.TrimStart().StartsWith('#') -or $text -cnotmatch $pattern) {
    [void]$after.Append($text)
  } elseif (!$found) {
    [void]$after.Append($line)
    [void]$after.Append([regex]::Match($text, '\\r?\\n$').Value)
    $found = $true
  }
}
if (!$found) {
  if ($after.Length -and !$clean.EndsWith($lf)) { [void]$after.Append($eol) }
  [void]$after.Append($line + $eol)
}
Write-Keys $before ($after.ToString())
${
    admin
      ? `& ssh-keygen -lf (Join-Path $env:ProgramData 'ssh\\ssh_host_ed25519_key.pub')
if ($LASTEXITCODE) { throw 'Could not read the SSH host fingerprint' }`
      : standardFingerprint
  }
`;
}

type Globals = z.infer<typeof GlobalArgsSchema>;
type Context = {
  globalArgs: unknown;
  signal?: AbortSignal;
  writeResource(spec: string, name: string, data: unknown): Promise<unknown>;
};
const bootstrapIdentity = z.object({
  bootstrapIdentityFile: abs.optional(),
  bootstrapSshPrefix: z.array(abs).min(1).optional(),
  bootstrapUser: user.optional().describe(
    "Alternate Windows account for read-only SSH policy inspection",
  ),
});
type BootstrapIdentity = z.infer<typeof bootstrapIdentity>;
const empty = z.object({});
const decoder = new TextDecoder();
const utf16 = (text: string) => {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(i * 2, text.charCodeAt(i), true);
  }
  return base64(bytes);
};

async function command(
  program: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 25_000,
  input?: string,
) {
  const deadline = AbortSignal.timeout(timeout);
  let result: Deno.CommandOutput;
  try {
    // The Windows and Herdr APIs are exposed by the SSH and hc executables.
    // swamp-quality-ignore deno-command
    const invocation = new Deno.Command(program, {
      args,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (input === undefined) {
      result = await invocation.output();
    } else {
      const child = invocation.spawn();
      const writer = child.stdin.getWriter();
      const write = writer.write(new TextEncoder().encode(input))
        .finally(() => writer.close()).catch(() => undefined);
      [result] = await Promise.all([child.output(), write]);
    }
  } catch {
    throw new Error("Local command could not start or exceeded its deadline");
  }
  return {
    code: result.code,
    out: decoder.decode(result.stdout).trim(),
    err: decoder.decode(result.stderr),
  };
}

async function readLocal(path: string, mode: number): Promise<string | null> {
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.mode === null || (info.mode & 0o777) !== mode) {
      return null;
    }
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function localDirectory(path: string, create: boolean) {
  if (create) await Deno.mkdir(path, { mode: 0o700, recursive: true });
  try {
    const info = await Deno.lstat(path);
    if (!info.isDirectory || info.mode === null || (info.mode & 0o077) !== 0) {
      throw new Error(
        "Herdr Windows state directories must be private and must be real directories",
      );
    }
    return true;
  } catch (error) {
    if (!create && error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function atomicWrite(path: string, text: string, mode: number) {
  if (await readLocal(path, mode) === text) return;
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tmp, text, { createNew: true, mode });
    await Deno.chmod(tmp, mode);
    await Deno.rename(tmp, path);
  } finally {
    await Deno.remove(tmp).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

function paths(g: Globals) {
  const home = Deno.env.get("HOME");
  if (!g.stateDir && !home) throw new Error("Set HOME or stateDir");
  const root = g.stateDir ?? join(home!, ".config", "herdr-windows");
  const directory = join(root, g.machineName);
  return {
    root,
    directory,
    wrapper: join(directory, "connect"),
    known: join(directory, "known_hosts"),
  };
}

async function machine(g: Globals, signal?: AbortSignal) {
  const result = await command(g.hcPath, ["machine", "ls", "--json"], signal);
  if (result.code) throw new Error("Could not list local hc machines");
  return parseMachines(result.out).find((entry) =>
    entry.name === g.machineName
  ) ?? null;
}

function machineVia(entry: Machine | null, path: string): boolean {
  return !!entry?.via &&
    (entry.target === path || entry.target === shQuote(path));
}

async function scanHost(g: Globals, signal?: AbortSignal) {
  const target = g.host.replace(/^\[|\]$/g, "");
  const scan = await command("/usr/bin/ssh-keyscan", [
    "-T",
    "5",
    "-p",
    String(g.port),
    "--",
    target,
  ], signal);
  const offered: string[] = [];
  for (const row of scan.out.split("\n")) {
    const [, type, blob] = row.trim().split(/\s+/);
    if (!type || !blob || row.startsWith("#")) continue;
    const key = `${type} ${blob}`;
    const observed = await fingerprint(key);
    offered.push(observed);
    if (observed === g.hostKeyFingerprint) {
      return {
        reachable: true,
        offered,
        key,
        known: renderKnownHosts(g.host, g.port, key),
      };
    }
  }
  return {
    reachable: offered.length > 0 || /^# .* SSH-/m.test(scan.err),
    offered,
    key: null,
    known: null,
  };
}

function directSsh(
  g: Globals,
  known: string,
  identity: Pick<SshOptions, "identityFile" | "sshPrefix"> = g,
) {
  // Inline the already verified public host key for read-only methods. No
  // scratch file or ambient SSH config is needed.
  const lookup = `KnownHostsCommand=/bin/echo ${shQuote(known.trim())}`;
  const argv = sshArgs({ ...g, ...identity }, "/dev/null");
  argv.unshift("-o", lookup);
  const programs = [...(identity.sshPrefix ?? []), g.sshPath];
  return (script: string, signal?: AbortSignal, timeout?: number) => {
    const body = base64(deflateRawSync(new TextEncoder().encode(script)));
    return command(
      programs[0],
      [
        ...programs.slice(1),
        ...argv,
        `powershell -NoProfile -NonInteractive -EncodedCommand ${launcher}`,
      ],
      signal,
      timeout,
      `${body.length}\n${body}`,
    );
  };
}

// Keep the launcher below cmd.exe's limit and the stdin transfer compact.
const launcher = utf16(`
$ErrorActionPreference = 'Stop'
try {
  $size = [Console]::In.ReadLine()
  $payload = [Console]::In.ReadToEnd()
  if (!$payload -or $size -ne [string]$payload.Length) { throw 'Incomplete PowerShell payload' }
  $data = [Convert]::FromBase64String($payload)
  $memory = New-Object IO.MemoryStream(,$data)
  $stream = New-Object IO.Compression.DeflateStream($memory,[IO.Compression.CompressionMode]::Decompress)
  $reader = New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
  try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
  & ([ScriptBlock]::Create($body))
} catch {
  [Console]::Error.WriteLine('Windows operation failed')
  exit 1
}
`);
const inspectScript = `${psStart}
${keyContext}
$install = Join-Path $env:LOCALAPPDATA 'Programs\\herdr-core'
$exe = Join-Path $install 'herdr-core.exe'
$v = $null
$running = $false
if (Test-Path -LiteralPath $exe -PathType Leaf) {
  $v = (& $exe --version) -replace '^hc ', ''
  if ($LASTEXITCODE) { throw 'Installed herdr-core version check failed' }
  & $exe server status --json 2>$null | Out-Null
  $running = $LASTEXITCODE -eq 0
}
$default = (Get-ItemProperty -Path HKLM:\\SOFTWARE\\OpenSSH -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
$shell = if (!$default -or $default -match '(?i)(^|\\\\)cmd(\\.exe)?$') { 'cmd' }
  elseif ($default -match '(?i)(^|\\\\)(powershell|pwsh)(\\.exe)?$') { 'powershell' }
  else { 'unsupported' }
$rejected = @()
try {
  $rejected = @(Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 100 -ErrorAction SilentlyContinue |
    Where-Object { $_.TimeCreated -gt (Get-Date).AddMinutes(-1) -and $_.Message -match 'not from a permitted host' } |
    Select-Object -First 1)
} catch {
  # Reading the event channel may require an administrator.
}
@{
  build = [Environment]::OSVersion.Version.Build
  admin = $isAdmin
  acl = Test-KeyAcl
  keys = Read-Keys
  shell = $shell
  exe = $exe
  version = $v
  running = $running
  onPath = @(([Environment]::GetEnvironmentVariable('Path','User') -split ';') |
    Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $install }).Count -gt 0
  sourcePinRejected = $rejected.Count -gt 0
} | ConvertTo-Json -Compress
`;

const remoteSchema = z.object({
  build: z.number(),
  admin: z.boolean(),
  acl: z.boolean(),
  keys: z.string(),
  shell: z.enum(["cmd", "powershell", "unsupported"]),
  exe: z.string(),
  version: version.nullable(),
  running: z.boolean(),
  onPath: z.boolean(),
  sourcePinRejected: z.boolean(),
});
const eligibilitySchema = z.object({
  status: z.enum(["eligible", "not eligible", "unknown"]),
  directive: z.enum(["AllowUsers", "AllowGroups", "DenyUsers", "DenyGroups"])
    .optional(),
  message: z.string().optional(),
});
type Eligibility = z.infer<typeof eligibilitySchema>;

function eligibilityScript(target: string) {
  return `${psStart}
${sshEligibility}
$account = ${psQuote(target)}
if ($account -ieq $env:USERNAME) {
  Get-SshEligibility $account @(Get-TokenSshGroups) | ConvertTo-Json -Compress
  return
}
if (!$isAdmin) { throw 'Alternate-account inspection requires an administrator' }
$target = Get-LocalUser -Name $account
$memberSids = @($target.SID.Value, 'S-1-5-11', 'S-1-1-0')
$localGroups = @(Get-LocalGroup)
do {
  $before = $memberSids.Count
  foreach ($group in $localGroups) {
    if ($group.SID.Value -in $memberSids) { continue }
    if (@(Get-LocalGroupMember -Group $group | Where-Object { $_.SID.Value -in $memberSids }).Count) {
      $memberSids += $group.SID.Value
    }
  }
} while ($before -ne $memberSids.Count)
$groups = @($localGroups | Where-Object { $_.SID.Value -in $memberSids } | ForEach-Object {
  $_.Name
  $_.SID.Translate([Security.Principal.NTAccount]).Value
})
Get-SshEligibility $account $groups | ConvertTo-Json -Compress
`;
}

function versionFrom(text: string): string {
  return version.parse(text.replace(/^hc /, ""));
}

async function inspect(
  g: Globals,
  input: BootstrapIdentity,
  signal?: AbortSignal,
) {
  const locations = paths(g);
  const entry = await machine(g, signal);
  const local = await command(g.hcPath, ["--version"], signal);
  if (local.code) throw new Error("Could not read local hc version");
  const localVersion = versionFrom(local.out);
  const verified = await scanHost(g, signal);
  const row = {
    machineName: g.machineName,
    machineState: entry?.state ?? null,
    machineVersion: entry?.version ?? null,
    unsupportedSession: !!entry?.session,
    reachable: verified.reachable,
    observedFingerprints: verified.offered,
    hostKeyMatches: !!verified.key,
    keyAuthorized: false,
    keyOptionsCurrent: false,
    sshEligibility: { status: "unknown" } as Eligibility,
    authReason: null as string | null,
    windowsBuild: null as number | null,
    administratorsMember: null as boolean | null,
    keysFile: null as string | null,
    keysAclCorrect: null as boolean | null,
    remoteShell: null as string | null,
    remoteVersion: null as string | null,
    coreRunning: null as boolean | null,
    onPath: null as boolean | null,
    wrapperCurrent: null as boolean | null,
    localVersion,
    plan: [] as Action[],
  };
  const access = verified.known ? directSsh(g, verified.known) : null;
  if (!access) return { row, entry };

  const clientKey = (await Deno.readTextFile(
    g.identityFile.endsWith(".pub") ? g.identityFile : g.identityFile + ".pub",
  )).trim();
  const desired = authorizedKeyLine(clientKey, g.allowFrom);
  const login = await access(inspectScript, signal);
  row.keyAuthorized = login.code === 0;
  if (
    login.code && !/permission denied|authentication failed/i.test(login.err)
  ) {
    row.authReason = "Pinned SSH or remote inspection failed";
  } else if (login.code) {
    row.authReason = "SSH rejected public-key authentication";
  }
  const bootstrapAccess = input.bootstrapIdentityFile
    ? directSsh(
      { ...g, user: input.bootstrapUser ?? g.user },
      verified.known!,
      {
        identityFile: input.bootstrapIdentityFile,
        sshPrefix: input.bootstrapSshPrefix ?? g.sshPrefix,
      },
    )
    : null;
  const bootstrap = input.bootstrapUser &&
      input.bootstrapUser.toLowerCase() !== g.user.toLowerCase()
    ? null
    : bootstrapAccess;
  const policyAccess = login.code ? bootstrapAccess : access;
  const policy = await policyAccess?.(eligibilityScript(g.user), signal);
  if (policy?.code === 0) {
    try {
      const parsed = eligibilitySchema.safeParse(JSON.parse(policy.out));
      if (parsed.success) row.sshEligibility = parsed.data;
    } catch {
      // The session did not return an interpretable admission check.
    }
  }
  if (row.sshEligibility.status === "not eligible") {
    row.authReason = row.sshEligibility.message ?? null;
  }
  const privileged = login.code
    ? await bootstrap?.(inspectScript, signal)
    : login;
  if (!privileged || privileged.code) return { row, entry };
  const remote = remoteSchema.parse(JSON.parse(privileged.out));
  if (
    !row.keyAuthorized && remote.sourcePinRejected &&
    row.sshEligibility.status !== "not eligible"
  ) {
    row.authReason = "sshd: not from a permitted host";
  }
  const remoteShell = g.remoteShell ?? remote.shell;
  const expected = remoteShell === "unsupported" ? null : renderWrapper({
    ...g,
    remoteExe: remote.exe,
    remoteShell,
    knownHostsFile: sshConfigFileArgument(locations.known),
  });
  let wrapperCurrent = false;
  if (
    expected && await localDirectory(locations.root, false) &&
    await localDirectory(locations.directory, false)
  ) {
    wrapperCurrent = await readLocal(locations.wrapper, 0o700) === expected &&
      await readLocal(locations.known, 0o600) === verified.known;
  }
  const keyOptionsCurrent = remote.acl &&
    !upsertAuthorizedKey(remote.keys, desired).changed;
  const plan = expected && row.sshEligibility.status !== "not eligible"
    ? planSetup({
      keyAuthorized: row.keyAuthorized,
      keyOptionsCurrent,
      remoteVersion: remote.version,
      localVersion,
      wrapperCurrent,
      machine: machineVia(entry, locations.wrapper)
        ? { ...entry!, target: locations.wrapper }
        : entry,
      wrapperPath: locations.wrapper,
    })
    : [];
  Object.assign(row, {
    keyOptionsCurrent,
    windowsBuild: remote.build,
    administratorsMember: remote.admin,
    keysFile: remote.admin
      ? "administrators_authorized_keys"
      : "authorized_keys",
    keysAclCorrect: remote.acl,
    remoteShell,
    remoteVersion: remote.version,
    coreRunning: remote.running,
    onPath: remote.onPath,
    wrapperCurrent,
    plan,
  });
  return {
    row,
    entry,
    remote,
    expected,
    verified,
    access,
    bootstrap,
    clientKey,
    desired,
  };
}

type Inspection = Awaited<ReturnType<typeof inspect>>;
type RemoteAccess = ReturnType<typeof directSsh>;

async function changeKey(
  access: RemoteAccess,
  before: string,
  after: string,
  signal?: AbortSignal,
) {
  const result = await access(
    `${psStart}
${keyContext}
Write-Keys (${psText(before)}) (${psText(after)})
`,
    signal,
  );
  if (result.code) {
    throw new Error(
      "Windows keys update failed. Inspect the keys file and its backup before retrying.",
    );
  }
}

async function checkedHc(
  g: Globals,
  args: string[],
  purpose: string,
  signal?: AbortSignal,
) {
  const result = await command(g.hcPath, args, signal, 150_000);
  if (result.code) throw new Error(purpose);
  return result.out;
}

async function awaitConnected(
  g: Globals,
  signal?: AbortSignal,
  repairedAt?: string,
) {
  const until = Date.now() + 180_000;
  const deadline = AbortSignal.timeout(180_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const login = [g.hcPath, "machine", "login", g.machineName];
  while (Date.now() < until && !bounded.aborted) {
    const entry = await machine(g, bounded).catch((error) => {
      if (!bounded.aborted) throw error;
      return null;
    });
    if (entry?.state === "connected") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    (repairedAt ? `Client key repaired at ${repairedAt}. ` : "") +
      `hc did not connect within three minutes. Run ${
        login.map(shQuote).join(" ")
      } in a terminal.`,
  );
}

async function save(context: Context, name: string, data: unknown) {
  const handle = await context.writeResource(name, name, data);
  return { dataHandles: [handle] };
}

async function stageWrapper(g: Globals, expected: string, known: string) {
  const loc = paths(g);
  await localDirectory(loc.root, true);
  await localDirectory(loc.directory, true);
  await atomicWrite(loc.known, known, 0o600);
  await atomicWrite(loc.wrapper, expected, 0o700);
}

async function releaseInstall(
  access: RemoteAccess,
  localVersion: string,
  signal?: AbortSignal,
) {
  // The versioned official manifest supplies the SHA-256 of the Windows zip.
  const result = await access(
    `${psStart}
$origin = 'https://releases.herdr.dev'
$version = ${psQuote(version.parse(localVersion))}
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { throw 'No verified Windows release for this architecture' }
$manifest = Invoke-RestMethod -Uri "$origin/core/$version/manifest.json" -MaximumRedirection 0
$target = $manifest.targets.'windows-x86_64'
if ($target.sha256 -notmatch '^[0-9a-f]{64}$' -or $target.url -notmatch '^https://releases\\.herdr\\.dev/') {
  throw 'Invalid official Windows release metadata'
}
$install = Join-Path $env:LOCALAPPDATA 'Programs\\herdr-core'
$exe = Join-Path $install 'herdr-core.exe'
if (Test-Path -LiteralPath $exe) { throw 'Refusing to overwrite an existing installation' }
$parent = Split-Path -Parent $install
[IO.Directory]::CreateDirectory($parent) | Out-Null
$tmp = Join-Path $parent ('.herdr-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tmp) | Out-Null
try {
  $zip = Join-Path $tmp 'release.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $target.url -OutFile $zip -MaximumRedirection 0
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ine $target.sha256) { throw 'Windows release checksum mismatch' }
  $unpack = Join-Path $tmp 'unpacked'
  Expand-Archive -LiteralPath $zip -DestinationPath $unpack
  $new = Join-Path $unpack 'herdr-core.exe'
  if (!(Test-Path -LiteralPath (Join-Path $unpack 'conpty\\conpty.dll'))) { throw 'Incomplete ConPTY release' }
  if ((& $new --version) -ne "hc $version" -or $LASTEXITCODE) { throw 'Windows release version mismatch' }
  if (Test-Path -LiteralPath $install) { throw 'Install directory already exists' }
  [IO.Directory]::Move($unpack, $install)
  $path = [Environment]::GetEnvironmentVariable('Path','User')
  if ($install -notin ($path -split ';')) {
    [Environment]::SetEnvironmentVariable('Path', ((@($path,$install) | Where-Object { $_ }) -join ';'), 'User')
  }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }
`,
    signal,
    180_000,
  );
  if (result.code) {
    throw new Error("Verified Windows release installation failed");
  }
}

const setupArgs = bootstrapIdentity.extend({
  temporary: z.boolean().default(false),
});

async function setup(input: z.infer<typeof setupArgs>, context: Context) {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const { signal } = context;
  const seen = await inspect(g, input, signal);
  const { row, entry, remote, expected, verified, access, bootstrap, desired } =
    seen;
  if (row.sshEligibility.status === "not eligible") {
    throw new Error(
      row.sshEligibility.message ?? "The account is not eligible for SSH",
    );
  }
  if (entry?.session) {
    throw new Error("Machines with a named session are read-only");
  }
  if (!remote || !expected || !verified?.known || !access || !desired) {
    throw new Error(
      "Setup requires a verified host key, supported remote shell and working client or bootstrap access",
    );
  }
  const loc = paths(g);
  const via = /^[a-zA-Z0-9_./-]+$/.test(loc.wrapper)
    ? loc.wrapper
    : shQuote(loc.wrapper);
  const add = [
    "machine",
    "add",
    "--json",
    "--name",
    g.machineName,
    "--via",
    via,
  ];
  if (input.temporary) add.push("--temp");
  let installer: string | null = null;
  let update: { status: "manual"; hint: string; command: string } | undefined;
  let repairedAt: string | undefined;
  let added = false;
  for (const action of row.plan) {
    switch (action) {
      case "authorize": {
        const updated = upsertAuthorizedKey(remote.keys, desired);
        await changeKey(
          row.keyAuthorized ? access : bootstrap!,
          remote.keys,
          updated.text,
          signal,
        );
        if (row.plan.includes("await-reconnect")) {
          repairedAt = new Date().toISOString();
        }
        if ((await access("exit 0", signal)).code) {
          throw new Error(
            "The client key still cannot authenticate after authorization",
          );
        }
        break;
      }
      case "install": {
        // hc needs a transport to attempt installation. Stage the intended
        // wrapper before invoking it; the write-wrapper action is idempotent.
        if (!entry) {
          await stageWrapper(g, expected, verified.known);
          const attempt = await command(
            g.hcPath,
            [...add, "--install"],
            signal,
            120_000,
          );
          if (attempt.code === 0) {
            installer = "hc";
            added = true;
            break;
          }
          if (await machine(g, signal)) {
            throw new Error(
              "hc created a machine entry during installation. Inspect it before retrying.",
            );
          }
        }
        await releaseInstall(access, row.localVersion, signal);
        installer = "verified-release";
        break;
      }
      case "update": {
        if (
          !machineVia(entry, loc.wrapper) || !row.wrapperCurrent || !entry ||
          entry.state !== "connected"
        ) {
          throw new Error(
            "Update requires a connected machine using the current pinned wrapper",
          );
        }
        const result = await command(
          g.hcPath,
          ["machine", "update", entry.name, "--json"],
          signal,
          150_000,
        );
        if (result.code) {
          const detail = z.object({
            error: z.object({
              kind: z.literal("install_failed"),
              hint: z.literal("install hc there yourself"),
            }),
          });
          const refusal = [result.err, result.out].flatMap((output) =>
            output.split("\n").flatMap((line) => {
              try {
                const parsed = detail.safeParse(JSON.parse(line));
                return parsed.success ? [parsed.data.error] : [];
              } catch {
                return [];
              }
            })
          )[0];
          if (!refusal) {
            throw new Error(
              "hc machine update failed without its Windows manual-install hint",
            );
          }
          update = {
            status: "manual",
            hint: refusal.hint,
            command:
              "& (Join-Path $env:LOCALAPPDATA 'Programs\\herdr-core\\herdr-core.exe') update",
          };
        }
        break;
      }
      case "write-wrapper":
        await stageWrapper(g, expected, verified.known);
        break;
      case "replace-machine": {
        const current = await machine(g, signal);
        if (
          current?.session ||
          (current &&
            (current.target !== entry?.target || current.via !== entry?.via))
        ) {
          throw new Error("Machine registration changed during setup");
        }
        if (current) {
          await checkedHc(
            g,
            ["machine", "rm", g.machineName],
            "Could not remove the previous machine entry",
            signal,
          );
        }
        await checkedHc(
          g,
          add,
          "Could not register the Windows machine",
          signal,
        );
        break;
      }
      case "add-machine":
        if (!added) {
          await checkedHc(
            g,
            add,
            "Could not register the Windows machine",
            signal,
          );
        }
        break;
      case "await-reconnect":
        break;
    }
  }
  await awaitConnected(g, signal, repairedAt);
  await checkedHc(
    g,
    ["exec", "--on", g.machineName, "--", "cmd", "/d", "/c", "ver"],
    "Windows Herdr smoke command failed",
    signal,
  );
  return save(context, "setup", {
    machineName: g.machineName,
    plan: row.plan,
    installer,
    state: "connected",
    ...(update ? { update } : {}),
    ...(repairedAt ? { repairedAt } : {}),
  });
}

function publicStatus(seen: Inspection, wrapper: string) {
  return {
    ...seen.row,
    via: seen.entry?.via ?? false,
    usingManagedWrapper: machineVia(seen.entry, wrapper),
    wrapperDrift: !machineVia(seen.entry, wrapper) ||
      seen.row.wrapperCurrent !== true,
  };
}

async function transportFingerprint(entry: Machine): Promise<string> {
  const data = new TextEncoder().encode(entry.target);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

const teardownArgs = bootstrapIdentity.extend({
  confirm: MachineName,
  uninstall: z.boolean().default(false),
});

async function teardown(input: z.infer<typeof teardownArgs>, context: Context) {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const { signal } = context;
  if (input.confirm !== g.machineName) {
    throw new Error("confirm must equal machineName");
  }
  const loc = paths(g);
  const seen = await inspect(g, input, signal);
  const { entry, remote, access, bootstrap, row, clientKey } = seen;
  if (entry?.session || (entry && !machineVia(entry, loc.wrapper))) {
    throw new Error("Teardown requires the managed default-session machine");
  }
  const writer = bootstrap ?? (row.keyAuthorized ? access : null);
  if (!remote || !writer || !clientKey) {
    throw new Error("Teardown requires verified Windows access");
  }
  const key = removeAuthorizedKey(remote.keys, clientKey);
  if (entry) {
    await checkedHc(
      g,
      ["machine", "rm", g.machineName],
      "Could not remove the managed machine",
      signal,
    );
  }
  if (input.uninstall && remote.version) {
    const result = await writer(
      `${psStart}
$install = Join-Path $env:LOCALAPPDATA 'Programs\\herdr-core'
$exe = Join-Path $install 'herdr-core.exe'
if ((Get-Item -LiteralPath $install -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked install directory' }
& $exe server stop | Out-Null
if ($LASTEXITCODE -and @(Get-Process -Name herdr-core -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $exe }).Count) {
  throw 'Could not stop the installed core'
}
Remove-Item -LiteralPath $install -Recurse -Force
$path = [Environment]::GetEnvironmentVariable('Path','User')
[Environment]::SetEnvironmentVariable('Path', (($path -split ';' | Where-Object { $_ -and $_ -ine $install }) -join ';'), 'User')
`,
      signal,
    );
    if (result.code) throw new Error("Windows uninstall did not complete");
  }
  if (key.removed) await changeKey(writer, remote.keys, key.text, signal);
  if (
    await localDirectory(loc.root, false) &&
    await localDirectory(loc.directory, false)
  ) {
    for (const path of [loc.wrapper, loc.known]) {
      await Deno.remove(path).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
    await Deno.remove(loc.directory);
  }
  return save(context, "teardown", {
    machineName: g.machineName,
    keysRemoved: key.removed,
    uninstalled: input.uninstall && !!remote.version,
  });
}

function resource(description: string, schema: z.ZodType) {
  return { description, schema, lifetime: "infinite", garbageCollection: 5 };
}
const machineResource = z.object({ machineName: MachineName }).passthrough();
const bootstrapArgs = z.object({
  account: z.enum(["administrator", "standard"]),
});

/** Swamp behavior for provisioning and inspecting Windows Herdr machines. */
export const behavior = {
  type: "@jpisgeek/herdr-windows",
  version: "2026.11.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    preflight: resource("Read-only Windows and Herdr checks", machineResource),
    bootstrap: resource(
      "PowerShell bootstrap script and observed SSH host fingerprints",
      machineResource,
    ),
    setup: resource("Windows Herdr setup receipt", machineResource),
    status: resource("Windows Herdr status", machineResource),
    adopt: resource("Existing Herdr registration and drift", machineResource),
    teardown: resource("Windows Herdr removal receipt", machineResource),
  },
  methods: {
    preflight: {
      description:
        "Inspect Windows, the pinned SSH connection and the local Herdr machine",
      arguments: bootstrapIdentity,
      execute: async (input: BootstrapIdentity, ctx: Context) => {
        const seen = await inspect(
          GlobalArgsSchema.parse(ctx.globalArgs),
          input,
          ctx.signal,
        );
        return save(ctx, "preflight", seen.row);
      },
    },
    bootstrapScript: {
      description: "Render a PowerShell script for console bootstrap",
      arguments: bootstrapArgs,
      execute: async (input: z.infer<typeof bootstrapArgs>, ctx: Context) => {
        const g = GlobalArgsSchema.parse(ctx.globalArgs);
        const key = await Deno.readTextFile(
          g.identityFile.endsWith(".pub")
            ? g.identityFile
            : g.identityFile + ".pub",
        );
        const scan = await scanHost(g, ctx.signal);
        const script = renderBootstrapScript({
          clientPublicKey: key,
          allowFrom: g.allowFrom,
          account: input.account,
        });
        return save(ctx, "bootstrap", {
          machineName: g.machineName,
          observedFingerprints: scan.offered,
          script,
        });
      },
    },
    setup: {
      description: "Authorize, install and connect the Windows machine",
      arguments: setupArgs,
      execute: setup,
    },
    status: {
      description:
        "Report Herdr state, versions, wrapper drift and whether the remote core is running",
      arguments: empty,
      execute: async (_input: unknown, ctx: Context) => {
        const g = GlobalArgsSchema.parse(ctx.globalArgs);
        const seen = await inspect(g, {}, ctx.signal);
        return save(ctx, "status", publicStatus(seen, paths(g).wrapper));
      },
    },
    adopt: {
      description:
        "Record an existing machine and wrapper drift without modifying the registration",
      arguments: empty,
      execute: async (_input: unknown, ctx: Context) => {
        const g = GlobalArgsSchema.parse(ctx.globalArgs);
        const seen = await inspect(g, {}, ctx.signal);
        if (!seen.entry) {
          throw new Error("No local hc machine is registered with this name");
        }
        return save(ctx, "adopt", {
          ...publicStatus(seen, paths(g).wrapper),
          transportFingerprint: await transportFingerprint(seen.entry),
        });
      },
    },
    teardown: {
      description:
        "Remove the managed machine, its client key and local wrapper",
      arguments: teardownArgs,
      execute: teardown,
    },
  },
};
