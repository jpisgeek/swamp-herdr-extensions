-- rex_herdr: herdr-core and swamp in Rex's command palette.
--
-- Installed by the @jpisgeek/rex-herdr swamp extension. Load it from
-- ~/.config/rex/init.lua:
--
--   require("rex_herdr").setup({ keys = { herdr_pick = "cmd+shift+h" } })
--
-- Palette entries (category Herdr and Swamp):
--   Herdr: Pick Terminal       herdr-core's own picker (hc) in a floating pane.
--                              Enter attaches; ctrl+\ detaches and the pane closes.
--   Herdr: New Kept Agent      a new tab with an agent that herdr-core owns, so
--                              it keeps running when Rex closes the tab.
--   Swamp: Approvals           gates waiting in the nearest swamp repo.
--   Swamp: Recent Runs         the last 24 hours of runs.
--   Swamp: Run Workflow        pick a workflow and run it.
--   Swamp: Stats               recent runs, success rate, durations, data, and
--                              whether swamp serve runs here (never starts it).
--
-- Every entry starts in the focused pane's folder. The swamp entries find the
-- repo by walking up to the nearest .swamp.yaml.
--
-- The panes it opens use the Swamp Club palette by Don O'Neill
-- (github.com/sntxrr/ghostty-swamp-club, MIT; see THIRD_PARTY_NOTICES.md),
-- read from the `swamp-club` theme file beside this module. Set `theme` to
-- false for Rex's own colors, or to the path of any Ghostty theme file.

local M = {}

local unpack = table.unpack or unpack
local HOME = os.getenv("HOME") or ""
local SHELL_FLAVOR = "com.superlogical.terminal.shell"

-- The folder this file was loaded from, so the helper is found beside it.
local function here()
  local src = debug and debug.getinfo and debug.getinfo(1, "S").source or ""
  src = src:gsub("^@", "")
  return src:match("^(.*)/[^/]*$") or (HOME .. "/.config/rex")
end

M.defaults = {
  hc = HOME .. "/.local/bin/hc", -- herdr-core CLI
  helper = here() .. "/rex-herdr-swamp", -- swamp menus, shipped beside this file
  agent = { "amp" }, -- inherits the user's saved Amp model/provider settings
  bounds = { 0.08, 0.06, 0.84, 0.84 }, -- floating pane, as fractions of the window
  keys = { herdr_pick = "cmd+shift+h" }, -- action name = key; false leaves it unbound
  theme = "swamp-club", -- a theme file beside this module, a path, a table, or false
}

