// 前端接线自检：JS 里引用的 DOM id 是否都存在于 HTML；tab 与 pane 是否一一对应
import fs from "node:fs";

const root = process.argv[2] || ".";
const js = fs.readFileSync(`${root}/public/app.js`, "utf8");
const html = fs.readFileSync(`${root}/public/index.html`, "utf8");
const css = fs.readFileSync(`${root}/public/style.css`, "utf8");

const grab = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const ids = new Set(grab(html, /id="([^"]+)"/g));
const used = new Set(grab(js, /\$\("([^"]+)"\)/g));
const missing = [...used].filter((i) => !ids.has(i));

const tabs = grab(html, /data-tab="([^"]+)"/g);
const panes = grab(html, /data-pane="([^"]+)"/g);
const swClasses = ["tabs", "tab", "tabpane", "banner", "save-state", "dim"];

console.log(`HTML id 数: ${ids.size} / JS 引用的 id 数: ${used.size}`);
console.log(`JS 引用但 HTML 缺失: ${missing.length ? missing.join(", ") : "（无）"}`);
console.log(`tabs: ${tabs.join(",")}`);
console.log(`panes: ${panes.join(",")}`);
console.log(`tab 与 pane 顺序一致: ${tabs.sort().join(",") === panes.sort().join(",")}`);
for (const cls of swClasses) {
  console.log(`CSS 含 .${cls}: ${css.includes(`.${cls}`)}`);
}
if (missing.length) process.exitCode = 1;
