// PoC gateway: gateway login cookie -> per-user DSH upstream, DSH auth cookie held server-side.
import http from 'node:http'
import net from 'node:net'
const AUTHORITY = 'localhost:8080'
const users = { a: { port: 13081, token: process.env.TOKEN_A }, b: { port: 13082, token: process.env.TOKEN_B } }
async function dshCookie(u) {
  if (u.cookie) return u.cookie
  const { status, set } = await new Promise((resolve, reject) => {
    // node fetch cannot override Host, and the DSH cookie is bound to the request authority
    http.get({ host: '127.0.0.1', port: u.port, path: `/?token=${u.token}`, headers: { host: AUTHORITY } }, r => {
      r.resume(); resolve({ status: r.statusCode, set: r.headers['set-cookie']?.[0] })
    }).on('error', reject)
  })
  if (status !== 303 || !set) throw new Error(`token exchange failed: ${status}`)
  return (u.cookie = set.split(';')[0])
}
function userOf(req) {
  const m = /(?:^|;\s*)gw_user=([ab])/.exec(req.headers.cookie ?? '')
  return m ? users[m[1]] : undefined
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/__login') {
    const u = url.searchParams.get('u')
    if (!users[u]) return res.writeHead(400).end('bad user')
    return res.writeHead(303, { 'set-cookie': `gw_user=${u}; Path=/; HttpOnly; SameSite=Lax`, location: '/' }).end()
  }
  const u = userOf(req)
  if (!u) return res.writeHead(401).end('login required')
  const headers = { ...req.headers, host: AUTHORITY, cookie: await dshCookie(u) }
  const up = http.request({ host: '127.0.0.1', port: u.port, method: req.method, path: req.url, headers }, upRes => {
    const h = { ...upRes.headers }; delete h['set-cookie']
    res.writeHead(upRes.statusCode, h); upRes.pipe(res)
  })
  up.on('error', e => res.writeHead(502).end(String(e)))
  req.pipe(up)
})
server.on('upgrade', async (req, socket, head) => {
  const u = userOf(req)
  if (!u) return socket.destroy()
  const cookie = await dshCookie(u)
  const up = net.connect(u.port, '127.0.0.1', () => {
    const h = { ...req.headers, host: AUTHORITY, cookie }
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
    up.write(head); socket.pipe(up); up.pipe(socket)
  })
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy())
})
server.listen(8080, '127.0.0.1', () => console.log('gateway on http://localhost:8080'))
