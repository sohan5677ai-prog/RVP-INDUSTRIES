import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest's default is 5s, which several tests here were already brushing
    // against: the two-page PDF render takes ~4.7s on its own, and the zip
    // round-trips deflate real buffers. They passed only while the suite was
    // small enough that each had a core largely to itself - adding the Phase 1
    // test files was enough parallel load to tip them over.
    //
    // Raised rather than worked around, because the time is genuine work, not
    // a hang. 20s still bounds a real deadlock well short of CI's patience.
    testTimeout: 20_000,

    // A throwaway secret so token sign/verify works in unit tests without
    // requiring a real JWT_SECRET in the environment. Never used outside tests.
    env: {
      JWT_SECRET: 'test-only-secret-not-used-in-production',
    },
  },
});
