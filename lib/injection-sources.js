// 仅从最终组装文本投影来源；不重新读取文件，不推断模型实际采用。
// 标题归属是可观测启发式：正文伪造同级标题可造成歧义，不能作为权限/事实裁决。
export function projectInjectionSources(block) {
  if (typeof block !== 'string') return []
  const re = /^(?:## 全局用户记忆.*|### 置顶记忆.*|### 长期记忆 \/.*|### 今日日志.*|### 近 .*日回顾.*|## 当前工作区.*|## 未匹配到工作区.*|## 可用工作区.*|## 记忆纪律.*)$/gm
  const heads = [...block.matchAll(re)]
  const sources = []
  for (let i = 0; i < heads.length; i++) {
    const heading = heads[i][0]
    const layer = heading.startsWith('## 全局用户记忆') ? 'profile'
      : heading.startsWith('### 置顶记忆') ? 'pinned'
      : heading.startsWith('### 长期记忆 / 相关') ? 'memory'
      : heading.startsWith('### 长期记忆 /') ? 'summary'
      : heading.startsWith('### 今日日志') ? 'today'
      : heading.startsWith('### 近 ') ? 'review' : null
    if (!layer) continue
    const text = block.slice(heads[i].index + heading.length, heads[i + 1]?.index ?? block.length).trim()
    if (!text) continue
    sources.push({ sourceId: layer + '-' + sources.length, layer, label: heading.replace(/^#+\s*/, '').slice(0, 160), text })
  }
  return sources
}
