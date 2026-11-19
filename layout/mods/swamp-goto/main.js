// Swamp go-to: a popup that lists what swamp needs from you, across every
// watched repo, and takes you to the panel that handles it. Gates waiting for
// approval and runs ready to resume open Swamp approvals; running and failed
// runs open Swamp runs; "Run a workflow…" opens Swamp quick run; "Stats…" opens Swamp stats. This popup
// changes nothing itself: approving, rejecting and running stay in those
// panels, behind their Confirm click.
//
// Type to filter, ↑/↓ and Enter to go, Esc to leave.
//
// Watched repos: the folder of any open space that has a .swamp.yaml, plus
// "repos" in ~/.config/herdr-app/swamp.json, e.g. { "repos": ["~/git/my-repo"] }.
//
// swamp facts this mod relies on (checked on swamp 20261106):
// - `swamp workflow approvals --json` -> { approvals: [{ workflowName, stepName, runId, prompt }], expired }
// - `swamp workflow history search --json` -> { results: [{ runId, workflowName, status, startedAt }] }
// - an approved gate leaves the approvals list but its run stays "suspended" until resumed.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, closeOverlay, exec, home, layout, props, readTextFile, run, shared, spaces, theme } from "herdr";

const DAY_MS = 86400000;
const FRESH_MS = 120000; // a runs summary newer than this is used as is

const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;

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

function hasNode(n, id) {
  if (!n || typeof n !== "object") return false;
  if (n.id === id) return true;
  return (n.children ?? []).some((c) => hasNode(c, id));
}

// Shows a swamp panel: in the swamp layout's tool stack when it is there,
// else as its own window.
function show(panel) {
  if (!hasNode(layout(), panel)) run("mod.open", { name: panel });
  else if (panel !== "swamp-approvals" && hasNode(layout(), "swamp-tools")) run("layout.select", { stack: "swamp-tools", child: panel });
  // else: always visible in this layout (the approvals column).
}

