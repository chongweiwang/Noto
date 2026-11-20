"use client";

import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./desktop-api";
import type { WorkspaceApi } from "./vault-api";

export interface WorkspaceRuntime {
  kind: "desktop" | "web";
  api: WorkspaceApi;
  nativeWindow?: {
    onCloseRequested: (handler: (event: { preventDefault: () => void }) => Promise<void>) => Promise<() => void>;
    destroy: () => Promise<void>;
  };
  logout?: () => Promise<void>;
  saveDrawingSvg?: (svg:string,suggestedName:string)=>Promise<string|null>;
  saveExportHtml?: (html:string, suggestedName:string) => Promise<string|null>;
  saveGraphic?: (bytes: Uint8Array, suggestedName: string, format: "png" | "pdf") => Promise<string | null>;
  saveVaultZip?: () => Promise<string | null>;
}
const native: WorkspaceRuntime = {
  kind: "desktop", api: desktop,
  saveDrawingSvg:(svg,suggestedName)=>invoke<string|null>("save_export_svg",{svg,suggestedName}),
  saveExportHtml: (html,suggestedName) => invoke<string|null>("save_export_html",{html,suggestedName}),
  saveGraphic: (bytes,suggestedName,format) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return invoke<string | null>("save_export_graphic", { data: btoa(binary), suggestedName, format });
  },
  saveVaultZip: () => invoke<string | null>("save_vault_zip"),
  nativeWindow: {
    onCloseRequested: (handler) => getCurrentWindow().onCloseRequested(handler),
    destroy: () => getCurrentWindow().destroy(),
  },
};
export const WorkspaceRuntimeContext = createContext<WorkspaceRuntime>(native);
export const useWorkspaceRuntime = () => useContext(WorkspaceRuntimeContext);
