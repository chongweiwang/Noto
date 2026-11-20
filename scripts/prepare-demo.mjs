import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "fixtures", "vault");
const destination = join(root, ".local", "demo-vault");

if (existsSync(destination)) {
  console.log("演示知识库已存在，保留原有内容。");
} else {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  console.log(`已创建演示知识库：${destination}`);
}

