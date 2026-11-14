// 迭代 F2：自动整理「连续进展不足」后停手（纯函数；状态存于 distilled.json 的 <工作区>.__compact__.autoPause）。
// 背景：整理结果仍超阈值且缩短不足 COMPACT_MIN_PROGRESS 时被拒收（insufficient-progress），原文不变；
// 库本身压不动时，每个逻辑日都会再空转一次（实测一次约 2 次模型调用）。连续 2 次后停手，不再调用模型。
//
// 计数口径：只计 insufficient-progress。
// - 保真/校验失败（fidelity/validation）与模型调用错误（timeout/llm-*/unknown）：多为瞬时或输出质量问题，
//   与「库压不动」无关；既不计数，也不清零（保留已有计数，一次超时不应抹掉真实的停滞信号）。
// - 成功写回（ok）：清零。写入冲突（conflict）不写 __compact__，状态原样保留。
// - 手动整理（force）不计数，开始时即清除停手状态；手动「重试失败」按自动口径计数，但不受停手拦截。
export const COMPACT_AUTOPAUSE_AFTER = 2 // 连续进展不足达到此次数即停手
export const COMPACT_AUTOPAUSE_RELEASE_DELTA = 0.15 // 库字符数相对 baselineChars 变化达此比例（任一方向）即解除

const num = v => Number.isFinite(v) && v >= 0 ? v : null
const isoOrNull = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null
const dayOrNull = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null

// 本次整理结果对应的新状态；返回 null 表示无状态（调用方删除该字段）。
export function nextAutoPause(prev, outcome, rawChars, at, day) {
  if (!outcome) return prev || null
  if (outcome.ok === true) return null
  if (outcome.errorCode !== 'insufficient-progress') return prev || null
  const before = outcome.before, after = outcome.after
  const lastRatio = before > 0 && Number.isFinite(after) ? Math.max(0, Math.round((1 - after / before) * 10000) / 10000) : null
  return {
    since: (prev && prev.since) || at, count: ((prev && prev.count) || 0) + 1, lastAt: at, lastDay: day,
    lastInputChars: before, lastAfterChars: after, lastRatio, baselineChars: rawChars,
  }
}

// 当前库字符数 chars / 阈值 threshold 下的状态：none | counting（未满次数）| paused | released（应清除）。
export function autoPauseState(pause, chars, threshold) {
  if (!pause || !(pause.count > 0)) return { state: 'none' }
  if (Number.isFinite(threshold) && Number.isFinite(chars) && chars <= threshold) return { state: 'released', reason: 'under-threshold' }
  const base = pause.baselineChars
  if (base > 0 && Number.isFinite(chars) && Math.abs(chars - base) / base >= COMPACT_AUTOPAUSE_RELEASE_DELTA) return { state: 'released', reason: 'library-changed' }
  return { state: pause.count >= COMPACT_AUTOPAUSE_AFTER ? 'paused' : 'counting' }
}

// 状态接口投影：只含数字与日期，不含记忆正文。paused 已按当前库大小折算（库已变化时为 false，下次巡检会清除记录）。
export function autoPauseView(pause, chars, threshold) {
  if (!pause || !(pause.count > 0)) return null
  return {
    paused: autoPauseState(pause, chars, threshold).state === 'paused', count: num(pause.count), after: COMPACT_AUTOPAUSE_AFTER,
    since: isoOrNull(pause.since), lastAt: isoOrNull(pause.lastAt), lastDay: dayOrNull(pause.lastDay) || dayOrNull(pause.lastAt),
    lastInputChars: num(pause.lastInputChars), lastAfterChars: num(pause.lastAfterChars), lastRatio: num(pause.lastRatio),
    baselineChars: num(pause.baselineChars), releaseDelta: COMPACT_AUTOPAUSE_RELEASE_DELTA, skippedDay: dayOrNull(pause.skippedDay),
  }
}
