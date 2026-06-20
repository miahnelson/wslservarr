const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sample = JSON.parse(fs.readFileSync(path.join(root, 'config.sample.json'), 'utf8'));
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert(pkg.scripts && pkg.scripts.build, 'package.json is missing build script');
assert(pkg.scripts && pkg.scripts.test, 'package.json is missing test script');
assert(sample.paths && sample.paths.configRoot, 'config.sample.json is missing paths.configRoot');
assert(typeof sample.composeYaml === 'string', 'config.sample.json is missing composeYaml');
assert(sample.sonarr && typeof sample.sonarr.composeYaml === 'string', 'config.sample.json is missing sonarr.composeYaml');
assert(serverJs.includes("app.get('/api/bootstrap'"), 'server.js is missing /api/bootstrap endpoint');
assert(serverJs.includes('requireApiToken'), 'server.js is missing API token middleware');

console.log('Smoke check passed.');
