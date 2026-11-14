/** @type {import('jest').Config} */
const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: true }],
  },
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/libs/*/test/**/*.test.ts'],
      testPathIgnorePatterns: ['\\.int\\.test\\.ts$'],
    },
    { ...base, displayName: 'integration', testMatch: ['<rootDir>/libs/*/test/**/*.int.test.ts'] },
  ],
};
