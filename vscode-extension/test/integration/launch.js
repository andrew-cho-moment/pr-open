// Downloads (or reuses) a real VS Code, launches it with this extension loaded, and runs
// `suite.js` inside its extension host. Run with `npm run test:integration`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

// VS Code opens a unix socket under its user-data dir, and those cap at 103 characters. The default
// sits inside the checkout, which is already over that in a worktree, so the run dies at startup
// with EINVAL. Keep the profile in a short path of its own instead.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc'));

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite.js');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // A clean profile each run, and no other extension's comment controller competing for the
      // gutter, which is the sort of interference that makes an anchoring assertion flap.
      launchArgs: ['--disable-extensions', '--disable-gpu', '--user-data-dir', userDataDir],
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('integration tests failed:', e);
  process.exit(1);
});
