/** 省级行政区简称；界面提供候选，仍允许输入其他有效地区。 */
export const REGIONS = ["北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆", "香港", "澳门", "台湾"] as const

const suffix = /(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/
export function normalizeRegion(value: string): string {
  const compact = value.trim().replace(/\s+/g, "")
  return compact.replace(suffix, "") || compact
}
