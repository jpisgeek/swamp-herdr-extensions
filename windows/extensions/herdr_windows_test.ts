import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  authorizedKeyLine,
  behavior,
  classifyRemoteLine,
  fingerprint,
  renderBootstrapScript,
  shQuote,
} from "./herdr_windows.ts";

const key =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV1K2ZLpIKGtS1ULVwlvdP1Q2kFqYn9+jfNIHVSzFJd";
const networks = ["192.0.2.0/24"];

Deno.test("standard bootstrap skips host-wide work and protects the profile keys", () => {
  const script = renderBootstrapScript({
    clientPublicKey: key,
    allowFrom: networks,
    account: "standard",
  });
  assertStringIncludes(script, "Skipping sshd and firewall changes");
  assertEquals(
    /Get-Service|Set-Service|Start-Service|FirewallRule|WindowsCapability/.test(
      script,
    ),
    false,
  );
  assertStringIncludes(script, "DirectorySecurity");
  assertStringIncludes(
    script,
    "[IO.Directory]::SetAccessControl($parent, $acl)",
  );
  assertStringIncludes(script, "@('S-1-5-18', 'S-1-5-32-544', $owner)");
  assertStringIncludes(script, "Write-Keys $before");
  assertStringIncludes(script, "ssh-keyscan.exe");
  assertStringIncludes(script, "-T 5 -t ed25519 127.0.0.1");
});

