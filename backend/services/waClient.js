const provider = process.env.WA_PROVIDER || 'waha';

let adapter;
if (provider === 'waha') {
  adapter = require('./waAdapters/wahaAdapter');
} else if (provider === 'metaCloud') {
  adapter = require('./waAdapters/metaCloudAdapter');
} else {
  throw new Error(`unknown WA_PROVIDER: ${provider}`);
}

module.exports = {
  provider: adapter.name,
  sendText: (opts) => adapter.sendText(opts),
  parseInbound: (raw) => adapter.parseInbound(raw),
};
