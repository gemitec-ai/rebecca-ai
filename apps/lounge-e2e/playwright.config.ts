import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  timeout: 40000,
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4300',
    trace: 'on',
    screenshot: 'on',
  },
  webServer: [
    {
      command: 'npm run start --workspace=lounge-backend',
      url: 'http://127.0.0.1:8083/api/v1/lounge/health',
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120 * 1000,
      env: {
        PORT: '8083',
        NODE_ENV: 'development',
        GCP_PROJECT_ID: 'rebecca-ai-gal-local',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
        ALLOW_GEO_FALLBACK_COUNTRY: 'true',
        LOUNGE_PUBLIC_ORIGIN: 'http://127.0.0.1:4300',
        CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:4300,http://localhost:4300',
        STRIPE_WEBHOOK_SECRET: 'whsec_e2e_test_secret',
        LOUNGE_TRIAL_HMAC_KEYS: '{"1":"e2e_test_hmac_secret_32bytes_minimum_value"}',
        BATCH_SECRET_KEY: 'e2e_batch_secret_key',
      },
    },
    {
      command: 'node ../../scripts/serve-frontend.js',
      url: 'http://127.0.0.1:4300',
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120 * 1000,
      env: {
        FRONTEND_PORT: '4300',
        BFF_PORT: '8083',
        FRONTEND_DIST_DIR: '../apps/lounge-frontend/dist/lounge-frontend/browser',
        SERVER_LABEL: 'Lounge',
      },
    },
  ],
  projects: [
    {
      name: 'lounge-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
