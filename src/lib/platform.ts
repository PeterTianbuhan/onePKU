export function isMacOS(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function searchShortcut(): string {
  return isMacOS() ? "⌘ K" : "Ctrl K";
}

export function trashName(): string {
  return isMacOS() ? "废纸篓" : "回收站";
}
