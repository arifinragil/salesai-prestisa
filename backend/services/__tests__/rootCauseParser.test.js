const assert = require('node:assert');
const { parseRootCauseFromSummary } = require('../rootCauseParser');

// Happy path
const out1 = parseRootCauseFromSummary(`## A. 5 Why\nfoo\n## D. Action\nbar\n{"root_cause_tag":"harga_terlalu_mahal","confidence":0.85}`);
assert.strictEqual(out1.tag, 'harga_terlalu_mahal');
assert.strictEqual(out1.confidence, 0.85);
assert.ok(!out1.summary.includes('root_cause_tag'), 'JSON stripped from summary');

// Invalid tag → null
const out2 = parseRootCauseFromSummary(`foo\n{"root_cause_tag":"bogus","confidence":0.5}`);
assert.strictEqual(out2.tag, null);

// No JSON
const out3 = parseRootCauseFromSummary(`just plain summary`);
assert.strictEqual(out3.tag, null);
assert.strictEqual(out3.summary, 'just plain summary');

// Confidence out of range
const out4 = parseRootCauseFromSummary(`foo\n{"root_cause_tag":"lainnya","confidence":2.5}`);
assert.strictEqual(out4.tag, 'lainnya');
assert.strictEqual(out4.confidence, null);

console.log('OK rootCauseParser');
