import { canvasColor, canvasEdgeGeometry, canvasFreehand, parseCanvas, type Point } from "./canvas-document";
import { canvasArrowDirection } from "./canvas-connection";
import { downloadBlob } from "./export-output";
import { bounded, maxExportBytes } from "./export-resources";
import { drawingToSvg } from "./drawing-svg";
import { CanvasResources } from "./canvas-resources";
import type { WorkspaceRuntime } from "./workspace-runtime";

export type GraphicFormat = "png" | "pdf";
const maxPixels = 14 * 1024 * 1024;

function surface(width: number, height: number) {
  if (!Number.isFinite(width * height) || width < 1 || height < 1) throw new Error("导出尺寸无效");
  const scale = Math.min(2, 8192 / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  if (Math.min(width, height) * scale < 1) throw new Error("图形长宽比例过大，无法导出完整内容");
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法初始化图形导出");
  ctx.scale(canvas.width / width, canvas.height / height);
  return { canvas, ctx };
}

async function loadImage(src: string) {
  const img = new Image();
  img.src = src;
  await bounded(img.decode());
  return img;
}

export async function drawingRaster(source: string, measure?: (line: string, size: number) => number) {
  const svg = drawingToSvg(source, measure);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = await loadImage(url);
    const { canvas, ctx } = surface(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(image, 0, 0);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, height: number) {
  const rows = Math.floor(height / 19);
  if (rows < 1 || width < 12) return;
  let line = "", row = 0;
  for (const char of text.slice(0, 4000)) {
    if (char === "\r") continue;
    if (char === "\n" || (line && ctx.measureText(line + char).width > width)) {
      ctx.fillText(line, x, y + row++ * 19, width);
      if (row >= rows) return;
      line = char === "\n" ? "" : char;
    } else line += char;
  }
  if (line) ctx.fillText(line, x, y + row * 19, width);
}

function arrow(ctx: CanvasRenderingContext2D, tip: Point, tangent: Point) {
  const angle = Math.atan2(tip.y - tangent.y, tip.x - tangent.x);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  for (const offset of [-0.45, 0.45]) ctx.lineTo(tip.x - 10 * Math.cos(angle + offset), tip.y - 10 * Math.sin(angle + offset));
  ctx.fill();
}

export async function knowledgeRaster(source: string, path: string, api: WorkspaceRuntime["api"]) {
  const { nodes, edges } = parseCanvas(source);
  const pad = 72;
  const x = Math.min(...nodes.map((node) => node.x), ...(nodes.length ? [] : [0])) - pad;
  const y = Math.min(...nodes.map((node) => node.y), ...(nodes.length ? [] : [0])) - pad;
  const width = Math.max(...nodes.map((node) => node.x + node.width), ...(nodes.length ? [] : [0])) - x + pad;
  const height = Math.max(...nodes.map((node) => node.y + node.height), ...(nodes.length ? [] : [0])) - y + pad;
  const { canvas, ctx } = surface(width, height);
  const resources = new CanvasResources(api, path);
  try {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.translate(-x, -y);
    ctx.textBaseline = "top";
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const color = (value?: string) => value ? canvasColor(value) : "#8795a6";
    for (const node of nodes.filter((node) => node.type === "group")) {
      ctx.fillStyle = "#eef2f7"; ctx.strokeStyle = color(node.color);
      ctx.fillRect(node.x, node.y, node.width, node.height);
      ctx.strokeRect(node.x, node.y, node.width, node.height);
      ctx.fillStyle = "#334155"; ctx.font = "bold 15px sans-serif";
      ctx.fillText(node.label || "分组", node.x, node.y - 20, node.width);
    }
    for (const edge of edges) {
      const { d, a, b, ca, cb, x, y } = canvasEdgeGeometry(edge, byId.get(edge.fromNode)!, byId.get(edge.toNode)!);
      ctx.strokeStyle = color(edge.color); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 2;
      ctx.stroke(new Path2D(d));
      const direction = canvasArrowDirection(edge);
      if (direction === "start" || direction === "both") arrow(ctx, a, ca);
      if (direction === "end" || direction === "both") arrow(ctx, b, cb);
      if (edge.label) {
        ctx.font = "13px sans-serif";
        ctx.fillText(edge.label, x + 4, y - 16, 250);
      }
    }
    for (const node of nodes.filter((node) => node.type !== "group")) {
      const { x, y, width, height } = node, ink = canvasFreehand(node);
      if (ink) {
        ctx.strokeStyle = ink.strokeColor; ctx.fillStyle = ink.strokeColor;
        ctx.lineWidth = ink.strokeWidth; ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.beginPath();
        if (ink.points.length === 1) {
          const [[px, py]] = ink.points;
          ctx.arc(x + px * width, y + py * height, ink.strokeWidth / 2, 0, 2 * Math.PI);
          ctx.fill();
        } else {
          for (const [px, py] of ink.points) ctx.lineTo(x + px * width, y + py * height);
          ctx.stroke();
        }
        continue;
      }
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = color(node.color); ctx.lineWidth = 1;
      ctx.fillRect(x, y, width, height); ctx.strokeRect(x, y, width, height);
      const resource = node.file ? await bounded(resources.load(node.file)) : undefined;
      if (resource?.image) {
        const image = await loadImage(resource.image);
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
        ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
        continue;
      }
      ctx.fillStyle = "#243247"; ctx.font = "14px sans-serif";
      const text = node.file
        ? node.file + (resource?.text ? "\n" + resource.text : "")
        : node.text ?? "";
      wrapText(ctx, text, x + 10, y + 10, width - 20, height - 20);
    }
    return canvas;
  } finally { resources.dispose(); }
}

export async function saveGraphic(runtime: WorkspaceRuntime, canvas: HTMLCanvasElement, path: string, format: GraphicFormat) {
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法编码 PNG")), "image/png");
  });
  const name = (path.split("/").at(-1) ?? "图形").replace(/\.(?:canvas|drawing)$/i, "") + "." + format;
  let output = png;
  if (format === "pdf") {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(await png.arrayBuffer());
    const width = image.width * .75, height = image.height * .75;
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    output = new Blob([new Uint8Array(await pdf.save())], { type: "application/pdf" });
  }
  if (output.size > maxExportBytes) throw new Error("图形文件超过 64 MiB");
  if (runtime.kind === "web") { downloadBlob(output, name); return "已发起下载，请查看浏览器下载列表。"; }
  if (!runtime.saveGraphic) throw new Error("当前桌面运行时无法保存图形");
  const bytes = new Uint8Array(await output.arrayBuffer());
  const result = await runtime.saveGraphic(bytes, name, format);
  return result ? "已保存 " + result : "已取消保存";
}
