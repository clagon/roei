// ScanNetSecurity の「インシデント・情報漏えい」月別一覧から、指定期間の候補を機械的に列挙する。
// 各記事の「一次情報または関連リンク」から公式発表の URL を抜き出し、.candidates/candidates.json に書く。
// from/to は組織が公表した日の範囲。記事は公表より遅れて出ることがあるため、to から LAG_DAYS 日後（今日まで）に出た記事も候補に含める。
// 記事の日付（articleDate）は公表日ではない。公表日の判定は、公式発表を確認する Claude が行う。
// Claude が一覧の読み飛ばしやリンクの取りこぼしをしないよう、列挙は LLM に任せない。
// articleFrom は、この日以降に出た記事だけを対象にする下限（省略時は from）。毎日の実行では、
// 公表日の範囲を広く（45日）取りつつ、新しく出た記事（直近7日間）だけを見るために使う。
// 使い方: node scripts/list-candidates.mjs 2026-05-01 2026-05-31 [記事の下限]
// ponytail: HTML を正規表現で読んでいる。サイトの構造が変わったら 0 件になるので、その場合は異常終了させる。
import { mkdirSync, writeFileSync } from "node:fs";

const [from, to, articleFrom = from] = process.argv.slice(2);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? "");
if (![from, to, articleFrom].every(isDate)) {
  console.error("usage: node scripts/list-candidates.mjs YYYY-MM-DD YYYY-MM-DD [YYYY-MM-DD]");
  process.exit(2);
}

const LAG_DAYS = 45;
const BASE = "https://scan.netsecurity.ne.jp";
const headers = { "user-agent": "Mozilla/5.0 (compatible; roei-collector)" };

async function get(url, { allow404 = false } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const articleTo = [addDays(to, LAG_DAYS), today].sort()[0];

function months(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ey, em] = to.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}/${String(m).padStart(2, "0")}`);
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

// 月別一覧をページ送りで最後まで読む（新しい記事が出なくなったら終了）
const articles = new Map();
for (const ym of months(articleFrom, articleTo)) {
  for (let page = 1; page <= 30; page++) {
    // 最終ページの次は 404 が返る
    const html = await get(`${BASE}/category/incident/incident/${ym}/?page=${page}`, { allow404: true });
    if (html === null) break;
    let added = 0;
    for (const [, path, inner] of html.matchAll(/<a[^>]*href="(\/article\/\d{4}\/\d{2}\/\d{2}\/\d+\.html)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
      const [, y, m, d] = path.match(/\/article\/(\d{4})\/(\d{2})\/(\d{2})\//);
      const date = `${y}-${m}-${d}`;
      if (date < articleFrom || date > articleTo || articles.has(path)) continue;
      // 一覧のリンク文字列は「カテゴリ 日時 題名」の順。日時より後ろを題名とする
      const title = text(inner).replace(/^.*?\d{4}\.\d{1,2}\.\d{1,2} \S+ \d{1,2}:\d{2} /, "");
      articles.set(path, { articleDate: date, title, articleUrl: BASE + path });
      added++;
    }
    if (added === 0) break;
  }
}

if (articles.size === 0) {
  console.error("候補が0件です。サイトの構造が変わった可能性があります。");
  process.exit(1);
}

// 各記事の「一次情報または関連リンク」を抜き出す（同時4件）
async function withLinks(a) {
  try {
    const html = await get(a.articleUrl);
    const section = html.match(/<section class="main-relation-link">([\s\S]*?)<\/section>/)?.[1] ?? "";
    const seen = new Set();
    const body = html.match(/class="arti-body[\s\S]*?<\/article>/)?.[0] ?? "";
    // 記事の冒頭に「〇月〇日、〜を公表した」という公表日が書かれていることが多い
    const excerpt = text(body.replace(/<script[\s\S]*?<\/script>/g, "")).replace(/^class="[^"]*">\s*/, "").slice(0, 200);
    const links = [...section.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(([, url, label]) => ({
      url,
      label: text(label),
      // 組織のトップページだけを指すリンクは、個別の公式発表ではない
      topPageOnly: new URL(url).pathname.replace(/\/(index\.(html?|php))?$/, "") === "",
    }));
    return { ...a, excerpt, links: links.filter((l) => !seen.has(l.url) && seen.add(l.url)) };
  } catch (e) {
    return { ...a, links: [], error: e.message };
  }
}

const list = [...articles.values()].sort((a, b) => b.articleDate.localeCompare(a.articleDate));
const results = [];
for (let i = 0; i < list.length; i += 4) {
  results.push(...(await Promise.all(list.slice(i, i + 4).map(withLinks))));
}

mkdirSync(".candidates", { recursive: true });
writeFileSync(".candidates/candidates.json", JSON.stringify(results, null, 1));

const direct = results.filter((r) => r.links.some((l) => !l.topPageOnly)).length;
console.log(`candidates: ${results.length} (公式発表の個別 URL あり: ${direct}, トップページのみ/なし: ${results.length - direct})`);
