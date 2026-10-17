/** Named WebServer routes bypass Connection's /api prefix. Delegate explicitly.
 * No credential parsing, Host allowlist, or authentication cache lives here.
 */
export function protectRoute(handler, getConnection) {
  return async function protectedRoute(req, res) {
    let rejection
    try {
      const connection = getConnection()
      if (typeof connection?.requestRejection !== 'function') return refuse(res, 503)
      rejection = connection.requestRejection(req)
      // The documented synchronous contract is undefined | 401 | 403.
      if (rejection !== undefined && rejection !== 401 && rejection !== 403) {
        // Consume a non-contract promise rejection without admitting the request.
        if (typeof rejection?.then === 'function') Promise.resolve(rejection).catch(() => {})
        return refuse(res, 503)
      }
    } catch { return refuse(res, 503) }
    if (rejection !== undefined) return refuse(res, rejection)
    return handler(req, res)
  }
}
function refuse(res, status) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ error: status === 503 ? '宿主鉴权不可用，接口已安全停用' : status === 401 ? '请通过DSH启动地址登录后重试' : '请求未通过宿主信任检查' }))
}
