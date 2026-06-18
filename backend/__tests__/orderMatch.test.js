'use strict';
// Pure-function tests for orderMatch.normalizePhone (no DB).
const { normalizePhone } = require('../services/orderMatch');

test('normalizePhone: clean 628 number -> last 10 digits', () => {
  expect(normalizePhone('6281377492022')).toBe('1377492022');
});

test('normalizePhone: 08 local and 628 international collapse to same key', () => {
  // same subscriber, different prefixes -> must match
  expect(normalizePhone('081377492022')).toBe(normalizePhone('6281377492022'));
});

test('normalizePhone: +62 with spaces/dashes normalizes', () => {
  expect(normalizePhone('+62 813-7749-2022')).toBe('1377492022');
});

test('normalizePhone: too-short / empty -> null', () => {
  expect(normalizePhone('123')).toBeNull();
  expect(normalizePhone('')).toBeNull();
  expect(normalizePhone(null)).toBeNull();
  expect(normalizePhone(undefined)).toBeNull();
});
