// Swamp stats: a window with what each watched swamp repo did lately, read
// from its own history with `swamp summarise`. It runs swamp only when you
// open it, press Refresh or change the window (7 or 30 days): nothing polls,
// and nothing runs while it is closed. Repos with no activity in the window
// fold into one line. It also says whether swamp serve is running here; it
// never starts it.
//
// Watched repos: "repos" in ~/.config/herdr-app/swamp.json, props.repos (if a
// layout gives it), and the folder of any open space that has a .swamp.yaml.
//
// swamp facts this mod relies on (checked on swamp 20261106):
// - `swamp summarise --since 7d --limit N --json` ->
//   { since, workflows: [{ workflowName, succeeded, failed, total, runs: [{ startedAt, completedAt, status }] }],
//     methodExecutions: [{ modelName, type, succeeded, failed, total, methods: [{ method, succeeded, failed, total, runs: [{ durationMs }] }] }],
//     data: { totalItems, totalVersions, uniqueModels, byModelType: [{ modelType, items, versions }] } }
//   or { message: "No activity found." }. Counts cover every run; `runs` holds at most N per group.
// - `swamp serve daemon status --json` -> { enabled, running, serviceMode }, without starting anything.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, home, props, readTextFile, spaces, theme } from "herdr";

const SAMPLE = 20; // runs per group used for durations

