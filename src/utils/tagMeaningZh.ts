/**
 * WD14 反推高频词条中英词典（2026-08-29 新增）。
 *
 * 来源：wd-v1-4-moat-tagger-v2.csv 按 Danbooru 出现次数排序的未收录高频词
 * （general 前 400 + character 前 150）。只做整词精确命中（key 为 cleanTag
 * 归一后的形式：小写、连字符转下划线），不参与逐词回退，避免歧义。
 *
 * 由 tagMeaning.ts 静态引入（二者同属懒加载 chunk，不占路由主包）。
 * 后续可按需追加：node scripts/tests/extract-wd14-untranslated.js <n> <m> 可
 * 随时重新生成下一批待翻译词表。
 */
import { tagMeaningGeneralZh } from './tagMeaningGeneralZh.ts'
import { tagMeaningCharactersZh } from './tagMeaningCharactersZh.ts'
import { tagMeaningExtendedZh } from './tagMeaningExtendedZh.ts'
import { tagMeaningScenesZh } from './tagMeaningScenesZh.ts'
export const WD14_ZH: Record<string, string> = {
  ...tagMeaningGeneralZh,
  ...tagMeaningCharactersZh,
  ...tagMeaningExtendedZh,
  ...tagMeaningScenesZh,
}
