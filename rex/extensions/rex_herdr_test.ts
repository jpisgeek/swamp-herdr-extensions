import { initTemplate, model as behavior, resolvePaths } from "./rex_herdr.ts";

type Ctx = Parameters<typeof behavior.methods.install.execute>[1];

/** The extension root, so tests install the real bundled files. */
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Builds a fake context that installs into `dir` and records resources. */
function ctx(dir: string, written: Record<string, unknown>[] = []): Ctx {
  return {
    globalArgs: { rexConfigDir: dir },
    extensionFile: (p: string) => `${ROOT}/${p}`,
    writeResource: (_spec: string, name: string, data) => {
      written.push(data);
      return Promise.resolve({ name });
    },
  };
}

/** Throws with `msg` unless `ok`. */
function assert(ok: boolean, msg: string): void {
  if (!ok) throw new Error(msg);
}

/** Returns true when a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("install copies the module and helper and creates init.lua", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const out: Record<string, unknown>[] = [];
  await behavior.methods.install.execute({ reload: false }, ctx(dir, out));
  assert(await exists(`${dir}/rex_herdr.lua`), "module not copied");
  assert(
    (await Deno.readTextFile(`${dir}/swamp-club`)).includes(
      "palette = 10=#39ff14",
    ),
    "theme not copied",
  );
  const mode = (await Deno.stat(`${dir}/rex-herdr-swamp`)).mode ?? 0;
  assert((mode & 0o111) !== 0, "helper is not executable");
  const init = await Deno.readTextFile(`${dir}/init.lua`);
  assert(init.includes('require("rex_herdr")'), "init.lua does not load it");
  assert(out[0].initLua === "created", "initLua should be created");
  assert(out[0].reloaded === false, "reloaded with reload: false");
});

Deno.test("install twice changes nothing the second time", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  await behavior.methods.install.execute({ reload: false }, ctx(dir));
  const out: Record<string, unknown>[] = [];
  await behavior.methods.install.execute({ reload: false }, ctx(dir, out));
  assert((out[0].copied as string[]).length === 0, "copied again");
  assert((out[0].unchanged as string[]).length === 3, "not reported unchanged");
  assert(out[0].initLua === "loads", "initLua should be loads");
});

Deno.test("install refuses a changed file and copies nothing", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  await Deno.writeTextFile(`${dir}/rex-herdr-swamp`, "mine");
  let failed = false;
  try {
    await behavior.methods.install.execute({ reload: false }, ctx(dir));
  } catch {
    failed = true;
  }
  assert(failed, "expected install to refuse");
  assert(
    (await Deno.readTextFile(`${dir}/rex-herdr-swamp`)) === "mine",
    "overwrote a changed file",
  );
  assert(!(await exists(`${dir}/rex_herdr.lua`)), "copied despite refusing");
  assert(!(await exists(`${dir}/init.lua`)), "wrote init.lua despite refusing");
});

Deno.test("install leaves an existing init.lua alone and says what to add", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const mine = 'rex.bind("ctrl+g", "pane.zoom")\n';
  await Deno.writeTextFile(`${dir}/init.lua`, mine);
  const out: Record<string, unknown>[] = [];
  await behavior.methods.install.execute({ reload: false }, ctx(dir, out));
  assert(
    (await Deno.readTextFile(`${dir}/init.lua`)) === mine,
    "edited init.lua",
  );
  assert(out[0].initLua === "not-loaded", "initLua should be not-loaded");
  assert(
    String(out[0].addLine).includes('require("rex_herdr")'),
    "no line to add",
  );
});

Deno.test("install refuses symlink files and config directories before copying anything", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    for (const target of ["rex_herdr.lua", "init.lua", "directory"]) {
      for (const dangling of [false, true]) {
        const dir = `${root}/${target}-${dangling}`;
        const outside = `${root}/outside-${target}-${dangling}`;
        if (target === "directory") {
          if (!dangling) await Deno.mkdir(outside);
          await Deno.symlink(outside, dir);
        } else {
          await Deno.mkdir(dir);
          if (!dangling) await Deno.writeTextFile(outside, "keep");
          await Deno.symlink(outside, `${dir}/${target}`);
        }
        let message = "";
        try {
          await behavior.methods.install.execute({ reload: false }, ctx(dir));
        } catch (error) {
          message = String(error);
        }
        assert(message.includes("Symlink refused"), `did not refuse ${target}`);
        assert(
          !(await exists(`${dir}/rex-herdr-swamp`)),
          "copied before refusal",
        );
        if (target !== "directory" && !dangling) {
          assert(
            await Deno.readTextFile(outside) === "keep",
            "changed outside file",
          );
        }
        if (dangling) {
          assert(!(await exists(outside)), "created a symlink target");
        }
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** True when the rex CLI is on PATH, so tests can exercise `rex config check`. */
async function haveRex(): Promise<boolean> {
  try {
    await new Deno.Command("rex", {
      args: ["version"],
      stdout: "null",
      stderr: "null",
    })
      .output();
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name: "install fails without writing a resource when rex config check fails",
  ignore: !(await haveRex()),
  fn: async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir());
    await Deno.writeTextFile(`${dir}/init.lua`, "this is not lua (\n");
    const out: Record<string, unknown>[] = [];
    let message = "";
    try {
      await behavior.methods.install.execute({ reload: false }, ctx(dir, out));
    } catch (e) {
      message = String((e as Error).message);
    }
    assert(
      message.includes("rex config check failed"),
      "expected a check failure",
    );
    assert(out.length === 0, "wrote a resource despite failing");
  },
});

Deno.test("the posix-host check passes on this machine", async () => {
  const r = await behavior.checks["posix-host"].execute();
  assert(r.pass === (Deno.build.os !== "windows"), "wrong check result");
});

Deno.test("status reports missing, current and differs", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const status = (out: Record<string, unknown>[]) =>
    behavior.methods.status.execute({}, ctx(dir, out));

  const before: Record<string, unknown>[] = [];
  await status(before);
  const f0 = before[0].files as Record<string, string>;
  assert(f0["rex_herdr.lua"] === "missing", "should be missing");
  assert(before[0].initLua === "missing", "init should be missing");

  await behavior.methods.install.execute({ reload: false }, ctx(dir));
  await Deno.writeTextFile(`${dir}/rex-herdr-swamp`, "edited");
  const after: Record<string, unknown>[] = [];
  await status(after);
  const f1 = after[0].files as Record<string, string>;
  assert(f1["rex_herdr.lua"] === "current", "module should be current");
  assert(f1["rex-herdr-swamp"] === "differs", "helper should differ");
  assert(after[0].initLua === "loads", "init should load it");
});

Deno.test("init template names hc only when it is not in ~/.local/bin", () => {
  const home = Deno.env.get("HOME") ?? "";
  assert(
    !initTemplate(`${home}/.local/bin/hc`).includes("hc ="),
    "default hc written",
  );
  assert(
    initTemplate("/opt/hc/bin/hc").includes('hc = "/opt/hc/bin/hc"'),
    "custom hc missing",
  );
});

Deno.test("an explicit config folder wins over the environment", () => {
  const p = resolvePaths("/tmp/rexcfg/");
  assert(
    p.dir === "/tmp/rexcfg" && p.init === "/tmp/rexcfg/init.lua",
    "wrong paths",
  );
});