const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);
const short = (p) => (p.startsWith(home()) ? "~" + p.slice(home().length) : p);
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
const pct = (ok, total) => (total ? `${Math.round((100 * ok) / total)}% ok` : "");
const sum = (xs, f) => xs.reduce((n, x) => n + (f(x) ?? 0), 0);
// A behavior without a name is known by its id: show the first 8 characters.
const label = (name) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name ?? "") ? name.slice(0, 8) : name ?? "?");

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function duration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60000)} min`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // swamp can print log lines before the JSON; take the first "{".
    const i = text.indexOf("{");
    return i >= 0 ? JSON.parse(text.slice(i)) : null;
  }
}

// Repos from ~/.config/herdr-app/swamp.json, or none.
async function configuredRepos() {
  const text = await readTextFile(appHome() + "/swamp.json").catch(() => null);
  if (!text) return [];
  try {
    const repos = JSON.parse(text).repos;
    return Array.isArray(repos) ? repos.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

// One repo's numbers from a summarise result, or null when it had no activity.
function digest(s) {
  if (!s || s.message || (!s.workflows?.length && !s.methodExecutions?.length && !s.data?.totalItems)) return null;
  const wfs = s.workflows ?? [];
  const models = s.methodExecutions ?? [];
  const methods = models.flatMap((m) => (m.methods ?? []).map((x) => ({ ...x, modelName: m.modelName })));
  const wfDur = median(wfs.flatMap((w) => (w.runs ?? []).map((r) => Date.parse(r.completedAt) - Date.parse(r.startedAt))));
  const mDur = median(methods.flatMap((x) => (x.runs ?? []).map((r) => r.durationMs)));
  const failing = [
    ...wfs.filter((w) => w.failed).map((w) => ({ name: w.workflowName, failed: w.failed, total: w.total })),
    ...methods.filter((x) => x.failed).map((x) => ({ name: `${label(x.modelName)} ${x.method}`, failed: x.failed, total: x.total })),
  ].sort((a, b) => b.failed - a.failed).slice(0, 3);
  return {
    workflows: { total: sum(wfs, (w) => w.total), ok: sum(wfs, (w) => w.succeeded), count: wfs.length, median: wfDur },
    methods: { total: sum(models, (m) => m.total), ok: sum(models, (m) => m.succeeded), median: mDur },
    data: s.data ?? null,
    failing,
  };
}

export default class SwampStats extends View {
  init(_props, cx) {
    this.swamp = "swamp";
    this.since = "7d";
    this.repos = []; // { repo, stats, error }
    this.serve = null; // { label, tone }
    this.loading = true;
    this.readAt = null;
    this.load(cx);
  }

  async findSwamp() {
    try {
      await exec("swamp", ["--version"]);
    } catch {
      this.swamp = home() + "/.local/bin/swamp";
    }
    this.swampChecked = true;
  }

  async repoList() {
    const set = new Set([...(await configuredRepos()), ...((props() ?? {}).repos ?? [])].map(expand));
    for (const s of spaces()) {
      if (s.machine || !s.folder || set.has(s.folder)) continue;
      if ((await readTextFile(s.folder + "/.swamp.yaml").catch(() => null)) != null) set.add(s.folder);
    }
    return [...set];
  }

  async swampJson(args, cwd) {
    const r = await exec(this.swamp, [...args, "--json"], { cwd, timeout: 60000 });
    const data = r.stdout.trim() ? parseJson(r.stdout) : null;
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`);
    return data;
  }

  // Whether swamp serve runs on this machine: the daemon's own status, then a
  // foreground `swamp serve` process. Reads only.
  async serveState() {
    try {
      const d = await this.swampJson(["serve", "daemon", "status"], home());
      if (d?.running) return { label: `serve: running as a daemon (${d.serviceMode ?? "user"})`, tone: "done" };
      const p = await exec("pgrep", ["-f", "swamp serve"]).catch(() => null);
      const pids = (p?.code === 0 ? p.stdout.trim().split("\n") : []).filter(Boolean);
      if (pids.length) return { label: `serve: running in a terminal (pid ${pids.join(", ")})`, tone: "done" };
      return { label: d?.enabled ? "serve: daemon enabled, not running" : "serve: off", tone: d?.enabled ? "blocked" : "dim" };
    } catch (e) {
      return { label: `serve: unknown (${String(e?.message ?? e)})`, tone: "dim" };
    }
  }

  load(cx) {
    if (this.busy) return;
    this.busy = true;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.swampChecked) await this.findSwamp();
        const repos = await this.repoList();
        const [serve, ...rows] = await Promise.all([
          this.serveState(),
          ...repos.map(async (repo) => {
            try {
              const s = await this.swampJson(["summarise", "--since", this.since, "--limit", String(SAMPLE)], repo);
              return { repo, stats: digest(s), error: null };
            } catch (e) {
              return { repo, stats: null, error: String(e?.message ?? e) };
            }
          }),
        ]);
        this.serve = serve;
        this.repos = rows;
        this.readAt = new Date();
      } finally {
        this.loading = false;
        this.busy = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const active = this.repos.filter((r) => r.stats);
    const quiet = this.repos.filter((r) => !r.stats && !r.error);
    const broken = this.repos.filter((r) => r.error);

    const chip = (id, label, on, onClick) =>
      h_flex().id(id).h(22).px(8).items_center().rounded(6).border_1().cursor_pointer()
        .border_color(on ? t.accent : t.input).text_color(on ? t.foreground : t.muted).text_size(11)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);

    const line = (label, value, note, tone) =>
      h_flex().gap(8).items_center().text_size(12)
        .child(div().w(76).flex_none().text_color(t.muted).child(label))
        .child(div().text_color(t[tone] ?? t.foreground).child(value))
        .when(Boolean(note), (el) => el.child(div().text_size(11).text_color(t.dim).child(note)));

    const card = ({ repo, stats: s }) => {
      const wf = s.workflows;
      const m = s.methods;
      const tone = (ok, total) => (total && ok < total ? "blocked" : "done");
      return v_flex().id(`st-${repo}`).gap(5).p(10).rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().truncate().text_size(13).font_semibold().text_color(t.foreground).child(base(repo)))
          .child(div().text_size(11).text_color(t.dim).child(short(repo))))
        .when(wf.total > 0, (el) => el.child(line("workflows", `${wf.total} run${wf.total === 1 ? "" : "s"} · ${pct(wf.ok, wf.total)}`,
          [wf.count > 1 ? `${wf.count} workflows` : "", wf.median != null ? `median ${duration(wf.median)}` : ""].filter(Boolean).join(" · "), tone(wf.ok, wf.total))))
        .when(m.total > 0, (el) => el.child(line("methods", `${m.total} run${m.total === 1 ? "" : "s"} · ${pct(m.ok, m.total)}`,
          m.median != null ? `median ${duration(m.median)}` : "", tone(m.ok, m.total))))
        .when(Boolean(s.data?.totalItems), (el) => el.child(line("data", `${s.data.totalItems} items · ${s.data.totalVersions} versions`,
          (s.data.byModelType ?? []).slice(0, 2).map((d) => `${d.modelType} ${d.items}`).join(" · "))))
        .when(s.failing.length > 0, (el) => el.child(v_flex().gap(2).pt(2)
          .child(div().text_size(11).text_color(t.muted).child("Most failures"))
          .children(s.failing.map((f) => h_flex().gap(8).text_size(11)
            .child(div().w(12).flex_none().text_color(t.blocked).child("✗"))
            .child(div().flex_1().truncate().text_color(t.foreground).child(f.name))
            .child(div().text_color(t.dim).child(`${f.failed} of ${f.total}`))))));
    };

    const body = v_flex().gap(8);
    if (this.serve) body.child(div().text_size(12).text_color(t[this.serve.tone] ?? t.dim).child(this.serve.label));
    if (this.loading && !this.readAt) body.child(div().py(20).text_size(12).text_color(t.muted).child("Reading swamp history…"));
    else if (!this.repos.length) {
      body.child(div().py(12).text_size(12).text_color(t.muted)
        .child("No swamp repos. Open a space whose folder has a .swamp.yaml, or list repos in ~/.config/herdr-app/swamp.json."));
    }
    body.children(active.map(card));
    if (quiet.length) {
      body.child(div().text_size(11).text_color(t.dim).child(`No activity in ${this.since}: ${quiet.map((r) => base(r.repo)).join(", ")}`));
    }
    for (const r of broken) body.child(div().p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.blocked).child(`${short(r.repo)}: ${r.error}`));

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(36).px(12).flex_none().items_center().gap(6).border_b_1().border_color(t.border)
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Swamp stats"))
        .child(chip("w7", "7 days", this.since === "7d", (_e, cx) => { this.since = "7d"; this.load(cx); }))
        .child(chip("w30", "30 days", this.since === "30d", (_e, cx) => { this.since = "30d"; this.load(cx); }))
        .child(div().id("refresh").px(6).py(2).rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.load(cx))
          .child(this.busy ? "…" : "Refresh"))
        .when(Boolean(props()?.overlay), (el) => el.child(div().id("close").px(6).py(2).rounded(4).text_size(13).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(props().overlay))
          .child("×"))))
      .child(div().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).child(body))
      .child(div().flex_none().px(12).py(4).text_size(10).text_color(t.dim)
        .child(this.readAt ? `Read ${this.readAt.toLocaleTimeString()} from each repo's own history` : ""));
  }
}
