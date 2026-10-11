import { BASE_CSS } from "./base-css";
import { CONSOLE_CSS } from "./console-css";


function opts(): string {
  return [1, 2, 3, 4, 5, 6, 7].map((i) => `<option value="${i}"${i === 1 ? " selected" : ""}>ID ${i}</option>`).join("");
}
function idOpts7(): string {
  return Array.from({ length: 7 }, (_, i) => `<option value="${i + 1}"${i === 0 ? " selected" : ""}>${i + 1}</option>`).join("");
}
const THEAD = `<thead><tr><th scope="col">参数</th><th scope="col">键</th><th scope="col">当前值</th><th style="width:9rem">新值</th><th scope="col">单位 / 范围</th><th scope="col"></th></tr></thead>`;
const ptable = (pg: string) => `<div class="parameter-table"><table class="params cfgparams">${THEAD}<tbody id="cfgBody_${pg}"></tbody></table></div>`;
const rampIn = (m: string, name: string) => `<div><label class="field" for="hRamp_${m}">${name} ms</label><input type="number" id="hRamp_${m}" min="0" max="60000" step="10"/><span class="small mono" id="hRampFw_${m}"></span></div>`;
const mini = (id: string, label: string) => `<div class="mini-g" id="${id}"><div class="ml">${label}</div><div class="mv"><b id="${id}V">—</b><span id="${id}U"></span></div></div>`;