-- Reads a Ghostty-format theme file (`palette = N=#rrggbb`, `background`,
-- `foreground`, `cursor-color`) into the form Rex's terminal `theme` option
-- takes. Returns nil when the file can't be read. Other keys are ignored.
function M.load_theme(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local hex = "^#?%x%x%x%x%x%x$"
  local t = { palette = {} }
  for line in f:lines() do
    local key, value = line:match("^%s*([%w%-]+)%s*=%s*(.-)%s*$")
    if key == "palette" then
      local i, color = value:match("^(%d+)%s*=%s*(#?%x%x%x%x%x%x)$")
      if i and tonumber(i) <= 255 then t.palette[#t.palette + 1] = i .. "=" .. color end
    elseif (key == "background" or key == "foreground") and value:match(hex) then
      t[key] = value
    elseif key == "cursor-color" and value:match(hex) then
      t.cursor = value
    end
  end
  f:close()
  return t
end

-- Turns the `theme` setting into a theme table, or nil for Rex's own colors.
local function resolve_theme(setting)
  if type(setting) == "table" then return setting end
  if type(setting) ~= "string" or setting == "" then return nil end
  local path = setting:find("/", 1, true) and setting or (here() .. "/" .. setting)
  return M.load_theme(path)
end

-- Returns a copy of `base` with the fields of `over` laid on top.
local function merge(base, over)
  local out = {}
  for k, v in pairs(base) do out[k] = v end
  for k, v in pairs(over or {}) do
    if type(v) == "table" and type(base[k]) == "table" and #v == 0 and next(v) ~= nil then
      out[k] = merge(base[k], v)
    else
      out[k] = v
    end
  end
  return out
end

-- The folder the focused pane's program is in, or HOME when it can't be read
-- (no window, or a block that isn't a terminal).
local function focused_cwd(session_id)
  local ok, view = pcall(rex.call, "session.view", { session_id = session_id })
  if not ok or type(view) ~= "table" then return HOME end
  for _, w in ipairs(view.windows or {}) do
    if w.window_id == view.active_window_id and w.focused_block_id then
      local ok2, p = pcall(rex.call, "block.method", {
        session_id = session_id,
        block_id = w.focused_block_id,
        method = "process",
      })
      if ok2 and type(p) == "table" and p.foreground and p.foreground.cwd then
        return p.foreground.cwd
      end
    end
  end
  return HOME
end

-- A terminal block running `command` in `cwd`, in `theme` when there is one.
local function terminal(label, command, cwd, theme)
  return rex.layout.block({
    flavor = SHELL_FLAVOR,
    label = label,
    options = { command = command, cwd = cwd, theme = theme },
  })
end

-- Opens `command` in a floating pane over the active window, focused.
local function float(cfg, ctx, label, command)
  return rex.call("session.new_layer", {
    session_id = ctx.session_id,
    bounds = cfg.bounds,
    focus = true,
    layout = terminal(label, command, focused_cwd(ctx.session_id), cfg.theme_table),
  })
end

-- Starts the agent in herdr-core, then attaches this pane to it. The name is
-- unique per second; herdr-core refuses a taken name and the pane stays open
-- to show why.
local AGENT_SCRIPT = table.concat({
  'hc="$1"; sid="$2"; shift 2',
  'n="rex-$(date +%H%M%S)"',
  '"$hc" run --bg --no-parent --keep --name "$n" --label "rex.session=$sid" -- "$@" >/dev/null || exit',
  'exec "$hc" attach "$n"',
}, "\n")

function M.setup(opts)
  local cfg = merge(M.defaults, opts)
  cfg.theme_table = resolve_theme(cfg.theme)

  rex.action({
    name = "herdr_pick",
    title = "Herdr: Pick Terminal",
    description = "herdr-core's picker in a floating pane: attach to any terminal or agent, on any machine.",
    category = "Herdr",
    keywords = "hc herdr-core attach agent terminal machine",
    run = function(ctx)
      return float(cfg, ctx, "herdr", { cfg.hc })
    end,
  })

  rex.action({
    name = "herdr_agent",
    title = "Herdr: New Kept Agent",
    description = "A new tab with an agent that herdr-core owns. Closing the tab detaches; the agent keeps running.",
    category = "Herdr",
    keywords = "hc herdr-core amp agent keep",
    run = function(ctx)
      return rex.call("session.new_window", {
        session_id = ctx.session_id,
        window_label = "agent",
        layout = terminal("agent", { "/bin/sh", "-c", AGENT_SCRIPT, "rex-herdr", cfg.hc, ctx.session_id, unpack(cfg.agent) },
          focused_cwd(ctx.session_id), cfg.theme_table),
      })
    end,
  })

  local swamp = {
    { name = "swamp_approvals", title = "Swamp: Approvals", sub = "approvals",
      description = "Gates waiting in the nearest swamp repo. Approve or reject, then resume, with a typed confirmation." },
    { name = "swamp_runs", title = "Swamp: Recent Runs", sub = "runs",
      description = "Workflow and behavior runs from the last 24 hours in the nearest swamp repo." },
    { name = "swamp_workflow", title = "Swamp: Run Workflow", sub = "workflows",
      description = "Pick a workflow in the nearest swamp repo and run it, with a typed confirmation." },
    { name = "swamp_stats", title = "Swamp: Stats", sub = "stats",
      description = "The nearest swamp repo's last 7 or 30 days: runs, success rate, durations, failures, data, and serve status." },
  }
  for _, s in ipairs(swamp) do
    rex.action({
      name = s.name,
      title = s.title,
      description = s.description,
      category = "Swamp",
      keywords = "swamp workflow " .. s.sub,
      run = function(ctx)
        return float(cfg, ctx, "swamp", { "/bin/sh", cfg.helper, s.sub })
      end,
    })
  end

  for action, key in pairs(cfg.keys or {}) do
    if key then rex.bind(key, action) end
  end

  return cfg
end

return M
