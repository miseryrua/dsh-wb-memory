// 只接受宿主对精确模型公告的档位；不猜测 none/off/thinking 参数。查询失败或超时按「未公告」处理。
async function advertisedEfforts(llm, provider, model, signal) {
  if (!provider || !model || typeof llm?.resolveModelInfo !== 'function') return []
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
    return (Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []).flatMap(e => typeof e?.id === 'string' ? [e.id] : [])
  } catch { return [] }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); ac.signal.removeEventListener('abort', onAbort) }
}

// 整理的思考策略固定（0.14.2 起不可配置）：宿主公告 off 档就关闭思考；
// 未公告时不传参数（可能仍按模型默认思考），也不回落 low。
export async function compactReasoningEffort(llm, provider, model, signal) {
  return (await advertisedEfforts(llm, provider, model, signal)).includes('off') ? 'off' : undefined
}
