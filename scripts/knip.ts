// Finds unused files, exports and dependencies with Knip (https://knip.dev),
// pinned and fetched by `pnpm dlx`, so it is not a dependency of this project:
//   pnpm run knip
// KNIP_DISABLE_RAW_TRANSFER=1 makes Knip's parser skip a large up-front memory
// reservation that fails on PCs with little free memory. CI runs this on Linux.

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2).map((a) => JSON.stringify(a)).join(' ');
const r = spawnSync(`pnpm dlx knip@6.48.0 ${args}`, { stdio: 'inherit', shell: true, env: { ...process.env, KNIP_DISABLE_RAW_TRANSFER: '1' } });
process.exitCode = r.status ?? 1;
