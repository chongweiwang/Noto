// Screen-space sizes and clipped endpoints keep drawing and hit testing aligned.
export function graphNodeRadius(connections: number, maximum: number, zoom: number, visibleCount = 1): number {
  const weight = maximum > 0 ? Math.sqrt(Math.max(0, connections) / maximum) : 0;
  const density = Math.min(1, Math.sqrt(80 / Math.max(1, visibleCount)) * Math.max(1, zoom * 1.5));
  return Math.max(1.5, (6 + 16 * Math.min(1, weight)) * Math.max(.5, Math.min(1.1, zoom)) * density);
}

type CollisionNode = { id: string; point: { x: number; y: number }; radius: number };

// Resolve nearby overlaps in screen space without comparing every pair in a large graph.
export function separateGraphNodes(nodes: CollisionNode[], zoom: number, pinned: string | null) {
  if (nodes.length < 40 || zoom <= 0) return;
  const cellSize = Math.max(1, ...nodes.map((node) => node.radius * 2 + 2));
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  nodes.forEach((node, index) => {
    const gx = Math.floor(node.point.x * zoom / cellSize), gy = Math.floor(node.point.y * zoom / cellSize);
    for (let y = gy - 1; y <= gy + 1; y++) for (let x = gx - 1; x <= gx + 1; x++) {
      for (const otherIndex of cells.get(key(x, y)) ?? []) {
        const other = nodes[otherIndex];
        let dx = (node.point.x - other.point.x) * zoom, dy = (node.point.y - other.point.y) * zoom;
        let distance = Math.hypot(dx, dy);
        const minimum = node.radius + other.radius + 2;
        if (distance >= minimum || node.id === pinned && other.id === pinned) continue;
        if (distance < .001) { const angle = (index + otherIndex + 1) * 2.399963; dx = Math.cos(angle); dy = Math.sin(angle); distance = 0; }
        else { dx /= distance; dy /= distance; }
        const shift = (minimum - distance) * .75 / zoom;
        const nodeShare = node.id === pinned ? 0 : other.id === pinned ? 1 : .5;
        node.point.x += dx * shift * nodeShare; node.point.y += dy * shift * nodeShare;
        other.point.x -= dx * shift * (1 - nodeShare); other.point.y -= dy * shift * (1 - nodeShare);
      }
    }
    const finalKey = key(Math.floor(node.point.x * zoom / cellSize), Math.floor(node.point.y * zoom / cellSize));
    const cell = cells.get(finalKey);
    if (cell) cell.push(index); else cells.set(finalKey, [index]);
  });
}

export function graphEdgeEndpoints(a: { x: number; y: number }, b: { x: number; y: number }, fromRadius: number, toRadius: number) {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  const from = fromRadius + 2, to = toRadius + 2;
  if (length <= from + to) return null;
  const ux = dx / length, uy = dy / length;
  return { start: { x: a.x + ux * from, y: a.y + uy * from }, end: { x: b.x - ux * to, y: b.y - uy * to }, angle: Math.atan2(dy, dx) };
}
