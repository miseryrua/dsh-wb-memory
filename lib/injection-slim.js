// 注入文本瘦身：只作用于「拼进系统提示的文本」，绝不回写 MEMORY.md。
// 内部簿记注释对模型无用且费 token：
//   - 提炼回执   <!-- wb-distill-batch:2026-11-06:<64 位十六进制> -->
//   - 管理标记   <!-- wb-memory:<base64url 元数据> -->
//   - 条目元数据 <!-- tags: … / date: … / expiry: … / importance: … -->
// 只剔除上述已知模式；用户自己写的其它 HTML 注释保持原样（宁可留，不误删）。
// 整行都是簿记注释的行连同换行一起删（不留空行）；夹在行内的连同前导空白删；
// 删后把 3 个及以上连续换行折成 2 个并去掉首尾空白。没有命中任何模式时原样返回（逐字节不变）。
const RECEIPT = /<!--\s*wb-distill-batch:[^>]*?-->/
const MARKER = /<!--\s*wb-memory\b[^>]*?-->/
const META_KEY = /(?:^|\/)\s*(?:tags|date|expiry|importance)\s*:/
const WHOLE_LINE = /^[ \t]*(<!--([\s\S]*?)-->)[ \t]*(?:\n|$)/gm
const INLINE = /[ \t]*(<!--([\s\S]*?)-->)/g

function isNoise(comment, inner) {
  return RECEIPT.test(comment) || MARKER.test(comment) || META_KEY.test(inner)
}

export function stripInjectionNoise(text) {
  if (typeof text !== 'string' || !text.includes('<!--')) return text
  let removed = false
  const drop = (all, comment, inner) => {
    if (!isNoise(comment, inner)) return all
    removed = true
    return ''
  }
  const out = text.replace(WHOLE_LINE, drop).replace(INLINE, drop)
  if (!removed) return text
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
