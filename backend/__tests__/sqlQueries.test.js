const sq = require('../services/sqlQueries');

describe('validateSqlText', () => {
  test('accepts SELECT', () => expect(sq.validateSqlText('SELECT * FROM products LIMIT 5')).toBeNull());
  test('rejects empty', () => expect(sq.validateSqlText('')).toMatch(/empty/));
  test('rejects non-SELECT', () => expect(sq.validateSqlText('UPDATE x SET y=1')).toMatch(/SELECT/));
  test('rejects forbidden keywords', () => {
    expect(sq.validateSqlText('SELECT * FROM x; DROP TABLE y')).toMatch(/forbidden|multiple/);
    expect(sq.validateSqlText('SELECT * FROM (DELETE FROM x) z')).toMatch(/forbidden/);
  });
  test('rejects multi-statement', () => {
    expect(sq.validateSqlText('SELECT 1; SELECT 2')).toMatch(/multiple/);
  });
  test('allows trailing semicolon', () => {
    expect(sq.validateSqlText('SELECT 1;')).toBeNull();
  });
  test('ignores SQL comments when checking forbidden', () => {
    expect(sq.validateSqlText('SELECT 1 /* DELETE this is a comment */ FROM x')).toBeNull();
  });
});

describe('validateParamsSchema', () => {
  test('accepts well-formed params', () => {
    expect(sq.validateParamsSchema([{ name: 'kota', type: 'string', required: true }])).toBeNull();
  });
  test('rejects bad name', () => {
    expect(sq.validateParamsSchema([{ name: '1bad' }])).toMatch(/invalid param name/);
  });
  test('rejects unknown type', () => {
    expect(sq.validateParamsSchema([{ name: 'x', type: 'datetime' }])).toMatch(/invalid param type/);
  });
  test('rejects non-array', () => {
    expect(sq.validateParamsSchema('foo')).toMatch(/array/);
  });
});

describe('buildBindings', () => {
  const query = {
    sql_text: 'SELECT * FROM products WHERE name LIKE :q AND price >= :min',
    params: [{ name: 'q', type: 'string', required: true }, { name: 'min', type: 'integer' }],
  };

  test('substitutes :params with ? + values in order', () => {
    const out = sq.buildBindings(query, { q: 'Mawar', min: 100000 });
    expect(out.sql).toBe('SELECT * FROM products WHERE name LIKE ? AND price >= ?');
    expect(out.values).toEqual(['Mawar', 100000]);
  });

  test('integer param coerced from string', () => {
    const out = sq.buildBindings(query, { q: 'X', min: '500000' });
    expect(out.values[1]).toBe(500000);
  });

  test('throws on missing required param', () => {
    expect(() => sq.buildBindings(query, { min: 100 })).toThrow(/required/);
  });

  test('non-required param defaults to null', () => {
    const out = sq.buildBindings(query, { q: 'X' });
    expect(out.values).toEqual(['X', null]);
  });

  test('integer param rejects non-numeric', () => {
    expect(() => sq.buildBindings(query, { q: 'X', min: 'abc' })).toThrow(/integer/);
  });
});

describe('ensureLimit', () => {
  test('preserves existing LIMIT', () => {
    expect(sq.ensureLimit('SELECT * FROM x LIMIT 5', 100)).toMatch(/LIMIT 5/);
  });
  test('injects LIMIT when missing', () => {
    expect(sq.ensureLimit('SELECT * FROM x', 20)).toMatch(/LIMIT 20$/);
  });
  test('handles trailing semicolon', () => {
    expect(sq.ensureLimit('SELECT * FROM x;', 20)).toMatch(/LIMIT 20$/);
  });
});

describe('extractParamNames', () => {
  test('finds all :params', () => {
    expect(sq.extractParamNames('SELECT * WHERE a = :x AND b = :y AND c = :x'))
      .toEqual(['x', 'y']);
  });
  test('empty when no params', () => {
    expect(sq.extractParamNames('SELECT 1')).toEqual([]);
  });
});
