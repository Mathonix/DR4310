/** Workspace layout. Each breakpoint has one set of rules; both themes share geometry. */
export const CONSOLE_CSS = `
html { scroll-padding-top: 80px; scroll-padding-bottom: 120px; }
.cmdbar { position: sticky; top: 0; z-index: 40; height: 64px; display: flex; align-items: center; gap: 24px; padding: 0 24px; background: var(--bg); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; }
.brand svg { width: 32px; height: 32px; }
.brand b { font: 600 18px var(--mono); }
.spacer { flex: 1; }
.links, .technical { display: none; }
.iconbtn { display: inline-grid; place-items: center; width: var(--ctl); padding: 0; background: transparent; color: var(--text); border-color: var(--line-2); }
.iconbtn svg { width: 20px; height: 20px; }
#themeToggle { user-select: none; }
#themeToggle .theme-moon { display: none; }
[data-theme="light"] #themeToggle .theme-sun { display: none; }
[data-theme="light"] #themeToggle .theme-moon { display: block; }
.header-actions, .connection-controls { display: flex; align-items: center; gap: 8px; flex: none; }
.header-actions > .iconbtn { flex: none; }
#dLink { width: 76px; padding-inline: 8px; }
#dConnect { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: var(--ctl); padding: 0 12px; white-space: nowrap; }
.conn-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--muted); }
.conn-dot.on { background: var(--ok); }
.views, .tabs { display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: var(--bg-2); max-width: 100%; overflow-x: auto; scrollbar-width: thin; }
.views button, .tabs button { flex: none; background: transparent; color: var(--label); white-space: nowrap; }
.views button.active, .tabs button.active { background: var(--accent-soft); color: var(--accent); }
.shell { max-width: 1200px; margin: 0 auto; padding: 24px 24px 128px; }
.work { display: grid; gap: 16px; min-width: 0; }
.view, .panel { display: none; }
.view.active, .panel.active { display: block; }
.block { min-width: 0; padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.bh { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.bh h2 { margin: 0; font: 600 18px/28px var(--font); }
.bh .tools { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
h3 { margin: 0 0 16px; font: 600 16px/24px var(--font); display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.sec { min-width: 0; padding: 16px 0; border-top: 1px solid var(--line); }
.sec:first-child, .target-sec { padding-top: 0; border-top: 0; }
.grid2, .row { display: grid; gap: 24px; }
.shared-status { border-bottom: 1px solid var(--line); padding-bottom: 16px; }
.connection-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.connection-bar select { width: auto; }
.motor-picker { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.motor-picker label { color: var(--label); font-size: 14px; white-space: nowrap; }
.dbadges { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 12px; min-width: 0; }
.dstatus { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); }
.dstatus i, .dot { display: inline-block; width: 8px; height: 8px; background: var(--muted); border-radius: 50%; flex: none; }
.dstatus.idle { color: var(--label); }
.dstatus.run, .dot.on { color: var(--ok); }
.dstatus.run i, .dot.on { background: var(--ok); }
.dstatus.err, .fault-summary { color: var(--danger); }
.dstatus.err i { background: var(--danger); }
.fault-summary { overflow-wrap: anywhere; }
.dot.warn { background: var(--warn); }
.ae-ind { color: var(--muted); font-size: 12px; }
.ae-ind.on { color: var(--warn); }
.dash-head { margin-bottom: 24px; }
.dtabs { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); }
.dtabs button { padding-inline: 16px; }
.dash { display: grid; gap: 12px 24px; grid-template-columns: minmax(0,5fr) minmax(0,7fr); grid-template-areas: "dial target" "dial run" "dial advanced" "readings readings"; align-items: start; }
.target-sec { grid-area: target; padding: 0; }
.target-sec h3 { justify-content: space-between; color: var(--label); margin-bottom: 8px; }
.tgtrow { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; }
.tgtrow input { height: 48px; font-size: 24px; color: var(--target); }
.tgtrow button, #dStart { min-height: 48px; }
.run-controls { grid-area: run; }
#dStart { width: 100%; font-size: 16px; }
#dStart.run { background: var(--danger-solid); color: var(--danger-ink); }
.dial { grid-area: dial; display: grid; justify-items: center; gap: 12px; }
#dAdvanced { grid-area: advanced; padding-bottom: 0; }
.gauge-host { position: relative; width: min(100%,340px); aspect-ratio: 1; }
.gauge-svg { width: 100%; height: 100%; display: block; touch-action: none; user-select: none; }
.gauge-svg[role="slider"] { cursor: crosshair; border-radius: 50%; }
.gauge-svg:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.g-track { fill: none; stroke: var(--panel-3); stroke-linecap: round; }
.g-val { fill: none; stroke: var(--accent); stroke-linecap: round; }
.g-ticks line { stroke: var(--muted); stroke-width: 1.2; }
.g-ticks line.maj { stroke: var(--label); stroke-width: 2.2; }
.g-ticks text { fill: var(--muted); font: 600 12px var(--mono); text-anchor: middle; dominant-baseline: middle; }
.g-tgt path { fill: var(--target); }
.g-mes path { fill: var(--measured); }
.g-disc { fill: var(--panel-2); stroke: var(--line); stroke-width: 1.5; }
.gcenter { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 4px; pointer-events: none; text-align: center; }
.gmode, .g-unit { font: 12px/18px var(--font); color: var(--muted); }
.g-readout { font: 600 32px/40px var(--mono); }
.dial-legend { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--label); }
.target-dot, .measured-dot { width: 16px; height: 3px; background: var(--target); border-radius: 2px; }
.measured-dot { background: var(--measured); margin-left: 8px; }
.mitgrid, .wgrid, .hgrid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; }
#dMitRow { margin-top: 16px; grid-template-columns: repeat(2,minmax(0,1fr)); }
.chiprow, .dial-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.chiprow select { width: auto; max-width: 100%; }
.gain-hint { font-size: 12px; color: var(--muted); }
.minis { grid-area: readings; display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px; padding: 16px 0 0; border-top: 1px solid var(--line); margin-top: 12px; }
.mini-g { min-width: 0; }
.mini-g .ml { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.mini-g .mv b { font: 600 24px/32px var(--mono); overflow-wrap: anywhere; }
.mini-g .mv span { display: block; font-size: 12px; color: var(--muted); }
.advanced > summary, .notice > summary, .linkbox > summary { cursor: pointer; list-style: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: var(--ctl); font-size: 14px; color: var(--label); }
.advanced > summary::-webkit-details-marker, .notice > summary::-webkit-details-marker, .linkbox > summary::-webkit-details-marker { display: none; }
.advanced > summary::after, .notice > summary::after, .linkbox > summary::after { content: "+"; margin-left: auto; color: var(--muted); }
.advanced[open] > summary::after, .notice[open] > summary::after, .linkbox[open] > summary::after { content: "−"; }
.advanced[open] > summary, .linkbox[open] > summary { margin-bottom: 12px; }
.telemetry-extra { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.telemetry-extra .chart { margin-top: 12px; }
.chart { min-width: 0; padding: 12px; background: var(--chart-bg); border: 1px solid var(--line); border-radius: 8px; }
.chart .ct { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; font-size: 12px; color: var(--label); }
.chart canvas { display: block; width: 100%; height: 200px; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.legend label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.legend i { display: inline-block; width: 12px; height: 3px; }
.legend input { width: 16px; height: 16px; }
.config-help { display: grid; gap: 8px; margin-bottom: 16px; }
.notice, .linkbox, .block.linkbox { padding: 0; border: 0; background: transparent; }
.notice p { font-size: 14px; color: var(--label); margin: 12px 0; }
.linksum { margin: 0; }
.linksum h2 { font-size: 14px; line-height: 22px; }
.pill { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.nodes { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nodes button { background: var(--panel-2); color: var(--text); border-color: var(--line-2); }
.nodes button.cur { background: var(--accent-soft); color: var(--accent); }
.nodes .f { color: var(--danger); }
.tiles { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 24px; padding: 16px 0; }
.tile { min-width: 0; }
.tile h3 { font-size: 16px; }
.tile .btns select { max-width: 110px; }
.config-view, #cfgView { min-width: 0; }
.cfg-toolbar-shell { margin-bottom: 16px; }
.cfg-toolbar-shell .tabs { flex-wrap: wrap; margin-top: 12px; }
.config-toolbar { margin: 16px 0 0; }
.config-toolbar > span { min-width: 0; overflow-wrap: anywhere; }
#cfgLast { flex-basis: 100%; }
#cfgFeat { display: block; overflow-wrap: anywhere; }
.cfg-toolbar-shell .banner { margin: 12px 0 0; }
.cfg-cards { display: grid; grid-template-columns: minmax(0,1fr); gap: 16px; align-items: start; }
.cfg-column { display: contents; }
.cfgpage { display: block; container: cfg-card / inline-size; padding: 16px; }
.cfgpage.active { border-color: var(--accent); }
.cfgpage .bh { margin-bottom: 8px; }
.cfgpage .bh h2 { font-size: 16px; line-height: 24px; }
.cfgpage h3 { margin-bottom: 8px; font-size: 14px; line-height: 20px; }
.cfgpage .sec { padding-block: 10px; }
.cfgpage .sec[style], .cfgpage .grid2[style] { margin-top: 8px !important; }
.cfgpage .hgrid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.cfgpage .grid2 { grid-template-columns: minmax(0,1fr); gap: 0; }
.cfgpage .field { margin-bottom: 4px; font-size: 12px; }
.cfgpage input[type="number"], .cfgpage select { height: 34px; }
.cfgpage button { min-height: 34px; padding: 4px 10px; font-size: 12px; line-height: 20px; max-width: 100%; }
.cfgpage .btns { margin-block: 8px; gap: 6px; }
.cfgpage .inline { gap: 6px; }
.cfgpage .inline > *, .cfgpage .btns > *, .cfgpage .info .kv > * { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.cfgpage .small, .cfgpage .mono { overflow-wrap: anywhere; }
.cfgpage .info { gap: 4px; }
.cfgpage .check-row, .cfgpage .ae-switch { min-height: 34px; font-size: 12px; }
.cfgpage .boot-sec { padding: 10px; margin-bottom: 8px; }
.cfgpage .advanced > summary { min-height: 32px; font-size: 12px; }
.cfgpage .advanced[open] > summary { margin-bottom: 8px; }
.cfgpage .badge { padding: 0 4px; font-size: 10px; line-height: 16px; white-space: nowrap; }
.cfgpage .telgrid { grid-template-columns: repeat(auto-fit,minmax(min(120px,100%),1fr)); gap: 2px 8px; }
.cfgpage .telc { padding: 2px 0; min-width: 0; min-height: 28px; font-size: 12px; overflow-wrap: anywhere; }
.cfgpage .telc input { margin: 0; }
.cfgpage .log-wrap { overflow-x: hidden; }
.cfgpage table.log { table-layout: fixed; }
.cfgpage table.log th, .cfgpage table.log td { padding: 6px 4px; white-space: normal; overflow-wrap: anywhere; }
.cfgpage table.log th:last-child { width: 64px; }
.cfgpage table.log button { padding-inline: 4px; min-height: 28px; }
#cfgPage_motor { order: 1; }
#cfgPage_drive { order: 2; }
#cfgPage_comm { order: 3; }
#cfgPage_store { order: 4; }
#cfgPage_other { order: 5; grid-column: 1 / -1; }
.more-actions { position: relative; }
.more-actions > summary { padding: 8px 12px; border: 1px solid var(--line-2); border-radius: 8px; }
.more-actions[open] > summary { margin-bottom: 0; }
.action-menu { position: absolute; top: calc(100% + 8px); left: 0; z-index: 50; min-width: 200px; display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: var(--shadow-float); }
.action-menu .danger { border-top: 1px solid var(--danger); margin-top: 8px; }
.banner { padding: 12px; margin-bottom: 16px; font-size: 14px; border-radius: 8px; background: var(--accent-soft); color: var(--label); overflow-wrap: anywhere; }
.banner.warn { background: var(--amber-soft); color: var(--warn); }
.banner:empty, .toast:empty, #bootNote:empty, #olNote:empty, #olHint:empty, #olStatus:empty, #cfgLast:empty { display: none; }
#olHint { color: var(--danger); }
#olStatus { align-self: end; padding-bottom: 6px; }
.is-off { opacity: 0.45; }
.boot-sec { padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); margin-bottom: 16px; }
.boot-sec:first-child { padding: 16px; border-top: 1px solid var(--line); }
.ae-switch { display: flex; align-items: center; gap: 12px; min-height: 44px; position: relative; cursor: pointer; font-size: 14px; }
.ae-switch input { position: absolute; width: 40px; height: 32px; margin: 0; opacity: 0; cursor: pointer; }
.switch-track { width: 40px; height: 24px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--panel-3); pointer-events: none; flex: none; }
.switch-track::after { content: ""; display: block; width: 18px; height: 18px; margin: 2px; border-radius: 50%; background: var(--muted); transition: transform .15s; }
.ae-switch input:checked + .switch-track { background: var(--amber-soft); border-color: var(--warn); }
.ae-switch input:checked + .switch-track::after { background: var(--warn); transform: translateX(16px); }
.ae-switch input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 3px; }
.ae-switch input:disabled { cursor: default; }
.badge { font-size: 12px; color: var(--warn); background: var(--amber-soft); padding: 2px 6px; border-radius: 4px; }
.badge.v3 { color: var(--accent); background: var(--accent-soft); }
.parameter-table { min-width: 0; max-width: 100%; overflow-x: auto; }
table.params { width: 100%; border-collapse: collapse; font-size: 14px; }
table.params td, table.params th { padding: 12px 8px; border-bottom: 1px solid var(--line); text-align: left; overflow-wrap: anywhere; }
table.params th { color: var(--muted); font-size: 12px; font-weight: 600; }
.prow .dev { font-family: var(--mono); }
.prow.mod td { background: var(--accent-soft); }
.modified-label { display: none; font-size: 12px; color: var(--accent); }
.prow.mod .modified-label { display: inline; }
.gh td { color: var(--label); font-weight: 600; padding-top: 24px; }
button.pulse { outline: 2px solid var(--warn); outline-offset: 2px; }
.telgrid { display: grid; grid-template-columns: repeat(auto-fill,minmax(140px,1fr)); gap: 8px; }
.telc { display: flex; gap: 8px; align-items: center; padding: 8px; min-height: 44px; font-size: 14px; }
.debug-layout { display: grid; grid-template-columns: minmax(0,5fr) minmax(0,7fr); gap: 16px; align-items: start; }
.debug-controls, .debug-observation { min-width: 0; }
.debug-observation { container-type: inline-size; }
.charts { display: grid; grid-template-columns: 1fr; gap: 12px; }
@container (min-width: 560px) { .charts { grid-template-columns: repeat(2,minmax(0,1fr)); } }
.debug-details { display: grid; gap: 12px; margin-top: 16px; }
.inst { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); overflow: hidden; }
.inst-h { display: flex; align-items: center; padding: 12px 16px; font-size: 16px; font-weight: 600; }
.inst-b { padding: 0 16px 16px; }
.live { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.live.on { background: var(--ok); }
.gauge { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
.gauge .gl { grid-column: 1 / -1; font-size: 12px; color: var(--muted); }
.gauge .n { font: 600 24px/32px var(--mono); overflow-wrap: anywhere; }
.gauge .gu, .gauge .l { font: 12px var(--mono); color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 4px 8px; background: var(--panel-3); border-radius: 4px; font-size: 12px; color: var(--label); overflow-wrap: anywhere; }
.chip.on { background: var(--danger-soft); color: var(--danger); }
.chip.ok { background: var(--ok-soft); color: var(--ok); }
.fsnap { width: 100%; border-collapse: collapse; font: 12px/18px var(--mono); }
.fsnap td { padding: 8px 4px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.fsnap td:first-child { color: var(--muted); }
.sp { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 8px; align-items: center; margin-bottom: 12px; }
.sp .lbl { font-size: 14px; }
.modes { display: flex; flex-wrap: wrap; gap: 8px; }
.modes .cur { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.technical-settings { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 12px; }
.hexbox { padding: 12px; background: var(--chart-bg); border: 1px dashed var(--line-2); border-radius: 8px; color: var(--accent); font: 12px/18px var(--mono); overflow-wrap: anywhere; }
.uvals { display: grid; gap: 8px; }
.uvals .r { display: grid; grid-template-columns: minmax(0,1fr) auto auto auto; gap: 8px; align-items: center; padding: 8px 0; font-size: 12px; border-bottom: 1px solid var(--line); }
.uvals .v { font-family: var(--mono); }
.log-wrap { max-width: 100%; max-height: min(56vh,520px); overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--chart-bg); }
table.log { width: 100%; border-collapse: collapse; font: 12px/18px var(--mono); }
table.log th, table.log td { padding: 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
table.log th { position: sticky; top: 0; z-index: 1; background: var(--panel-2); color: var(--muted); }
tr.tx-row td:nth-child(2) { color: var(--tx); }
tr.rx-row td:nth-child(2) { color: var(--rx); }
tr.err-row { color: var(--danger); }
.site { padding-top: 8px; text-align: center; color: var(--muted); font-size: 12px; }
.site a { color: var(--muted); text-decoration: none; }
#estop { position: fixed; right: 24px; bottom: 24px; z-index: 100; width: 80px; height: 80px; padding: 0; border-radius: 50%; border: 3px solid #FACC15; background: var(--danger-solid); color: var(--danger-ink); box-shadow: var(--shadow-float); font: 700 16px/22px var(--font); }
#estop small { display: block; font-size: 12px; }
.toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 95; width: max-content; max-width: min(600px,calc(100vw - 232px)); padding: 12px 16px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-3); box-shadow: var(--shadow-float); font-size: 14px; overflow-wrap: anywhere; }
.toast.err { color: var(--danger); border-color: var(--danger); }
.toast.ok { color: var(--ok); }
@media (min-width: 1024px) {
  .grid2, .cfg-cards { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .cfg-column { display: grid; gap: 16px; align-content: start; min-width: 0; }
}
@media (max-width: 1023px) {
  .dash { grid-template-columns: 1fr; grid-template-areas: "target" "run" "dial" "readings" "advanced"; }
  .debug-layout { grid-template-columns: 1fr; }
  .tiles { grid-template-columns: 1fr; gap: 16px; }
  .tile + .tile { border-top: 1px solid var(--line); padding-top: 16px; }
  .hgrid, .mitgrid, .wgrid { grid-template-columns: repeat(2,minmax(0,1fr)); }
}
@media (max-width: 767px) {
  :root { --ctl: 44px; }
  html { scroll-padding-top: 116px; scroll-padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
  body::after { content: ""; position: fixed; left: 0; right: 0; bottom: 0; height: calc(88px + env(safe-area-inset-bottom)); background: var(--bg); border-top: 1px solid var(--line); z-index: 90; pointer-events: none; }
  .cmdbar { height: auto; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; padding: 8px 12px; }
  .brand { min-height: 44px; }
  .spacer { display: none; }
  .header-actions { grid-column: 2; grid-row: 1; }
  #dLink { width: 72px; }
  #dConnect { padding-inline: 10px; }
  #dConnect .conn-label { display: none; }
  #dConnect::after { content: attr(data-short-label); }
  .views { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); padding: 0; }
  .views button { padding: 8px 4px; }
  .shell { padding: 12px 12px calc(112px + env(safe-area-inset-bottom)); }
  .work { gap: 12px; }
  .block { padding: 16px; }
  .connection-bar { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; }
  .connection-bar #dRoute { overflow-wrap: anywhere; }
  .motor-picker { margin-left: 0; }
  .dbadges { gap: 8px 12px; margin-top: 8px; }
  .dash-head { margin-bottom: 16px; }
  .dtabs { width: 100%; padding: 0; gap: 4px; }
  .dtabs button { min-width: 0; padding: 8px 4px; }
  input[type="number"], input[type="text"], select { font-size: 16px; }
  .tgtrow input { font-size: 24px; }
  .gauge-host { width: min(100%,280px); }
  .g-readout { font-size: 28px; line-height: 36px; }
  .minis { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; }
  .mini-g .mv b { font-size: 22px; line-height: 30px; }
  .chart canvas { height: 180px; }
  .bh .tools { margin-left: 0; width: 100%; }
  .linksum .pill, .linksum .nodes { display: none; }
  .tabs { flex-wrap: nowrap; }
  .config-toolbar { gap: 8px; }
  .config-toolbar #cfgParamState { flex-basis: 100%; }
  .config-help { margin-bottom: 12px; }
  .action-menu { left: auto; right: 0; }
  #panel-native table.params { table-layout: fixed; }
  #panel-native table.params th, #panel-native table.params td { padding-inline: 2px; font-size: 12px; }
  #panel-native table.params button { padding-inline: 4px; }
  #panel-native table.params th:nth-child(3) { width: 25% !important; }
  #uCustom { min-width: 0 !important; width: 100%; }
  #estop { right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); width: 64px; height: 64px; }
  #estop small { display: none; }
  .toast { bottom: calc(92px + env(safe-area-inset-bottom)); max-width: calc(100vw - 24px); }
}
.cfgpage .parameter-table { overflow: visible; }
.cfgparams thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
table.cfgparams, .cfgparams tbody { display: block; width: 100%; }
/* The original six cells stay in place; metadata sits below the name in column one. */
.cfgparams .prow { display: grid; grid-template-columns: minmax(0,1.65fr) minmax(0,.7fr) minmax(0,1fr) 44px; grid-template-areas: "name current new write" "meta current new write"; column-gap: 8px; min-height: 52px; padding-block: 6px; border-bottom: 1px solid var(--line); font-size: 13px; line-height: 18px; }
table.cfgparams td { border: 0; padding: 0; min-width: 0; }
.cfgparams .prow td:first-child { grid-area: name; font-weight: 600; align-self: end; }
.cfgparams .prow td:nth-child(2) { display: none; }
.cfgparams .prow td:nth-child(3) { grid-area: current; align-self: center; }
.cfgparams .prow td:nth-child(4) { grid-area: new; align-self: center; }
.cfgparams .prow td:nth-child(5) { grid-area: meta; font-size: 11px; line-height: 16px; color: var(--muted); }
.cfgparams .prow td:last-child { grid-area: write; align-self: center; }
.cfgparams .prow input { height: 34px; padding-inline: 6px; font-size: 13px; }
.cfgparams .prow button { width: 100%; min-height: 32px; padding: 3px 4px; border-color: transparent; }
.cfgparams .prow button:hover { border-color: var(--line-2); }
.cfgparams .modified-label { font-size: 10px; line-height: 16px; white-space: nowrap; }
.cfgparams .prow.mod { background: var(--accent-soft); }
.cfgparams .prow.mod td { background: transparent; }
.cfgparams .gh, .cfgparams tr:not(.prow):not(.gh) { display: block; }
.cfgparams .gh td { display: block; padding-block: 10px 8px; font-size: 12px; line-height: 18px; }
.cfgparams td.empty { display: block; padding-block: 8px; }
@container cfg-card (width < 420px) {
  .cfgparams .prow { grid-template-columns: minmax(0,1fr) minmax(0,1.2fr) 44px; grid-template-areas: "name name name" "meta meta meta" "current new write"; row-gap: 2px; min-height: 0; padding-block: 6px; }
  .cfgparams .prow td:first-child { align-self: start; }
  .cfgparams .prow td:nth-child(3), .cfgparams .prow td:nth-child(4) { display: flex; flex-direction: column; gap: 2px; }
  .cfgparams .prow td:nth-child(3)::before, .cfgparams .prow td:nth-child(4)::before { content: attr(data-label); font: 10px/14px var(--font); color: var(--muted); }
  .cfgparams .prow td:last-child { align-self: end; padding-bottom: 1px; }
  .cfgparams .prow input { font-size: 16px; }
  .cfgparams .gh td { padding-block: 8px; }
}
@media (max-width: 430px) {
  .brand > div { display: none; }
}
@media (max-width: 359px) {
  .config-toolbar > button { padding-inline: 12px; }
  .more-actions > summary { padding-inline: 8px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
`;
