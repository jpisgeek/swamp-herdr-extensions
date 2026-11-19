// Swamp approvals: shows swamp workflow runs that wait at a manual_approval
// gate, in every watched swamp repo, and lets you approve, reject or resume
// them. Every action asks for a second click (Confirm) before it runs.
//
// Watched repos: "repos" in ~/.config/herdr-app/swamp.json, REPOS below,
// props.repos (if a layout gives it), and the
// folder of any open space that has a .swamp.yaml.
//
// swamp facts this mod relies on (checked on swamp 20261102):
// - `swamp workflow approvals --json` -> { approvals: [...], expired: [...] }
// - `approve` only records the decision. The run stays "suspended" and leaves
//   the approvals list; `swamp workflow resume` continues it. So a suspended
//   run with no open gate is shown under "Ready to resume".
// - `reject` ends the run (status failed).
// Approve & resume is one decision: after the last gate of a run is approved,
// the panel resumes the run right away in a background herdr-core terminal
// (`hc run --bg`, named "swamp-resume-<run id 8>", labelled swamp.run=<id>).
// No tab opens. The card shows "Resuming…" with Watch, which peeks at the
// terminal's output, and a notification says how it ended. herdr-core owns
// the terminal, so the resume keeps going if Herdr closes. A run that is
// approved but not resumed (approved elsewhere) shows Resume, which does the
// same. Never start a second resume of a run.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, hc, home, notify, playSound, props, readTextFile, run, setShared, shared, spaces, terminals, theme } from "herdr";

const REPOS = []; // kept for older setups; prefer "repos" in ~/.config/herdr-app/swamp.json, which every swamp mod reads

// Repos from ~/.config/herdr-app/swamp.json ({ "repos": ["~/git/my-repo"] }), or none.
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
const POLL_MS = 20000;
const SEEN_KEY = "swamp-approvals.seen";
const COUNT_KEY = "swamp-approvals.count";

const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);
const short = (p) => (p.startsWith(home()) ? "~" + p.slice(home().length) : p);
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
const RESUME_GRACE_MS = 15000; // after starting a resume, treat the run as resuming this long (hc can lag)
const WATCH_MS = 3000; // how often to look at running resumes
const resumeName = (runId) => `swamp-resume-${String(runId).slice(0, 8).toLowerCase()}`;

