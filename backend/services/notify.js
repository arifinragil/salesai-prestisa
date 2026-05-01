let io = null;

function setIO(ioInstance) { io = ioInstance; }
function getIO() { return io; }

function notifyMessage({ conversation_id, message }) {
  if (!io) return;
  io.to(`crm:conv:${conversation_id}`).emit('crm:message', { conversation_id, message });
  io.to('crm:inbox').emit('crm:conv-updated', { conversation_id });
}

function notifyHandover({ conversation_id, reason, summary }) {
  if (!io) return;
  const payload = { conversation_id, reason, summary, at: new Date().toISOString() };
  io.to('crm:inbox').emit('crm:handover', payload);
  io.to('crm:monitor').emit('crm:handover', payload);
}

function notifyConvUpdated(conversation_id) {
  if (!io) return;
  io.to('crm:inbox').emit('crm:conv-updated', { conversation_id });
}

function notifyMetrics(payload) {
  if (!io) return;
  io.to('crm:monitor').emit('crm:metrics', payload);
}

module.exports = { setIO, getIO, notifyMessage, notifyHandover, notifyConvUpdated, notifyMetrics };
