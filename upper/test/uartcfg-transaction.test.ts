import { describe, expect, it } from "vitest";
import { createTelemetryTransactions } from "../src/uartcfg-transaction";

function fake(original: number | null = 1, fail?: (line: string, count: number) => boolean) {
  const commands: string[] = [];
  let telem = original;
  const run = async (line: string) => {
    commands.push(line.trim());
    const ok = !fail?.(line.trim(), commands.length);
    if (ok && line.startsWith("SET TELEM")) telem = Number(line.trim().split(" ")[2]);
    return { ok, err: ok ? undefined : "串口无应答" };
  };
  const transaction = createTelemetryTransactions({ current: () => telem, run, restored: (v) => { telem = v; } });
  return { commands, run, transaction, telem: () => telem };
}

describe("parameter transactions with telemetry paused", () => {
  it("restores the original TELEM before SAVE, including nested single/multiple writes", async () => {
    const f = fake();
    await f.transaction(async (scope) => {
      await f.transaction(async () => {
        await f.run("SET BOOT_AE 1\n");
        await f.run("SET CUR_KP 12\n");
      }, scope);
      await f.transaction(async (nested) => {
        await nested.restore();
        await f.run("SAVE\n");
      }, scope);
    });
    expect(f.commands).toEqual(["SET TELEM 0", "SET BOOT_AE 1", "SET CUR_KP 12", "SET TELEM 1", "SAVE"]);
    expect(f.telem()).toBe(1);
  });
  it.each(["GET\n", "GET ZERO_OFFSET\n"])("pauses and restores around %s", async (command) => {
    const f = fake();
    await f.transaction(() => f.run(command));
    expect(f.commands).toEqual(["SET TELEM 0", command.trim(), "SET TELEM 1"]);
  });
  it("single RAM writes restore telemetry without saving unrelated inputs", async () => {
    const f = fake();
    await f.transaction(() => f.run("SET CUR_KP 13\n"));
    expect(f.commands).toEqual(["SET TELEM 0", "SET CUR_KP 13", "SET TELEM 1"]);
  });
  it("leaves an originally disabled stream disabled", async () => {
    const f = fake(0);
    await f.transaction(async (scope) => { await f.run("SET CUR_KP 12\n"); await scope.restore(); await f.run("SAVE\n"); });
    expect(f.commands).toEqual(["SET CUR_KP 12", "SAVE"]);
    expect(f.telem()).toBe(0);
  });
  it("does not invent a TELEM value when both INFO and the table lack one", async () => {
    const f = fake(null);
    await f.transaction(() => f.run("GET\n"));
    expect(f.commands).toEqual(["GET"]);
  });
  it("restores in finally when GET throws", async () => {
    const f = fake();
    await expect(f.transaction(async () => { await f.run("GET\n"); throw new Error("读取失败"); })).rejects.toThrow("读取失败");
    expect(f.commands).toEqual(["SET TELEM 0", "GET", "SET TELEM 1"]);
  });
  it("restores after a failed write response", async () => {
    const f = fake(1, (line) => line.startsWith("SET CUR_KP"));
    await f.transaction(async () => { expect((await f.run("SET CUR_KP 12\n")).ok).toBe(false); });
    expect(f.commands).toEqual(["SET TELEM 0", "SET CUR_KP 12", "SET TELEM 1"]);
  });
  it("attempts restoration even when the pause acknowledgement is lost", async () => {
    const f = fake(1, (line) => line === "SET TELEM 0");
    await expect(f.transaction(() => f.run("GET\n"))).rejects.toThrow();
    expect(f.commands).toEqual(["SET TELEM 0", "SET TELEM 1"]);
  });
  it("never saves if restoration fails; finally retries restoration", async () => {
    const f = fake(1, (line, count) => line === "SET TELEM 1" && count === 3);
    await expect(f.transaction(async (scope) => {
      await f.run("SET CUR_KP 12\n"); await scope.restore(); await f.run("SAVE\n");
    })).rejects.toThrow();
    expect(f.commands).toEqual(["SET TELEM 0", "SET CUR_KP 12", "SET TELEM 1", "SET TELEM 1"]);
    expect(f.telem()).toBe(1);
  });
  it("serializes independent operations so one cannot resume another's stream", async () => {
    const f = fake();
    await Promise.all([f.transaction(() => f.run("GET\n")), f.transaction(() => f.run("SET CUR_KP 12\n"))]);
    expect(f.commands).toEqual(["SET TELEM 0", "GET", "SET TELEM 1", "SET TELEM 0", "SET CUR_KP 12", "SET TELEM 1"]);
  });
  it("keeps an explicit TELEM parameter edit rather than reverting the user's setting", async () => {
    const f = fake();
    await f.transaction(async (scope) => {
      await f.run("SET TELEM 0\n"); scope.setRestoreValue(0);
      await scope.restore(); await f.run("SAVE\n");
    });
    expect(f.commands.at(-2)).toBe("SET TELEM 0");
    expect(f.telem()).toBe(0);
  });
  it("does not restore an old connection's TELEM onto a reconnected device", async () => {
    const commands: string[] = [];
    let generation = 1;
    const transaction = createTelemetryTransactions({
      current: () => 1,
      captureSession: () => { const captured = generation; return () => captured === generation; },
      run: async (line) => { commands.push(line.trim()); return { ok: true }; },
      restored() {},
    });
    await expect(transaction(async () => { commands.push("GET"); generation++; })).rejects.toThrow("连接已变更");
    expect(commands).toEqual(["SET TELEM 0", "GET"]);
  });

});
