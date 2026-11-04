const key = "corgi-pure-black";

export function pureBlack(): boolean {
  try {
    return window.localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}
export function applyAppearance(enabled: boolean) {
  document.documentElement.toggleAttribute("data-pure-black", enabled);
}
export function setPureBlack(enabled: boolean) {
  applyAppearance(enabled);
  try {
    window.localStorage.setItem(key, enabled ? "on" : "off");
  } catch {
    // The setting still applies when phone storage is unavailable.
  }
}
