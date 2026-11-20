import {describe,expect,it} from "vitest";
import {getTheme,themes} from "./themes";
import {defaultPreferences,normalizePreferences,selectTheme,toggleThemePreference} from "./workspace-state";
import {drawingUiColors} from "./drawing-ui";

function luminance(hex:string){const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];}
function contrast(a:string,b:string){const [lo,hi]=[luminance(a),luminance(b)].sort((x,y)=>x-y);return (hi+.05)/(lo+.05);}
describe("主题与旧设置",()=>{
 it("旧明暗设置迁移并保留其他偏好，损坏的 ID 安全回退",()=>{
  expect(normalizePreferences({theme:"light",fontSize:19})).toMatchObject({theme:"light",themeId:"catppuccin-latte",fontSize:19});
  expect(normalizePreferences(null,"light").themeId).toBe("catppuccin-latte");
  expect(normalizePreferences({theme:"dark",themeId:"unknown",lastLightThemeId:"nord",fontSize:18})).toMatchObject({theme:"dark",themeId:"catppuccin-mocha",lastLightThemeId:"catppuccin-latte",fontSize:18});
  expect(normalizePreferences({theme:"dark",themeId:"nord",lastDarkThemeId:"catppuccin-mocha"}).lastDarkThemeId).toBe("nord");
 });
 it("深浅切换记住各类别主题，序列化保留旧版明暗字段",()=>{
  const north=selectTheme(defaultPreferences,"nord"),warm=selectTheme(north,"solarized-light"),again=toggleThemePreference(warm),saved=normalizePreferences(JSON.parse(JSON.stringify(again)));
  expect(saved).toMatchObject({theme:"dark",themeId:"nord",lastDarkThemeId:"nord",lastLightThemeId:"solarized-light"});
  expect(toggleThemePreference(saved).themeId).toBe("solarized-light");expect(getTheme("light").id).toBe("catppuccin-latte");
 });
 it.each(themes)("$name 的正文、提示和按钮前景具有基本对比度",({colors:c})=>{
  expect(contrast(c.text,c.primary)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(c.subtext,c.secondary)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(c.muted,c.secondary)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(c.accent,c.onAccent)).toBeGreaterThanOrEqual(4.5);
 });
 it("白板装饰根据纸张明暗选择，但不修改纸张或 SVG 数据",()=>{
  expect(drawingUiColors("#ffffff").selection).toBe("#1d4ed8");
  expect(drawingUiColors("#111827").selection).toBe("#b9d8ff");
  for(const background of ["#ffffff","#111827","#777777","#aaaaaa","#315678"])expect(contrast(drawingUiColors(background).selection,background)).toBeGreaterThanOrEqual(3);
 });
});
