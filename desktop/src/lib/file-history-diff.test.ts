import { expect, it } from "vitest";
import { historyDiff } from "./file-history-diff";
it("逐行比较 Unicode 内容，保留共同内容并标记增删",()=>{
  expect(historyDiff("标题\r\n旧文\n尾部","标题\n新文\n尾部")).toEqual({limited:false,lines:[{kind:"same",text:"标题"},{kind:"remove",text:"旧文"},{kind:"add",text:"新文"},{kind:"same",text:"尾部"}]});
  expect(historyDiff("a","a").lines).toEqual([{kind:"same",text:"a"}]);
});
it("大块改动、超长行和超多行均限制比较成本与渲染量",()=>{
  const large=historyDiff(Array.from({length:3000},(_,i)=>`before${i}`).join("\n"),Array.from({length:3000},(_,i)=>`after${i}`).join("\n"));
  expect(large.limited).toBe(true);expect(large.lines.length).toBeLessThanOrEqual(1000);
  const long=historyDiff("x".repeat(2*1024*1024),"短行");expect(long.limited).toBe(true);expect(long.lines[0].text.length).toBe(4000);
  expect(historyDiff("\n".repeat(10000),"\n".repeat(10000)).limited).toBe(true);
});
it("折叠大量共同上下文，靠近文末的差异仍能看到",()=>{
  const prefix="相同\n".repeat(2000);const diff=historyDiff(prefix+"旧结尾",prefix+"新结尾");
  expect(diff.limited).toBe(false);expect(diff.lines).toContainEqual({kind:"remove",text:"旧结尾"});expect(diff.lines.length).toBeLessThan(12);
});
