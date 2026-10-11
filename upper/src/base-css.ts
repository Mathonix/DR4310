/** DR4310 "console" theme — dark graphite + teal by default, light optional (data-theme on <html>). */
export const BASE_CSS = String.raw`
:root, :root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0B1118; --bg-2: #101923;
  --panel: #141E29; --panel-2: #192633; --panel-3: #243447;
  --line: #344457; --line-2: #718399;
  --text: #F1F5F9; --label: #CBD5E1; --muted: #A3B2C3;
  --accent: #2DD4BF; --accent-press: #5EEAD4; --accent-ink: #062722; --accent-soft: #123B3B;
  --amber: #FCD34D; --amber-soft: #3A2D16;
  --ok: #86EFAC; --ok-soft: #17382A;
  --warn: #FCD34D; --danger: #FDA4AF; --danger-soft: #421E29;
  --tx: #D8B4FE; --rx: #7DD3FC;
  --shadow: none; --shadow-float: 0 8px 24px #00000066;
  --danger-solid: #B91C1C; --danger-ink: #FFFFFF; --target: #FBBF24; --measured: #E2E8F0;
  --chart-bg: #101923;
  --series-0: #2DD4BF; --series-1: #FBBF24; --series-2: #7DD3FC; --series-3: #D8B4FE; --series-4: #FDA4AF; --series-5: #86EFAC; --series-6: #F472B6; --series-7: #FCD34D; --series-8: #A5B4FC; --series-9: #5EEAD4; --series-10: #FDBA74; --series-11: #CBD5E1; --series-12: #BEF264; --series-13: #F0ABFC; --series-14: #FECDD3; --series-15: #67E8F9;
  /* legacy names used by components / canvas */
  --card-solid: var(--panel-2); --border-soft: var(--line); --bg-elevated: var(--panel-3);
  --radius: 12px; --radius-sm: 8px; --radius-pill: 6px; --ctl: 40px;
  --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --glass-blur: none;
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #F3F5F7; --bg-2: #F8FAFC;
  --panel: #ffffff; --panel-2: #F1F5F9; --panel-3: #E2E8F0;
  --line: #CBD5E1; --line-2: #64748B;
  --text: #172033; --label: #334155; --muted: #526174;
  --accent: #0F766E; --accent-press: #115E59; --accent-ink: #ffffff; --accent-soft: #E0F2F1;
  --amber: #92400E; --amber-soft: #FFF4D6;
  --ok: #166534; --ok-soft: #EAF7EE;
  --warn: #92400E; --danger: #B91C1C; --danger-soft: #FEE2E2;
  --tx: #7E22CE; --rx: #0369A1;
  --shadow: none; --shadow-float: 0 8px 24px #0F172A26;
  --target: #92400E; --measured: #334155;
  --chart-bg: #FFFFFF;
  --series-0: #0F766E; --series-1: #92400E; --series-2: #0369A1; --series-3: #7E22CE; --series-4: #B91C1C; --series-5: #166534; --series-6: #BE185D; --series-7: #854D0E; --series-8: #4338CA; --series-9: #115E59; --series-10: #9A3412; --series-11: #475569; --series-12: #3F6212; --series-13: #A21CAF; --series-14: #9F1239; --series-15: #0E7490;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: var(--font); font-size: 14px; color: var(--text); line-height: 1.57;
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--accent-soft); }
/* Let safety controls receive input through the transition snapshot overlay. */
::view-transition { pointer-events: none; }
::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
::view-transition-old(root) { z-index: 1; }
::view-transition-new(root) { z-index: 2; }
.theme-switching *, .theme-switching *::before, .theme-switching *::after { transition: none !important; }
html.theme-switching, html.theme-switching * { user-select: none !important; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: .86em; padding: 0 .25em; border-radius: 4px; background: var(--panel-3); }
.hidden { display: none !important; }

button, input, select { font-variant-numeric: tabular-nums; }
button { appearance: none; min-height: var(--ctl); padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font: 600 14px/22px var(--font); cursor: pointer; background: var(--accent); color: var(--accent-ink); transition: background .12s; }
button:hover { background: var(--accent-press); }
button:disabled { background: var(--panel-3); color: var(--muted); border-color: var(--line); cursor: not-allowed; }
button.ghost { background: transparent; color: var(--text); border-color: var(--line-2); }
button.ghost:hover { background: var(--panel-3); }
button.danger { background: var(--danger-solid); color: var(--danger-ink); }
button.ghost.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
input[type="text"], input[type="number"], select { width: 100%; min-width: 0; height: var(--ctl); border: 1px solid var(--line-2); border-radius: 8px; padding: 0 10px; background: var(--bg-2); color: var(--text); font: 14px var(--mono); }
input:disabled, select:disabled { color: var(--muted); background: var(--panel-3); }
input[type="range"] { width: 100%; min-width: 0; accent-color: var(--accent); }
input[type="checkbox"] { accent-color: var(--accent); width: 18px; height: 18px; flex: none; }
.field { display: block; margin-bottom: 8px; font-size: 14px; color: var(--label); }
.small, .sub { color: var(--muted); font-size: 12px; line-height: 18px; }
.mono { font-family: var(--mono); }
.btns, .inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.btns { margin: 12px 0; }
.inline input, .inline select { width: auto; max-width: 100%; min-width: 0; }
.check-row { display: flex; gap: 8px; align-items: center; color: var(--label); min-height: var(--ctl); font-size: 14px; }
.check-row input { margin: 0; }
.info { display: grid; gap: 8px; font-size: 14px; }
.info .kv { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.info .k { color: var(--muted); }
.info .v { font: 12px/18px var(--mono); text-align: right; overflow-wrap: anywhere; }
`;
