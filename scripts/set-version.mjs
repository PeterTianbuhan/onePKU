// 发布前把版本号写进 package.json 和 tauri.conf.json：前端显示的版本与更新插件比较的版本必须一致。
// 用法：node scripts/set-version.mjs 0.12.4-nightly.202610302000
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) {
  console.error(`版本号不合法：${version}`);
  process.exit(1);
}
for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
console.log(`版本号：${version}`);
