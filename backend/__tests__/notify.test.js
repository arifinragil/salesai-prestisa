const { notifyMessage, notifyHandover, notifyConvUpdated, setIO, getIO } = require('../services/notify');

const fakeRoom = {
  emit: jest.fn(),
};
const fakeIO = {
  to: jest.fn().mockReturnValue(fakeRoom),
};

beforeEach(() => {
  fakeIO.to.mockClear();
  fakeRoom.emit.mockClear();
  setIO(fakeIO);
});

test('notifyMessage emits crm:message to conv room', () => {
  notifyMessage({ conversation_id: 5, message: { id: 1, body: 'hi' } });
  expect(fakeIO.to).toHaveBeenCalledWith('crm:conv:5');
  expect(fakeRoom.emit).toHaveBeenCalledWith('crm:message', expect.objectContaining({ conversation_id: 5 }));
});

test('notifyHandover emits to inbox + monitor rooms', () => {
  notifyHandover({ conversation_id: 5, reason: 'complaint', summary: 'late delivery' });
  expect(fakeIO.to).toHaveBeenCalledWith('crm:inbox');
  expect(fakeIO.to).toHaveBeenCalledWith('crm:monitor');
  expect(fakeRoom.emit).toHaveBeenCalledWith('crm:handover', expect.objectContaining({ reason: 'complaint' }));
});

test('notifyConvUpdated emits to inbox', () => {
  notifyConvUpdated(7);
  expect(fakeIO.to).toHaveBeenCalledWith('crm:inbox');
  expect(fakeRoom.emit).toHaveBeenCalledWith('crm:conv-updated', { conversation_id: 7 });
});

test('no-op when io not set', () => {
  setIO(null);
  expect(() => notifyMessage({ conversation_id: 1, message: {} })).not.toThrow();
});
