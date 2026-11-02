import { z } from "npm:zod@4";

/** Files the extension bundles, relative to the extension root and to the Herdr home. */
const FILES: readonly string[] = [
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

const GlobalArgsSchema = z.object({
  herdrHome: z.string().optional().describe(
    "Herdr home folder. Defaults to $HERDR_APP_HOME, else ~/.config/herdr-app",
  ),
});

const InstallSchema = z.object({
  home: z.string(),
  copied: z.array(z.string()),
  installedAt: z.string(),
});

/** Returns the Herdr home folder to install into. */
function resolveHome(arg: string | undefined): string {
  const home = arg ?? Deno.env.get("HERDR_APP_HOME") ??
    `${Deno.env.get("HOME") ?? ""}/.config/herdr-app`;
  return home.replace(/\/+$/, "");
}

/** Returns true when a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/** Returns the folder part of a path. */
function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/**
 * Herdr swamp layout installer. The `install` method copies the layout, theme
 * and five mods into a Herdr home. It never overwrites: if any target exists
 * it stops before copying anything.
 */
export const behavior = {
  type: "@jpisgeek/herdr-swamp-layout",
  version: "2026.11.02.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "install": {
      description: "What the last install copied",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    install: {
      description:
        "Copy the Herdr swamp layout, theme and mods into the Herdr home. Refuses to overwrite.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          extensionFile: (path: string) => string;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const home = resolveHome(context.globalArgs.herdrHome);
        if (!(await exists(home))) {
          throw new Error(
            `Herdr home not found: ${home}. Start Herdr once, then run install again.`,
          );
        }
        const taken: string[] = [];
        for (const rel of FILES) {
          if (await exists(`${home}/${rel}`)) taken.push(rel);
        }
        if (taken.length > 0) {
          throw new Error(
            `Nothing copied. These already exist in ${home}: ${
              taken.join(", ")
            }`,
          );
        }
        for (const rel of FILES) {
          const to = `${home}/${rel}`;
          await Deno.mkdir(dirname(to), { recursive: true });
          await Deno.copyFile(context.extensionFile(rel), to);
        }
        const handle = await context.writeResource("install", "install", {
          home,
          copied: [...FILES],
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
