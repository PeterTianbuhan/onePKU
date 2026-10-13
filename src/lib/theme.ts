/** 外观模式：跟随系统、固定浅色或固定深色。 */
export type ThemeMode = "system" | "light" | "dark";
type Scheme = "light" | "dark";

const KEY = "onepku.theme.v1";
const darkQuery = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined;

export function savedTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    return "system";
  }
}

export function resolvedTheme(mode: ThemeMode): Scheme {
  if (mode !== "system") return mode;
  return darkQuery()?.matches ? "dark" : "light";
}

/** 主题写到 html 上供 CSS 取用，原生窗口标题栏与滚动条跟着一起变。 */
export function applyTheme(mode: ThemeMode) {
  const scheme = resolvedTheme(mode);
  document.documentElement.dataset.theme = scheme;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window)
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_window_theme", { theme: scheme }))
      .catch(() => {
        /* 窗口主题同步失败不影响页面配色。 */
      });
}

let watching: () => void = () => {};

/** 应用主题并记住它；「跟随系统」时还要监听系统切换。 */
export function chooseTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* 记不住只影响下次启动的默认值。 */
  }
  watching();
  applyTheme(mode);
  const list = mode === "system" ? darkQuery() : undefined;
  if (!list?.addEventListener) {
    watching = () => {};
    return;
  }
  const onChange = () => applyTheme("system");
  list.addEventListener("change", onChange);
  watching = () => list.removeEventListener("change", onChange);
}
