import { createHash } from 'node:crypto'

export const memoryRevision = (text) => createHash('sha256').update(text).digest('hex')

// 保留原条目边界：代码围栏中的标题不算条目。
export function memoryHeadings(text) {
  const headers = []
  let fence = null
  for (const line of text.matchAll(/^[^\r\n]*(?:\r?\n|$)/gm)) {
    const delimiter = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)/.exec(line[0])
    if (delimiter) {
      const [marker, tail] = delimiter.slice(1)
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && !tail.trim()) fence = null
      continue
    }
    if (fence) continue
    const heading = /^##[^\S\r\n]+([^\r\n]*)(?:\r?\n|$)/.exec(line[0])
    if (heading) { heading.index = line.index; headers.push(heading) }
  }
  return headers.map(h => ({ start: h.index, title: h[1].trim() }))
}
