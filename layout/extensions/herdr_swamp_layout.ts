import { z } from "npm:zod@4.6.7";

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
  "mods/swamp-goto/main.js",
  "mods/swamp-goto/mod.json",
  "mods/swamp-stats/main.js",
  "mods/swamp-stats/mod.json",
];

const GlobalArgsSchema = z.object({ herdrHome: z.string().optional() });
const Receipt = z.object({
  home: z.string(),
  action: z.string(),
  version: z.string(),
  changed: z.array(z.string()),
  at: z.string(),
});
import LEGACY from "./legacy-hashes.json" with { type: "json" };
const VERSION = "2026.11.19.1";
const STATE = ".swamp-layout-state.json";
const BACKUP = ".swamp-layout-backup";
type State = { version: string; hashes: Record<string, string> };
type Ctx = {
  globalArgs: { herdrHome?: string };
  extensionFile(path: string): string;
  writeResource(spec: string, name: string, data: unknown): Promise<unknown>;
};
const encoder = new TextEncoder();
async function hash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function read(path: string): Promise<Uint8Array | null> {
  await safe("", path.slice(1));
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}
async function safe(home: string, rel: string) {
  let path = home || "/";
  for (const part of ["", ...rel.split("/")]) {
    if (part) path += `${path.endsWith("/") ? "" : "/"}${part}`;
    try {
      const s = await Deno.lstat(path);
      if (s.isSymlink) throw new Error(`Symlink refused: ${path}`);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}
async function put(path: string, data: Uint8Array | null) {
  await safe("", path.slice(1));
  if (data === null) {
    try {
      await Deno.remove(path);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return;
  }
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await safe("", path.slice(1));
  const tmp = `${path}.swamp-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmp, data, { createNew: true });
    await safe("", tmp.slice(1));
    await safe("", path.slice(1));
    await Deno.rename(tmp, path);
    // A successful rename consumes the temporary file. No cleanup remains.
  } catch (operationError) {
    try {
      await safe("", tmp.slice(1));
      await Deno.remove(tmp);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) {
        throw new AggregateError(
          [operationError, cleanupError],
          `Write and temporary-file cleanup both failed: ${path}`,
        );
      }
    }
    throw operationError;
  }
}
async function apply(action: "install" | "upgrade" | "rollback", context: Ctx) {
  const home =
    (context.globalArgs.herdrHome ?? Deno.env.get("HERDR_APP_HOME") ??
      `${Deno.env.get("HOME")}/.config/herdr-app`).replace(/\/+$/, "");
  if (!home.startsWith("/")) throw new Error("Herdr home must be absolute");
  // Recheck ancestors before filesystem operations. This is defensive checking,
  // not a dirfd/no-follow security boundary against hostile concurrent writers.
  await safe("", home.slice(1));
  if (!(await Deno.stat(home)).isDirectory) {
    throw new Error("Herdr home must exist");
  }
  await safe(home, ".swamp-layout-lock");
  await Deno.mkdir(`${home}/.swamp-layout-lock`); // fail closed on concurrent or interrupted run
  try {
    for (const rel of [...FILES, STATE, BACKUP, "swamp.json"]) {
      await safe(home, rel);
    }
    const previous = new Map<string, Uint8Array | null>();
    for (const rel of [...FILES, STATE]) {
      previous.set(rel, await read(`${home}/${rel}`));
    }
    const stateBytes = previous.get(STATE)!;
    if (action === "install" && stateBytes) {
      throw new Error("Existing managed installation; use upgrade");
    }
    const state: State | null = stateBytes
      ? JSON.parse(new TextDecoder().decode(stateBytes))
      : null;
    const next = new Map<string, Uint8Array | null>();
    if (action === "rollback") {
      await safe(home, `${BACKUP}/receipt.json`);
      const meta = JSON.parse(
        new TextDecoder().decode(
          (await read(`${home}/${BACKUP}/receipt.json`)) ?? new Uint8Array(),
        ),
      );
      const alreadyRestored =
        (await Promise.all([...previous].map(async ([rel, bytes]) =>
          (bytes ? await hash(bytes) : null) === meta.before[rel]
        ))).every(Boolean);
      for (const rel of [...FILES, STATE]) {
        const current = previous.get(rel)!;
        if (
          !alreadyRestored &&
          (current ? await hash(current) : null) !== meta.after[rel]
        ) {
          throw new Error(`Rollback conflict: ${rel}`);
        }
        await safe(home, `${BACKUP}/files/${rel}`);
        next.set(
          rel,
          meta.before[rel] === null
            ? null
            : await read(`${home}/${BACKUP}/files/${rel}`),
        );
        if (
          (next.get(rel) ? await hash(next.get(rel)!) : null) !==
            meta.before[rel]
        ) {
          throw new Error(`Backup checksum failed: ${rel}`);
        }
      }
    } else {
      const hashes: Record<string, string> = {};
      for (const rel of FILES) {
        const bytes = await Deno.readFile(context.extensionFile(rel));
        hashes[rel] = await hash(bytes);
        next.set(rel, bytes);
        const old = previous.get(rel)!;
        const oldHash = old ? await hash(old) : null;
        if (action === "install" && old) {
          throw new Error(`Install refuses overwrite: ${rel}`);
        }
        if (action === "upgrade" && oldHash !== hashes[rel]) {
          const known = state
            ? (state.hashes[rel] ?? null) === oldHash
            : oldHash === null
            ? !(rel in LEGACY)
            : (LEGACY as Record<string, string[]>)[rel]?.includes(oldHash);
          if (!known) {
            throw new Error(
              `Local edit or unknown installation: ${rel}. No files changed. Merge it explicitly before retrying.`,
            );
          }
        }
      }
      next.set(
        STATE,
        encoder.encode(
          JSON.stringify({ version: VERSION, hashes }, null, 2) + "\n",
        ),
      );
    }
    const changed: string[] = [];
    for (const [rel, bytes] of next) {
      const old = previous.get(rel)!;
      if (
        (old ? await hash(old) : null) !== (bytes ? await hash(bytes) : null)
      ) changed.push(rel);
    }
    // Source resolution can yield; inspect the full destination tree again.
    for (const rel of [...FILES, STATE, BACKUP, "swamp.json"]) {
      await safe("", `${home}/${rel}`.slice(1));
    }
    if (changed.length && action !== "rollback") {
      // Never destroy a previous rollback point. Archive it locally first.
      try {
        const archive = `${home}/${BACKUP}-${crypto.randomUUID()}`;
        await safe("", `${home}/${BACKUP}`.slice(1));
        await safe("", archive.slice(1));
        await Deno.rename(`${home}/${BACKUP}`, archive);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      await safe("", `${home}/${BACKUP}`.slice(1));
      await Deno.mkdir(`${home}/${BACKUP}`, { mode: 0o700 });
      const before: Record<string, string | null> = {},
        after: Record<string, string | null> = {};
      for (const [rel, bytes] of previous) {
        before[rel] = bytes ? await hash(bytes) : null;
        if (bytes) await put(`${home}/${BACKUP}/files/${rel}`, bytes);
        const n = next.get(rel)!;
        after[rel] = n ? await hash(n) : null;
      }
      const config = await read(`${home}/swamp.json`);
      if (config) {
        await put(`${home}/${BACKUP}/local-config/swamp.json`, config);
      }
      await put(
        `${home}/${BACKUP}/receipt.json`,
        encoder.encode(
          JSON.stringify({ before, after, at: new Date().toISOString() }),
        ),
      );
    }
    const written: string[] = [];
    try {
      for (const rel of changed) {
        const now = await read(`${home}/${rel}`), old = previous.get(rel)!;
        if ((now ? await hash(now) : null) !== (old ? await hash(old) : null)) {
          throw new Error(`Concurrent edit: ${rel}`);
        }
        await put(`${home}/${rel}`, next.get(rel)!);
        written.push(rel);
      }
    } catch (e) {
      for (const rel of written.reverse()) {
        const current = await read(`${home}/${rel}`),
          installed = next.get(rel)!;
        if (
          (current ? await hash(current) : null) !==
            (installed ? await hash(installed) : null)
        ) {
          throw new Error(
            `Recovery stopped: concurrent edit to ${rel}; backup retained. Original failure: ${e}`,
          );
        }
        await put(`${home}/${rel}`, previous.get(rel)!);
      }
      throw e;
    }
    // Personal config is NEVER replaced, including rollback. The backup is for manual recovery only.
    const finalState = next.get(STATE);
    const resultingVersion = finalState
      ? (JSON.parse(new TextDecoder().decode(finalState)) as State).version
      : FILES.some((rel) => next.get(rel) !== null)
      ? "unmanaged"
      : "uninstalled";
    const data = {
      home,
      action,
      version: resultingVersion,
      changed,
      at: new Date().toISOString(),
    };
    try {
      const handle = await context.writeResource("install", "install", data);
      return { dataHandles: [handle] };
    } catch (error) {
      throw new Error(
        `FILES COMMITTED: ${action} completed, but Swamp resource receipt failed. Installed version: ${resultingVersion}. Local state/backup are authoritative; inspect them before retrying. Cause: ${error}`,
      );
    }
  } finally {
    await safe("", `${home}/.swamp-layout-lock`.slice(1));
    await Deno.remove(`${home}/.swamp-layout-lock`);
  }
}
export const model = {
  type: "@jpisgeek/herdr-swamp-layout",
  version: "2026.11.19.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [{
    toVersion: "2026.11.19.1",
    description: "Add go-to and stats panels; global arguments are unchanged",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  resources: {
    install: {
      description: "Layout change receipt",
      schema: Receipt,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    install: {
      description: "Install without overwriting existing files",
      arguments: z.object({}),
      execute: (_args: unknown, context: Ctx) => apply("install", context),
    },
    upgrade: {
      description:
        "Back up and upgrade known managed files; preserve personal config; stop on local edits",
      arguments: z.object({}),
      execute: (_args: unknown, context: Ctx) => apply("upgrade", context),
    },
    rollback: {
      description:
        "Restore the previous managed files only if they have not changed since upgrade",
      arguments: z.object({}),
      execute: (_args: unknown, context: Ctx) => apply("rollback", context),
    },
  },
};
