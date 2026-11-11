// 只接受宿主对精确模型公告的档位；不猜测 none/off/thinking 参数。
export async function compactReasoningInfo(llm, provider, model, signal) {
  if (!provider || !model || typeof llm?.resolveModelInfo !== 'function') return { available: false, efforts: [] }
  const ac = new AbortController()
  const abort = () => ac.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) ac.abort()
  let timer, onAbort
  try {
    const stop = new Promise((_, reject) => {
      onAbort = () => reject(new Error('reasoning-lookup-failed'))
      ac.signal.addEventListener('abort', onAbort, { once: true })
      if (ac.signal.aborted) onAbort()
      timer = setTimeout(() => ac.abort(), 5000)
    })
    const info = await Promise.race([Promise.resolve().then(() => llm.resolveModelInfo(provider, model, ac.signal)), stop])
    const seen = new Set()
    const efforts = (Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []).flatMap(e => {
      if (typeof e?.id !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(e.id) || ['auto','default'].includes(e.id) || seen.has(e.id)) return []
      seen.add(e.id)
      return [{ id: e.id, name: typeof e.name === 'string' ? e.name.slice(0,80) : e.id }]
    })
    return { available: true, efforts }
  } catch { return { available: false, efforts: [] } }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); ac.signal.removeEventListener('abort', onAbort) }
}
export async function compactReasoningOption(llm, provider, model, choice, explicit, signal) {
  if (choice === 'default') return undefined // 不传参数，使用提供方默认
  const info = await compactReasoningInfo(llm, provider, model, signal)
  // off 是宿主公告的关闭档位；未公告时不猜测 wire 参数，也不回落 low。
  if (!choice || choice === 'auto') return info.efforts.some(e => e.id === 'off') ? 'off' : undefined
  if (!info.available || !info.efforts.some(e => e.id === choice)) throw new Error('reasoning-unavailable')
  return choice
}
