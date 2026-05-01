module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFiles: ['<rootDir>/__tests__/setupEnv.js'],
  testTimeout: 15000,
  verbose: true,
  collectCoverageFrom: ['services/**/*.js', 'routes/**/*.js', 'middleware/**/*.js'],
};
