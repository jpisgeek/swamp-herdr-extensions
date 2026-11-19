// Swamp status: a status-bar item with swamp counts. It reads what the
// swamp-approvals and swamp-runs panels share, so it starts no swamp
// commands. Counts older than STALE_MS show as "?" (no panel reads them).
//
// Click an item: in a layout with the "swamp-tools" stack, the item shows
// that tab; elsewhere it opens the panel as a window. Click "swamp…" for the
// swamp-goto popup: every gate, run and workflow in one filterable list.
// Click "stats" for the Swamp stats window (runs only while it is open).

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, shared, theme } from "herdr";

const STALE_MS = 120000;

function hasNode(n, id) {
  if (!n || typeof n !== "object") return false;
  if (n.id === id) return true;
  return (n.children ?? []).some((c) => hasNode(c, id));
}

function show(panel) {
  if (!hasNode(layout(), panel)) run("mod.open", { name: panel });
  else if (panel !== "swamp-approvals" && hasNode(layout(), "swamp-tools")) run("layout.select", { stack: "swamp-tools", child: panel });
  // else: always visible in this layout (the approvals column).
}

export default class SwampStatus extends View {
  init(_props, cx) {
    // Only to notice when the shared counts become stale.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  render() {
    const t = theme();
    const a = shared("swamp-approvals.summary");
    const r = shared("swamp-runs.summary");
    const fresh = (s) => s && Date.now() - s.at < STALE_MS;

    const item = (id, color, text, onClick, strong) =>
      h_flex().id(id).h(20).px(6).gap(6).items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(onClick)
        .child(div().size(6).rounded(3).flex_none().bg(color))
        .child(div().text_color(strong ? t.foreground : t.muted).child(text));

    const items = [];
    if (!fresh(a)) items.push(item("gates", t.dim, "gates ?", () => show("swamp-approvals")));
    else {
      items.push(item("gates", a.gates ? t.blocked : t.dim, a.gates ? `${a.gates} gate${a.gates > 1 ? "s" : ""} wait` : "no gates", () => show("swamp-approvals"), a.gates > 0));
      if (a.ready) items.push(item("ready", t.accent, `${a.ready} to resume`, () => show("swamp-approvals"), true));
    }
    if (!fresh(r)) items.push(item("runs", t.dim, "runs ?", () => show("swamp-runs")));
    else {
      if (r.running) items.push(item("running", t.working, `${r.running} running`, () => show("swamp-runs"), true));
      items.push(item("failed", r.failedToday ? t.blocked : t.ansi2, r.failedToday ? `${r.failedToday} failed today` : "no failures today", () => show("swamp-runs"), r.failedToday > 0));
    }

    return h_flex().id("root").size_full().px(8).gap(2).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("goto").h(20).px(6).items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("mod.open", { name: "swamp-goto" }))
        .text_color(t.dim).child("swamp…"))
      .children(items)
      .child(h_flex().id("stats").h(20).px(6).items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => show("swamp-stats"))
        .text_color(t.dim).child("stats"));
  }
}