Deno.test("setup pins the host, preserves healthy state, and reports manual update", async () => {
  const dir = await Deno.makeTempDir();
  const stateDir = join(dir, "state");
  const hcPath = join(dir, "hc");
  const sshPath = join(dir, "ssh");
  const identityFile = join(dir, "key.pub");
  const scan = join(dir, "scan");
  const sshCalls = join(dir, "ssh-calls");
  const machines = join(dir, "machines");
  const oldVersion = join(dir, "old-version");
  const receipts: unknown[] = [];
  const observed = await fingerprint(key);
  const globals = {
    machineName: "test-windows",
    host: "windows.example.invalid",
    user: "test",
    hostKeyFingerprint: observed,
    allowFrom: networks,
    identityFile,
    stateDir,
    hcPath,
    sshPath,
  };
  const context = {
    globalArgs: globals,
    writeResource: (_spec: string, _name: string, data: unknown) => {
      receipts.push(data);
      return Promise.resolve("receipt");
    },
  };
  const Command = Deno.Command;

  try {
    await Deno.writeTextFile(identityFile, key);
    await Deno.writeTextFile(scan, `windows.example.invalid ${key}\n`);
    await Deno.writeTextFile(
      hcPath,
      `#!/bin/sh
case "$1 $2" in
  '--version ') echo 'hc 0.1.22' ;;
  'machine ls') if test -f ${shQuote(machines)}; then cat ${
        shQuote(machines)
      }; else echo '{"machines":[]}'; fi ;;
  'machine add') printf '%s\\n' ${
        shQuote(JSON.stringify({
          machines: [{
            name: "test-windows",
            via: true,
            state: "connected",
            target: join(stateDir, "test-windows", "connect"),
            version: "0.1.22",
          }],
        }))
      } > ${shQuote(machines)} ;;
  'exec --on') test "$*" = 'exec --on test-windows -- cmd /d /c ver' ;;
  'machine update') printf '%s\\n' '{"error":{"kind":"install_failed","hint":"install hc there yourself","message":"<via> runs Windows"}}' >&2; exit 1 ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    await Deno.writeTextFile(
      sshPath,
      `#!/bin/sh
last=''
for arg; do last=$arg; done
case "$last" in
  'powershell -NoProfile -NonInteractive -EncodedCommand '*) ;;
  *) exit 2 ;;
esac
IFS= read -r size
body=$(cat)
test "${"${#body}"}" = "$size" || exit 3
test "${"${#last}"}" -lt 8191 || exit 4
printf '%s\\n' "$body" >> ${shQuote(sshCalls)}
remote_version=0.1.22
test ! -f ${shQuote(oldVersion)} || remote_version=0.1.21
printf '%s\\n' ${
        shQuote(JSON.stringify({
          build: 26100,
          admin: true,
          acl: true,
          keys: authorizedKeyLine(key, networks) + "\n",
          shell: "cmd",
          exe:
            "C:\\Users\\test\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe",
          version: "VERSION",
          running: true,
          onPath: true,
          sourcePinRejected: false,
        }))
      } | sed "s/VERSION/$remote_version/"
`,
      { mode: 0o700 },
    );
    Deno.Command = class extends Command {
      constructor(program: string | URL, options?: Deno.CommandOptions) {
        const scanner = program === "/usr/bin/ssh-keyscan";
        super(
          scanner ? "/bin/cat" : program,
          scanner ? { ...options, args: [scan] } : options,
        );
      }
    };
    const runSetup = behavior.methods.setup.execute;
    globals.hostKeyFingerprint = "SHA256:" + "A".repeat(43);
    await assertRejects(
      () => runSetup({ temporary: true }, context),
      Error,
      "verified host key",
    );
    await assertRejects(() => Deno.stat(sshCalls), Deno.errors.NotFound);
    await assertRejects(() => Deno.stat(stateDir), Deno.errors.NotFound);
    assertEquals(receipts, []);

    globals.hostKeyFingerprint = observed;
    await runSetup({ temporary: true }, context);
    const body = (await Deno.readTextFile(sshCalls)).trim();
    const script = new TextDecoder().decode(
      inflateRawSync(Uint8Array.from(atob(body), (char) => char.charCodeAt(0))),
    );
    assertStringIncludes(script, "ConvertTo-Json -Compress");
    const wrapper = join(stateDir, "test-windows", "connect");
    const known = join(stateDir, "test-windows", "known_hosts");
    assertStringIncludes(
      await Deno.readTextFile(wrapper),
      "StrictHostKeyChecking=yes",
    );
    const original = await Promise.all(
      [wrapper, known].map((path) => Deno.stat(path)),
    );
    await runSetup({ temporary: true }, context);
    const after = await Promise.all(
      [wrapper, known].map((path) => Deno.stat(path)),
    );
    assertEquals(
      after.map(({ ino, mtime }) => ({ ino, mtime })),
      original.map(({ ino, mtime }) => ({ ino, mtime })),
    );
    assertEquals(receipts, [
      {
        machineName: "test-windows",
        plan: ["write-wrapper", "add-machine"],
        installer: null,
        state: "connected",
      },
      {
        machineName: "test-windows",
        plan: [],
        installer: null,
        state: "connected",
      },
    ]);
    await Deno.writeTextFile(oldVersion, "");
    await runSetup({ temporary: true }, context);
    assertEquals(receipts.at(-1), {
      machineName: "test-windows",
      plan: ["update"],
      installer: null,
      state: "connected",
      update: {
        status: "manual",
        hint: "install hc there yourself",
        command:
          "& (Join-Path $env:LOCALAPPDATA 'Programs\\herdr-core\\herdr-core.exe') update",
      },
    });
  } finally {
    Deno.Command = Command;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("classifies both exact hc 0.1.22 connect probes", () => {
  const unix =
    'sh -c \'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; exec "$p" connect\'';
  const windows =
    'cmd /d /c "if exist .\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe (.\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe connect) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"';
  assertEquals(classifyRemoteLine(unix), "connect");
  assertEquals(classifyRemoteLine(windows), "connect");
  assertEquals(classifyRemoteLine("uname -sm"), "passthrough");
  assertEquals(
    classifyRemoteLine('cmd /d /c "echo herdr-core-windows"'),
    "passthrough",
  );
  assertEquals(
    classifyRemoteLine(windows.replace(" connect)", " --version)")),
    "passthrough",
  );
});
