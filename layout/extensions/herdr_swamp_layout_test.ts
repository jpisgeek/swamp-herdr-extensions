import { model as behavior } from "./herdr_swamp_layout.ts";

type Ctx = Parameters<typeof behavior.methods.install.execute>[1];

/** Builds a fake context whose bundled files live in `src`. */
function ctx(home: string, src: string): Ctx {
  return {
    globalArgs: { herdrHome: home },
    extensionFile: (p: string) => `${src}/${p}`,
    writeResource: (_spec: string, name: string) => Promise.resolve({ name }),
  };
}

/** Creates a source tree holding every file the installer expects. */
async function makeSource(): Promise<string> {
  const src = await Deno.makeTempDir();
  const files = [
    "layouts/swamp.json",
    "layouts/swamp.svg",
    "themes/swamp-club.json",
    "mods/swamp-approvals/main.js",
    "mods/swamp-approvals/mod.json",
    "mods/swamp-runs/main.js",
    "mods/swamp-runs/mod.json",
    "mods/swamp-quickrun/main.js",
    "mods/swamp-quickrun/mod.json",
    "mods/swamp-tabs/main.js",
    "mods/swamp-tabs/mod.json",
    "mods/swamp-tabs/fonts/ChakraPetch-Regular.ttf",
    "mods/swamp-tabs/fonts/ChakraPetch-Medium.ttf",
    "mods/swamp-tabs/fonts/ChakraPetch-SemiBold.ttf",
    "mods/swamp-tabs/fonts/ChakraPetch-Bold.ttf",
    "mods/swamp-tabs/fonts/OFL.txt",
    "mods/swamp-status/main.js",
    "mods/swamp-status/mod.json",
    "mods/swamp-goto/main.js",
    "mods/swamp-goto/mod.json",
    "mods/swamp-stats/main.js",
    "mods/swamp-stats/mod.json",
  ];
  for (const f of files) {
    await Deno.mkdir(`${src}/${f.slice(0, f.lastIndexOf("/"))}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${src}/${f}`, `file ${f}`);
  }
  return src;
}

Deno.test("install copies every file into the Herdr home", async () => {
  const src = await makeSource();
  const home = await Deno.realPath(await Deno.makeTempDir());
  await behavior.methods.install.execute({}, ctx(home, src));
  const copied = await Deno.readTextFile(`${home}/layouts/swamp.json`);
  if (copied !== "file layouts/swamp.json") throw new Error("not copied");
});

