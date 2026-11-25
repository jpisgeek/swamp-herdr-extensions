/**
 * Acceptance tests for @jpisgeek/herdr-windows.
 *
 * Plan: docs/plans/2026-11-25-herdr-windows.md
 *
 * The reviewer owns this file. Implementers make it pass and must not edit it:
 * its SHA-256 is recorded in the plan, and a changed hash fails review on its
 * own. Add your own cases to herdr_windows_test.ts instead.
 *
 * Nothing here needs a Windows machine or the network. The wrapper tests do
 * run the generated script, against a fake ssh that records its argv, because
 * quoting is only proven by executing it.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import type { z } from "npm:zod@4";
import {
  authorizedKeyLine,
  CidrList,
  classifyRemoteLine,
  fingerprint,
  GlobalArgsSchema,
  HostKeyFingerprint,
  MachineName,
  parseMachines,
  planSetup,
  removeAuthorizedKey,
  renderBootstrapScript,
  renderKnownHosts,
  renderWrapper,
  shQuote,
  upsertAuthorizedKey,
} from "./herdr_windows.ts";

// Throwaway fixture keys. Their private halves were discarded at creation.
const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV1K2ZLpIKGtS1ULVwlvdP1Q2kFqYn9+jfNIHVSzFJd fixture@example.invalid";
const KEY_A_FP = "SHA256:M+8zsXphyluqer2nDH3WUuFcnYsHewVqBQKUodBgCCI";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKsy+bWRZvzZ9oKiXocFjfIp1rF0Pri4NYBwfFN9HXwG second@example.invalid";
const BLOB_A = KEY_A.split(" ")[1];
const BLOB_B = KEY_B.split(" ")[1];

const LAN = ["192.0.2.0/24", "198.51.100.0/24"];
const EXE =
  "C:\\Users\\Administrator\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe";

const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;
const ASCII_ONLY = /^[\t\n\r -~]*$/;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

Deno.test("MachineName follows hc's naming and avoids terminal-id lookalikes", () => {
  for (const good of ["win-build", "win01", "e2e-win01", "a"]) {
    assert(ok(MachineName, good), `refused ${good}`);
  }
  for (
    const bad of [
      "",
      "Win01",
      "t14",
      "t2",
      "a_b",
      "-a",
      "a-",
      "a/b",
      "a".repeat(33),
    ]
  ) {
    assertFalse(ok(MachineName, bad), `accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test("CidrList accepts real networks and single addresses", () => {
  assert(ok(CidrList, LAN));
  assert(ok(CidrList, ["192.168.1.10"]));
  assert(ok(CidrList, ["2001:db8::/32"]));
});

Deno.test("CidrList refuses empty, anywhere, hostnames, wildcards and malformed entries", () => {
  for (
    const bad of [
      [],
      ["0.0.0.0/0"],
      ["::/0"],
      ["*"],
      ["10.0.*"],
      ["host.example.com"],
      ["10.0.0.0/33"],
      ["10.0.0.256/24"],
      ["10.0.0.0/16,10.1.0.0/16"],
      ["192.0.2.5/24"], // host bits set: sshd rejects these
      ["10.0.0.0/16", "10.0.0.0/16"],
      ["!10.0.0.0/8"],
      [" 10.0.0.0/8"],
    ]
  ) {
    assertFalse(ok(CidrList, bad), `accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test("HostKeyFingerprint takes only the SHA256 form ssh-keygen prints", () => {
  assert(ok(HostKeyFingerprint, KEY_A_FP));
  for (
    const bad of [
      "",
      KEY_A_FP.slice(7),
      KEY_A_FP + "=",
      "MD5:9f:2a:1c:00:11:22:33:44:55:66:77:88:99:aa:bb:cc",
      "SHA256:short",
      `${KEY_A_FP} extra`,
    ]
  ) {
    assertFalse(ok(HostKeyFingerprint, bad), `accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test("GlobalArgsSchema demands identity and pinning, defaults the rest", () => {
  const minimal = {
    machineName: "e2e-win01",
    host: "10.0.0.5",
    user: "Administrator",
    hostKeyFingerprint: KEY_A_FP,
    allowFrom: LAN,
    identityFile: "/home/op/.ssh/herdr_windows",
  };
  const a = GlobalArgsSchema.parse(minimal);
  assertEquals(a.port, 22);
  assertEquals(a.hcPath, "hc");
  assertEquals(a.sshPath, "/usr/bin/ssh");
  for (const key of Object.keys(minimal)) {
    const { [key]: _gone, ...rest } = minimal as Record<string, unknown>;
    assertFalse(ok(GlobalArgsSchema, rest), `${key} should be required`);
  }
  assertFalse(ok(GlobalArgsSchema, { ...minimal, host: "op@10.0.0.5" }));
  assertFalse(ok(GlobalArgsSchema, { ...minimal, host: "-oProxyCommand=x" }));
  assertFalse(ok(GlobalArgsSchema, { ...minimal, user: "a@b" }));
  assertFalse(
    ok(GlobalArgsSchema, { ...minimal, identityFile: "relative/key" }),
  );
  assertFalse(
    ok(GlobalArgsSchema, { ...minimal, sshPrefix: ["relative/helper.sh"] }),
  );
  assert(
    ok(GlobalArgsSchema, { ...minimal, sshPrefix: ["/opt/ops/with-key.sh"] }),
  );
});

Deno.test("GlobalArgsSchema marks the machine identity sensitive", () => {
  assertEquals(GlobalArgsSchema.shape.host.meta()?.sensitive, true);
  assertEquals(GlobalArgsSchema.shape.user.meta()?.sensitive, true);
});

// ---------------------------------------------------------------------------
// authorized_keys handling
// ---------------------------------------------------------------------------

Deno.test("authorizedKeyLine always pins the source networks and restricts the key", () => {
  assertEquals(
    authorizedKeyLine(KEY_A, LAN),
    `from="192.0.2.0/24,198.51.100.0/24",restrict ${KEY_A}`,
  );
  assertThrows(() => authorizedKeyLine(KEY_A, []));
  assertThrows(() => authorizedKeyLine(KEY_A, ["0.0.0.0/0"]));
  assertThrows(() => authorizedKeyLine("not a key", LAN));
  assertThrows(() => authorizedKeyLine(`restrict ${KEY_A}`, LAN));
});

Deno.test("upsertAuthorizedKey creates a file from nothing", () => {
  const line = authorizedKeyLine(KEY_A, LAN);
  const r = upsertAuthorizedKey("", line);
  assertEquals(r.text, line + "\n");
  assertEquals(r.changed, true);
  assertEquals(r.replaced, false);
});

Deno.test("upsertAuthorizedKey is a no-op when the line is already exact", () => {
  const line = authorizedKeyLine(KEY_A, LAN);
  const text = `${KEY_B}\n${line}\n`;
  const r = upsertAuthorizedKey(text, line);
  assertEquals(r.text, text);
  assertEquals(r.changed, false);
});

Deno.test("upsertAuthorizedKey replaces the same key in place, whatever its old options", () => {
  // The outage this extension exists to prevent: a key pinned to one address.
  const old = `from="203.0.113.7",restrict ${KEY_A}`;
  const text =
    `${KEY_B}\r\n\r\n# keep me\r\n${old}\r\nssh-ed25519 ${BLOB_B} other\r\n`;
  const line = authorizedKeyLine(KEY_A, LAN);
  const r = upsertAuthorizedKey(text, line);
  assertEquals(
    r.text,
    `${KEY_B}\r\n\r\n# keep me\r\n${line}\r\nssh-ed25519 ${BLOB_B} other\r\n`,
  );
  assertEquals(r.changed, true);
  assertEquals(r.replaced, true);
});

Deno.test("upsertAuthorizedKey matches by key blob, not by comment or quoted options", () => {
  const old =
    `command="echo hi there",no-pty ssh-ed25519 ${BLOB_A} renamed-comment`;
  const line = authorizedKeyLine(KEY_A, LAN);
  const r = upsertAuthorizedKey(`${old}\n`, line);
  assertEquals(r.text, `${line}\n`);
  assertEquals(r.replaced, true);
});

Deno.test("upsertAuthorizedKey collapses duplicates of the same key to one line", () => {
  const line = authorizedKeyLine(KEY_A, LAN);
  const text = `${KEY_A}\n${KEY_B}\nrestrict ${KEY_A}\n`;
  const r = upsertAuthorizedKey(text, line);
  assertEquals(r.text, `${line}\n${KEY_B}\n`);
});

Deno.test("upsertAuthorizedKey appends with the file's own line ending", () => {
  const line = authorizedKeyLine(KEY_A, LAN);
  assertEquals(
    upsertAuthorizedKey(`${KEY_B}\r\n`, line).text,
    `${KEY_B}\r\n${line}\r\n`,
  );
  assertEquals(
    upsertAuthorizedKey(`${KEY_B}`, line).text,
    `${KEY_B}\n${line}\n`,
  );
});

Deno.test("upsertAuthorizedKey strips a byte-order mark, which breaks sshd's first line", () => {
  const line = authorizedKeyLine(KEY_A, LAN);
  const r = upsertAuthorizedKey(`\uFEFF${KEY_B}\n`, line);
  assertEquals(r.text, `${KEY_B}\n${line}\n`);
  assertEquals(r.bomRemoved, true);
  assertEquals(r.changed, true);
});

Deno.test("removeAuthorizedKey removes every line for the key and nothing else", () => {
  const text =
    `${KEY_B}\r\nrestrict ${KEY_A}\r\n# c\r\nfrom="10.0.0.0/8" ssh-ed25519 ${BLOB_A}\r\n`;
  const r = removeAuthorizedKey(text, KEY_A);
  assertEquals(r.text, `${KEY_B}\r\n# c\r\n`);
  assertEquals(r.removed, 2);
  const none = removeAuthorizedKey(`${KEY_B}\n`, KEY_A);
  assertEquals(none.text, `${KEY_B}\n`);
  assertEquals(none.removed, 0);
});

// ---------------------------------------------------------------------------
// Host keys
// ---------------------------------------------------------------------------

Deno.test("fingerprint matches ssh-keygen -l for the same key", async () => {
  assertEquals(await fingerprint(KEY_A), KEY_A_FP);
  assertEquals(await fingerprint(`ssh-ed25519 ${BLOB_A}`), KEY_A_FP);
});

Deno.test("renderKnownHosts uses ssh's host and [host]:port forms", () => {
  assertEquals(
    renderKnownHosts("10.0.0.5", 22, KEY_A),
    `10.0.0.5 ssh-ed25519 ${BLOB_A}\n`,
  );
  assertEquals(
    renderKnownHosts("10.0.0.5", 2222, KEY_A),
    `[10.0.0.5]:2222 ssh-ed25519 ${BLOB_A}\n`,
  );
  assertEquals(
    renderKnownHosts("win01.lan", 22, KEY_A),
    `win01.lan ssh-ed25519 ${BLOB_A}\n`,
  );
  assertThrows(() => renderKnownHosts("10.0.0.5", 22, "nonsense"));
  assertThrows(() => renderKnownHosts("op@10.0.0.5", 22, KEY_A));
});

// ---------------------------------------------------------------------------
// The hc connect line
// ---------------------------------------------------------------------------

Deno.test("classifyRemoteLine finds hc's connect probes in both shells", () => {
  for (
    const line of [
      "sh -c 'herdr-core connect'",
      `sh -c '"$HOME"/.local/bin/herdr-core connect'`,
      "cmd /d /c herdr-core.exe connect",
      'cmd /d /c "herdr-core.exe" connect',
    ]
  ) {
    assertEquals(classifyRemoteLine(line), "connect", line);
  }
});

Deno.test("classifyRemoteLine passes everything else through untouched", () => {
  for (
    const line of [
      "sh -c 'herdr-core --version'",
      "cmd /d /c herdr-core.exe --version",
      "sh -c 'uname -s'",
      "cmd /d /c ver",
      "connect herdr-core",
      "sh -c 'echo connect; herdr-core version'",
      "",
    ]
  ) {
    assertEquals(classifyRemoteLine(line), "passthrough", line);
  }
});

Deno.test("shQuote survives anything", () => {
  assertEquals(shQuote(""), "''");
  assertEquals(shQuote("plain"), "'plain'");
  assertEquals(shQuote("a'b"), `'a'\\''b'`);
});

// ---------------------------------------------------------------------------
// The wrapper, executed against a fake ssh
// ---------------------------------------------------------------------------

type Run = { code: number; argv: string[] };

async function harness() {
  const dir = await Deno.makeTempDir({ prefix: "herdr-windows-test-" });
  const fakeSsh = join(dir, "fake-ssh");
  await Deno.writeTextFile(
    fakeSsh,
    `#!/bin/bash\ntouch ${
      shQuote(join(dir, "ssh-ran"))
    }\nprintf '%s\\0' "$@"\n`,
  );
  await Deno.chmod(fakeSsh, 0o755);
  const prefix = join(dir, "fake-prefix");
  await Deno.writeTextFile(
    prefix,
    `#!/bin/bash\nprintf 'PREFIX\\0'\nexec "$@"\n`,
  );
  await Deno.chmod(prefix, 0o755);
  return { dir, fakeSsh, prefix };
}

async function runWrapper(
  script: string,
  dir: string,
  args: string[],
): Promise<Run> {
  const path = join(dir, "connect");
  await Deno.writeTextFile(path, script);
  await Deno.chmod(path, 0o700);
  // cwd is the scratch dir so an injected `$(touch pwned)` would land where the test looks.
  const out = await new Deno.Command(path, {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  const argv = new TextDecoder().decode(out.stdout).split("\0");
  argv.pop();
  return { code: out.code, argv };
}

function opt(argv: string[], value: string) {
  const i = argv.indexOf(value);
  return i > 0 && argv[i - 1] === "-o";
}

Deno.test("wrapper rewrites hc's connect probe to the installed exe, for cmd", async () => {
  const h = await harness();
  try {
    const known = join(h.dir, "known_hosts");
    const script = renderWrapper({
      host: "10.0.0.5",
      user: "Administrator",
      port: 22,
      knownHostsFile: known,
      identityFile: "/home/op/.ssh/herdr_windows",
      sshPath: h.fakeSsh,
      remoteExe: EXE,
      remoteShell: "cmd",
    });
    assert(script.startsWith("#!/bin/bash\n"));
    assertStringIncludes(script, "set -euo pipefail");
    const r = await runWrapper(script, h.dir, [
      "cmd /d /c herdr-core.exe connect",
    ]);
    assertEquals(r.code, 0);
    assertEquals(r.argv.at(-1), `"${EXE}" connect`);
    assertEquals(r.argv.at(-2), "Administrator@10.0.0.5");
    assertEquals(r.argv.at(-3), "--");
    const f = r.argv.indexOf("-F");
    assert(
      f >= 0 && r.argv[f + 1] === "/dev/null",
      "ambient ssh config not disabled",
    );
    for (
      const o of [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        `UserKnownHostsFile=${known}`,
        "GlobalKnownHostsFile=/dev/null",
        "PreferredAuthentications=publickey",
        "IdentitiesOnly=yes",
        "ForwardAgent=no",
        "ClearAllForwardings=yes",
        "ControlMaster=no",
        "ControlPath=none",
      ]
    ) {
      assert(opt(r.argv, o), `missing -o ${o}`);
    }
    const i = r.argv.indexOf("-i");
    assert(i >= 0 && r.argv[i + 1] === "/home/op/.ssh/herdr_windows");
    const p = r.argv.indexOf("-p");
    assert(p >= 0 && r.argv[p + 1] === "22");
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("wrapper writes a PowerShell-safe connect line when that is the remote shell", async () => {
  const h = await harness();
  try {
    const exe =
      "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe";
    const script = renderWrapper({
      host: "10.0.0.5",
      user: "obrien",
      port: 2222,
      knownHostsFile: join(h.dir, "known_hosts"),
      identityFile: "/home/op/.ssh/herdr_windows",
      sshPath: h.fakeSsh,
      remoteExe: exe,
      remoteShell: "powershell",
    });
    const r = await runWrapper(script, h.dir, ["sh -c 'herdr-core connect'"]);
    assertEquals(r.code, 0);
    assertEquals(
      r.argv.at(-1),
      "& 'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe' connect",
    );
    const p = r.argv.indexOf("-p");
    assert(p >= 0 && r.argv[p + 1] === "2222");
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("wrapper quotes cmd paths that contain spaces", async () => {
  const h = await harness();
  try {
    const exe =
      "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe";
    const script = renderWrapper({
      host: "10.0.0.5",
      user: "jane",
      port: 22,
      knownHostsFile: join(h.dir, "known_hosts"),
      identityFile: "/home/op/.ssh/herdr_windows",
      sshPath: h.fakeSsh,
      remoteExe: exe,
      remoteShell: "cmd",
    });
    const r = await runWrapper(script, h.dir, [
      "cmd /d /c herdr-core.exe connect",
    ]);
    assertEquals(r.argv.at(-1), `"${exe}" connect`);
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("wrapper passes every other line through byte for byte", async () => {
  const h = await harness();
  try {
    const script = renderWrapper({
      host: "10.0.0.5",
      user: "Administrator",
      port: 22,
      knownHostsFile: join(h.dir, "known_hosts"),
      identityFile: "/home/op/.ssh/herdr_windows",
      sshPath: h.fakeSsh,
      remoteExe: EXE,
      remoteShell: "cmd",
    });
    const line = `cmd /d /c echo "$(whoami)" '; rm -rf ~' %PATH%`;
    const r = await runWrapper(script, h.dir, [line]);
    assertEquals(r.code, 0);
    assertEquals(r.argv.at(-1), line);
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("wrapper refuses anything but exactly one argument, without running ssh", async () => {
  const h = await harness();
  try {
    const script = renderWrapper({
      host: "10.0.0.5",
      user: "Administrator",
      port: 22,
      knownHostsFile: join(h.dir, "known_hosts"),
      identityFile: "/home/op/.ssh/herdr_windows",
      sshPath: h.fakeSsh,
      remoteExe: EXE,
      remoteShell: "cmd",
    });
    for (const args of [[], ["a", "b"]]) {
      const r = await runWrapper(script, h.dir, args);
      assertEquals(r.code, 2, `args ${JSON.stringify(args)}`);
    }
    const ran = await Deno.stat(join(h.dir, "ssh-ran")).then(
      () => true,
      () => false,
    );
    assertFalse(ran, "ssh ran for a refused call");
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("wrapper treats hostile local paths as data", async () => {
  const h = await harness();
  try {
    const hostile = join(h.dir, `it's $(touch pwned) a dir`);
    await Deno.mkdir(hostile);
    const known = join(hostile, "known_hosts");
    const script = renderWrapper({
      host: "10.0.0.5",
      user: "Administrator",
      port: 22,
      knownHostsFile: known,
      identityFile: join(hostile, "key"),
      sshPath: h.fakeSsh,
      remoteExe: EXE,
      remoteShell: "cmd",
    });
    const r = await runWrapper(script, h.dir, ["cmd /d /c ver"]);
    assertEquals(r.code, 0);
    assert(opt(r.argv, `UserKnownHostsFile=${known}`));
    const pwned = await Deno.stat(join(h.dir, "pwned")).then(
      () => true,
      () => false,
    );
    assertFalse(pwned, "a path was executed");
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("wrapper runs ssh through an operator-supplied prefix when given one", async () => {
  const h = await harness();
  try {
    const script = renderWrapper({
      host: "10.0.0.5",
      user: "Administrator",
      port: 22,
      knownHostsFile: join(h.dir, "known_hosts"),
      identityFile: "/home/op/.ssh/herdr_windows.pub",
      sshPath: h.fakeSsh,
      sshPrefix: [h.prefix],
      remoteExe: EXE,
      remoteShell: "cmd",
    });
    const r = await runWrapper(script, h.dir, ["cmd /d /c ver"]);
    assertEquals(r.code, 0);
    assertEquals(r.argv[0], "PREFIX");
    assertEquals(r.argv.at(-1), "cmd /d /c ver");
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("renderWrapper is deterministic", () => {
  const o = {
    host: "10.0.0.5",
    user: "Administrator",
    port: 22,
    knownHostsFile: "/home/op/.config/herdr-windows/win01/known_hosts",
    identityFile: "/home/op/.ssh/herdr_windows",
    sshPath: "/usr/bin/ssh",
    remoteExe: EXE,
    remoteShell: "cmd" as const,
  };
  assertEquals(renderWrapper(o), renderWrapper(o));
});

// ---------------------------------------------------------------------------
// Bootstrap script (pasted by a person on a machine with no key access yet)
// ---------------------------------------------------------------------------

Deno.test("bootstrap for an administrator writes the admin keys file, locked by SID", () => {
  const ps = renderBootstrapScript({
    clientPublicKey: KEY_A,
    allowFrom: LAN,
    account: "administrator",
  });
  assertStringIncludes(ps, authorizedKeyLine(KEY_A, LAN));
  assertStringIncludes(ps, "administrators_authorized_keys");
  assertStringIncludes(ps, "/inheritance:r");
  assertStringIncludes(ps, "*S-1-5-18:F");
  assertStringIncludes(ps, "*S-1-5-32-544:F");
});

Deno.test("bootstrap for a standard user writes that user's own keys file", () => {
  const ps = renderBootstrapScript({
    clientPublicKey: KEY_A,
    allowFrom: LAN,
    account: "standard",
  });
  assertMatch(ps, /\.ssh\\authorized_keys/);
  assertFalse(ps.includes("administrators_authorized_keys"));
  assertStringIncludes(ps, "/inheritance:r");
  assertStringIncludes(ps, "WindowsIdentity]::GetCurrent()");
});

Deno.test("bootstrap turns sshd on, opens 22/TCP and prints the host key fingerprint", () => {
  const ps = renderBootstrapScript({
    clientPublicKey: KEY_A,
    allowFrom: LAN,
    account: "administrator",
  });
  assertMatch(ps, /Set-Service\s+-Name\s+sshd\s+-StartupType\s+Automatic/);
  assertMatch(ps, /Start-Service\s+(-Name\s+)?sshd/);
  assertMatch(ps, /New-NetFirewallRule[^\n]*-LocalPort\s+22\b/);
  assertStringIncludes(ps, "ssh-keygen");
  assertStringIncludes(ps, "ssh_host_ed25519_key.pub");
});

Deno.test("bootstrap is ASCII, grants nobody broad access and holds no secret", () => {
  for (const account of ["administrator", "standard"] as const) {
    const ps = renderBootstrapScript({
      clientPublicKey: KEY_A,
      allowFrom: LAN,
      account,
    });
    assertMatch(ps, ASCII_ONLY);
    assertFalse(
      /Out-File/.test(ps),
      "Out-File writes UTF-16 on Windows PowerShell",
    );
    for (
      const broad of [
        "Everyone",
        "Authenticated Users",
        "S-1-1-0",
        "S-1-5-11",
        "S-1-5-32-545",
      ]
    ) {
      assertFalse(ps.includes(broad), `grants ${broad}`);
    }
    assertFalse(ps.includes("PRIVATE KEY"));
  }
});

Deno.test("bootstrap refuses bad keys and bad networks", () => {
  assertThrows(() =>
    renderBootstrapScript({
      clientPublicKey: "nope",
      allowFrom: LAN,
      account: "administrator",
    })
  );
  assertThrows(() =>
    renderBootstrapScript({
      clientPublicKey: KEY_A,
      allowFrom: ["0.0.0.0/0"],
      account: "administrator",
    })
  );
});

// ---------------------------------------------------------------------------
// hc state
// ---------------------------------------------------------------------------

const MACHINES = JSON.stringify({
  machines: [
    {
      host: "mac-a",
      id: "4c6bff7c7f9bb226d43035c73b45bed8",
      name: "mac-a",
      session: null,
      state: "connected",
      target: "mac-a",
      temporary: false,
      version: "0.1.22",
      via: false,
    },
    {
      host: "win01",
      id: "1ae025082e361b05e11326af7b889574",
      name: "win01",
      session: null,
      since_ms: 1795560122623,
      state: "needs_login",
      target: "/home/op/.config/herdr-windows/win01/connect",
      temporary: false,
      version: "0.1.22",
      via: true,
    },
  ],
});

Deno.test("parseMachines reads hc machine ls --json", () => {
  const rows = parseMachines(MACHINES);
  assertEquals(rows.length, 2);
  assertEquals(rows[1], {
    name: "win01",
    state: "needs_login",
    target: "/home/op/.config/herdr-windows/win01/connect",
    version: "0.1.22",
    via: true,
  });
});

Deno.test("parseMachines refuses shapes it does not understand", () => {
  assertThrows(() => parseMachines("not json"));
  assertThrows(() => parseMachines("{}"));
  assertThrows(() => parseMachines(JSON.stringify({ machines: {} })));
  assertThrows(() =>
    parseMachines(JSON.stringify({ machines: [{ state: "connected" }] }))
  );
});

// ---------------------------------------------------------------------------
// planSetup: what setup will do, decided before it does anything
// ---------------------------------------------------------------------------

const CURRENT = {
  keyAuthorized: true,
  keyOptionsCurrent: true,
  remoteVersion: "0.1.22",
  localVersion: "0.1.22",
  wrapperCurrent: true,
  machine: { state: "connected", target: "/w/connect" },
  wrapperPath: "/w/connect",
};

Deno.test("planSetup on a fresh machine does everything, in order", () => {
  assertEquals(
    planSetup({
      ...CURRENT,
      keyAuthorized: false,
      keyOptionsCurrent: false,
      remoteVersion: null,
      wrapperCurrent: false,
      machine: null,
    }),
    ["authorize", "install", "write-wrapper", "add-machine"],
  );
});

Deno.test("planSetup on a healthy machine does nothing", () => {
  assertEquals(planSetup(CURRENT), []);
});

Deno.test("planSetup compares versions numerically", () => {
  assertEquals(planSetup({ ...CURRENT, remoteVersion: "0.1.9" }), ["update"]);
  assertEquals(planSetup({ ...CURRENT, remoteVersion: "0.1.30" }), []);
  assertEquals(
    planSetup({ ...CURRENT, remoteVersion: "0.2.0", localVersion: "0.10.0" }),
    ["update"],
  );
});

Deno.test("planSetup repairs a stale source pin and then waits for hc to reconnect", () => {
  assertEquals(
    planSetup({
      ...CURRENT,
      keyOptionsCurrent: false,
      machine: { state: "needs_login", target: "/w/connect" },
    }),
    ["authorize", "await-reconnect"],
  );
  assertEquals(
    planSetup({
      ...CURRENT,
      machine: { state: "needs_login", target: "/w/connect" },
    }),
    ["await-reconnect"],
  );
});

Deno.test("planSetup re-adds a machine that points at some other wrapper", () => {
  assertEquals(
    planSetup({
      ...CURRENT,
      machine: { state: "connected", target: "/elsewhere/connect" },
    }),
    ["replace-machine"],
  );
});

Deno.test("planSetup rewrites a stale wrapper without touching the hc entry", () => {
  assertEquals(planSetup({ ...CURRENT, wrapperCurrent: false }), [
    "write-wrapper",
  ]);
});
