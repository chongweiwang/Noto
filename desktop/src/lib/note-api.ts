import { isTauri } from "@tauri-apps/api/core";

export function runtime(): "desktop" | "web" {
  return isTauri() ? "desktop" : "web";
}
