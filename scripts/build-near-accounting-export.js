#!/usr/bin/env node
// Build near-accounting-export's TypeScript sources into dist/.
// The upstream package is consumed via a github URL and ships TS only,
// with no `prepare` script — so we compile it ourselves after install.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', 'node_modules', 'near-accounting-export');

if (!existsSync(pkgDir)) {
    process.exit(0);
}

if (existsSync(join(pkgDir, 'dist', 'scripts', 'index.js'))) {
    process.exit(0);
}

function run(cmd, args, cwd) {
    const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

run('npm', ['install', '--no-audit', '--no-fund', '--silent'], pkgDir);
run('npm', ['run', 'build', '--silent'], pkgDir);
