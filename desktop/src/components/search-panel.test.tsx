// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {SearchPanel} from "./search-panel";
const note=(path:string,content:string)=>({path,content,version:"v1"});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("分组显示同一行多命中和长行摘要，路径结果不伪造正文范围",async()=>{
 const choose=vi.fn(),content="前".repeat(250)+"命中 命中"+ "后".repeat(200),snapshot={notes:[note("正文.md",content),note("命中.md","其他内容")],errors:[],loading:false};
 render(<SearchPanel snapshot={snapshot} onChoose={choose} onClose={()=>{}}/>);
 fireEvent.change(screen.getByRole("searchbox"),{target:{value:"命中"}});
 const group=await screen.findByRole("region",{name:"搜索结果：正文.md"}),matches=group.querySelectorAll<HTMLButtonElement>(".search-match");
 expect(matches).toHaveLength(2);expect(group.querySelector("mark")?.textContent).toBe("命中");expect(matches[0].textContent).not.toContain("前".repeat(200));
 fireEvent.click(matches[1]);expect(choose.mock.calls[0][0].hit.from).toBe(content.lastIndexOf("命中"));
 fireEvent.click(screen.getByRole("button",{name:"命中.md，文件名匹配"}));expect(choose.mock.calls[1][0].hit).toBeUndefined();
});
it("输入法组字中不计算/选择，结束后运行；快速改词只保留新查询",async()=>{
 const choose=vi.fn(),context=vi.fn();render(<SearchPanel snapshot={{notes:[note("a.md","旧查询 新查询")],errors:[],loading:false}} onChoose={choose} onContext={context} onClose={()=>{}}/>);
 const input=screen.getByRole("searchbox");fireEvent.compositionStart(input);fireEvent.change(input,{target:{value:"旧查询"}});fireEvent.keyDown(input,{key:"Enter",isComposing:true});
 expect(screen.queryByRole("region",{name:"搜索结果：a.md"})).toBeNull();expect(choose).not.toHaveBeenCalled();expect(context).toHaveBeenLastCalledWith(null);
 fireEvent.compositionEnd(input);fireEvent.change(input,{target:{value:"新查询"}});
 const group=await screen.findByRole("region",{name:"搜索结果：a.md"});expect(group.querySelector("mark")?.textContent).toBe("新查询");
 fireEvent.keyDown(input,{key:"Enter"});expect(choose.mock.calls[0][0].context.query).toBe("新查询");
});
it("不可读正文按路径可找，未读不伪装成没有正文匹配",async()=>{
 render(<SearchPanel paths={["坏文件.md"]} snapshot={{notes:[],errors:[{path:"坏文件.md",error:"拒绝读取"}],loading:false}} onClose={()=>{}}/>);
 fireEvent.change(screen.getByRole("searchbox"),{target:{value:"坏文件"}});
 const group=await screen.findByRole("region",{name:"搜索结果：坏文件.md"});expect(within(group).getByText("正文未读取，匹配情况未知")).toBeTruthy();
 expect(screen.getByText("坏文件.md：拒绝读取")).toBeTruthy();
});
it("收集截断与已显示数量分别说明，更多只展开已收集项",async()=>{
 render(<SearchPanel snapshot={{notes:[note("a.md","x ".repeat(220))],errors:[],loading:false}} onClose={()=>{}}/>);
 fireEvent.change(screen.getByRole("searchbox"),{target:{value:"x"}});
 const group=await screen.findByRole("region",{name:"搜索结果：a.md"});
 expect(group.querySelectorAll(".search-match")).toHaveLength(199);expect(screen.getByText(/至少 200 处正文命中/)).toBeTruthy();
 expect(screen.getByText(/数量不是全库完整总数/)).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"显示更多已收集结果"}));
 await waitFor(()=>expect(group.querySelectorAll(".search-match")).toHaveLength(200));expect(screen.queryByRole("button",{name:"显示更多已收集结果"})).toBeNull();
});
it("未变查询刷新结果不自动打开、聚焦输入或改变查询身份",async()=>{
 const choose=vi.fn(),onContext=vi.fn(),close=vi.fn(),notes=[note("a.md","旧文本")];
 const {rerender,unmount}=render(<SearchPanel paths={["a.md"]} snapshot={{notes,errors:[],loading:false}} onChoose={choose} onContext={onContext} onClose={close}/>);
 const input=screen.getByRole("searchbox");fireEvent.change(input,{target:{value:"文本"}});await screen.findByRole("region",{name:"搜索结果：a.md"});
 const context=onContext.mock.calls.at(-1)![0];rerender(<SearchPanel paths={["a.md"]} snapshot={{notes:[note("a.md","新增文本")],errors:[],loading:false}} onChoose={choose} onContext={onContext} onClose={close}/>);
 await screen.findByText(/新增/);expect(onContext.mock.calls.at(-1)![0]).toBe(context);expect(choose).not.toHaveBeenCalled();expect(input).toHaveProperty("value","文本");
 unmount();expect(onContext).toHaveBeenLastCalledWith(null);
});
