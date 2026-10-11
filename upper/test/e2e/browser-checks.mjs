// Runs in an actual browser on scripts/preview.mjs /checks?fw=v2|v3|legacy|can.
// Checks use the app's real DOM, bundled client, frame codecs and fake device streams.
const $ = id => document.getElementById(id);
const testId = id => document.querySelector(`[data-testid="${id}"]`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, ms = 5000) => { const t = performance.now(); while (!fn()) { if (performance.now() - t > ms) throw new Error("等待超时"); await sleep(20); } };
const rows = [];
const check = (name, ok) => { rows.push({ name, ok: !!ok }); if (!ok) console.error("FAIL", name); };
const set = (id, value) => { $(id).value = String(value); $(id).dispatchEvent(new Event("change", { bubbles: true })); };
const clickMode = mode => document.querySelector(`[data-dmode="${mode}"]`).click();
const writes = () => window.__writes.map(x => x.trim());
const motion = () => writes().filter(x => /^(SPD|CUR|POS|MIT|IQ|RUN)\b/.test(x));
const can = () => window.__tx.map(u => ({ id: (u[3] | u[4] << 8) >> 5, data: u.slice(5, 13) }));
const target = x => { set("dTarget", x); $("dApply").click(); };
const connect = route => { set("dLink", route); testId("connection-toggle").click(); };
const stop = async () => { if ($("dStart").textContent === "停止") $("dStart").click(); await wait(() => $("dStart").textContent === "启动"); await sleep(80); };
try {
  check("默认折叠高级控制与电气曲线", !$("dAdvanced").open && !document.querySelector(".telemetry-extra").open);
  if (window.__testMode === "can") {
    connect("can"); await wait(() => $("pcanDisconnect").disabled === false); await wait(() => document.querySelector('[data-node="3"]'), 3000).catch(() => {}); await sleep(100);
    check("连接与被动发现不发送运动命令", can().length === 0 && document.querySelector('[data-node="3"]'));
    check("仪表盘无运行时自动使能开关", !testId("auto-enable"));
    const aeBefore = can().length; testId("emergency-stop").click(); await sleep(120);
    const aeTail = can().slice(aeBefore);
    check("急停先 08 00 再 03 ×2", aeTail[0]?.data[0] === 8 && aeTail[0]?.data[1] === 0 && aeTail.filter(f => f.data[0] === 3).length === 2);
    set("dTarget", 8); $("dStart").click(); await sleep(500);
    check("直接启动提交输入并发速度帧", can().some(f => f.id === 0x401) && $("dStart").textContent === "停止");
    set("motorId", 3); await sleep(200);
    const frames = can();
    check("换节点先停止旧节点", frames.some(f => f.id === 0x101 && f.data[0] === 8 && f.data[1] === 0) && frames.some(f => f.id === 0x101 && f.data.every(x => x === 0)) && !frames.some(f => f.id === 0x403));
    check("换节点取消仪表盘会话", $("dStart").textContent === "启动" && $("motorId").value === "3");
    await sleep(200); target(5); $("dStart").click(); await sleep(450);
    window.__canNodes.find(n => n.id === 3).faults = 0x42;
    await wait(() => $("dStart").textContent === "启动");
    check("CAN 故障立即停机", can().some(f => f.id === 0x103 && f.data.every(x => x === 0)));
    window.__canNodes.find(n => n.id === 3).faults = 0; await sleep(300);
    $("dStart").click(); await sleep(200); window.__canReceive = false;
    await wait(() => $("dStart").textContent === "启动", 3500);
    check("反馈中断自动停机", /反馈中断/.test($("msg").textContent));
    window.__canReceive = true; await sleep(300);
    // Same-ID check: CAN 3 must not consume serial node 2's position.
    testId("connect-serial").click(); await wait(() => /v3/.test($("stFw").textContent)); await sleep(250);
    clickMode("pos"); window.__confirmAccept = false; const before = window.__confirmations.length; $("dStart").click(); await sleep(100);
    check("其他节点的串口位置不能用于 CAN 对齐", window.__confirmations.length === before + 1 && $("dStart").textContent === "启动");
    window.__confirmAccept = true;
    // Delayed MIT enter: stop during first packet, no packed target may follow E-stop.
    clickMode("mit"); window.__canDelay = 150; const txBefore = can().length; $("dStart").click(); await sleep(30); $("estop").click(); await sleep(850);
    const tail = can().slice(txBefore);
    check("MIT 启动中急停取消后续打包帧", tail.some(f => f.data[0] === 3) && !tail.some(f => ![0, 3, 6, 8].includes(f.data[0])) && $("dStart").textContent === "启动");
    window.__canDelay = 0;
  } else {
    connect("serial"); await wait(() => /v[23]|旧固件/.test($("stFw").textContent), 8000); await sleep(250);
    check("探测期间不发送运动命令", motion().length === 0);
    if (window.__testMode !== "legacy") {
      const w = writes(); check("PING → INFO → HELP → GET 探测顺序", w.indexOf("PING") < w.indexOf("INFO") && w.indexOf("INFO") < w.indexOf("HELP") && w.indexOf("HELP") < w.indexOf("GET"));
      window.__dev.ae = 1; window.__dev.mode = 2; // firmware booted with BOOT_AE=1
      await wait(() => testId("ae-indicator").dataset.ae === "1");
      check("INFO ae=1 只读指示", testId("ae-indicator").classList.contains("on") && !writes().includes("AE 1"));
      const aeBefore = writes().length; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await sleep(150);
      const aeTail = writes().slice(aeBefore).filter(w => /^(AE|STOP)/.test(w));
      check("Esc 先 AE 0 再 STOP", aeTail[0] === "AE 0" && aeTail[1] === "STOP" && window.__dev.ae === 0);
      check("固件参数读取完成", $("pd_SPD_KP")?.textContent === "0.25");
      check("v2/v3 能力探测", window.__testMode === "v3" ? w.includes("TLIST") && w.includes("TCH") && w.includes("FAULT") : !w.some(x => /^(TLIST|TCH|FAULT|SETZERO)/.test(x)));
      set("dTarget", 8); $("dStart").click(); await sleep(650);
      check("直接启动提交输入", motion().some(x => /^SPD 8$/.test(x)));
      $("dAdvanced").open = true; set("wAmp", 10000); set("wOff", 10000); set("wFreq", 99); $("wStart").click(); await sleep(100);
      check("波形幅值偏置频率限幅", Number($("wAmp").value) + Math.abs(Number($("wOff").value)) <= 200 && Number($("wFreq").value) <= 5);
      set("wAmp", 2); set("wOff", 0); set("wFreq", 1); $("wStart").click(); await sleep(150);
      check("波形可以运行", /停止波形/.test($("wStart").textContent));
      set("dRangeSel", 50); await sleep(100);
      check("缩小量程自动停止波形", /启动波形/.test($("wStart").textContent));
      const hideBefore = writes().length;
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); await sleep(100);
      check("隐藏页面停止会话并发送 STOP", writes().slice(hideBefore).includes("STOP") && $("dStart").textContent === "启动");
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      $("dStart").click(); await sleep(200); const faultBefore = writes().length; window.__injectSerial("@FAULT code=0x0040 latched=0x0040 names=BusUndervoltage"); await sleep(100);
      check("主动 @FAULT 自动停止", $("dStart").textContent === "启动" && writes().slice(faultBefore).includes("STOP"));
      if (window.__testMode === "v3") {
        // real v3 default telemetry has no PosRad: stream it first so the host knows the position
        await stop(); document.querySelectorAll("#telList input").forEach(e => { e.checked = ["3", "21", "22"].includes(e.value); }); $("telApply").click();
        await wait(() => /PosRad/.test($("telState").textContent), 3000).catch(() => {});
        clickMode("pos"); await sleep(250); const hold = window.__dev.pos, n = motion().length; $("dStart").click(); await sleep(150);
        const pos = motion().slice(n).find(x => x.startsWith("POS "));
        check("位置启动对齐当前实测", pos && Math.abs(Number(pos.split(" ")[1]) - hold) < .05);
        await stop(); clickMode("mit"); $("dStart").click(); await sleep(160); const m = motion().filter(x => x.startsWith("MIT ")).length;
        set("dMitKp", 6); await sleep(150);
        check("MIT 辅助参数变化会发送", motion().filter(x => x.startsWith("MIT ")).length > m);
        await stop();
      }
      clickMode("spd"); $("dStart").click(); await sleep(150); window.__dev.alive = false;
      await wait(() => $("dStart").textContent === "启动", 4500);
      check("串口反馈消失停止", writes().at(-1) === "STOP" || writes().slice(-3).includes("STOP")); window.__dev.alive = true;
    } else {
      $("dStart").click(); check("旧固件拒绝速度模式", /只支持电流/.test($("msg").textContent));
      clickMode("cur"); set("dTarget", .1); $("dStart").click(); await sleep(450);
      check("旧固件 RUN → IQ 兼容", motion().includes("RUN") && motion().includes("IQ 0.1"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await sleep(100);
      check("Esc 急停发 STOP", writes().includes("STOP") && $("dStart").textContent === "启动");
    }
  }
  $("themeToggle").click(); await sleep(100); check("主题切换", ["dark", "light"].includes(document.documentElement.dataset.theme));
  check("无浏览器运行异常", window.__errors.length === 0);
} catch (e) { check(String(e), false); }
const report = document.createElement("pre"); report.id = "check-results"; report.style.cssText = "white-space:pre-wrap;padding:24px;background:#11171f;color:#e4ebf2;font-size:15px;border:1px solid #19c6b1;margin:20px;";
report.textContent = `${window.__testMode}: ${rows.filter(x => x.ok).length}/${rows.length} PASS\n` + rows.map(x => `${x.ok ? "PASS" : "FAIL"} ${x.name}`).join("\n") + "\n" + window.__errors.join("\n");
document.body.prepend(report); window.__checkResults = rows; document.title = `${rows.every(x => x.ok) ? "PASS" : "FAIL"} DR4310 ${window.__testMode}`;
