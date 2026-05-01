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
  });
};
