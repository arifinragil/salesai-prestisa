function notImplemented() {
  throw new Error('metaCloudAdapter is a Phase 2 stub. Set WA_PROVIDER=waha for pilot.');
}

module.exports = {
  name: 'metaCloud',
  sendText: notImplemented,
  sendImage: notImplemented,
  sendFile: notImplemented,
  parseInbound: notImplemented,
};
