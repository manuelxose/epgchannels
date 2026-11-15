import { defineConfig } from 'vitest/config';

/**
 * Three project groups, each with its own folder and timeout policy:
 *
 * | project       | what it proves                                              |
 * | ------------- | ----------------------------------------------------------- |
 * | unit          | pure logic: policy, parsers, mappers, security primitives   |
 * | integration   | real MongoDB, real HTTP app, real migrations                |
 * | independence  | the platform still works with TDTChannels blocked at egress |
 */
export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.unit.spec.ts'],
          environment: 'node',
          testTimeout: 15_000,
          hookTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.spec.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Integration suites share one database; running them in the same
          // process keeps setup cost bounded and ordering deterministic.
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
      {
        test: {
          name: 'independence',
          include: ['src/**/*.independence.spec.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
