import { describe, expect, it } from "vitest";
import { graphEdgeEndpoints, graphNodeRadius, separateGraphNodes } from "./graph-geometry";

describe("图谱屏幕几何", () => {
  it("节点随关联数量变化，缩放后仍有可点击大小", () => {
    expect(graphNodeRadius(0, 10, .1)).toBe(3);
    expect(graphNodeRadius(10, 10, 1)).toBe(22);
    expect(graphNodeRadius(2, 10, 1)).toBeGreaterThan(graphNodeRadius(0, 10, 1));
    expect(graphNodeRadius(10, 10, 4)).toBeCloseTo(24.2);
    expect(graphNodeRadius(10, 10, .2, 1000)).toBeLessThan(4);
    expect(graphNodeRadius(10, 10, 2, 1000)).toBeGreaterThan(graphNodeRadius(10, 10, .2, 1000));
  });
  it("密集节点逐步分离，固定节点在分离时不移动", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ id: String(i), point: { x: i % 10 * 5, y: Math.floor(i / 10) * 5 }, radius: 3 }));
    const overlaps = () => nodes.flatMap((node, i) => nodes.slice(i + 1).filter((other) => Math.hypot(node.point.x - other.point.x, node.point.y - other.point.y) < 6)).length;
    const before = overlaps(), anchor = { ...nodes[0].point };
    for (let i = 0; i < 40; i++) separateGraphNodes(nodes, 1, "0");
    expect(before).toBeGreaterThan(0);
    expect(overlaps()).toBeLessThan(before / 4);
    expect(nodes[0].point).toEqual(anchor);
  });
  it("连线和箭头停止在各节点外侧，重叠时不绘制", () => {
    expect(graphEdgeEndpoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 20)).toEqual({ start: { x: 8, y: 0 }, end: { x: 78, y: 0 }, angle: 0 });
    expect(graphEdgeEndpoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 6, 6)).toBeNull();
  });
});
