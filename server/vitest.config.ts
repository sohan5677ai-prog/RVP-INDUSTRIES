import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A throwaway secret so token sign/verify works in unit tests without
    // requiring a real JWT_SECRET in the environment. Never used outside tests.
    env: {
      JWT_SECRET: 'test-only-secret-not-used-in-production',
    },
  },
});
