import fs from "node:fs";
import YAML from "yaml";
const doc = YAML.parse(
  fs.readFileSync("docs/DESIGN.md", "utf8").split("---")[1],
);
const names = [...Object.keys(doc.colors), ...Object.keys(doc.spacing)];
if (new Set(names).size !== names.length)
  throw Error("Duplicate design token name");
const out =
  ":root {\n" +
  Object.entries(doc.colors)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n") +
  "\n" +
  Object.entries(doc.spacing)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n") +
  "\n" +
  Object.entries(doc.rounded)
    .map(([k, v]) => `  --radius-${k.toLowerCase()}: ${v};`)
    .join("\n") +
  `\n  --font-sans: ${doc.typography.sans.fontFamily};\n  --font-mono: ${doc.typography.mono.fontFamily};\n}\n` +
  // 深色只改颜色取值：同一批语义名，由 theme.ts 决定何时挂上这个属性。
  '\n[data-theme="dark"] {\n' +
  Object.entries(doc.darkColors)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n") +
  "\n}\n";
const path = "src/styles/tokens.css";
if (process.argv.includes("--check")) {
  if (fs.readFileSync(path, "utf8").replaceAll("\r\n", "\n") !== out)
    throw Error("Design tokens drift");
} else fs.writeFileSync(path, out);