Deno.test("upgrade adds new panels to an older managed install and rollback removes only those additions", async () => {
  const src = await makeSource();
  const home = await Deno.realPath(await Deno.makeTempDir());
  const context = ctx(home, src);
  try {
    await behavior.methods.install.execute({}, context);
    const statePath = `${home}/.swamp-layout-state.json`;
    const state = JSON.parse(await Deno.readTextFile(statePath));
    for (const mod of ["swamp-goto", "swamp-stats"]) {
      for (const file of ["main.js", "mod.json"]) {
        delete state.hashes[`mods/${mod}/${file}`];
      }
      await Deno.remove(`${home}/mods/${mod}`, { recursive: true });
    }
    state.version = "2026.11.12.2";
    await Deno.writeTextFile(statePath, JSON.stringify(state));
    await behavior.methods.upgrade.execute({}, context);
    if (
      await Deno.readTextFile(`${home}/mods/swamp-stats/main.js`) !==
        "file mods/swamp-stats/main.js"
    ) throw new Error("new panel missing");
    await behavior.methods.rollback.execute({}, context);
    try {
      await Deno.stat(`${home}/mods/swamp-stats/main.js`);
      throw new Error("rollback retained the new panel");
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    if (
      await Deno.readTextFile(`${home}/layouts/swamp.json`) !==
        "file layouts/swamp.json"
    ) throw new Error("rollback changed the original layout");
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("install refuses to overwrite and copies nothing", async () => {
  const src = await makeSource();
  const home = await Deno.realPath(await Deno.makeTempDir());
  await Deno.mkdir(`${home}/layouts`);
  await Deno.writeTextFile(`${home}/layouts/swamp.json`, "mine");
  let failed = false;
  try {
    await behavior.methods.install.execute({}, ctx(home, src));
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("expected install to refuse");
  const kept = await Deno.readTextFile(`${home}/layouts/swamp.json`);
  if (kept !== "mine") throw new Error("overwrote an existing file");
  try {
    await Deno.lstat(`${home}/themes/swamp-club.json`);
    throw new Error("copied despite refusing");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
});

Deno.test("install fails when the Herdr home is missing", async () => {
  const src = await makeSource();
  let failed = false;
  try {
    await behavior.methods.install.execute({}, ctx("/nonexistent/herdr", src));
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("expected install to fail");
});

function assert(value: unknown, message = "assertion failed") {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => Promise<unknown>) {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(rejected, "expected refusal");
}

Deno.test("upgrade backs up, preserves local config, rolls back, and is idempotent", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir());
  const context = ctx(home, src);
  await behavior.methods.install.execute({}, context);
  const config = '{"repos":["~/private-repo"]}\n';
  await Deno.writeTextFile(`${home}/swamp.json`, config);
  await Deno.writeTextFile(
    `${src}/mods/swamp-runs/main.js`,
    "new implementation",
  );
  await behavior.methods.upgrade.execute({}, context);
  assert(
    await Deno.readTextFile(`${home}/mods/swamp-runs/main.js`) ===
      "new implementation",
  );
  assert(await Deno.readTextFile(`${home}/swamp.json`) === config);
  assert(
    await Deno.readTextFile(
      `${home}/.swamp-layout-backup/local-config/swamp.json`,
    ) === config,
  );
  const backup = await Deno.readTextFile(
    `${home}/.swamp-layout-backup/receipt.json`,
  );
  await behavior.methods.upgrade.execute({}, context);
  assert(
    await Deno.readTextFile(`${home}/.swamp-layout-backup/receipt.json`) ===
      backup,
    "no-op replaced backup",
  );
  await behavior.methods.rollback.execute({}, context);
  assert(
    await Deno.readTextFile(`${home}/mods/swamp-runs/main.js`) ===
      "file mods/swamp-runs/main.js",
  );
  assert(await Deno.readTextFile(`${home}/swamp.json`) === config);
  await behavior.methods.rollback.execute({}, context);
});

Deno.test("local asset edit aborts upgrade before any managed write", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  await behavior.methods.install.execute({}, context);
  await Deno.writeTextFile(`${home}/mods/swamp-tabs/main.js`, "user edit");
  await Deno.writeTextFile(`${src}/layouts/swamp.json`, "new upstream");
  await rejects(() => behavior.methods.upgrade.execute({}, context));
  assert(
    await Deno.readTextFile(`${home}/layouts/swamp.json`) ===
      "file layouts/swamp.json",
  );
  assert(
    await Deno.readTextFile(`${home}/mods/swamp-tabs/main.js`) === "user edit",
  );
});
Deno.test("rollback refuses later edits and does not restore old personal config", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  await behavior.methods.install.execute({}, context);
  await Deno.writeTextFile(`${src}/layouts/swamp.json`, "new");
  await behavior.methods.upgrade.execute({}, context);
  await Deno.writeTextFile(`${home}/mods/swamp-tabs/main.js`, "later edit");
  await rejects(() => behavior.methods.rollback.execute({}, context));
  assert(await Deno.readTextFile(`${home}/layouts/swamp.json`) === "new");
});
Deno.test("unknown legacy install refuses upgrade", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir());
  await Deno.mkdir(`${home}/layouts`);
  await Deno.writeTextFile(`${home}/layouts/swamp.json`, "custom");
  await rejects(() => behavior.methods.upgrade.execute({}, ctx(home, src)));
  assert(await Deno.readTextFile(`${home}/layouts/swamp.json`) === "custom");
});
Deno.test("symlink and concurrent lock are refused", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    outside = await Deno.makeTempDir();
  await Deno.symlink(outside, `${home}/mods`);
  await rejects(() => behavior.methods.install.execute({}, ctx(home, src)));
  await Deno.remove(`${home}/mods`);
  await Deno.mkdir(`${home}/.swamp-layout-lock`);
  await rejects(() => behavior.methods.install.execute({}, ctx(home, src)));
});
Deno.test("missing source file fails preflight without partial install", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir());
  await Deno.remove(`${src}/mods/swamp-status/mod.json`);
  await rejects(() => behavior.methods.install.execute({}, ctx(home, src)));
  await rejects(() => Deno.stat(`${home}/layouts/swamp.json`));
});
Deno.test("corrupt backup refuses rollback", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  await behavior.methods.install.execute({}, context);
  await Deno.writeTextFile(`${src}/layouts/swamp.json`, "new");
  await behavior.methods.upgrade.execute({}, context);
  await Deno.writeTextFile(
    `${home}/.swamp-layout-backup/files/layouts/swamp.json`,
    "corrupt",
  );
  await rejects(() => behavior.methods.rollback.execute({}, context));
  assert(await Deno.readTextFile(`${home}/layouts/swamp.json`) === "new");
});

