import {expect,it} from "vitest";
import {normalizeWorkspace} from "./workspace-state";

it("恢复各文件的橡皮尺寸和模式，旧设置或无效设置使用安全默认值",()=>{
 const state=normalizeWorkspace({version:1,canvases:{"old.canvas":{},"chosen.canvas":{eraserSize:40},"bad.canvas":{eraserSize:999}},drawings:{"old.drawing":{},"chosen.drawing":{eraserSize:60,eraserMode:"object"},"bad.drawing":{eraserSize:"40",eraserMode:"unknown"}}});
 expect(state.canvases?.["old.canvas"].eraserSize).toBe(20);expect(state.canvases?.["chosen.canvas"].eraserSize).toBe(40);expect(state.canvases?.["bad.canvas"].eraserSize).toBe(20);
 expect(state.drawings?.["old.drawing"]).toMatchObject({eraserSize:20,eraserMode:"stroke"});expect(state.drawings?.["chosen.drawing"]).toMatchObject({eraserSize:60,eraserMode:"object"});expect(state.drawings?.["bad.drawing"]).toMatchObject({eraserSize:20,eraserMode:"stroke"});
});