// Live background resumes, from herdr-core's labels.
function liveResumes() {
  return terminals().filter((t) => t.labels?.["swamp.run"] && t.state === "live");
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
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

export default class SwampApprovals extends View {
  init(_props, cx) {
    this.swamp = "swamp";
    this.repos = {}; // repo path -> { gates, expired, ready, error }
    this.loading = true;
    this.lastRefresh = null;
    this.pending = null; // { key, action } waiting for Confirm
    this.busy = null; // key of the item whose action runs now
    this.errors = {}; // item key -> message
    this.resuming = {}; // runId -> time the resume was started
    this.watching = {}; // terminal address -> { runId, workflowName }
    // Adopt resumes started before this panel (re)loaded.
    for (const t of liveResumes()) this.watching[t.address] = { runId: t.labels["swamp.run"], workflowName: t.labels["swamp.workflow"] ?? "workflow" };
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    cx.timer.every(WATCH_MS, (cx) => this.checkResumes(cx));
    this.refresh(cx);
  }

  // Tells the person how each finished background resume ended.
  checkResumes(cx) {
    const addrs = Object.keys(this.watching);
    if (!addrs.length) return;
    const live = new Set(liveResumes().map((t) => t.address));
    const ended = addrs.filter((a) => !live.has(a));
    if (!ended.length) return;
    cx.spawn(async (cx) => {
      for (const address of ended) {
        const w = this.watching[address];
        delete this.watching[address];
        let code = null;
        try {
          const r = await hc(["get", address, "--json"]);
          code = JSON.parse(r.stdout).exit_code ?? null;
        } catch {
          // Removed already: report it without a code.
        }
        notify({
          title: code === 0 ? `Resumed: ${w.workflowName}` : `Resume ended: ${w.workflowName}`,
          body: code === 0 ? "The run finished its steps." : code == null ? "See Swamp runs for the result." : `swamp exited with ${code}. Watch shows its output.`,
          level: code === 0 ? "success" : "warning",
          action: { name: "terminal.peek", args: { terminal: address } },
        });
        if (code !== 0) playSound("blocked");
      }
      cx.notify();
      this.refresh(cx);
    });
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
    const set = new Set([...REPOS, ...(await configuredRepos()), ...((props() ?? {}).repos ?? [])].map(expand));
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
      const h = await this.swampJson(repo, ["workflow", "history", "search", "--filter", 'status == "suspended"']);
      const gates = a?.approvals ?? [];
      const gated = new Set(gates.map((g) => g.runId));
      const ready = (h?.results ?? []).filter((r) => !gated.has(r.runId));
      return { gates, expired: a?.expired ?? [], ready, error: null };
    } catch (e) {
      return { gates: [], expired: [], ready: [], error: String(e?.message ?? e) };
    }
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.swampChecked) await this.findSwamp();
        const repos = await this.repoList();
        const next = {};
        for (const repo of repos) next[repo] = await this.loadRepo(repo);
        this.repos = next;
        this.lastRefresh = new Date();
        this.announce();
      } finally {
        this.loading = false;
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  // Tell the person about gates they have not seen yet (kept across restarts).
  announce() {
    const all = Object.entries(this.repos).flatMap(([repo, r]) => r.gates.map((g) => ({ repo, g })));
    setShared(COUNT_KEY, all.length);
    // For the status item: gates, runs ready to resume, and when this was read.
    setShared("swamp-approvals.summary", {
      gates: all.length,
      ready: Object.values(this.repos).reduce((n, r) => n + (r.ready?.length ?? 0), 0),
      at: Date.now(),
    });
    const seen = new Set(shared(SEEN_KEY) ?? []);
    const fresh = all.filter(({ g }) => !seen.has(`${g.runId}/${g.stepName}`));
    if (fresh.length) {
      const { repo, g } = fresh[0];
      notify({
        title: fresh.length === 1 ? `Swamp gate: ${g.workflowName} / ${g.stepName}` : `${fresh.length} swamp gates wait for you`,
        body: fresh.length === 1 ? g.prompt ?? base(repo) : fresh.map(({ g }) => g.workflowName).join(", "),
        level: "warning",
        action: { name: "mod.open", args: { name: "swamp-approvals" } },
      });
      playSound("blocked");
    }
    // Keep only keys still open, so the list does not grow forever.
    setShared(SEEN_KEY, all.map(({ g }) => `${g.runId}/${g.stepName}`));
  }

  ask(key, action, cx) {
    this.pending = { key, action };
    delete this.errors[key];
    cx.notify();
  }

  // Runs a confirmed action. approve continues with resume once every gate is
  // decided; reject and cancel end the run; resume starts in the background.
  act(item, cx) {
    const { key, action } = this.pending;
    this.pending = null;
    const { repo, workflowName, runId, stepName } = item;
    if (action === "resume") {
      this.resume(item, cx);
      return;
    }
    const args = {
      approve: ["workflow", "approve", workflowName, stepName, "--run", runId, "--reason", "Approved in Herdr"],
      reject: ["workflow", "reject", workflowName, stepName, "--run", runId, "--reason", "Rejected in Herdr"],
      cancel: ["workflow", "cancel", workflowName, "--run", runId],
    }[action];
    this.busy = key;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.swamp, [...args, "--json"], { cwd: repo });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`);
        const out = parseJson(r.stdout) ?? {};
        if (action === "approve") {
          if (out.allGatesDecided === false) {
            notify({ title: `Approved: ${workflowName} / ${stepName}`, body: "Other gates in this run still wait.", level: "success" });
          } else {
            this.resume(item, cx);
          }
        } else {
          notify({ title: `${action === "reject" ? "Rejected" : "Cancelled"}: ${workflowName}`, level: "info" });
        }
      } catch (e) {
        this.errors[key] = String(e?.message ?? e);
      } finally {
        this.busy = null;
        cx.notify();
        this.refresh(cx);
      }
    });
  }

  // Resume in a background herdr-core terminal. Never start a second resume of a run.
  resume(item, cx) {
    const { repo, workflowName, runId } = item;
    const live = liveResumes().find((t) => t.labels["swamp.run"] === runId);
    if (live || Date.now() - (this.resuming[runId] ?? 0) < RESUME_GRACE_MS) {
      notify({ title: `Already resuming: ${workflowName}`, level: "info", action: live ? { name: "terminal.peek", args: { terminal: live.address } } : undefined });
      return;
    }
    this.resuming[runId] = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hc([
          "run", "--bg", "--json", "--no-parent", "--no-notify",
          "--name", resumeName(runId), "--cwd", repo,
          "--label", `swamp.run=${runId}`, "--label", `swamp.workflow=${workflowName}`, "--label", `swamp.repo=${repo}`,
          "--", this.swamp, "workflow", "resume", workflowName, "--run", runId,
        ]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `hc run exit ${r.code}`);
        const address = JSON.parse(r.stdout).address;
        this.watching[address] = { runId, workflowName };
        notify({ title: `Resuming: ${workflowName}`, body: "In the background. Watch shows its output.", level: "info", action: { name: "terminal.peek", args: { terminal: address } } });
      } catch (e) {
        delete this.resuming[runId];
        this.errors[`r:${runId}`] = String(e?.message ?? e);
      }
      cx.notify();
      cx.timer.after(5000, (cx) => this.refresh(cx));
    });
  }

  render(cx) {
    const t = theme();
    const entries = Object.entries(this.repos);
    const items = [];
    const resumes = liveResumes();
    const inFlight = new Set(resumes.map((t) => t.labels["swamp.run"]));
    for (const [runId, at] of Object.entries(this.resuming)) if (Date.now() - at < RESUME_GRACE_MS) inFlight.add(runId);
    for (const t of resumes) {
      items.push({ kind: "resuming", repo: t.labels["swamp.repo"] ?? "", workflowName: t.labels["swamp.workflow"] ?? "workflow", runId: t.labels["swamp.run"], address: t.address, key: `m:${t.address}` });
    }
    for (const [repo, r] of entries) {
      for (const g of r.gates) items.push({ kind: "gate", repo, ...g, key: `g:${g.runId}/${g.stepName}` });
      for (const x of r.ready) if (!inFlight.has(x.runId)) items.push({ kind: "ready", repo, ...x, key: `r:${x.runId}` });
      for (const x of r.expired) items.push({ kind: "expired", repo, ...x, key: `x:${x.runId}/${x.stepName ?? ""}` });
    }
    const gates = items.filter((i) => i.kind === "gate");
    const ready = items.filter((i) => i.kind === "ready");
    const expired = items.filter((i) => i.kind === "expired");
    const resuming = items.filter((i) => i.kind === "resuming");
    const repoErrors = entries.filter(([, r]) => r.error);
    const many = entries.length > 1;

    const button = (id, label, bg, fg, border, onClick, disabled) =>
      h_flex().id(id).h(26).px(10).items_center().rounded(6).border_1().border_color(border).bg(bg).text_color(fg).text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(onClick))
        .when(disabled, (el) => el.opacity(0.5))
        .child(label);

    const section = (title, count) =>
      h_flex().pt(10).pb(4).gap(6).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
        .child(div().text_size(11).text_color(t.dim).child(String(count)));

    const VERB = {
      approve: ["Approve and resume?", "The run continues in the background right away. Its next steps can write to real systems."],
      reject: ["Reject this gate?", "This ends the run. You cannot undo it."],
      resume: ["Resume this run?", "It continues in the background. Its next steps can write to real systems."],
      cancel: ["Cancel this run?", "The gate has expired. This ends the run."],
    };

    const card = (i) => {
      const busy = this.busy === i.key;
      const asking = this.pending?.key === i.key ? this.pending.action : null;
      const accent = i.kind === "gate" ? t.blocked : i.kind === "ready" ? t.done : i.kind === "resuming" ? t.working : t.dim;
      const inputs = i.inputs && Object.keys(i.inputs).length
        ? Object.entries(i.inputs).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("  ")
        : null;

      const actions = asking
        ? v_flex().gap(6).p(8).rounded(6).bg(t.raised)
            .child(div().text_size(12).font_semibold().text_color(t.foreground).child(VERB[asking][0]))
            .child(div().text_size(11).text_color(t.muted).child(VERB[asking][1]))
            // Confirm sits at the left edge, Back at the right edge: the first-step buttons are
            // right-aligned, so a double-click never lands on Confirm.
            .child(h_flex().gap(6).justify_between()
              .child(button(`${i.key}-yes`, "Confirm", asking === "approve" || asking === "resume" ? t.solid : t.blocked,
                asking === "approve" || asking === "resume" ? t.solid_foreground : t.background,
                asking === "approve" || asking === "resume" ? t.solid : t.blocked, (_e, cx) => this.act(i, cx)))
              .child(button(`${i.key}-no`, "Back", t.surface, t.foreground, t.input, (_e, cx) => { this.pending = null; cx.notify(); })))
        : h_flex().gap(6).justify_end()
            .when(busy, (el) => el.child(div().flex_1().text_size(11).text_color(t.muted).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
            .when(i.kind === "gate", (el) => el
              .child(button(`${i.key}-rej`, "Reject", t.surface, t.foreground, t.input, (_e, cx) => this.ask(i.key, "reject", cx), busy || this.busy))
              .child(button(`${i.key}-ok`, "Approve & resume", t.solid, t.solid_foreground, t.solid, (_e, cx) => this.ask(i.key, "approve", cx), busy || this.busy)))
            .when(i.kind === "resuming", (el) => el
              .child(div().flex_1().text_size(11).text_color(t.working).frames(["◌ Resuming…", "◎ Resuming…"], 600))
              .child(button(`${i.key}-watch`, "Watch", t.surface, t.foreground, t.input, () => run("terminal.peek", { terminal: i.address }))))
            .when(i.kind === "ready", (el) => el
              .child(button(`${i.key}-res`, "Resume", t.solid, t.solid_foreground, t.solid, (_e, cx) => this.ask(i.key, "resume", cx), busy || this.busy)))
            .when(i.kind === "expired", (el) => el
              .child(button(`${i.key}-can`, "Cancel run", t.surface, t.foreground, t.input, (_e, cx) => this.ask(i.key, "cancel", cx), busy || this.busy)));

      return v_flex().id(i.key).gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(h_flex().gap(8).items_center()
          .child(div().size(8).rounded(4).flex_none().bg(accent))
          .child(div().flex_1().truncate().text_size(13).font_semibold().text_color(t.foreground)
            .child(i.kind === "ready" ? i.workflowName : `${i.workflowName} / ${i.stepName ?? "?"}`))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(i.suspendedAt ?? i.startedAt ?? ""))))
        .when(Boolean(i.prompt), (el) => el.child(div().text_size(12).text_color(t.foreground).child(i.prompt)))
        .when(i.kind === "ready", (el) => el.child(div().text_size(12).text_color(t.muted)
          .child(`Approved, not resumed yet. Steps ${i.stepProgress?.completed ?? "?"} of ${i.stepProgress?.total ?? "?"} done.`)))
        .when(i.kind === "resuming", (el) => el.child(div().text_size(12).text_color(t.muted).child("Approved. The run continues in the background.")))
        .when(Boolean(inputs), (el) => el.child(div().text_size(11).text_color(t.muted).child(inputs)))
        .child(div().text_size(11).text_color(t.dim).truncate()
          .child(`${many ? base(i.repo) + " · " : ""}run ${String(i.runId).slice(0, 8)}`))
        .when(Boolean(this.errors[i.key]), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.errors[i.key])))
        .child(actions);
    };

    const body = v_flex().gap(6);
    if (this.loading) body.child(div().py(20).text_size(12).text_color(t.muted).child("Reading swamp repos…"));
    else if (!items.length && !repoErrors.length) {
      body.child(v_flex().py(24).gap(4).items_center()
        .child(div().text_size(13).text_color(t.muted).child("No gates wait for you."))
        .child(div().text_size(11).text_color(t.dim).child(entries.map(([r]) => short(r)).join(", "))));
    }
    if (gates.length) body.child(section("Waiting for you", gates.length)).children(gates.map(card));
    if (resuming.length) body.child(section("Resuming", resuming.length)).children(resuming.map(card));
    if (ready.length) body.child(section("Ready to resume", ready.length)).children(ready.map(card));
    if (expired.length) body.child(section("Expired", expired.length)).children(expired.map(card));
    for (const [repo, r] of repoErrors) {
      body.child(div().mt(8).p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.blocked).child(`${short(repo)}: ${r.error}`));
    }

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(36).px(12).flex_none().items_center().gap(8).border_b_1().border_color(t.border)
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Swamp approvals"))
        .when(gates.length > 0, (el) => el.child(div().px(6).rounded(8).bg(t.blocked).text_color(t.background).text_size(11).child(String(gates.length))))
        .child(div().id("refresh").px(6).py(2).rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.refresh(cx))
          .child(this.refreshing ? "…" : "Refresh"))
        .when(Boolean(props()?.overlay), (el) => el.child(div().id("close").px(6).py(2).rounded(4).text_size(13).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(props().overlay))
          .child("×"))))
      .child(div().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().px(10).pb(10).child(body))
      .child(div().flex_none().px(12).py(4).text_size(10).text_color(t.dim)
        .child(this.lastRefresh ? `Updated ${this.lastRefresh.toLocaleTimeString()}` : ""));
  }
}