export default class SwampGoto extends View {
  init(_props, cx) {
    this.swamp = "swamp";
    this.filter = "";
    this.at = 0;
    this.loading = true;
    this.repos = []; // { repo, gates, ready, running, failed, error }
    this.input = InputState.new({ placeholder: "Filter gates, runs, repos…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.pickable()[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      await this.load();
      this.loading = false;
      cx.notify();
    });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  async findSwamp() {
    try {
      await exec("swamp", ["--version"]);
    } catch {
      this.swamp = home() + "/.local/bin/swamp";
    }
  }

  async repoList() {
    const set = new Set([...(await configuredRepos()), ...((props() ?? {}).repos ?? [])].map(expand));
    for (const s of spaces()) {
      if (s.machine || !s.folder || set.has(s.folder)) continue;
      if ((await readTextFile(s.folder + "/.swamp.yaml").catch(() => null)) != null) set.add(s.folder);
    }
    return [...set];
  }

  async swampJson(repo, args) {
    const r = await exec(this.swamp, [...args, "--json"], { cwd: repo });
    const data = r.stdout.trim() ? parseJson(r.stdout) : null;
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`);
    return data;
  }

  async loadRepo(repo) {
    try {
      const a = await this.swampJson(repo, ["workflow", "approvals"]);
      const h = await this.swampJson(repo, ["workflow", "history", "search"]);
      const gates = a?.approvals ?? [];
      const gated = new Set(gates.map((g) => g.runId));
      const runs = h?.results ?? [];
      const now = Date.now();
      return {
        repo,
        gates,
        ready: runs.filter((r) => r.status === "suspended" && !gated.has(r.runId)),
        running: runs.filter((r) => r.status === "running"),
        failed: runs.filter((r) => r.status === "failed" && now - Date.parse(r.startedAt) < DAY_MS),
        error: null,
      };
    } catch (e) {
      return { repo, gates: [], ready: [], running: [], failed: [], error: String(e?.message ?? e) };
    }
  }

  async load() {
    await this.findSwamp();
    const repos = await this.repoList();
    this.repos = await Promise.all(repos.map((r) => this.loadRepo(r)));
  }

  // Every row, in order. Rows with `go` can be picked.
  rows() {
    const f = this.filter.toLowerCase();
    const match = (...parts) => !f || parts.join(" ").toLowerCase().includes(f);
    const out = [];
    const section = (title, items) => {
      if (items.length) out.push({ kind: "head", title }, ...items);
    };

    section("Gates", this.repos.flatMap(({ repo, gates }) => gates
      .filter((g) => match(g.workflowName, g.stepName, base(repo), g.prompt ?? ""))
      .map((g) => ({ kind: "item", mark: "⏸", tone: "blocked", label: `${g.workflowName} / ${g.stepName}`, note: base(repo), hint: "needs you", go: "swamp-approvals" }))));
    section("Ready to resume", this.repos.flatMap(({ repo, ready }) => ready
      .filter((r) => match(r.workflowName, base(repo)))
      .map((r) => ({ kind: "item", mark: "▶", tone: "accent", label: r.workflowName, note: base(repo), hint: "approved", go: "swamp-approvals" }))));

    // Prefer the runs panel's own counts (they include method runs) while fresh.
    const summary = shared("swamp-runs.summary");
    const fresh = summary && Date.now() - summary.at < FRESH_MS;
    const running = fresh ? summary.running : this.repos.reduce((n, r) => n + r.running.length, 0);
    const failed = fresh ? summary.failedToday : this.repos.reduce((n, r) => n + r.failed.length, 0);
    const runs = [];
    if (running && match("running runs")) runs.push({ kind: "item", mark: "●", tone: "working", label: `${running} running`, note: "", hint: "", go: "swamp-runs" });
    if (match("failed runs today")) {
      runs.push(failed
        ? { kind: "item", mark: "✗", tone: "blocked", label: `${failed} failed today`, note: "", hint: "", go: "swamp-runs" }
        : { kind: "item", mark: "✓", tone: "ansi2", label: "no failures today", note: "", hint: "", go: "swamp-runs" });
    }
    section("Runs", runs);

    if (match("run a workflow quick run")) {
      section("Workflows", [{ kind: "item", mark: "+", tone: "muted", label: "Run a workflow…", note: "", hint: "", go: "swamp-quickrun" }]);
    }

    if (match("stats statistics history success rate durations data serve")) {
      section("More", [{ kind: "item", mark: "≡", tone: "muted", label: "Stats…", note: "runs, success rate, durations, data, serve", hint: "", go: "swamp-stats" }]);
    }

    const errors = this.repos.filter((r) => r.error && match(base(r.repo), r.error));
    section("Errors", errors.map((r) => ({ kind: "error", label: base(r.repo), note: r.error })));
    return out;
  }

  pickable() {
    return this.rows().filter((r) => r.go);
  }

  go(r) {
    if (!r?.go) return;
    this.close();
    show(r.go);
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => r.go);
    this.at = Math.max(0, Math.min(this.at, pickable.length - 1));
    const sel = pickable[this.at];

    const row = (r, i) => {
      if (r.kind === "head") {
        return div().id(`sg-h-${i}`).px(10).pt(10).pb(3).text_size(11).font_semibold().text_color(t.dim).child(r.title.toUpperCase());
      }
      if (r.kind === "error") {
        return h_flex().id(`sg-e-${i}`).mx(4).px(10).h(32).gap(10).items_center()
          .child(div().w(12).flex_none().text_color(t.blocked).child("!"))
          .child(div().flex_none().text_color(t.foreground).child(r.label))
          .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(r.note));
      }
      const on = r === sel;
      return h_flex().id(`sg-${i}`).mx(4).px(10).h(32).gap(10).items_center().rounded(7).cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(div().w(12).flex_none().text_color(t[r.tone] ?? t.dim).child(r.mark))
        .child(div().flex_1().truncate().text_color(t.foreground).child(r.label))
        .when(Boolean(r.hint), (el) => el.child(div().text_size(11).text_color(t[r.tone] ?? t.dim).child(r.hint)))
        .when(Boolean(r.note), (el) => el.child(div().text_size(11).text_color(t.dim).child(r.note)));
    };

    const empty = this.loading
      ? "Reading swamp repos…"
      : this.repos.length === 0
        ? "No swamp repos. Open a space whose folder has a .swamp.yaml, or list repos in ~/.config/herdr-app/swamp.json."
        : null;

    return v_flex()
      .id("swamp-goto")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (!pickable.length) return;
        if (k === "down") this.at = (this.at + 1) % pickable.length;
        else if (k === "up") this.at = (this.at + pickable.length - 1) % pickable.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Swamp"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(empty
        ? div().px(10).py(8).text_color(t.dim).child(empty)
        : v_flex().id("sg-list").min_h(0).mb(6).overflow_y_scroll().children(rows.map(row)));
  }
}
