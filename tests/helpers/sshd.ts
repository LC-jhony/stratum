import net from 'node:net'
import { Server, utils } from 'ssh2'

/**
 * Minimal in-process sshd for tunnel tests: password authentication plus TCP/IP forwarding
 * (`direct-tcpip` arrives as the `tcpip` event on the connection) to the requested destination.
 * Being a real SSH server, it exercises the same code path as production, on loopback only.
 */
export function startSshd(password: string): Server {
  const keys = utils.generateKeyPairSync('ed25519')
  return new Server({ hostKeys: [keys.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === password) ctx.accept()
      else ctx.reject()
    })
    client.on('tcpip', (acceptConn, _rejectConn, info: { destIP: string; destPort: number | string }) => {
      const channel = acceptConn()
      const upstream = net.connect(Number(info.destPort), info.destIP)
      upstream.on('connect', () => { channel.pipe(upstream); upstream.pipe(channel) })
      upstream.on('error', () => channel.destroy())
    })
    client.on('error', () => { /* rejected handshakes are asserted by the client side */ })
  })
}

/** Listens on an ephemeral loopback port and returns it. */
export function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  })
}
