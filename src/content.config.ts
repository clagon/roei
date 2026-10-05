import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// このスキーマが収集データの検証も兼ねる（pnpm build が失敗したら push しない）
export const categories = ["不正アクセス", "ランサムウェア", "誤送信", "紛失・盗難", "内部不正", "設定ミス", "その他"] as const;
export const industries = ["行政・自治体", "教育", "医療", "金融", "小売・EC", "IT・通信", "製造", "インフラ", "サービス", "その他"] as const;

const incidents = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./data/incidents" }),
  schema: z.object({
    organization: z.string().min(1),
    publishedAt: z.iso.date(),
    title: z.string().min(1),
    summary: z.string().min(1),
    category: z.enum(categories),
    industry: z.enum(industries).optional(),
    records: z
      .object({
        count: z.int().positive(),
        qualifier: z.enum(["約", "最大", "以上"]).optional(),
      })
      .optional(),
    dataTypes: z.array(z.string().min(1)).optional(),
    occurredAt: z.iso.date().optional(),
    discoveredAt: z.iso.date().optional(),
    // 第1報・続報。一次情報 URL を最低1件必須とする
    reports: z
      .array(
        z.object({
          date: z.iso.date(),
          url: z.url({ protocol: /^https?$/ }),
          summary: z.string().min(1),
        }),
      )
      .min(1),
  }),
});

export const collections = { incidents };
