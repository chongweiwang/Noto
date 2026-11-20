// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { liveMarkdownPlugin, notePathFacet } from "./index";

const image = vi.hoisted(() => vi.fn());
vi.mock("../../lib/desktop-api", () => ({ desktop: { image } }));

it("实时编辑按当前笔记解析并渲染本地图片", async () => {
  image.mockResolvedValue("data:image/png;base64,AA==");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({ parent: host, state: EditorState.create({
    doc: "光标在这里\n![图](../附件/图片%20%281%29.png)",
    extensions: [notePathFacet.of("项目/笔记.md"), liveMarkdownPlugin],
  }) });
  try {
    await waitFor(() => expect(host.querySelector("img.md-inline-img")?.getAttribute("src")).toBe("data:image/png;base64,AA=="));
    expect(image).toHaveBeenCalledWith("项目/笔记.md", "../附件/图片 (1).png");
  } finally { view.destroy(); host.remove(); }
});
