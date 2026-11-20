import { describe, expect, it } from "vitest";
import { buildTagIndex, matchingTagPaths, noteTags, parseTagFilters } from "./note-tags";
import { collectSearch } from "./note-search";

const fixture = (path: string, content: string) => ({ path, content, version: "1" });

describe("标签索引", () => {
  it("合并正文及 YAML 标签，区分真正标签、链接、代码和转义", () => {
    const note = fixture("笔记.md", [
      "---", "tags: [NAS/部署, Docker, '硬件 笔记']", "---", "# 标题",
      "#docker，#NAS/排障", "`#inline` [#链接](note.md#anchor)", "\\#escaped",
      "", "~~~~", "#fenced", "~~~~", "", "    #indented", "", "$#math$ [[引用 | #alias]]",
    ].join("\n"));
    expect(noteTags(note).map(tag => tag.key)).toEqual(["nas/部署", "docker", "硬件 笔记", "nas/排障"]);
  });

  it("父标签按笔记去重，全部或任意匹配与高级搜索一致", async () => {
    const notes = [
      fixture("A.md", "#NAS/部署 #NAS/排障 #Docker\n挂载权限"),
      fixture("B.md", "#NAS/排障\n挂载权限"),
      fixture("C.md", "#Docker\n示例"),
    ];
    const options = parseTagFilters("#NAS，Docker, docker");
    expect(options).toEqual(["nas", "docker"]);
    const index = buildTagIndex(notes);
    expect(index.byKey.get("nas")?.paths.size).toBe(2);
    expect([...matchingTagPaths(index, options, "all")]).toEqual(["A.md"]);
    expect([...matchingTagPaths(index, options, "any")].sort()).toEqual(["A.md", "B.md", "C.md"]);
    const paths = notes.map(note => note.path);
    const query = { tag: "#NAS，Docker" };
    expect((await collectSearch("权限", notes, paths, () => false, query))?.files.map(file => file.path)).toEqual(["A.md"]);
    expect((await collectSearch("权限", notes, paths, () => false, { ...query, tagMode: "any" }))?.files.map(file => file.path)).toEqual(["A.md", "B.md"]);
  });
});
