// .candidates/candidates.json の公式発表の URL を先にダウンロードして、本文のテキストを .candidates/official/ に書き出す。
// Claude の WebFetch は PDF を読めず、403 などで弾かれることも多いため、取得と本文の抽出は機械的に行い、
// Claude には書き出したテキストを読んで判断させる。取得できなかったものは、Claude が従来どおり WebFetch で試す。
// 使い方: node scripts/list-candidates.mjs ... && node scripts/fetch-official.mjs [公表日の範囲の終わり YYYY-MM-DD]
// ponytail: HTML のタグ除去は正規表現。本文の抽出精度より、確認に足る冒頭を確実に渡すことを優先している。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";

const FILE = ".candidates/candidates.json";
const OUT = ".candidates/official";
const MAX_CHARS = 6000; // 1件あたりに残す本文の長さ
const LINKS_PER_CANDIDATE = 2;
const MAX_BYTES = 15 * 1024 * 1024; // これを超える応答は読まない（同時6件でもメモリを使い切らないため）
const headers = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "accept-language": "ja,en;q=0.8",
  accept: "text/html,application/pdf,application/xhtml+xml;q=0.9,*/*;q=0.5",
};

const candidates = JSON.parse(readFileSync(FILE, "utf8"));
mkdirSync(OUT, { recursive: true });

function decode(buf, contentType) {
  const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
  // charset="Shift_JIS" や charset = euc-jp のように、引用符や空白が付く書き方もある
  const charset = (contentType.match(/charset\s*=\s*["']?([\w-]+)/i) ?? head.match(/charset\s*=\s*["']?([\w-]+)/i))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

const htmlToText = (html) =>
  html
    .replace(/<(script|style|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// 応答を MAX_BYTES までしか読み込まない。超えたら読むのをやめて null を返す
async function readLimited(res) {
  if (Number(res.headers.get("content-length")) > MAX_BYTES) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function fetchText(url) {
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  if (!res.ok) return { status: res.status };
  const type = res.headers.get("content-type") ?? "";
  const buf = await readLimited(res);
  if (!buf) return { status: 200, tooLarge: true };
  // 拡張子のないダウンロード用 URL や、汎用の MIME 型で配られる PDF もあるので、先頭のバイト列（%PDF-）でも判定する
  const isPdf = String.fromCharCode(...buf.slice(0, 5)) === "%PDF-" || /pdf/i.test(type) || url.toLowerCase().split("?")[0].endsWith(".pdf");
  if (isPdf) {
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return { status: 200, kind: "pdf", text: text.replace(/\s+/g, " ").trim() };
  }
  const text = htmlToText(decode(buf, type));
  // PDF 以外のバイナリ（画像・圧縮ファイルなど）を文字として読んだものは、本文として渡さない
  if ((text.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0) > text.length * 0.05) return { status: 200, kind: "binary", text: "" };
  return { status: 200, kind: "html", text };
}

const jobs = [];
candidates.forEach((c, ci) =>
  c.links
    .filter((l) => !l.topPageOnly)
    .slice(0, LINKS_PER_CANDIDATE)
    .forEach((l, li) => jobs.push({ link: l, file: `${OUT}/${ci}-${li}.txt` })),
);

async function run({ link, file }) {
  try {
    const r = await fetchText(link.url);
    if (r.status !== 200) return void (link.fetch = { status: r.status });
    if (r.tooLarge) return void (link.fetch = { status: 200, tooLarge: true });
    if (r.text.length < 40) return void (link.fetch = { status: 200, kind: r.kind, empty: true }); // 画像だけの PDF など
    writeFileSync(file, `${link.url}\n\n${r.text.slice(0, MAX_CHARS)}\n`);
    link.fetch = { status: 200, kind: r.kind, file };
  } catch (e) {
    link.fetch = { error: String(e.cause?.code ?? e.message).slice(0, 80) };
  }
}

for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(run));

writeFileSync(FILE, JSON.stringify(candidates, null, 1));

// 候補ごとの詳細（記事の冒頭 excerpt、links、alsoReportedBy など）を、番号を名前にした小さなファイルに書く。
// index.txt の番号から、そのファイルだけを Read できる（candidates.json は大きすぎて部分的にしか読めない）。
const DETAIL = ".candidates/detail";
mkdirSync(DETAIL, { recursive: true });
candidates.forEach((c, i) => writeFileSync(`${DETAIL}/${i}.json`, JSON.stringify({ id: i, ...c }, null, 1)));

// 候補の一覧を、1行1件の短い形で index.txt に書く。candidates.json は整形すると数千行・数百KB になり、
// Claude の Read では先頭の数件しか読めない。index.txt なら全候補を数回の Read で見渡せる。
// 列: 番号 / 記事の日付 / 情報源(S=ScanNetSecurity, G=Google ニュース) / 題名 / 取得済みの本文ファイル / 公式発表の候補 URL（本文がないもの）
const line = (c, i) => {
  const direct = c.links.filter((l) => !l.topPageOnly);
  const files = direct.map((l) => l.fetch?.file).filter(Boolean);
  const url = files.length ? "-" : (direct[0]?.url ?? "-");
  return [i, c.articleDate, c.source.startsWith("Scan") ? "S" : "G", c.title.replace(/\s+/g, " ").slice(0, 55), files.join(",") || "-", url].join("\t");
};
// 並び: 公式発表の URL を持つ ScanNetSecurity の候補（範囲内の記事、範囲より後の記事の順）、最後に Google ニュース由来
const toDate = process.argv[2];
const rank = (c) => (c.source.startsWith("Scan") ? (toDate && c.articleDate > toDate ? 1 : 0) : 2);
const ordered = candidates.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || b.c.articleDate.localeCompare(a.c.articleDate));
writeFileSync(`${OUT.replace(/\/official$/, "")}/index.txt`, ordered.map(({ c, i }) => line(c, i)).join("\n") + "\n");

const fetched = jobs.filter((j) => j.link.fetch?.file);
const count = (f) => jobs.filter((j) => f(j.link.fetch ?? {})).length;
console.log(
  `official: ${jobs.length} urls, 本文取得 ${fetched.length} (pdf ${fetched.filter((j) => j.link.fetch.kind === "pdf").length}), ` +
    `本文なし ${count((f) => f.empty)}, 大きすぎ ${count((f) => f.tooLarge)}, HTTPエラー ${count((f) => f.status && f.status !== 200)}, 通信エラー ${count((f) => f.error)}`,
);
