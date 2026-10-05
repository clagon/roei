import type { CollectionEntry } from "astro:content";

type Records = CollectionEntry<"incidents">["data"]["records"];

export function formatRecords(r: Records) {
  if (!r) return "不明";
  const n = `${r.count.toLocaleString("ja-JP")}件`;
  if (r.qualifier === "約") return `約${n}`;
  if (r.qualifier === "最大") return `最大${n}`;
  if (r.qualifier === "以上") return `${n}以上`;
  return n;
}

export const sizes = ["1,000件未満", "1,000〜10万件", "10万件以上", "不明"] as const;

export function sizeOf(r: Records): (typeof sizes)[number] {
  if (!r) return "不明";
  if (r.count < 1000) return "1,000件未満";
  if (r.count < 100000) return "1,000〜10万件";
  return "10万件以上";
}
