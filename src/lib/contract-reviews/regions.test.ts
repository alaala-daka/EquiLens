import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeRegion } from "./regions"

test("地域输入统一为省级简称，带后缀写法不会原样进入审查", () => {
  assert.equal(normalizeRegion(" 北京市 "), "北京")
  assert.equal(normalizeRegion("上海市"), "上海")
  assert.equal(normalizeRegion("广东省"), "广东")
  assert.equal(normalizeRegion("广西壮族自治区"), "广西")
  assert.equal(normalizeRegion("内蒙古自治区"), "内蒙古")
  assert.equal(normalizeRegion("香港特别行政区"), "香港")
  assert.equal(normalizeRegion(""), "")
})
