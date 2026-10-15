import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import type { IncomingMessage } from 'node:http';

const [directory, upstreamPort] = process.argv.slice(2);
if (directory === undefined || upstreamPort === undefined) throw new Error('Missing proxy inputs');
const options = (incoming: IncomingMessage) => {
  const peer = incoming.socket.remoteAddress?.replace(/^::ffff:/, '');
  if (peer === undefined || incoming.headers.host === undefined)
    throw new Error('Missing proxy peer or authority');
  const headers = { ...incoming.headers };
  delete headers.forwarded;
  headers['x-forwarded-host'] = incoming.headers.host;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = peer;
  return {
    hostname: 'dsh-team-platform',
    port: Number(upstreamPort),
    method: incoming.method,
    path: incoming.url,
    headers,
  };
};
const server = createServer(
  {
    key: readFileSync(`${directory}/key.pem`),
    cert: readFileSync(`${directory}/cert.pem`),
  },
  (incoming, outgoing) => {
    const correlation = incoming.headers['x-test-correlation'];
    if (typeof correlation === 'string' && /^[a-f0-9-]{36}$/.test(correlation))
      process.stdout.write(
        `${JSON.stringify({ correlation, peer: incoming.socket.remoteAddress?.replace(/^::ffff:/, '') })}\n`,
      );
    const upstream = request(options(incoming), (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on('error', () => outgoing.destroy());
    });
    upstream.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  },
);
server.on('upgrade', (incoming, socket, head) => {
  const upstream = request(options(incoming));
  upstream.on('upgrade', (response, peer, upstreamHead) => {
    socket.write(`HTTP/1.1 ${String(response.statusCode)} ${response.statusMessage ?? ''}\r\n`);
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined)
        socket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
    }
    socket.write('\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) peer.write(head);
    socket.on('error', () => peer.destroy());
    peer.on('error', () => socket.destroy());
    socket.on('close', () => peer.destroy());
    peer.on('close', () => socket.destroy());
    socket.pipe(peer).pipe(socket);
  });
  upstream.on('response', (response) => {
    response.resume();
    socket.destroy();
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
});
server.listen(8443, '0.0.0.0');
