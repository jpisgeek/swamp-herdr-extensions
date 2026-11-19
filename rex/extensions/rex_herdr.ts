import { z } from "npm:zod@4.6.7";

/** Files the extension bundles, relative to its root and to the Rex config folder. `swamp-club` is the Swamp Club palette (MIT, see THIRD_PARTY_NOTICES.md). */
const FILES: readonly string[] = [
  "rex/rex_herdr.lua",
  "rex/rex-herdr-swamp",
  "rex/swamp-club",
];

/** The helper script, which must stay executable. */
const HELPER = "rex/rex-herdr-swamp";

/** Matches an init.lua line that loads the module. */
const LOADS = /require\s*\(?\s*["']rex_herdr["']/;

const GlobalArgsSchema = z.object({
  rexConfigDir: z.string().optional().describe(
    "Rex config folder, where init.lua lives. Defaults to the folder of $REX_CONFIG, else $XDG_CONFIG_HOME/rex, else ~/.config/rex",
  ),
});

const InstallArgsSchema = z.object({
  reload: z.boolean().default(true).describe(
    "Ask the running Rex server to reload its config after a clean check",
  ),
});

const FileStateSchema = z.enum(["missing", "current", "differs"]);
const InitStateSchema = z.enum(["created", "loads", "not-loaded", "missing"]);

const InstallSchema = z.object({
  dir: z.string(),
  copied: z.array(z.string()),
  unchanged: z.array(z.string()),
  initLua: InitStateSchema,
  addLine: z.string().nullable(),
  hc: z.string().nullable(),
  check: z.string().nullable(),
  reloaded: z.boolean(),
  installedAt: z.string(),
});

const StatusSchema = z.object({
  dir: z.string(),
  files: z.record(z.string(), FileStateSchema),
  initLua: InitStateSchema,
  hc: z.string().nullable(),
  check: z.string().nullable(),
  checkedAt: z.string(),
});

type Paths = { dir: string; init: string };

/** Returns the Rex config folder and init.lua path to work in. */
export function resolvePaths(arg: string | undefined): Paths {
  const env = (k: string) => Deno.env.get(k) || undefined;
  if (arg) {
    const dir = arg.replace(/\/+$/, "");
    return { dir, init: `${dir}/init.lua` };
  }
  const cfg = env("REX_CONFIG");
  if (cfg) return { dir: dirname(cfg), init: cfg };
  const base = env("XDG_CONFIG_HOME") ?? `${env("HOME") ?? ""}/.config`;
  const dir = `${base.replace(/\/+$/, "")}/rex`;
  return { dir, init: `${dir}/init.lua` };
}

/** Returns the folder part of a path. */
function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** Returns the last part of a path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Refuse linked destinations, including dangling links and linked ancestors. */
async function safePath(path: string): Promise<void> {
  if (!path.startsWith("/")) {
    throw new Error("Rex config path must be absolute");
  }
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      if ((await Deno.lstat(current)).isSymlink) {
        throw new Error(`Symlink refused: ${current}`);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}

/** Returns a file's bytes, or null when it doesn't exist. */
async function readOrNull(path: string): Promise<Uint8Array | null> {
  await safePath(path);
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/** Returns true when two byte arrays hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Compares an installed file with the bundled one. */
async function fileState(
  installed: string,
  bundled: string,
): Promise<z.infer<typeof FileStateSchema>> {
  const have = await readOrNull(installed);
  if (have === null) return "missing";
  const want = await Deno.readFile(bundled);
  return same(have, want) ? "current" : "differs";
}

/** Reports whether init.lua exists and loads the module. */
async function initState(
  init: string,
): Promise<z.infer<typeof InitStateSchema>> {
  const bytes = await readOrNull(init);
  if (bytes === null) return "missing";
  return LOADS.test(new TextDecoder().decode(bytes)) ? "loads" : "not-loaded";
}

/** Finds the herdr-core CLI: ~/.local/bin/hc first, then each PATH folder. */
export async function findHc(): Promise<string | null> {
  const home = Deno.env.get("HOME") ?? "";
  const dirs = [
    `${home}/.local/bin`,
    ...(Deno.env.get("PATH") ?? "").split(":"),
  ];
  for (const d of dirs) {
    if (!d) continue;
    try {
      const info = await Deno.stat(`${d}/hc`);
      if (info.isFile) return `${d}/hc`;
    } catch (e) {
      // Not in this folder, or a PATH entry that can't be read: try the next.
      if (
        !(e instanceof Deno.errors.NotFound ||
          e instanceof Deno.errors.NotADirectory ||
          e instanceof Deno.errors.PermissionDenied)
      ) throw e;
    }
  }
  return null;
}

/** The init.lua the installer writes when there is none. */
export function initTemplate(hc: string | null): string {
  const home = Deno.env.get("HOME") ?? "";
  const hcLine = hc && hc !== `${home}/.local/bin/hc`
    ? `\n  hc = ${JSON.stringify(hc)},`
    : "";
  return `-- Rex config. Written by @jpisgeek/rex-herdr because there was none.
-- rex_herdr adds Herdr and Swamp entries to the command palette.
-- Change the key, or set it to false to leave it unbound.
require("rex_herdr").setup({${hcLine}
  keys = { herdr_pick = "cmd+shift+h" },
})
`;
}

/** Runs \`rex config check\` against init.lua. Returns its output, or null without rex. */
async function rexCheck(
  init: string,
): Promise<{ ok: boolean; output: string } | null> {
  try {
    // Fixed argv, no user input; swamp has no primitive for Rex. See README.
    // swamp-quality-ignore deno-command
    const out = await new Deno.Command("rex", {
      args: ["config", "check"],
      env: { REX_CONFIG: init },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    return { ok: out.success, output: text.trim() };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/** Asks the running Rex server to reload its config. Returns true on success. */
async function rexReload(): Promise<boolean> {
  try {
    // Fixed argv, no user input; swamp has no primitive for Rex. See README.
    // swamp-quality-ignore deno-command
    const out = await new Deno.Command("rex", {
      args: ["config", "reload"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

type Ctx = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  extensionFile: (path: string) => string;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
};

/**
 * Rex palette entries for herdr-core and swamp. `install` copies the Lua
 * module and its swamp helper into the Rex config folder, creates init.lua
 * when there is none, checks the config and reloads Rex. It never overwrites a
 * changed file or edits an existing init.lua. `status` reports what is
 * installed without changing anything.
 */
export const model = {
  type: "@jpisgeek/rex-herdr",
  version: "2026.11.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "install": {
      description: "What the last install copied and found",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "status": {
      description: "What is installed now, compared with the bundled files",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  checks: {
    "posix-host": {
      description:
        "The Lua module and helper run /bin/sh, so install needs macOS or Linux",
      labels: ["policy"],
      appliesTo: ["install"],
      execute: () =>
        Promise.resolve(
          Deno.build.os === "windows"
            ? {
              pass: false,
              errors: [
                "rex-herdr needs macOS or Linux: its helper is POSIX sh.",
              ],
            }
            : { pass: true },
        ),
    },
  },
  methods: {
    install: {
      description:
        "Copy the Rex module and swamp helper into the Rex config folder, create init.lua if missing, check and reload. Refuses to overwrite a changed file.",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: Ctx,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { dir, init } = resolvePaths(context.globalArgs.rexConfigDir);
        const reload = args.reload ?? true;
        context.logger?.info("Installing rex-herdr into {dir}", { dir });

        const states: Record<string, z.infer<typeof FileStateSchema>> = {};
        for (const rel of FILES) {
          states[rel] = await fileState(
            `${dir}/${basename(rel)}`,
            context.extensionFile(rel),
          );
        }
        const differs = FILES.filter((rel) => states[rel] === "differs");
        if (differs.length > 0) {
          throw new Error(
            `Nothing copied. These exist in ${dir} and differ from the bundled files: ${
              differs.map(basename).join(", ")
            }. Move them aside, then run install again.`,
          );
        }

        let initLua = await initState(init);
        await safePath(dir);
        await Deno.mkdir(dir, { recursive: true });
        const copied: string[] = [];
        const unchanged: string[] = [];
        for (const rel of FILES) {
          const to = `${dir}/${basename(rel)}`;
          if (states[rel] === "current") {
            unchanged.push(basename(rel));
            continue;
          }
          await safePath(to);
          await Deno.writeFile(
            to,
            await Deno.readFile(context.extensionFile(rel)),
            {
              createNew: true,
            },
          );
          copied.push(basename(rel));
        }
        await safePath(`${dir}/${basename(HELPER)}`);
        await Deno.chmod(`${dir}/${basename(HELPER)}`, 0o755);

        const hc = await findHc();
        let addLine: string | null = null;
        if (initLua === "missing") {
          await safePath(init);
          await Deno.writeTextFile(init, initTemplate(hc), { createNew: true });
          initLua = "created";
        } else if (initLua === "not-loaded") {
          addLine = 'require("rex_herdr").setup({})';
          context.logger?.info(
            "{init} was left as it is. Add this line to it: {addLine}",
            { init, addLine },
          );
        }

        const check = await rexCheck(init);
        if (check && !check.ok) {
          throw new Error(
            `rex config check failed for ${init} (copied: ${
              copied.join(", ") || "nothing"
            }; init.lua: ${initLua}):\n${check.output}`,
          );
        }
        let reloaded = false;
        if (check?.ok && reload && initLua !== "not-loaded") {
          reloaded = await rexReload();
        }

        context.logger?.info(
          "Installed rex-herdr: copied {copied}, unchanged {unchanged}, init.lua {initLua}, reloaded {reloaded}",
          { copied, unchanged, initLua, reloaded },
        );
        const handle = await context.writeResource("install", "install", {
          dir,
          copied,
          unchanged,
          initLua,
          addLine,
          hc,
          check: check?.output ?? null,
          reloaded,
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    status: {
      description:
        "Report whether the Rex module and helper are installed and current, and whether init.lua loads them. Changes nothing.",
      kind: "read",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Ctx,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { dir, init } = resolvePaths(context.globalArgs.rexConfigDir);
        context.logger?.info("Checking rex-herdr in {dir}", { dir });
        const files: Record<string, z.infer<typeof FileStateSchema>> = {};
        for (const rel of FILES) {
          files[basename(rel)] = await fileState(
            `${dir}/${basename(rel)}`,
            context.extensionFile(rel),
          );
        }
        const initLua = await initState(init);
        const check = initLua === "missing" ? null : await rexCheck(init);
        context.logger?.info("rex-herdr files {files}, init.lua {initLua}", {
          files,
          initLua,
        });
        const handle = await context.writeResource("status", "status", {
          dir,
          files,
          initLua,
          hc: await findHc(),
          check: check?.output ?? null,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
