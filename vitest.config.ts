const config = {
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/helpers/tempDirGuard.ts"],
    setupFiles: ["tests/helpers/setupTempDirs.ts"],
    // Run files and tests in random order so shared state between tests
    // shows up. Reproduce a failure with --sequence.seed=<printed seed>.
    sequence: { shuffle: true },
  },
};

export default config;
