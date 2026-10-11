import { writeStored } from "./storage";

type Theme = "dark" | "light";
type ThemeTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition(): void;
};

export function nextTheme(current: string | undefined, pending: Theme | null): Theme {
  return (pending ?? current) === "light" ? "dark" : "light";
}

/** Theme failures must never interrupt control initialization or E-stop events. */
export function initTheme(markChartsDirty: () => void): void {
  try {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    const root = document.documentElement;
    const doc = document as Document & { startViewTransition?: (update: () => void) => ThemeTransition };
    let active: ThemeTransition | null = null;
    let pending: Theme | null = null;
    let gen = 0;
    let ignoreNextThemeClickUntil = 0;

    const sync = (theme: Theme): void => {
      try {
        root.dataset.theme = theme;
        const label = theme === "light" ? "切换到深色主题" : "切换到浅色主题";
        btn.title = label;
        btn.setAttribute("aria-label", label);
        btn.setAttribute("aria-pressed", String(theme === "light"));
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#F3F5F7" : "#0B1118");
      } catch { /* optional theme UI */ }
    };
    const apply = (theme: Theme): void => {
      sync(theme);
      writeStored("dr4310-theme", theme);
      try { markChartsDirty(); } catch { /* optional chart redraw */ }
    };
    const clear = (): void => {
      active = null;
      pending = null;
      try { root.classList.remove("theme-switching"); } catch { /* optional theme UI */ }
    };
    const skip = (): void => {
      const previous = active;
      ++gen; // Invalidate even an update callback that has not run yet.
      clear();
      try { previous?.skipTransition(); } catch { /* E-stop must still receive its event */ }
    };
    const canAnimate = (): boolean => {
      try {
        return typeof doc.startViewTransition === "function" && !doc.hidden
          && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch { return false; }
    };

    const containsPoint = (element: HTMLElement | null, event: PointerEvent): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return event.clientX >= rect.left - 4 && event.clientX <= rect.right + 4
        && event.clientY >= rect.top - 4 && event.clientY <= rect.bottom + 4;
    };

    sync(root.dataset.theme === "light" ? "light" : "dark");
    document.addEventListener("pointerdown", (event) => {
      try {
        if (!active) return;
        const previousPending = pending;
        skip();
        // View-transition overlays can retarget every pointer event to <html>.
        const estop = document.getElementById("estop");
        if (containsPoint(estop, event)) {
          estop!.click();
        } else if (containsPoint(btn, event)) {
          ignoreNextThemeClickUntil = Date.now() + 400;
          apply(nextTheme(root.dataset.theme, previousPending));
        }
      } catch {
        // Theme or cancellation failures must still allow a coordinate-hit E-stop.
        try {
          const estop = document.getElementById("estop");
          if (containsPoint(estop, event)) estop!.click();
        } catch { /* Never interrupt other safety event handlers. */ }
      }
    }, { capture: true, passive: true });

    btn.addEventListener("click", () => {
      const ignoreClick = Date.now() < ignoreNextThemeClickUntil;
      ignoreNextThemeClickUntil = 0;
      if (ignoreClick) return;
      const next = nextTheme(root.dataset.theme, pending);
      if (active) {
        skip();
        apply(next);
        return;
      }
      if (!canAnimate()) {
        apply(next);
        return;
      }
      const thisGen = ++gen;
      pending = next;
      try {
        window.getSelection()?.removeAllRanges();
        const rect = btn.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        root.classList.add("theme-switching");
        const vt = doc.startViewTransition!(() => {
          if (gen === thisGen) apply(next);
        });
        active = vt;
        void vt.ready.then(() => {
          if (gen !== thisGen || active !== vt) return;
          root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, {
            duration: 600,
            easing: "cubic-bezier(.65,0,.35,1)",
            pseudoElement: "::view-transition-new(root)",
          });
        }).catch(() => {
          if (gen !== thisGen || active !== vt) return;
          skip();
          if (root.dataset.theme !== next) apply(next);
        });
        void vt.finished.catch(() => {}).then(() => {
          if (gen === thisGen && active === vt) clear();
        });
      } catch {
        skip();
        apply(next);
      }
    });
  } catch { /* Keep the rest of client initialization and safety controls running. */ }
}
