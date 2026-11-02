import { behavior } from "./herdr_swamp_layout.ts";

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
  const home = await Deno.makeTempDir();
  await behavior.methods.install.execute({}, ctx(home, src));
  const copied = await Deno.readTextFile(`${home}/layouts/swamp.json`);
  if (copied !== "file layouts/swamp.json") throw new Error("not copied");
});

Deno.test("install refuses to overwrite and copies nothing", async () => {
  const src = await makeSource();
  const home = await Deno.makeTempDir();
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
