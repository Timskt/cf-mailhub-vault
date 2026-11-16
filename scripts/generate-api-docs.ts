import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openApi } from "../shared/api-contract";
import {
  developerGuide,
  llmsIndex,
  postmanCollection,
} from "../shared/api-guides";

const base = "http://localhost:8787";
const files: Record<string, string> = {
  "docs/openapi.json": JSON.stringify(openApi(base), null, 2) + "\n",
  "docs/postman.collection.json":
    JSON.stringify(postmanCollection(base), null, 2) + "\n",
  "docs/API.md": developerGuide(base),
  "docs/llms.txt": llmsIndex(base),
};
await mkdir("docs", { recursive: true });
for (const [path, contents] of Object.entries(files)) {
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8").catch(() => "")) !== contents)
      throw new Error(`${path} 已过期，请运行 pnpm docs:generate`);
  } else await writeFile(path, contents);
}
console.log(
  `API 文档 ${process.argv.includes("--check") ? "一致性检查通过" : "生成完成"}：${Object.keys(files).length} 个文件`,
);
