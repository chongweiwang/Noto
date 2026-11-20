// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {BacklinksPanel} from "./knowledge-sidebar";
import {MarkdownPreview} from "./markdown-preview";
import {headingIndex} from "../lib/heading-index";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
afterEach(cleanup);
it("诊断区分标题缺失、未读和同名，明确候选直传路径与原片段",()=>{
 const notes=[{path:"源.md",content:"[[目标#重复-1]]\n\n[[目标#缺失]]\n\n[[未读#标题]]\n\n[[同名#段落|别名]]",version:"v1"},{path:"目标.md",content:"# 重复\n\n# 重复",version:"v1"}];
 const open=vi.fn(),wiki=vi.fn(),paths=["源.md","目标.md","未读.md","甲/同名.md","乙/同名.md"];
 render(<BacklinksPanel snapshot={{notes,errors:[{path:"未读.md",error:"无法读取"}],loading:false}} target="源.md" paths={paths} onOpen={open} onClose={()=>{}} onWikiOpen={wiki}/>);
 fireEvent.click(screen.getByRole("button",{name:"出链"}));fireEvent.click(screen.getByRole("button",{name:/目标.md.*Wiki · #重复-1/}));
 expect(wiki).toHaveBeenCalledWith("目标#重复-1","源.md");
 fireEvent.click(screen.getByRole("button",{name:"链接问题"}));
 expect(screen.getByText("文件存在，标题不存在 · 第 3 行")).toBeTruthy();expect(screen.getByText("标题尚未验证 · 第 5 行")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"乙/同名.md"}));expect(wiki).toHaveBeenLastCalledWith("同名#段落","源.md","乙/同名.md");expect(open).not.toHaveBeenCalled();
});
it("正文标题样式不触发 I/O，阅读链接带自身来源；新确认内容刷新错误状态",()=>{
 const wiki=vi.fn(),load=vi.fn(),lookup=vi.fn(()=>undefined as ReturnType<typeof headingIndex>|undefined),services={lookup,load,feedback:vi.fn()};
 const props={note:"源.md",content:"[[目标#章节|链接]]",wikiPaths:["源.md","目标.md"],onError:vi.fn(),onWikiOpen:wiki,wikiServices:services};
 const {rerender}=render(<MarkdownPreview {...props}/>);const link=screen.getByRole("link",{name:"链接"});
 expect(link.classList.contains("wiki-unverified")).toBe(true);expect(link.title).toContain("标题尚未验证");expect(load).not.toHaveBeenCalled();
 lookup.mockReturnValue(headingIndex("# 其他"));rerender(<MarkdownPreview {...props} wikiServices={{...services}}/>);
 expect(link.title).toContain("文件存在，标题不存在");expect(link.classList.contains("wiki-unresolved")).toBe(true);
 lookup.mockReturnValue(headingIndex("# 章节"));rerender(<MarkdownPreview {...props} wikiServices={{...services}}/>);
 expect(link.classList.contains("wiki-unresolved")).toBe(false);fireEvent.click(link);expect(wiki).toHaveBeenCalledWith("目标#章节","源.md");
});
