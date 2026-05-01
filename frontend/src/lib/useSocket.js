import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

let sharedSocket = null;
function getSocket() {
  if (sharedSocket && sharedSocket.connected) return sharedSocket;
  if (!sharedSocket) {
    sharedSocket = io({
      withCredentials: true,
      autoConnect: true,
      transports: ['websocket', 'polling'],
    });
  }
  return sharedSocket;
}

/**
 * Subscribe to one or more Socket.IO events while the component is mounted.
 *
 * @param {Record<string, (payload: any) => void>} handlers - event name -> callback
 * @param {{ joinRooms?: Array<{event: string, arg?: any}> }} [opts]
 */
export function useSocket(handlers, opts = {}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const sock = getSocket();
    const { joinRooms = [] } = opts;

    const stableHandlers = {};
    for (const evt of Object.keys(handlersRef.current)) {
      stableHandlers[evt] = (payload) => handlersRef.current[evt]?.(payload);
      sock.on(evt, stableHandlers[evt]);
    }

    for (const room of joinRooms) {
      sock.emit(room.event, room.arg);
    }

    return () => {
      for (const evt of Object.keys(stableHandlers)) {
        sock.off(evt, stableHandlers[evt]);
      }
      // Optional: leave rooms (skipped — many components share connection)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(opts.joinRooms || [])]);
}
