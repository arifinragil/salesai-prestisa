test('jest is wired up', () => {
  expect(1 + 1).toBe(2);
});

test('env loaded', () => {
  expect(process.env.PG_DATABASE).toBeDefined();
});
