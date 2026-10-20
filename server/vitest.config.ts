import { defineConfig, configDefaults } from 'vitest/config';

// The git and PM2 updater (Update now for a git install) is for Linux, Raspberry Pi and macOS: on Windows the Windows package updates
// itself instead (updateWindows.test.ts), and these tests drive real git, sh and PM2 stand-ins. They run in CI on Linux.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ...(process.platform === 'win32' ? ['test/updateApply.test.ts'] : [])] },
});