Deno.test("identical manually installed bytes can adopt a receipt", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  await behavior.methods.install.execute({}, context);
  await Deno.remove(`${home}/.swamp-layout-state.json`);
  await behavior.methods.upgrade.execute({}, context);
  assert(
    (await Deno.readTextFile(`${home}/.swamp-layout-state.json`)).includes(
      "hashes",
    ),
  );
});
Deno.test("mid-write failure restores already written managed files", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  await behavior.methods.install.execute({}, context);
  await Deno.writeTextFile(`${src}/layouts/swamp.json`, "new json");
  await Deno.writeTextFile(`${src}/layouts/swamp.svg`, "new svg");
  const original = Deno.rename;
  let failed = false;
  Deno.rename = async (from, to) => {
    if (to === `${home}/layouts/swamp.svg` && !failed) {
      failed = true;
      throw new Error("injected write failure");
    }
    return await original(from, to);
  };
  try {
    await rejects(() => behavior.methods.upgrade.execute({}, context));
  } finally {
    Deno.rename = original;
  }
  assert(
    await Deno.readTextFile(`${home}/layouts/swamp.json`) ===
      "file layouts/swamp.json",
  );
  assert(
    await Deno.readTextFile(`${home}/layouts/swamp.svg`) ===
      "file layouts/swamp.svg",
  );
});

Deno.test("post-preflight symlink swap is refused without writes outside home", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    outside = await Deno.realPath(await Deno.makeTempDir());
  const context = ctx(home, src);
  let injected = false;
  context.extensionFile = (rel) => {
    if (!injected) {
      injected = true;
      Deno.symlinkSync(outside, `${home}/mods`);
    }
    return `${src}/${rel}`;
  };
  await rejects(() => behavior.methods.install.execute({}, context));
  assert(
    Array.from(Deno.readDirSync(outside)).length === 0,
    "wrote outside home",
  );
  await rejects(() => Deno.stat(`${home}/layouts/swamp.json`));
});
Deno.test("rollback receipt reports restored version, not updater version", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  await behavior.methods.install.execute({}, context);
  const state = JSON.parse(
    await Deno.readTextFile(`${home}/.swamp-layout-state.json`),
  );
  state.version = "previous-test-release";
  await Deno.writeTextFile(
    `${home}/.swamp-layout-state.json`,
    JSON.stringify(state),
  );
  await Deno.writeTextFile(`${src}/layouts/swamp.json`, "new release");
  await behavior.methods.upgrade.execute({}, context);
  let version: unknown;
  context.writeResource = (_spec, _name, data) => {
    version = (data as { version: string }).version;
    return Promise.resolve({});
  };
  await behavior.methods.rollback.execute({}, context);
  assert(version === "previous-test-release");
});
Deno.test("resource failure clearly reports committed files and leaves retry safe", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  context.writeResource = () =>
    Promise.reject(new Error("receipt unavailable"));
  let message = "";
  try {
    await behavior.methods.install.execute({}, context);
  } catch (e) {
    message = String(e);
  }
  assert(message.includes("FILES COMMITTED"));
  assert(
    await Deno.readTextFile(`${home}/layouts/swamp.json`) ===
      "file layouts/swamp.json",
  );
  context.writeResource = () => Promise.resolve({});
  await behavior.methods.upgrade.execute({}, context);
});

Deno.test("filesystem guard never passes an empty path to native lstat", async () => {
  const src = await makeSource(),
    home = await Deno.realPath(await Deno.makeTempDir()),
    context = ctx(home, src);
  const original = Deno.lstat;
  Deno.lstat = async (path) => {
    if (path === "") throw new Error("Empty path is not allowed");
    return await original(path);
  };
  try {
    await behavior.methods.install.execute({}, context);
  } finally {
    Deno.lstat = original;
  }
  assert(
    await Deno.readTextFile(`${home}/layouts/swamp.json`) ===
      "file layouts/swamp.json",
  );
});
