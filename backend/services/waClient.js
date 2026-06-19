const provider = process.env.WA_PROVIDER || 'waha';

let adapter;
if (provider === 'waha') {
  adapter = require('./waAdapters/wahaAdapter');
} else if (provider === 'metaCloud') {
  adapter = require('./waAdapters/metaCloudAdapter');
} else if (provider === 'vonage') {
  adapter = require('./waAdapters/vonageAdapter');
} else {
  throw new Error(`unknown WA_PROVIDER: ${provider}`);
}

module.exports = {
  provider: adapter.name,
  sendText: (opts) => adapter.sendText(opts),
  sendImage: (opts) => adapter.sendImage(opts),
  sendFile: (opts) => adapter.sendFile(opts),
  sendButtons: (opts) => adapter.sendButtons ? adapter.sendButtons(opts) : Promise.reject(new Error('buttons not supported')),
  sendList:    (opts) => adapter.sendList    ? adapter.sendList(opts)    : Promise.reject(new Error('list not supported')),
  parseInbound: (raw) => adapter.parseInbound(raw),
  getContact: (opts) => adapter.getContact ? adapter.getContact(opts) : Promise.resolve({ unsupported: true }),
  startTyping: (opts) => adapter.startTyping ? adapter.startTyping(opts) : Promise.resolve(),
  stopTyping:  (opts) => adapter.stopTyping  ? adapter.stopTyping(opts)  : Promise.resolve(),
  sendSeen:    (opts) => adapter.sendSeen    ? adapter.sendSeen(opts)    : Promise.resolve(),
  setPresence: (opts) => adapter.setPresence ? adapter.setPresence(opts) : Promise.resolve(),
  getProfile:  (opts) => adapter.getProfile  ? adapter.getProfile(opts)  : Promise.resolve({ unsupported: true }),
  setProfileName:    (opts) => adapter.setProfileName    ? adapter.setProfileName(opts)    : Promise.reject(new Error('not supported')),
  setProfileStatus:  (opts) => adapter.setProfileStatus  ? adapter.setProfileStatus(opts)  : Promise.reject(new Error('not supported')),
  setProfilePicture: (opts) => adapter.setProfilePicture ? adapter.setProfilePicture(opts) : Promise.reject(new Error('not supported')),
  sendTemplate: (opts) => adapter.sendTemplate ? adapter.sendTemplate(opts) : Promise.reject(new Error('template not supported')),
};
