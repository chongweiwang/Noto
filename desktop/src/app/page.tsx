"use client";

import { useEffect, useState } from "react";
import { runtime } from "../lib/note-api";
import DesktopApp from "../components/desktop-app";
import WebApp from "../components/web-app";

export default function Home() {
  const [platform, setPlatform] = useState<"desktop" | "web" | null>(null);
  useEffect(() => setPlatform(runtime()), []);
  if (!platform) return <main className="loading">正在启动本地知识库…</main>;
  return platform === "desktop" ? <DesktopApp /> : <WebApp />;
}
