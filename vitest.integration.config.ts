const config = {
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/helpers/tempDirGuard.ts"],
    setupFiles: ["tests/helpers/setupTempDirs.ts"],
    testTimeout: 30_000,
  },
};

export default config;
