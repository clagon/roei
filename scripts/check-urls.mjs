// 未コミットの事案ファイルで新たに追加された出典 URL が実在するか確認する。
// HEAD に既にある URL はリンク切れで永久に push が止まらないよう対象外。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "data/incidents"], { encoding: "utf8" })
  .split("\n")
  .filter((l) => l && !l.slice(0, 2).includes("D"))
  .map((l) => l.slice(3))
  .filter((f) => f.endsWith(".json"));

const urlsOf = (json) => (JSON.parse(json).reports ?? []).map((r) => r.url);

function committedUrls(file) {
  try {
    return new Set(urlsOf(execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })));
  } catch {
    return new Set(); // 新規ファイル
  }
}

const failures = [];
let checked = 0;
for (const file of files) {
  const old = committedUrls(file);
  for (const url of urlsOf(readFileSync(file, "utf8")).filter((u) => !old.has(u))) {
    checked++;
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

console.log(`checked ${checked} new url(s) in ${files.length} file(s)`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
