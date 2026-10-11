import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, nextTheme } from "../src/theme";
import { BASE_CSS } from "../src/base-css";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; ++i) await Promise.resolve(); };

function fixture(theme = "dark") {
  const classes = new Set<string>();
  const root = {
    dataset: { theme },
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    animate: vi.fn(),
  };
  let click!: () => void;
  let pointerdown!: (event: { target: unknown; clientX: number; clientY: number }) => void;
  const attrs: Record<string, string> = {};
  const btn = {
    title: "",
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
    getBoundingClientRect: () => ({ left: 90, top: 30, right: 130, bottom: 70, width: 40, height: 40 }),
    addEventListener: (_type: string, cb: () => void) => { click = cb; },
  };
  const estop = {
    getBoundingClientRect: vi.fn(() => ({ left: 700, top: 500, right: 780, bottom: 560, width: 80, height: 60 })),
    click: vi.fn(),
  };
  const meta = { setAttribute: vi.fn() };
  const transitions: {
    ready: Promise<void>; finished: Promise<void>; skipTransition: ReturnType<typeof vi.fn>;
    update: () => void; readyDeferred: ReturnType<typeof deferred>; finishedDeferred: ReturnType<typeof deferred>;
  }[] = [];
  const startViewTransition = vi.fn((update: () => void) => {
    const readyDeferred = deferred(), finishedDeferred = deferred();
    const vt = {
      update, readyDeferred, finishedDeferred,
      ready: readyDeferred.promise, finished: finishedDeferred.promise,
      skipTransition: vi.fn(),
    };
    transitions.push(vt);
    return vt;
  });
  const doc = {
    documentElement: root, hidden: false,
    startViewTransition: startViewTransition as typeof startViewTransition | undefined,
    getElementById: (id: string) => id === "themeToggle" ? btn : id === "estop" ? estop : null,
    querySelector: () => meta,
    addEventListener: vi.fn((_type: string, cb: typeof pointerdown, _options: AddEventListenerOptions) => { pointerdown = cb; }),
  };
  const removeAllRanges = vi.fn();
  const win = {
    innerWidth: 800, innerHeight: 600,
    getSelection: () => ({ removeAllRanges }),
    matchMedia: vi.fn(() => ({ matches: false })),
  };
  const storage = { setItem: vi.fn() };
  const dirty = vi.fn();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", storage);
  initTheme(dirty);
  return { root, classes, btn, estop, attrs, meta, doc, win, storage, dirty, transitions, startViewTransition, removeAllRanges,
    click: () => click(),
    pointerdown: (target: unknown, clientX: number, clientY: number) => pointerdown({ target, clientX, clientY }),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("theme target and fallback", () => {
  it("inverts the pending theme before consulting the applied theme", () => {
    expect(nextTheme("dark", null)).toBe("light");
    expect(nextTheme("light", null)).toBe("dark");
    expect(nextTheme(undefined, null)).toBe("light");
    expect(nextTheme("dark", "light")).toBe("dark");
    expect(nextTheme("light", "dark")).toBe("light");
  });

  it("initializes the accessible button and meta color from the persisted light theme", () => {
    const f = fixture("light");
    expect(f.btn.title).toBe("切换到深色主题");
    expect(f.attrs).toEqual({ "aria-label": "切换到深色主题", "aria-pressed": "true" });
    expect(f.meta.setAttribute).toHaveBeenLastCalledWith("content", "#F3F5F7");
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "reduced motion", "hidden", "media query failure"])("switches instantly for %s", (reason) => {
    const f = fixture();
    if (reason === "unsupported") f.doc.startViewTransition = undefined;
    if (reason === "reduced motion") f.win.matchMedia.mockReturnValue({ matches: true });
    if (reason === "hidden") f.doc.hidden = true;
    if (reason === "media query failure") f.win.matchMedia.mockImplementation(() => { throw new Error("unsupported"); });
    f.click();
    expect(f.root.dataset.theme).toBe("light");
    expect(f.storage.setItem).toHaveBeenLastCalledWith("dr4310-theme", "light");
    expect(f.attrs).toEqual({ "aria-label": "切换到深色主题", "aria-pressed": "true" });
    expect(f.dirty).toHaveBeenCalledOnce();
    expect(f.startViewTransition).not.toHaveBeenCalled();
    expect(f.root.animate).not.toHaveBeenCalled();
    expect(f.classes.size).toBe(0);
  });

  it("falls back when startViewTransition throws and invalidates a retained update", () => {
    const f = fixture();
    let staleUpdate!: () => void;
    f.startViewTransition.mockImplementationOnce((update) => { staleUpdate = update; throw new Error("start failed"); });
    f.click();
    expect(f.root.dataset.theme).toBe("light");
    expect(f.classes.size).toBe(0);
    f.doc.startViewTransition = undefined;
    f.click(); staleUpdate();
    expect(f.root.dataset.theme).toBe("dark");
    expect(f.dirty).toHaveBeenCalledTimes(2);
  });
});

describe("circular theme reveal lifecycle", () => {
  it.each(["dark", "light"])("reveals the new theme from the button in %s mode", async (theme) => {
    const f = fixture(theme);
    f.click();
    const vt = f.transitions[0]!;
    expect(f.removeAllRanges).toHaveBeenCalledOnce();
    expect(f.classes.has("theme-switching")).toBe(true);
    expect(f.root.dataset.theme).toBe(theme);
    expect(f.root.animate).not.toHaveBeenCalled();
    vt.update();
    expect(f.root.dataset.theme).toBe(theme === "dark" ? "light" : "dark");
    expect(f.meta.setAttribute).toHaveBeenLastCalledWith("content", theme === "dark" ? "#F3F5F7" : "#0B1118");
    expect(f.dirty).toHaveBeenCalledOnce();
    vt.readyDeferred.resolve(); await flush();
    expect(f.root.animate).toHaveBeenCalledWith({
      clipPath: ["circle(0px at 110px 50px)", `circle(${Math.hypot(690, 550)}px at 110px 50px)`],
    }, { duration: 600, easing: "cubic-bezier(.65,0,.35,1)", pseudoElement: "::view-transition-new(root)" });
    vt.finishedDeferred.resolve(); await flush();
    expect(f.classes.size).toBe(0);
    f.click();
    expect(f.startViewTransition).toHaveBeenCalledTimes(2);
  });

  it.each(["ready rejection", "animation throw", "finished rejection"])("cleans up on %s without leaking rejection", async (failure) => {
    const f = fixture(); f.click();
    const vt = f.transitions[0]!; vt.update();
    if (failure === "animation throw") f.root.animate.mockImplementation(() => { throw new Error("animation failed"); });
    if (failure === "ready rejection") vt.readyDeferred.reject(new Error("skipped"));
    else vt.readyDeferred.resolve();
    if (failure === "finished rejection") vt.finishedDeferred.reject(new Error("finished failed"));
    else vt.finishedDeferred.resolve();
    await flush();
    expect(f.classes.size).toBe(0);
    expect(f.root.dataset.theme).toBe("light");
    f.click(); expect(f.startViewTransition).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("skips a quick second click, even when update has run: %s", async (updated) => {
    const f = fixture(); f.click();
    const old = f.transitions[0]!;
    if (updated) old.update();
    f.click();
    expect(old.skipTransition).toHaveBeenCalledOnce();
    expect(f.root.dataset.theme).toBe("dark");
    expect(f.attrs["aria-pressed"]).toBe("false");
    expect(f.btn.title).toBe("切换到浅色主题");
    expect(f.classes.size).toBe(0);
    expect(f.startViewTransition).toHaveBeenCalledOnce();
    old.update(); old.readyDeferred.resolve(); await flush();
    expect(f.root.dataset.theme).toBe("dark");
    expect(f.root.animate).not.toHaveBeenCalled();

    // A third click starts a fresh transition; the old completion must not clear it.
    f.click();
    old.finishedDeferred.reject(new Error("skipped")); await flush();
    expect(f.classes.has("theme-switching")).toBe(true);
    f.transitions[1]!.update();
    expect(f.root.dataset.theme).toBe("light");
    f.click();
    expect(f.transitions[1]!.skipTransition).toHaveBeenCalledOnce();
    expect(f.root.dataset.theme).toBe("dark");
  });
});

describe("E-stop during theme transitions", () => {
  it.each([false, true])("skips and clicks E-stop by coordinates when the target is html (update ran: %s)", async (updated) => {
    const f = fixture();
    expect(f.doc.addEventListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), { capture: true, passive: true });
    f.click();
    const vt = f.transitions[0]!;
    if (updated) vt.update();
    f.pointerdown(f.root, 740, 530);
    expect(vt.skipTransition).toHaveBeenCalledOnce();
    expect(f.estop.click).toHaveBeenCalledOnce();
    expect(vt.skipTransition.mock.invocationCallOrder[0]).toBeLessThan(f.estop.click.mock.invocationCallOrder[0]!);
    expect(f.classes.size).toBe(0);
    vt.update(); vt.readyDeferred.resolve(); vt.finishedDeferred.resolve(); await flush();
    expect(f.root.dataset.theme).toBe(updated ? "light" : "dark");
    expect(f.root.animate).not.toHaveBeenCalled();
    f.click(); expect(f.startViewTransition).toHaveBeenCalledTimes(2);
  });

  it.each([[696, 496], [784, 564]])("allows 4px E-stop hit tolerance at (%s, %s)", (x, y) => {
    const f = fixture(); f.click();
    f.pointerdown(f.root, x, y);
    expect(f.transitions[0]!.skipTransition).toHaveBeenCalledOnce();
    expect(f.estop.click).toHaveBeenCalledOnce();
  });

  it.each([[400, 300], [695, 530], [785, 530], [740, 495], [740, 565]])("only skips for coordinates outside both buttons (%s, %s)", async (x, y) => {
    const f = fixture(); f.click();
    const vt = f.transitions[0]!;
    f.pointerdown(f.root, x, y);
    expect(vt.skipTransition).toHaveBeenCalledOnce();
    expect(f.classes.size).toBe(0);
    expect(f.estop.click).not.toHaveBeenCalled();
    expect(f.dirty).not.toHaveBeenCalled();
    vt.update(); vt.readyDeferred.resolve(); vt.finishedDeferred.resolve(); await flush();
    expect(f.root.dataset.theme).toBe("dark");
    expect(f.root.animate).not.toHaveBeenCalled();
  });

  it("leaves pointer events alone when there is no active transition", () => {
    const f = fixture();
    f.pointerdown(f.root, 740, 530);
    f.pointerdown(f.root, 110, 50);
    expect(f.estop.getBoundingClientRect).not.toHaveBeenCalled();
    expect(f.estop.click).not.toHaveBeenCalled();
    expect(f.root.dataset.theme).toBe("dark");
    expect(f.dirty).not.toHaveBeenCalled();
  });

  it("swallows skip failures and still clicks E-stop", () => {
    const f = fixture(); f.click();
    const vt = f.transitions[0]!;
    vt.skipTransition.mockImplementation(() => { throw new Error("skip failed"); });
    expect(() => f.pointerdown(f.root, 740, 530)).not.toThrow();
    expect(vt.skipTransition).toHaveBeenCalledOnce();
    expect(f.estop.click).toHaveBeenCalledOnce();
    expect(f.classes.size).toBe(0);
    f.click(); expect(f.startViewTransition).toHaveBeenCalledTimes(2);
  });

  it("retries coordinate-hit E-stop after an exception following skip", () => {
    const f = fixture(); f.click();
    f.estop.getBoundingClientRect.mockImplementationOnce(() => { throw new Error("layout failed"); });
    expect(() => f.pointerdown(f.root, 740, 530)).not.toThrow();
    expect(f.transitions[0]!.skipTransition).toHaveBeenCalledOnce();
    expect(f.classes.size).toBe(0);
    expect(f.estop.getBoundingClientRect).toHaveBeenCalledTimes(2);
    expect(f.estop.click).toHaveBeenCalledOnce();
  });

  it("retries E-stop if its click throws, without suppressing another dispatch", () => {
    const f = fixture(); f.click();
    f.estop.click.mockImplementationOnce(() => { throw new Error("click failed"); });
    expect(() => f.pointerdown(f.root, 740, 530)).not.toThrow();
    expect(f.estop.click).toHaveBeenCalledTimes(2);
    f.estop.click(); // A later native click must remain available to the existing handler.
    expect(f.estop.click).toHaveBeenCalledTimes(3);
  });

  it("keeps cancellation available when storage or chart redraw fails", () => {
    const f = fixture();
    f.storage.setItem.mockImplementation(() => { throw new Error("storage blocked"); });
    f.dirty.mockImplementation(() => { throw new Error("chart failed"); });
    f.click(); const vt = f.transitions[0]!;
    expect(() => vt.update()).not.toThrow();
    expect(() => f.pointerdown(f.root, 740, 530)).not.toThrow();
    expect(vt.skipTransition).toHaveBeenCalledOnce();
    expect(f.estop.click).toHaveBeenCalledOnce();
    expect(f.root.dataset.theme).toBe("light");
  });

  it("makes the browser snapshot overlay transparent to pointer events", () => {
    expect(BASE_CSS).toMatch(/::view-transition\s*\{\s*pointer-events:\s*none;\s*\}/);
  });
});

describe("theme button coordinates during transitions", () => {
  it.each([
    ["dark", false], ["dark", true], ["light", false], ["light", true],
  ] as const)("switches instantly from %s using pending (update ran: %s), ignoring only the next click", async (theme, updated) => {
    const f = fixture(theme); f.click();
    const vt = f.transitions[0]!;
    if (updated) vt.update();
    const previousCalls = f.dirty.mock.calls.length;
    f.pointerdown(f.root, 110, 50);
    expect(vt.skipTransition).toHaveBeenCalledOnce();
    expect(f.classes.size).toBe(0);
    expect(f.root.dataset.theme).toBe(theme);
    expect(f.storage.setItem).toHaveBeenLastCalledWith("dr4310-theme", theme);
    expect(f.dirty).toHaveBeenCalledTimes(previousCalls + 1);
    expect(f.estop.click).not.toHaveBeenCalled();
    expect(f.startViewTransition).toHaveBeenCalledOnce();
    f.click(); // Some browsers may deliver the native click to the button after skip.
    expect(f.root.dataset.theme).toBe(theme);
    expect(f.dirty).toHaveBeenCalledTimes(previousCalls + 1);
    expect(f.startViewTransition).toHaveBeenCalledOnce();
    vt.update(); vt.readyDeferred.resolve(); vt.finishedDeferred.resolve(); await flush();
    expect(f.root.dataset.theme).toBe(theme);
    expect(f.root.animate).not.toHaveBeenCalled();
    f.click();
    expect(f.startViewTransition).toHaveBeenCalledTimes(2);
  });

  it("expires click suppression after 400ms if no native button click arrives", () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const f = fixture(); f.click();
    f.pointerdown(f.root, 110, 50);
    vi.advanceTimersByTime(401);
    f.click();
    expect(f.startViewTransition).toHaveBeenCalledTimes(2);
    f.transitions[1]!.update();
    expect(f.root.dataset.theme).toBe("light");
  });
});
