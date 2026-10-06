// 情報漏洩事案の候補を、複数の情報源から機械的に列挙して .candidates/candidates.json に書く。
//  - ScanNetSecurity の月別一覧: 各記事の「一次情報または関連リンク」から公式発表の個別 URL を取れる。
//  - Google ニュースの RSS 検索: 全国紙・地方紙・NHK・専門誌を横断して拾う。公式発表の URL は含まれない。
// 情報源のどれかが壊れても、残りで動き続ける（警告を出す）。すべてが0件のときだけ異常終了する。
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

// --- 情報源 1: ScanNetSecurity ---
async function scanNetSecurity() {
  const articles = new Map();
  // 月別一覧をページ送りで最後まで読む
  for (const ym of months(articleFrom, articleTo)) {
    for (let page = 1; page <= 30; page++) {
      // 最終ページの次は 404 が返る
      const html = await get(`${BASE}/category/incident/incident/${ym}/?page=${page}`, { allow404: true });
      if (html === null) break;
      const dates = [];
      for (const [, path, inner] of html.matchAll(/<a[^>]*href="(\/article\/\d{4}\/\d{2}\/\d{2}\/\d+\.html)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
        const [, y, m, d] = path.match(/\/article\/(\d{4})\/(\d{2})\/(\d{2})\//);
        const date = `${y}-${m}-${d}`;
        dates.push(date);
        if (date < articleFrom || date > articleTo || articles.has(path)) continue;
        // 一覧のリンク文字列は「カテゴリ 日時 題名」の順。日時より後ろを題名とする
        const title = text(inner).replace(/^.*?\d{4}\.\d{1,2}\.\d{1,2} \S+ \d{1,2}:\d{2} /, "");
        articles.set(path, { articleDate: date, title, articleUrl: BASE + path });
      }
      // 一覧は新しい順。範囲より新しい記事だけのページは読み飛ばして次へ進み、
      // 記事がなくなったか、すべて下限より古くなったページで終える
      if (dates.length === 0 || dates.every((d) => d < articleFrom)) break;
    }
  }
  // 各記事の「一次情報または関連リンク」と冒頭を抜き出す（同時4件）
  const list = [...articles.values()];
  const results = [];
  for (let i = 0; i < list.length; i += 4) results.push(...(await Promise.all(list.slice(i, i + 4).map(withLinks))));
  return results.map((r) => ({ ...r, source: "ScanNetSecurity" }));
}

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

// --- 情報源 2: Google ニュース RSS ---
// 1回の検索で返る件数に上限があるため、期間を3日ずつに区切る。
const NEWS_QUERIES = [
  "(個人情報 OR 顧客情報 OR 会員情報) (漏えい OR 漏洩 OR 流出 OR 不正アクセス OR 誤送信)",
  "(ランサムウェア OR サイバー攻撃 OR 紛失 OR 盗難 OR 誤送付 OR 誤公開) 個人情報",
];
const unescapeXml = (t) => t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ニュースは公表から数日で出るため、ScanNetSecurity のような遅れ（45日）は見ない。
const NEWS_LAG_DAYS = 7;
const NEWS_KEYWORDS = /漏えい|漏洩|漏れ|流出|不正アクセス|不正ログイン|不正利用|誤送信|誤送付|誤公開|誤配|紛失|盗難|盗まれ|ランサム|サイバー攻撃|閲覧可能|閲覧できる|読み取れる/;

async function googleNews() {
  const items = new Map();
  const newsTo = [addDays(to, NEWS_LAG_DAYS), today].sort()[0];
  for (let a = articleFrom; a <= newsTo; a = addDays(a, 3)) {
    for (const q of NEWS_QUERIES) {
      // after は排他的、before も排他的に扱われる
      const query = `${q} after:${addDays(a, -1)} before:${addDays(a, 3)}`;
      const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`);
      for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1];
        const pub = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
        const raw = item.match(/<title>([\s\S]*?)<\/title>/)?.[1];
        if (!link || !pub || !raw) continue;
        const articleDate = new Date(pub).toISOString().slice(0, 10);
        if (articleDate < articleFrom || articleDate > newsTo || items.has(link)) continue;
        // 題名は「見出し - 媒体名」の形。媒体名は別に持つ
        const title = unescapeXml(raw).replace(/ - ([^-]+)$/, "");
        if (!NEWS_KEYWORDS.test(title)) continue; // 解説記事や無関係な記事を除く
        const outlet = unescapeXml(raw).match(/ - ([^-]+)$/)?.[1];
        if (outlet === "ScanNetSecurity") continue; // 情報源 1 で取得済み
        // links は空: Google ニュースのリンクは転送用で、公式発表の URL は含まれない
        items.set(link, { articleDate, title, articleUrl: link, source: `Google ニュース（${outlet ?? "不明"}）`, links: [] });
      }
    }
  }
  return [...items.values()];
}

// --- 統合: 同じ事案を1件にまとめる ---
// 題名の3文字の組の重なり（Jaccard）で同じ事案かを判定する。
// ScanNetSecurity の候補は公式発表の URL を持つので、互いに統合せずすべて残し、ニュース側を寄せる。
const grams = (t) => {
  const s = t.replace(/[\s\-　、。「」『』（）()・]/g, "");
  return new Set(Array.from({ length: Math.max(s.length - 2, 0) }, (_, i) => s.slice(i, i + 3)));
};
const jaccard = (a, b) => [...a].filter((x) => b.has(x)).length / (a.size + b.size - [...a].filter((x) => b.has(x)).length || 1);
const SAME_INCIDENT = 0.4;

function merge([withLinks = [], news = []]) {
  const kept = withLinks.map((c) => ({ ...c, grams: grams(c.title), alsoReportedBy: [] }));
  for (const c of news.sort((a, b) => a.articleDate.localeCompare(b.articleDate))) {
    const g = grams(c.title);
    const same = kept.find((k) => jaccard(g, k.grams) > SAME_INCIDENT);
    if (same) same.alsoReportedBy.push(c.source);
    else kept.push({ ...c, grams: g, alsoReportedBy: [] });
  }
  return kept.map(({ grams, ...c }) => c).sort((a, b) => b.articleDate.localeCompare(a.articleDate));
}

const sources = { ScanNetSecurity: scanNetSecurity, "Google ニュース": googleNews };
const bySource = {};
for (const [name, run] of Object.entries(sources)) {
  try {
    const list = await run();
    console.log(`${name}: ${list.length}件`);
    bySource[name] = list;
  } catch (e) {
    // 1つの情報源が壊れても、残りで続ける
    console.warn(`::warning::${name} の取得に失敗しました: ${e.message}`);
  }
}

const results = merge([bySource["ScanNetSecurity"], bySource["Google ニュース"]]);
if (results.length === 0) {
  console.error("候補が0件です。すべての情報源が失敗したか、サイトの構造が変わった可能性があります。");
  process.exit(1);
}

mkdirSync(".candidates", { recursive: true });
writeFileSync(".candidates/candidates.json", JSON.stringify(results, null, 1));

const direct = results.filter((r) => r.links.some((l) => !l.topPageOnly)).length;
console.log(`candidates: ${results.length} (公式発表の個別 URL あり: ${direct}, なし: ${results.length - direct})`);
