// 未コミットの事案ファイルに含まれる出典 URL が実在するか確認する。
// 既存ファイルはリンク切れで永久に push が止まらないよう対象外。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "data/incidents"], { encoding: "utf8" })
  .split("\n")
  .filter((l) => l && !l.slice(0, 2).includes("D"))
  .map((l) => l.slice(3))
  .filter((f) => f.endsWith(".json"));

const failures = [];
for (const file of files) {
  for (const { url } of JSON.parse(readFileSync(file, "utf8")).reports ?? []) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "Mozilla/5.0 (compatible; roei-checker)" },
      });
      if (!res.ok) failures.push(`${file}: ${url} -> ${res.status}`);
    } catch (e) {
      failures.push(`${file}: ${url} -> ${e.cause?.code ?? e.message}`);
    }
  }
}

console.log(`checked ${files.length} file(s)`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
