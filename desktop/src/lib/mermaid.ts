import DOMPurify from "dompurify";

let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

// Diagrams are rendered locally. Reject links and directives that could cause
// Mermaid to load remote content or change the security configuration.
export async function renderMermaid(source: string): Promise<string> {
  if (/%%\s*\{|(?:https?:|file:|data:|javascript:)\/\/|(?:https?:|file:|data:|javascript:)|^\s*click\s/im.test(source)) {
    throw new Error("图表中的外部资源、点击链接和配置指令暂不支持");
  }
  const work = async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "neutral", fontFamily: "Arial, sans-serif", htmlLabels: false, secure: ["securityLevel", "startOnLoad", "maxTextSize", "htmlLabels", "flowchart", "theme", "fontFamily", "secure", "suppressErrorRendering"] });
    const { svg } = await mermaid.render(`noto-mermaid-${++sequence}`, source);
    const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"], FORBID_TAGS: ["script", "foreignObject", "image", "a"], FORBID_ATTR: ["href", "xlink:href"] });
    // Keep SVG fragment references used for arrows, never external CSS URLs.
    if (/@import|url\(\s*['"]?(?!#)/i.test(clean)) throw new Error("图表包含不支持的外部资源");
    return clean;
  };
  const result = queue.then(work, work);
  queue = result.catch(() => {});
  return result;
}
