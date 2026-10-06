// .candidates/candidates.json の公式発表の URL を先にダウンロードして、本文のテキストを .candidates/official/ に書き出す。
// Claude の WebFetch は PDF を読めず、403 などで弾かれることも多いため、取得と本文の抽出は機械的に行い、
// Claude には書き出したテキストを読んで判断させる。取得できなかったものは、Claude が従来どおり WebFetch で試す。
// 使い方: node scripts/list-candidates.mjs ... && node scripts/fetch-official.mjs
// ponytail: HTML のタグ除去は正規表現。本文の抽出精度より、確認に足る冒頭を確実に渡すことを優先している。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";

const FILE = ".candidates/candidates.json";
const OUT = ".candidates/official";
const MAX_CHARS = 6000; // 1件あたりに残す本文の長さ
const LINKS_PER_CANDIDATE = 2;
const headers = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "accept-language": "ja,en;q=0.8",
  accept: "text/html,application/pdf,application/xhtml+xml;q=0.9,*/*;q=0.5",
};

const candidates = JSON.parse(readFileSync(FILE, "utf8"));
mkdirSync(OUT, { recursive: true });

function decode(buf, contentType) {
  const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
  const charset = (contentType.match(/charset=([\w-]+)/i) ?? head.match(/charset=["']?([\w-]+)/i))?.[1] ?? "utf-8";
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

async function fetchText(url) {
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  if (!res.ok) return { status: res.status };
  const type = res.headers.get("content-type") ?? "";
  const buf = new Uint8Array(await res.arrayBuffer());
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
    if (r.text.length < 40) return void (link.fetch = { status: 200, kind: r.kind, empty: true }); // 画像だけの PDF など
    writeFileSync(file, `${link.url}\n\n${r.text.slice(0, MAX_CHARS)}\n`);
    link.fetch = { status: 200, kind: r.kind, file };
  } catch (e) {
    link.fetch = { error: String(e.cause?.code ?? e.message).slice(0, 80) };
  }
}

for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(run));

writeFileSync(FILE, JSON.stringify(candidates, null, 1));

const fetched = jobs.filter((j) => j.link.fetch?.file);
const count = (f) => jobs.filter((j) => f(j.link.fetch ?? {})).length;
console.log(
  `official: ${jobs.length} urls, 本文取得 ${fetched.length} (pdf ${fetched.filter((j) => j.link.fetch.kind === "pdf").length}), ` +
    `本文なし ${count((f) => f.empty)}, HTTPエラー ${count((f) => f.status && f.status !== 200)}, 通信エラー ${count((f) => f.error)}`,
);