export function page(appScriptSrc = "/app.js"): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="color-scheme" content="dark light"/>
<meta name="theme-color" content="#0B1118"/>
<meta name="description" content="DR4310 FOC 电机上位机：仪表盘（速度/力矩/位置/MIT）、参数配置、示波器；WebUSB PCAN-USB / Web Serial 串口。"/>
<title>DR4310 上位机 · Mathonix</title>
<script>(function(){try{var t=localStorage.getItem("dr4310-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();</script>
<style>${BASE_CSS}${CONSOLE_CSS}</style>
</head>
<body>
<header class="cmdbar">
  <div class="brand">
    <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="var(--panel-2)" stroke="var(--line-2)"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="var(--accent)" stroke-width="2.4"/><path d="M16 7.5v4M16 20.5v4M7.5 16h4M20.5 16h4" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="2.6" fill="var(--amber)"/></svg>
    <div><b>DR4310</b></div>
  </div>
  <nav class="views" id="views" aria-label="视图">
    <button type="button" data-view="dash" data-testid="view-dash" class="active">仪表盘</button>
    <button type="button" data-view="cfg" data-testid="view-cfg">参数配置</button>
    <button type="button" data-view="debug" data-testid="view-debug">调试</button>
  </nav>
  <div class="links"><span class="pill"><span class="dot" id="dotPcan"></span>CAN</span><span class="pill"><span class="dot" id="dotSer"></span>UART</span></div>
  <div class="spacer"></div>
  <div class="header-actions">
    <button type="button" class="iconbtn" id="themeToggle" title="切换到浅色主题" aria-label="切换到浅色主题" aria-pressed="false"><svg class="theme-sun" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/></svg><svg class="theme-moon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z"/></svg></button>
    <div class="connection-controls">
      <select id="dLink" data-testid="connection-route" aria-label="控制链路" title="自动：优先 PCAN，否则串口"><option value="auto">自动</option><option value="can">CAN</option><option value="serial">串口</option></select>
      <button type="button" id="dConnect" data-testid="connection-toggle" data-short-label="连接" aria-label="连接" title="连接（自动：优先 PCAN，否则串口）"><span class="conn-dot" aria-hidden="true"></span><span class="conn-label" aria-hidden="true">连接</span></button>
    </div>
  </div>
</header>
<div class="shell">
  <main class="work">
    <div class="shared-status">
      <div class="connection-bar" data-testid="connection-bar">
        <span class="small" id="dRoute">未连接</span>
        <div class="motor-picker"><label for="motorId">电机 ID</label><select id="motorId" data-testid="motor-id">${opts()}</select></div>
      </div>
          <div class="dbadges">
            <span class="dstatus off" id="dStatus" role="status"><i></i><span id="dStatusT">无反馈</span></span>
            <span class="small fault-summary" id="dFault" data-testid="fault-summary"></span><span class="ae-ind hidden" id="dAe" data-testid="ae-indicator" title="固件 INFO ae=（只读）。上电自动使能在 参数配置 › 驱动 › 上电行为"></span>
          </div>
    </div>
    <!-- ================= 仪表盘 (home) ================= -->
    <section class="block view active" id="view-dash">
      <div class="bh dash-head">
        <nav class="tabs dtabs" id="dModes" aria-label="控制模式">
          <button type="button" data-dmode="spd" data-testid="mode-speed" class="active">速度</button>
          <button type="button" data-dmode="cur" data-testid="mode-current" title="力矩 / 电流控制">力矩</button>
          <button type="button" data-dmode="pos" data-testid="mode-position">位置</button>
          <button type="button" data-dmode="mit" data-testid="mode-mit">MIT</button>
        </nav>
      </div>
      <div class="dash">
          <div class="sec target-sec">
            <h3>目标值<span class="small mono" id="dTgtUnit">rpm</span></h3>
            <div class="tgtrow">
              <input type="number" id="dTarget" data-testid="target-input" step="any" value="0" aria-label="目标值"/>
              <button type="button" class="ghost" id="dApply" data-testid="target-apply" title="设定目标（Enter）；运行时更新目标">设定</button>
            </div>
            <div class="mitgrid hidden" id="dMitRow">
              <div><label class="field" for="dMitV">速度 rad/s</label><input type="number" id="dMitV" min="-50" max="50" step="0.1" value="0"/></div>
              <div><label class="field" for="dMitKp">Kp</label><input type="number" id="dMitKp" min="0" max="500" step="0.5" value="5"/></div>
              <div><label class="field" for="dMitKd">Kd</label><input type="number" id="dMitKd" min="0" max="5" step="0.01" value="0.1"/></div>
              <div><label class="field" for="dMitT">前馈电流 A</label><input type="number" id="dMitT" min="-2.5" max="2.5" step="0.01" value="0"/></div>
            </div>
          </div>
          <div class="run-controls">
            <button type="button" id="dStart" data-testid="motor-toggle" aria-pressed="false">启动</button>
          </div>
        <div class="dial">
          <div id="dGauge" data-testid="target-gauge" title="点击或拖动刻度设定目标；方向键微调，Home 归零">
            <div class="gcenter">
              <div class="gmode" id="dGaugeMode">速度</div><div class="g-readout">—</div><div class="g-unit"></div>
            </div>
          </div>
          <div class="dial-legend"><span class="target-dot"></span>目标<span class="measured-dot"></span>实测</div>
        </div>
      <div class="minis">${mini("mSpd", "转速")}${mini("mTrq", "电流")}${mini("mPos", "位置")}${mini("mVbus", "母线电压")}</div>
          <details class="advanced sec" id="dAdvanced" data-testid="advanced-controls">
            <summary>更多控制</summary>
            <div class="chiprow"><select id="dRangeSel" data-testid="target-range" aria-label="量程" title="表盘与波形量程"></select><span class="small" id="dRampChip">—</span><span class="small" id="dDisp">—</span></div>
            <div class="btns"><button type="button" class="ghost" id="dTgtZero" title="目标归零">目标归零</button><button type="button" class="ghost" id="dTgtNeg" title="目标反向">反向</button><span class="gain-hint" id="dGainNote" title="CAN 增益在调试页设置；串口使用电机内参数">ⓘ 增益</span></div>
            <div class="dial-meta"><span class="small mono" id="dCmdNow">待机</span><span class="small" id="dSrc">○ 无反馈</span></div>
            <div class="btns"><button type="button" class="ghost hidden" id="dZero" title="当前位置设为零，需空闲">位置设零</button><button type="button" class="ghost" id="dClear">清除故障</button></div>
            <h3>波形<span class="small mono" id="wInfo"></span></h3>
            <div class="wgrid">
              <div><label class="field" for="wKind">形状</label><select id="wKind"><option value="sine">正弦</option><option value="square">方波</option><option value="triangle">三角</option></select></div>
              <div><label class="field" for="wAmp">幅值 <span id="wUnit"></span></label><input type="number" id="wAmp" step="any" value="10"/></div>
              <div><label class="field" for="wOff">偏置</label><input type="number" id="wOff" step="any" value="0"/></div>
              <div><label class="field" for="wFreq">频率 Hz</label><input type="number" id="wFreq" step="0.1" min="0.1" max="5" value="0.5"/></div>
            </div>
            <div class="btns"><button type="button" id="wStart" data-testid="wave-toggle">启动波形</button></div>
          </details>
      </div>
      <details class="advanced telemetry-extra" data-testid="response-details"><summary>响应曲线</summary>
        <div class="chart response-chart"><div class="ct"><span>响应</span><span class="legend" id="lgD1"></span></div><canvas id="dChart" aria-label="目标与实测响应曲线"></canvas></div>
        <div class="chart"><div class="ct"><span>电气</span><span class="legend" id="lgD2"></span></div><canvas id="dChart2" aria-label="电流功率与母线曲线"></canvas></div>
        <div class="small">功率 <span id="dPower">— W</span><span id="dPowerSrc"></span></div>
      </details>
    </section>

    <!-- ================= 参数配置 ================= -->
    <section class="view config-view" id="view-cfg">
      <div class="bh"><h2>参数配置</h2></div>
      <div class="config-help">
    <details class="notice">
      <summary>安全说明</summary>
      <p><strong>浏览器：</strong>仅支持 Chrome / Edge 桌面版（WebUSB + Web Serial），且须 HTTPS。浏览器本地运行，不上云。<br/>
      <strong>PCAN on Windows：</strong>WebUSB 无法占用 PEAK 官方驱动下的设备——请用 <strong>Zadig → WinUSB</strong> 绑定 PCAN-USB（VID 0x0C72 / PID 0x000C），或临时卸载 PEAK 驱动。换回 PCAN-View 时需在设备管理器里回滚驱动。仅支持经典 PCAN-USB。<br/>
      <strong>安全：</strong>电机须固定、远离人手；电流模式不限转速，空载小电流也会持续加速。原生协议<strong>没有命令超时</strong>，请保留硬件急停。右下角红色按钮 = 急停（任何时刻可用，快捷键 <code>Esc</code>）。</p>
    </details>

    <details class="block linkbox" id="linkBox" data-testid="connection-details">
      <summary class="bh linksum"><h2>连接详情</h2>
        <span class="pill"><span class="dot" id="sumCanDot"></span><span id="sumCan">CAN 未连接</span></span>
        <span class="pill"><span class="dot" id="sumSerDot"></span><span id="sumSer">串口未连接</span></span>
        <span class="nodes" id="canNodes"><span class="small">—</span></span>
        <span class="sub tog"></span>
      </summary>

      <div class="tiles">
        <div class="tile">
          <h3>PCAN · 1 Mbps</h3>
          <div class="btns" style="margin-top:0">
            <button type="button" id="pcanConnect" data-testid="connect-can">连接</button>
            <button type="button" class="ghost" id="pcanDisconnect" data-testid="disconnect-can" disabled>断开</button>
          </div>
          <div class="info">
            <div class="kv"><span class="k">设备</span><span class="v" id="stPcanDev">—</span></div>
            <div class="kv"><span class="k">总线</span><span class="v" id="stPcanBus">未连接</span></div>
          </div>
        </div>
        <div class="tile">
          <h3>串口</h3>
          <div class="btns" style="margin-top:0">
            <select aria-label="串口波特率" id="serBaud" style="width:auto">
              <option value="115200" selected>115200</option>
              <option value="230400">230400</option>
              <option value="460800">460800</option>
              <option value="921600">921600</option>
            </select>
            <button type="button" id="serConnect" data-testid="connect-serial">连接</button>
            <button type="button" class="ghost" id="serDisconnect" data-testid="disconnect-serial" disabled>断开</button>
          </div>
          <div class="info">
            <div class="kv"><span class="k">状态</span><span class="v" id="stSer">未连接</span></div>
            <div class="kv"><span class="k">固件</span><span class="v" id="stFw">—</span></div>
            <div class="kv"><span class="k" title="JustFloat 遥测帧">遥测</span><span class="v" id="stSerFrames">—</span></div>
            <div class="kv"><span class="k">应答</span><span class="v" id="stSerLines">—</span></div>
          </div>
        </div>
        <div class="tile">
          <h3>连接选项</h3><span class="technical" id="hdrIds"></span>
          <div class="small mono technical" id="stIds" style="margin-top:6px">—</div>
          <label class="check-row"><input type="checkbox" id="wdHidden" checked/>隐藏时停机</label>
          <label class="check-row"><input type="checkbox" id="wdConfirm" checked/>操作确认</label>
          <label class="check-row"><input type="checkbox" id="autoRe"/>自动连接</label>
        </div>
      </div>
    </details>

      </div>
     <div id="cfgView">
      <div class="block cfg-toolbar-shell">
      <span class="sub mono" id="cfgFeat">—</span>
      <nav class="tabs" id="cfgPages" aria-label="参数卡片快速跳转">
        <button type="button" data-page="motor">电机</button>
        <button type="button" data-page="drive" class="active">驱动</button>
        <button type="button" data-page="comm">通信</button>
        <button type="button" data-page="store">存储</button>
        <button type="button" data-page="other" id="cfgTab_other" class="hidden">其他</button>
      </nav>
      <div class="btns config-toolbar">
        <button type="button" class="ghost" id="btnGetAll">读取</button>
        <button type="button" id="btnSync" title="写入所有修改项并保存到 Flash">同步</button>
        <details class="advanced more-actions"><summary>更多操作</summary><div class="action-menu">
        <button type="button" class="ghost" id="btnWriteMod" title="写入修改项到 RAM，断电不保留">临时写入</button>
        <button type="button" class="ghost" id="btnRevertInputs">撤销输入</button>
        <button type="button" class="ghost danger" id="btnDefaults">重置</button>
        </div></details>
        <span class="small" id="cfgParamState"></span> <span class="small" id="cfgLast"></span>
      </div>

      <div class="banner info" id="cfgBanner"></div>
      </div>
      <div class="cfg-cards">
      <div class="cfg-column">
      <div class="block cfgpage" id="cfgPage_motor">
        <div class="bh"><h2 title="电机基础参数、零点与力矩换算">电机参数</h2></div>
        ${ptable("motor")}
        <div class="sec hidden" id="zeroSec" style="margin-top:12px">
          <h3>零点</h3>
          <div class="btns" style="margin-top:0"><button type="button" id="btnSetZero">位置设零</button><span class="small mono" id="cfgCalib2">—</span></div>

        </div>
        <div class="sec" style="margin-top:12px">
          <h3>力矩换算</h3>
          <div class="hgrid">
            <div><label class="field" for="hKt">力矩常数 N·m/A</label><input type="number" id="hKt" title="Kt 力矩常数，Iq × Kt" min="0" max="10" step="any" placeholder="未设置"/></div>
          </div>
          <div class="small" id="hFwNote" style="margin-top:6px">—</div>

        </div>
      </div>

      <div class="block cfgpage" id="cfgPage_comm">
        <div class="bh"><h2 title="CAN ID、遥测通道与心跳">通信参数</h2></div>
        ${ptable("comm")}
        <div class="grid2" style="margin-top:12px">
          <div class="sec">
            <h3>CAN ID</h3>
            <div class="inline">
              <span class="small">生效 ID</span><strong class="mono" id="cfgActiveId">—</strong>
              <span class="small">已设置 ID</span><strong class="mono" id="cfgCfgId">—</strong>
            </div>
            <div class="inline" style="margin-top:.6rem">
              <select id="newCanId">${idOpts7()}</select>
              <button type="button" id="btnApplyId">修改并重启</button>
            </div>
            <div class="small mono" id="canIdHint" style="margin-top:.4rem">—</div>

          </div>
          <div class="sec">
            <h3>遥测通道</h3>
            <div id="telNone" class="small" title="v3 固件支持自选遥测通道">固定通道</div>
            <div id="telSec" class="hidden">
              <div class="telgrid" id="telList"></div>
              <div class="inline" style="margin-top:8px">
                <span id="telRateRow" class="inline"><label class="small" for="telRate">频率 Hz</label><input type="number" id="telRate" min="1" max="1000" step="1" style="width:6rem"/></span>
                <button type="button" id="telApply">应用</button>
                <button type="button" class="ghost" id="telReload">读取</button>
              </div>
              <div class="small mono" id="telState" style="margin-top:6px">—</div>
            </div>
            <label class="check-row" title="PING / INFO 每 0.5 秒保活，防止固件 TIMEOUT_MS 停机"><input type="checkbox" id="cfgHb" checked/>心跳</label>
          </div>
        </div>
      </div>
      </div>

      <div class="cfg-column">
      <div class="block cfgpage active" id="cfgPage_drive">
        <div class="bh"><h2 title="上电行为、电流限制、控制增益与指令时间">驱动参数</h2></div>
        <div class="sec boot-sec" id="bootSec" data-testid="boot-behavior">
          <h3>上电行为 <span class="badge" title="重启生效">重启生效</span></h3>
          <div class="hgrid">
            <div><label class="field" for="bootMode">上电模式</label><select id="bootMode" data-testid="boot-mode"><option value="0">空闲</option><option value="1">电流</option><option value="2">速度</option><option value="3">位置</option></select></div>
            <div><label class="field" for="bootTarget">上电目标 <span id="bootUnit">—</span></label><input type="number" id="bootTarget" data-testid="boot-target" step="any"/></div>
            <div style="grid-column:span 2"><label class="ae-switch" for="bootAe"><input type="checkbox" role="switch" id="bootAe" data-testid="boot-auto-enable"/><span class="switch-track" aria-hidden="true"></span><span>上电自动使能</span></label></div>
          </div>
          <div class="small" id="bootNote" title="同步写入并保存，重启生效"></div>
        </div>
        <div class="sec boot-sec" id="ilimSec" data-testid="current-limit">
          <h3 title="持续上限为最大电流。开启超限模式后可短时到达超限电流；超过最大电流的时间消耗预算（满值=超限时间），耗尽后回到最大电流，低于最大电流时预算恢复">电流限制</h3>
          <div class="hgrid">
            <div><label class="field" for="iqMax" title="IQ_LIM · 持续电流上限">最大电流 A</label><input type="number" id="iqMax" data-testid="iq-max" step="any" min="0" max="2.5"/></div>
            <div class="small hidden" id="olStatus" data-testid="ol-status" title="INFO ol / budget"></div>
          </div>
          <div id="olFields" class="hidden">
            <div class="hgrid">
              <div style="grid-column:span 2"><label class="ae-switch" for="olEnable" title="OL_EN · 开启后允许短时超过最大电流"><input type="checkbox" role="switch" id="olEnable" data-testid="ol-enable"/><span class="switch-track" aria-hidden="true"></span><span>超限模式</span></label></div>
              <div id="olCurrentWrap"><label class="field" for="olCurrent" title="OL_IQ · 须 ≥ 最大电流，固件上限 2.8 A">超限电流 A</label><input type="number" id="olCurrent" data-testid="ol-current" step="any" min="0" max="2.8"/></div>
              <div id="olTimeWrap"><label class="field" for="olTime" title="OL_TIME_S · 超限预算（秒），0 等同关闭">超限时间 s</label><input type="number" id="olTime" data-testid="ol-time" step="any" min="0" max="10"/></div>
            </div>
          </div>
          <div class="small" id="olNote"></div>
          <div class="small" id="olHint" data-testid="ol-hint"></div>
        </div>
        ${ptable("drive")}
        <details class="sec advanced">
          <summary title="固件支持斜坡时优先使用固件参数">指令时间</summary>
          <div class="hgrid">${rampIn("spd", "速度")}${rampIn("cur", "力矩")}${rampIn("pos", "位置")}${rampIn("mit", "MIT 位置")}</div>

        </details>
      </div>
      <div class="block cfgpage" id="cfgPage_store">
        <div class="bh"><h2 title="设备与 Flash、参数文件和日志">数据存储</h2></div>
        <div class="grid2">
          <div class="sec">
            <h3>设备与 Flash</h3>
            <div class="info" style="margin:0">
              <div class="kv"><span class="k">运行</span><span class="v" id="cfgRun">—</span></div>
              <div class="kv"><span class="k">配置来源</span><span class="v" id="cfgSrc">—</span></div>
              <div class="kv"><span class="k">记录序号</span><span class="v" id="cfgSeq">—</span></div>
              <div class="kv"><span class="k">电角度校准</span><span class="v" id="cfgCalib">—</span></div>
            </div>
            <div class="btns">
              <button type="button" id="btnSave" title="SAVE：保存当前 RAM 参数">保存配置</button>
              <button type="button" class="ghost" id="btnCfgInfo" title="读取 INFO 设备状态">刷新状态</button>
              <button type="button" class="ghost" id="btnReload" title="RELOAD：从已保存配置重新载入">重新载入</button>
              <button type="button" class="ghost danger" id="btnReboot" title="REBOOT：控制器重启">重启设备</button>
            </div>
          </div>
          <div class="sec">
            <h3>参数文件</h3>
            <div class="btns" style="margin-top:0">
              <button type="button" class="ghost" id="btnExport" title="JSON 参数文件">导出参数</button>
              <button type="button" class="ghost" id="btnImport" title="JSON 参数文件">导入参数</button>
              <input type="file" id="profFile" accept=".json,application/json" class="hidden"/>
            </div>

          </div>
        </div>
        <div class="sec" style="margin-top:12px">
          <h3 title="CSV 记录保存在本浏览器 IndexedDB">日志 <span class="small" id="logStat"></span></h3>
          <div class="btns" style="margin-top:0">
            <label class="check-row" style="margin:0"><input type="checkbox" id="logAuto" checked/>停止记录时自动存入</label>
            <button type="button" class="ghost" id="logRefresh">刷新</button>
            <button type="button" class="ghost danger" id="logDelAll">全部删除</button>
          </div>
          <div class="log-wrap" style="max-height:320px"><table class="log"><thead><tr><th scope="col">名称</th><th scope="col">时间</th><th scope="col">行数</th><th scope="col">大小</th><th scope="col">来源</th><th scope="col"></th></tr></thead><tbody id="logList"></tbody></table></div>
        </div>
      </div>
      </div>

      <div class="block cfgpage hidden" id="cfgPage_other">
        <div class="bh"><h2 title="固件返回的其他参数">其他参数</h2></div>
        ${ptable("other")}
      </div>
      </div>

     </div>
    </section>

    <!-- ================= 调试 ================= -->
    <div class="view" id="view-debug">
    <div class="debug-layout"><section class="block debug-controls">
      <div class="bh"><h2>调试</h2></div>
      <nav class="tabs" id="tabs">
        <button type="button" data-tab="native" class="active">原生控制</button>
        <button type="button" data-tab="gm">GM6020 电流</button>
        <button type="button" data-tab="uart">串口</button>
        <button type="button" data-tab="log">帧日志</button>
      </nav>

    <!-- Native -->
    <div class="panel active" id="panel-native">
      <div class="sec">
        <h3>模式 <span class="small" id="lastCmd"></span></h3>
        <div class="modes" id="modeBtns">
          <button type="button" class="ghost" data-mode="0">停止</button>
          <button type="button" class="ghost" data-mode="1">电流环</button>
          <button type="button" class="ghost" data-mode="2">速度环</button>
          <button type="button" class="ghost" data-mode="3">位置环</button>
          <button type="button" class="ghost" data-mode="4">MIT</button>
        </div>

      </div>

      <div class="sec" style="margin-top:1rem">
        <h3>目标值</h3>
        <div class="sp"><span class="lbl">电流 Iq (A)</span><input aria-label="调试目标" type="number" id="nIq" step="0.01" min="-2.5" max="2.5" value="0.05"/><input type="range" id="rIq" min="-2.5" max="2.5" step="0.01" value="0.05"/><button type="button" id="sendIq">发送</button></div>
        <label class="check-row" title="拖动滑块或修改数值时实时发送，限速 20 Hz，电流 / 速度 / 位置通用"><input type="checkbox" id="liveSlider"/>实时发送</label>

      </div>
      <div class="sec" style="margin-top:1rem">
        <h3>速度环 <span class="small mono" id="spdId"></span></h3>
        <div class="sp"><span class="lbl">目标 (rpm)</span><input aria-label="调试目标" type="number" id="nSpd" step="1" min="-1000" max="1000" value="100"/><input type="range" id="rSpd" min="-1000" max="1000" step="1" value="100"/><button type="button" id="sendSpd">发送</button></div>
        <details class="advanced technical-settings"><summary>增益与周期发送</summary><div class="mitgrid" style="grid-template-columns:repeat(3,1fr)"><div><label class="field" for="spdkp">KP [0,10]</label><input type="number" id="spdkp" step="any" min="0" max="10"/></div><div><label class="field" for="spdki">KI [0,5]</label><input type="number" id="spdki" step="any" min="0" max="5"/></div><div><label class="field" for="spdkd">KD [0,1]</label><input type="number" id="spdkd" step="any" min="0" max="1"/></div></div>
        <div class="hexbox" id="spdHex" style="margin-top:.6rem">—</div>
        <div class="small mono" id="spdQ"></div>
        <div class="btns">
          <label class="check-row" style="margin:0"><input type="checkbox" id="spdPeriodic"/>周期发送</label>
          <input type="number" id="spdPeriod" min="10" step="1" value="50" style="width:5.5rem"/><span class="small">ms</span>
          <button type="button" class="ghost" id="spdFactory">出厂增益</button>
        </div></details>
      </div>
      <div class="sec" style="margin-top:1rem">
        <h3>位置环 <span class="small mono" id="posId"></span></h3>
        <div class="sp"><span class="lbl">目标 (rad)</span><input aria-label="调试目标" type="number" id="nPos" step="0.01" min="-500" max="500" value="0"/><input type="range" id="rPos" min="-12.57" max="12.57" step="0.01" value="0"/><button type="button" id="sendPos">发送</button></div>
        <details class="advanced technical-settings"><summary>增益与周期发送</summary><div class="mitgrid" style="grid-template-columns:repeat(3,1fr)"><div><label class="field" for="poskp">KP [0,200]</label><input type="number" id="poskp" step="any" min="0" max="200"/></div><div><label class="field" for="poski">KI [0,100]</label><input type="number" id="poski" step="any" min="0" max="100"/></div><div><label class="field" for="poskd">KD [0,100]</label><input type="number" id="poskd" step="any" min="0" max="100"/></div></div>
        <div class="hexbox" id="posHex" style="margin-top:.6rem">—</div>
        <div class="small mono" id="posQ"></div>
        <div class="btns">
          <label class="check-row" style="margin:0"><input type="checkbox" id="posPeriodic"/>周期发送</label>
          <input type="number" id="posPeriod" min="10" step="1" value="50" style="width:5.5rem"/><span class="small">ms</span>
          <button type="button" class="ghost" id="posFactory">出厂增益</button>
        </div></details>
      </div>

      <details class="sec advanced">
        <summary title="仅写入 RAM，断电不保留">在线参数</summary>
        <table class="params"><thead><tr><th scope="col">ID</th><th scope="col">参数</th><th style="width:9rem">值</th><th scope="col">单位</th><th scope="col"></th></tr></thead><tbody id="paramBody"></tbody></table>
        <div class="btns"><button type="button" id="paramAll">全部写入</button><button type="button" class="ghost" id="paramReset">默认输入</button></div>

      </details>

      <details class="sec advanced">
        <summary>MIT</summary>
        <div class="mitgrid">
          <div><label class="field" for="mP">目标位置 rad [-50,50]</label><input type="number" id="mP" step="0.01" value="0"/></div>
          <div><label class="field" for="mV">目标速度 rad/s [-50,50]</label><input type="number" id="mV" step="0.1" value="0"/></div>
          <div><label class="field" for="mKp">Kp [0,500]</label><input type="number" id="mKp" step="0.5" value="5"/></div>
          <div><label class="field" for="mKd">Kd [0,5]</label><input type="number" id="mKd" step="0.01" value="0.1"/></div>
          <div><label class="field" for="mT">前馈电流 A [-2.5,2.5]</label><input type="number" id="mT" step="0.01" value="0"/></div>
        </div>
        <div class="hexbox" id="mitHex" style="margin-top:.6rem">—</div>
        <div class="small" id="mitWarn" style="color:var(--danger)"></div>
        <div class="btns">
          <button type="button" class="ghost" id="mitEnter">进入 MIT</button>
          <button type="button" id="mitSend">发送</button>
          <label class="check-row" style="margin:0"><input type="checkbox" id="mitPeriodic"/>周期发送</label>
          <input type="number" id="mitPeriod" min="5" step="1" value="10" style="width:5.5rem"/><span class="small">ms</span>
        </div>

      </details>

    </div>

    <!-- GM6020 -->
    <div class="panel" id="panel-gm">
      <div class="sec">
        <h3><span class="dot" id="dotGm"></span>GM6020 电流 <span class="small mono" id="gmIds"></span></h3>
        <div class="sp"><span class="lbl">目标 Iq (A)</span><input type="number" id="gmA" step="0.01" min="-2.5" max="2.5" value="0.05"/><input type="range" id="gmR" min="-2.5" max="2.5" step="0.01" value="0.05"/><span class="mono small" id="gmRaw">原始值 —</span></div>
        <div class="btns">
          <button type="button" id="gmStart">启动</button>
          <button type="button" class="ghost danger" id="gmStop" disabled>停止</button>
          <button type="button" class="ghost" id="gmZero">零帧</button>
        </div>
        <div class="hexbox" id="gmHex">—</div>
        <div class="small" id="gmState" style="margin-top:.4rem">未运行</div>
        <details class="advanced"><summary>协议说明</summary><p class="small">
          流程：启动后先连续发 3 帧本机槽位为 0 的握手帧，再每 10 ms 发送目标电流。固件 100 ms 收不到帧即停机，且需重新零帧握手。<br/>
          零电流帧 = 关闭功率级（不是保持 0 A）。其余槽位固定为 0 —— 若总线上有其他 GM6020/电机共用 0x1FE/0x2FE，请勿使用。<br/>
          线上量程 ±3 A（raw = A×16384/3），固件限幅 2.5 A。反馈 0x204+ID 约 1 kHz：角度、rpm、Iq（温度字节 0xFF = 不可用）。<br/>
          发送任何原生协议命令都会取消 GM 会话，本页会同时停止此循环。
        </p></details>
      </div>
    </div>

    <!-- UART -->
    <div class="panel" id="panel-uart">
      <div class="sec">
        <h3 title="VOFA 兼容 ASCII 命令，换行结尾">ASCII</h3>
        <div class="btns" style="margin-top:0">
          <button type="button" class="danger" data-u="STOP" title="STOP">停止</button>
          <button type="button" data-u="RUN" title="RUN">电流运行</button>
          <button type="button" class="ghost" data-u="ZERO" title="ZERO">目标归零</button>
          <button type="button" class="ghost" data-u="CLEAR" title="CLEAR">清除故障</button>
          <button type="button" class="ghost" id="uCalib" title="CALIB">电角度标定</button>
        </div>
        <div class="inline" style="margin-bottom:.5rem">
          <span class="lbl small">IQ (A)</span><input type="number" id="uIq" step="0.01" value="0.05"/><button type="button" id="uIqSend" title="IQ">发送</button>
          <span class="lbl small">KP [0,20]</span><input type="number" id="uKp" step="0.1" value="6"/><button type="button" id="uKpSend" title="KP">发送</button>
          <span class="lbl small">KI [0,20000]</span><input type="number" id="uKi" step="10" value="6816"/><button type="button" id="uKiSend" title="KI">发送</button>
        </div>
        <div class="inline">
          <input type="text" id="uCustom" placeholder="自定义命令，如 IQ=0.1" spellcheck="false" style="min-width:14rem"/>
          <button type="button" class="ghost" id="uCustomSend">发送</button>
        </div>

      </div>
      <div class="sec" style="margin-top:1rem">
        <h3><span id="uValsH">遥测通道 · 16</span> <span title="A / B 选择曲线">ⓘ</span></h3>
        <div class="uvals" id="uVals"></div>
      </div>
      <div class="charts" style="margin-top:1rem">
        <div class="chart"><div class="ct"><span>串口图 A</span><span class="legend" id="lgUA"></span></div><canvas id="chUA"></canvas></div>
        <div class="chart"><div class="ct"><span>串口图 B</span><span class="legend" id="lgUB"></span></div><canvas id="chUB"></canvas></div>
      </div>
    </div>

    <!-- Log -->
    <!-- Log -->
    <div class="panel" id="panel-log">
      <div class="btns" style="margin-top:0">
        <button type="button" class="ghost" id="logPause">暂停</button>
        <button type="button" class="ghost" id="logClear">清空</button>
        <label class="check-row" style="margin:0"><input type="checkbox" id="logHide1k" title="隐藏 1 kHz GM 反馈帧，仅影响日志显示" checked/>隐藏高频帧</label>
        <label class="check-row" style="margin:0"><input type="checkbox" id="logHideStatus" title="隐藏 10 Hz 状态帧及串口心跳，仅影响日志显示"/>隐藏心跳帧</label>
      </div>
      <div class="log-wrap" id="logWrap">
        <table class="log">
          <thead><tr><th scope="col">时间</th><th scope="col">方向</th><th scope="col">通道</th><th scope="col">ID</th><th scope="col">数据</th><th scope="col">解析</th></tr></thead>
          <tbody id="logBody"></tbody>
        </table>
      </div>
    </div>
    </section>
    <div class="debug-observation">
    <section class="block">
      <div class="bh"><h2>示波器</h2>
        <div class="tools">
          <select id="chWin" style="width:auto">
            <option value="2">2 s</option><option value="5">5 s</option><option value="10" selected>10 s</option><option value="30">30 s</option><option value="60">60 s</option>
          </select>
          <button type="button" class="ghost" id="chPause" title="暂停曲线显示，不停止电机">暂停</button>
          <button type="button" class="ghost" id="chClear">清空</button>
        </div>
      </div>
      <div class="charts">
        <div class="chart"><div class="ct"><span>转速 rpm</span><span class="legend" id="lgRpm"></span></div><canvas id="chRpm"></canvas></div>
        <div class="chart"><div class="ct"><span>电流 A</span><span class="legend" id="lgIq"></span></div><canvas id="chIq"></canvas></div>
        <div class="chart"><div class="ct"><span>机械角 °</span><span class="legend" id="lgAng"></span></div><canvas id="chAng"></canvas></div>
        <div class="chart"><div class="ct"><span id="chPrimT">状态主反馈</span><span class="legend" id="lgPrim"></span></div><canvas id="chPrim"></canvas></div>
      </div>
    </section>

  <div class="debug-details">
    <details class="inst advanced live-instruments"><summary class="inst-h">CAN 仪表<span class="live" id="liveDot"></span></summary>
      <div class="gauge" style="--c:var(--accent)"><span class="gl">模式</span><span class="n" id="vMode">—</span></div>
      <div class="gauge" style="--c:var(--amber)"><span class="gl" id="vPrimL">主反馈</span><span class="n" id="vPrim">—</span></div>
      <div class="gauge" style="--c:#5cc8ff"><span class="gl">转速</span><span class="n" id="vRpm">—</span><span class="gu">rpm</span></div>
      <div class="gauge" style="--c:#c79bff"><span class="gl">机械角</span><span class="n" id="vAngle">—</span><span class="gu">°</span></div>
      <div class="gauge" style="--c:var(--ok)"><span class="gl">Iq</span><span class="n" id="vIq">—</span><span class="gu">A</span></div>
      <div class="gauge" style="--c:var(--danger)"><span class="gl">故障字节</span><span class="n" id="vFault">—</span></div>
    </details>
    <details class="inst advanced" data-testid="fault-details">
      <summary class="inst-h">故障详情</summary>
      <div class="inst-b">
        <div class="chips" id="faultChips"></div>
        <div class="chips" id="faultInfo" style="margin-top:6px"></div>
        <details class="advanced fault-details"><summary>快照</summary><div id="faultSnap"></div></details>
        <div class="btns" style="margin:8px 0 0">
          <button type="button" class="ghost" id="btnFaultClear">清除故障</button>
          <button type="button" class="ghost hidden" id="btnFaultRead">故障快照</button>
        </div>
        <div class="small mono" id="vRates" style="margin-top:8px;line-height:1.6">—</div>
      </div>
    </details>
    <details class="inst advanced" data-testid="record-details">
      <summary class="inst-h">数据记录</summary>
      <div class="inst-b">
        <div class="btns" style="margin:0 0 6px">
          <button type="button" id="recBtn" title="记录 CSV">开始记录</button>
          <button type="button" class="ghost" id="recSave" disabled>下载</button>
        </div>
        <div class="small" id="recInfo">未记录</div>
      </div>
    </details>
  </div>
    </div></div>
    </div>
    <footer class="site"><a href="https://233688.xyz/">← Mathonix 门户</a> · <a href="https://webpcan.233688.xyz/">WebPCAN</a> · <a href="https://vofa.233688.xyz/">在线 VOFA</a></footer>
  </main>

</div>
<button type="button" id="estop" data-testid="emergency-stop" title="急停 (Esc)" aria-label="急停（Esc）">急停<small>Esc</small></button>
<div class="toast" id="msg" role="status" aria-live="polite"></div>
<script src="${appScriptSrc}" defer></script>
</body>
</html>`;
}
