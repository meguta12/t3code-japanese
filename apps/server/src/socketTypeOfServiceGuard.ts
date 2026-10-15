import * as NodeNet from "node:net";

const GUARD_MARKER = Symbol.for("t3code.socketTypeOfServiceGuard");

type GuardableSocketPrototype = NodeNet.Socket & {
  setTypeOfService?: (this: NodeNet.Socket, tos: number) => NodeNet.Socket;
  [GUARD_MARKER]?: true;
};

// Node 24's bundled undici calls `socket.setTypeOfService` while writing an
// HTTP/1 request. On macOS that syscall can fail with EINVAL (for example on a
// socket the peer already closed, or an IPv6 loopback socket). The error is
// thrown synchronously from a socket event handler, so nothing upstream can
// catch it and the whole backend process exits, taking every provider session
// down with it. The type-of-service hint is optional, so ignore EINVAL.
export function installSocketTypeOfServiceGuard(
  prototype: GuardableSocketPrototype = NodeNet.Socket.prototype as GuardableSocketPrototype,
): void {
  const original = prototype.setTypeOfService;
  if (typeof original !== "function" || prototype[GUARD_MARKER]) return;

  prototype.setTypeOfService = function guardedSetTypeOfService(this: NodeNet.Socket, tos) {
    try {
      return original.call(this, tos);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EINVAL") return this;
      throw error;
    }
  };
  prototype[GUARD_MARKER] = true;
}

installSocketTypeOfServiceGuard();
