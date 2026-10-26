export type RecommendSourceValue =
  | 'douban'
  | 'bangumi'
  | 'hot-list'
  | 'douban-top250'
  | 'bili'
  | 'anilist'
  | 'tvmaze';

/**
 * 部署者通过 DEFAULT_RECOMMEND_SOURCE 环境变量指定的首页推荐数据源默认值。
 * 可选值：douban（豆瓣热门）/ bangumi（Bangumi 新番放送）/ hot-list（影视热榜）/
 * douban-top250（豆瓣高分电影 Top250）/ bili（B站影视榜）/ anilist（AniList 动漫趋势）/
 * tvmaze（TVMaze 欧美剧排期）。
 * 未配置返回 undefined（沿用内置默认 hot-list）；取值非法时告警并忽略，不影响站点运行。
 */
export function getEnvRecommendSource(): RecommendSourceValue | undefined {
  const raw = process.env.DEFAULT_RECOMMEND_SOURCE?.trim().toLowerCase();
  if (!raw) return undefined;
  const valid: RecommendSourceValue[] = [
    'douban',
    'bangumi',
    'hot-list',
    'douban-top250',
    'bili',
    'anilist',
    'tvmaze',
  ];
  if ((valid as string[]).includes(raw)) return raw as RecommendSourceValue;
  console.warn(
    '[LibreTV] DEFAULT_RECOMMEND_SOURCE 取值无效，已忽略（可选 douban / bangumi / hot-list / douban-top250 / bili / anilist / tvmaze）：',
    raw
  );
  return undefined;
}
