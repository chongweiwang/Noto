import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const root = path.join(workspace, ".local", `stage2-${Date.now()}`);
for (const folder of ["vault/项目/attachments", "vault/任务/工作", "vault/日记/2026/11", "data"]) await mkdir(path.join(root, folder), { recursive: true });
await writeFile(path.join(root, "password.txt"), randomBytes(24).toString("base64url"), { mode: 0o600 });
await writeFile(path.join(root, "vault/.noto-test-fixture"), "isolated stage 2 validation\n");
await writeFile(path.join(root, "vault/欢迎.md"), `# 欢迎使用 Noto\n\n这是网页和桌面共享的 Markdown 工作区。\n\n## 知识链接\n\n[[项目/技术笔记]] · [技术笔记](项目/技术笔记.md)\n\n## Markdown\n\n| 项目 | 状态 |\n| --- | --- |\n| 共享编辑器 | 就绪 |\n\n- [ ] 网页验证\n- [x] 本地优先\n\n## 数学公式\n\n行内 $E=mc^2$。\n\n$$\n\\int_0^1 x^2\\,dx=\\frac13\n$$\n\n## 流程图\n\n\`\`\`mermaid\nflowchart LR\n  浏览器 --> Axum\n  Axum --> Markdown\n\`\`\`\n`);
await writeFile(path.join(root, "vault/项目/技术笔记.md"), "# 技术笔记\n\n来自 [[欢迎]]。\n\n![示例图片](attachments/示例.png)\n\n## 设计\n\n共享 React 工作区与 Rust 文件核心。\n");
await writeFile(path.join(root, "vault/项目/attachments/示例.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
await writeFile(path.join(root, "vault/日记/2026/11/2026-11-13.md"), "# 2026-11-13\n\n网页验收日记。\n");
// Use the application's own task serializer in the UI for additional task data.
await writeFile(path.join(workspace, ".local/stage2-current.json"), JSON.stringify({ root, vault: path.join(root, "vault"), data: path.join(root, "data"), passwordFile: path.join(root, "password.txt") }, null, 2));
process.stdout.write(`已准备隔离测试目录：${root}\n配置记录：.local/stage2-current.json\n`);
