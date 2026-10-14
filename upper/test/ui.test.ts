import { describe, expect, it } from "vitest";
import { page } from "../src/page";
import { chartColor } from "../src/chart";
const originalIds = "autoRe bootAe bootMode bootNote bootSec bootTarget bootUnit btnApplyId btnCfgInfo btnDefaults btnExport btnFaultClear btnFaultRead btnGetAll btnImport btnReboot btnReload btnRevertInputs btnSave btnSetZero btnSync btnWriteMod canIdHint canNodes cfgActiveId cfgBanner cfgBody_comm cfgBody_drive cfgBody_motor cfgBody_other cfgCalib cfgCalib2 cfgCfgId cfgFeat cfgHb cfgLast cfgPage_comm cfgPage_drive cfgPage_motor cfgPage_other cfgPage_store cfgPages cfgParamState cfgRun cfgSeq cfgSrc cfgTab_other cfgView chAng chClear chIq chPause chPrim chPrimT chRpm chUA chUB chWin dAdvanced dAe dApply dChart dChart2 dClear dCmdNow dConnect dDisp dFault dGainNote dGauge dGaugeMode dLink dMitKd dMitKp dMitRow dMitT dMitV dModes dPower dPowerSrc dRampChip dRangeSel dRoute dSrc dStart dStatus dStatusT dTarget dTgtNeg dTgtUnit dTgtZero dZero dotGm dotPcan dotSer estop faultChips faultInfo faultSnap gmA gmHex gmIds gmR gmRaw gmStart gmState gmStop gmZero hFwNote hKt hRampFw_cur hRampFw_mit hRampFw_pos hRampFw_spd hRamp_cur hRamp_mit hRamp_pos hRamp_spd hdrIds ilimSec iqMax lastCmd lgAng lgD1 lgD2 lgIq lgPrim lgRpm lgUA lgUB linkBox liveDot liveSlider logAuto logBody logClear logDelAll logHide1k logHideStatus logList logPause logRefresh logStat logWrap mKd mKp mP mPos mPosU mPosV mSpd mSpdU mSpdV mT mTrq mTrqU mTrqV mV mVbus mVbusU mVbusV mitEnter mitHex mitPeriod mitPeriodic mitSend mitWarn modeBtns motorId msg nIq nPos nSpd newCanId olCurrent olCurrentWrap olEnable olFields olHint olNote olStatus olTime olTimeWrap panel-gm panel-log panel-native panel-uart paramAll paramBody paramReset pcanConnect pcanDisconnect posFactory posHex posId posPeriod posPeriodic posQ poskd poski poskp profFile rIq rPos rSpd recBtn recInfo recSave sendIq sendPos sendSpd serBaud serConnect serDisconnect spdFactory spdHex spdId spdPeriod spdPeriodic spdQ spdkd spdki spdkp stFw stIds stPcanBus stPcanDev stSer stSerFrames stSerLines sumCan sumCanDot sumSer sumSerDot tabs telApply telList telNone telRate telRateRow telReload telSec telState themeToggle uCalib uCustom uCustomSend uIq uIqSend uKi uKiSend uKp uKpSend uVals uValsH vAngle vFault vIq vMode vPrim vPrimL vRates vRpm view-cfg view-dash view-debug views wAmp wFreq wInfo wKind wOff wStart wUnit wdConfirm wdHidden zeroSec".split(" ");
const originalTestIds = "advanced-controls ae-indicator boot-auto-enable boot-behavior boot-mode boot-target connect-can connect-serial connection-bar connection-details connection-route connection-toggle current-limit disconnect-can disconnect-serial emergency-stop fault-details fault-summary iq-max mode-current mode-mit mode-position mode-speed motor-id motor-toggle ol-current ol-enable ol-hint ol-status ol-time record-details response-details target-apply target-gauge target-input target-range view-cfg view-dash view-debug wave-toggle".split(" ");
const attrs = (html: string, name: string) => [...html.matchAll(new RegExp(' '+name+'="([^"]+)"', 'g'))].map(m => m[1]).sort();
describe("UI contracts", () => {
  it("uses a relative script for a Pages project while keeping the Worker default", () => {
    expect(page()).toContain('<script src="/app.js" defer></script>');
    expect(page("./app.js")).toContain('<script src="./app.js" defer></script>');
    expect(new URL("./app.js", "https://mathonix.github.io/DR4310/").pathname).toBe("/DR4310/app.js");
  });
  it("preserves every original static id/testid and their uniqueness", () => {
    const html = page();
    expect(attrs(html, "id")).toEqual(expect.arrayContaining(originalIds));
    expect(attrs(html, "data-testid")).toEqual(expect.arrayContaining(originalTestIds));
    expect(new Set(attrs(html, "id")).size).toBe(attrs(html, "id").length);
    expect(new Set(attrs(html, "data-testid")).size).toBe(attrs(html, "data-testid").length);
    expect(html).toContain('<option value="200000" selected>200000</option>');
  });
  it("uses a common connection/status area and puts phone controls before the dial", () => {
    const html = page();
    const header = html.slice(html.indexOf('<header class="cmdbar">'), html.indexOf('</header>'));
    expect(header.indexOf(' id="themeToggle"')).toBeLessThan(header.indexOf(' id="dLink"'));
    expect(header.indexOf(' id="dLink"')).toBeLessThan(header.indexOf(' id="dConnect"'));
    const connectionBar = html.slice(html.indexOf('<div class="connection-bar"'), html.indexOf('<div class="dbadges"'));
    expect(connectionBar).toContain(' id="dRoute"');
    expect(connectionBar).toContain(' id="motorId"');
    expect(connectionBar).not.toMatch(/ id="(?:dLink|dConnect)"/);
    const start = html.indexOf(' id="view-dash"');
    for (const id of ["dLink", "dConnect", "motorId", "dStatus", "dStatusT", "dFault", "dAe"]) expect(html.indexOf(' id="'+id+'"')).toBeLessThan(start);
    const dial = html.indexOf(' id="dGauge"');
    for (const id of ["dTarget", "dMitRow", "dStart"]) expect(html.indexOf(' id="'+id+'"')).toBeLessThan(dial);
    expect(html.indexOf(' id="tabs"')).toBeLessThan(html.indexOf(' id="chRpm"'));
    expect(html).not.toMatch(/减速比|传动比/);
  });
  it("resolves canvas series colors from the same CSS source as legends", () => {
    expect(chartColor("var(--series-1)", { getPropertyValue: () => " #92400E " })).toBe("#92400E");
    expect(chartColor("#123456", { getPropertyValue: () => "" })).toBe("#123456");
  });
});
