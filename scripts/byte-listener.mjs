import net from 'node:net';

/** One owned listener, one fixed destination, and byte-preserving paired streams. */
export function byteListener(address) {
  const sockets = new Set();
  let destination;
  /** @type {Promise<void> | undefined} */
  let closing;
  let stopped = false;
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = net.createServer({ allowHalfOpen: true }, (incoming) => {
    const left = track(incoming);
    if (stopped || destination === undefined) {
      left.destroy();
      return;
    }
    const right = track(net.connect({ ...destination, allowHalfOpen: true }));
    const abort = () => {
      left.destroy();
      right.destroy();
    };
    left.on('error', abort);
    right.on('error', abort);
    for (const [socket, peer] of [
      [left, right],
      [right, left],
    ]) {
      socket.once('close', (hadError) => {
        if (hadError || !socket.readableEnded || !socket.writableFinished) peer.destroy();
      });
    }
    left.pipe(right);
    right.pipe(left);
  });
  const started = Promise.withResolvers();
  server.once('error', started.reject);
  try {
    server.listen(address, () => {
      server.off('error', started.reject);
      started.resolve(undefined);
    });
  } catch (error) {
    server.off('error', started.reject);
    started.reject(error);
  }
  return {
    server,
    ready: started.promise,
    forwardTo: (target) => {
      if (stopped || destination !== undefined)
        throw new Error('Byte listener destination is already fenced');
      destination = { ...target };
    },
    close: () => {
      stopped = true;
      return (closing ??= (async () => {
        // Settle the original bind before closing; a rejected observer is not bind cancellation.
        await started.promise.catch(() => undefined);
        const listenerClosed = Promise.withResolvers();
        try {
          server.close((error) => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') listenerClosed.reject(error);
            else listenerClosed.resolve(undefined);
          });
        } catch (error) {
          listenerClosed.reject(error);
        }
        const socketClosures = [...sockets].map((socket) => {
          const closed = Promise.withResolvers();
          socket.once('close', () => closed.resolve(undefined));
          socket.destroy();
          return closed.promise;
        });
        await Promise.all([listenerClosed.promise, ...socketClosures]);
      })());
    },
  };
}
