import type { RelationIndex } from "./knowledge";
import type { GraphSettings } from "./workspace-state";

export type GraphNode = { id: string; label: string; connections: number; unreadable: boolean };
export type GraphEdge = { source: string; target: string; forward: number; reverse: number };
export type KnowledgeGraph = { nodes: GraphNode[]; edges: GraphEdge[] };
export const graphDisplayLimit = 1000;

export function buildGraph(index: RelationIndex): KnowledgeGraph {
  const nodes = new Map(index.paths.map((id) => [id, { id, label: id.split("/").pop()!.replace(/\.(md|markdown)$/i, ""), connections: 0, unreadable: !index.readable.has(id) }]));
  const pairs = new Map<string, GraphEdge>();
  for (const link of index.references) {
    if (link.status !== "resolved" || !link.target || link.source === link.target) continue;
    const [source, target] = [link.source, link.target].sort();
    if (!nodes.has(source) || !nodes.has(target)) continue;
    const key = JSON.stringify([source, target]);
    let edge = pairs.get(key);
    if (!edge) { edge = { source, target, forward: 0, reverse: 0 }; pairs.set(key, edge); nodes.get(source)!.connections++; nodes.get(target)!.connections++; }
    if (link.source === source) edge.forward++; else edge.reverse++;
  }
  return { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...pairs.values()] };
}

export function filterGraph(graph: KnowledgeGraph, settings: GraphSettings, selected: string | null = null, currentNote: string | null = null) {
  const centerExists = !!settings.center && graph.nodes.some((node) => node.id === settings.center);
  const neighbors = new Set<string>(settings.center ? [settings.center] : []);
  if (settings.mode === "local" && centerExists) for (const edge of graph.edges) {
    if (edge.source === settings.center) neighbors.add(edge.target);
    if (edge.target === settings.center) neighbors.add(edge.source);
  }
  let scope = graph.nodes.filter((node) => (settings.mode === "global" || centerExists && neighbors.has(node.id)) && (!settings.folder || node.id.startsWith(`${settings.folder}/`)));
  let ids = new Set(scope.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  if (!settings.isolated) {
    const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    scope = scope.filter((node) => connected.has(node.id));
  }
  // Search selection, the current note and the local center stay visible in a capped graph.
  const priority = new Set([selected, currentNote, settings.mode === "local" ? settings.center : null]);
  const nodes = [...scope.filter((node) => priority.has(node.id)), ...scope.filter((node) => !priority.has(node.id))].slice(0, graphDisplayLimit);
  ids = new Set(nodes.map((node) => node.id));
  return { scope, nodes, edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), totalEdges: edges.length, centerExists, truncated: scope.length > nodes.length };
}
