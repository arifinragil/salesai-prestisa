module.exports = function attachSocket(io) {
  io.on('connection', (socket) => {
    socket.on('crm:join-conv', (id) => {
      const n = parseInt(id);
      if (n) socket.join(`crm:conv:${n}`);
    });
    socket.on('crm:leave-conv', (id) => {
      const n = parseInt(id);
      if (n) socket.leave(`crm:conv:${n}`);
    });
    socket.on('crm:join-inbox', () => socket.join('crm:inbox'));
    socket.on('crm:join-monitor', () => socket.join('crm:monitor'));
    socket.on('crm:join-lotus', (id) => {
      if (typeof id === 'string' && /^[a-zA-Z0-9_\-]{8,64}$/.test(id)) {
        socket.join(`crm:lotus:${id}`);
      }
    });
    socket.on('crm:leave-lotus', (id) => {
      if (typeof id === 'string') socket.leave(`crm:lotus:${id}`);
    });
    socket.on('crm:join-lotus-inbox', () => socket.join('crm:lotus-inbox'));
  });
};
