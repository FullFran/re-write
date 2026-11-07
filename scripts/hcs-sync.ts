// Vendors one pinned HCS release into vendor/hcs/<version>/ and writes vendor/hcs/PIN.json. Guide: docs/hcs.md.
//
//   npm run hcs:sync -- <version> <sha256>
//   node scripts/hcs-sync.ts <version> <sha256> [--url <tarball URL>] [--root <repository>]
//
// Exit codes: 0 vendored, 1 the release was refused, 2 usage error.
import { relative, resolve } from 'node:path';
import { PIN_FILE, SUMS_FILE, UsageError, syncHcs } from '../src/hcs/vendor.ts';

const USAGE = 'usage: node scripts/hcs-sync.ts <version> <sha256> [--url <tarball URL>] [--root <repository>]';

function parseArgs(argv: string[]): { version: string; digest: string; url?: string; root?: string } {
  const positional: string[] = [];
  const options: { url?: string; root?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' || arg === '--root') {
      if (argv[i + 1] === undefined) throw new UsageError(`${arg} needs a value`);
      options[arg === '--url' ? 'url' : 'root'] = argv[++i];
    } else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new UsageError('expected <version> <sha256>');
  return { version: positional[0], digest: positional[1], ...options };
}

async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(argv); } catch (error) {
    console.error(`hcs-sync: ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const root = resolve(args.root ?? resolve(import.meta.dirname, '..'));
  try {
    const { dir, files, pin } = await syncHcs({ ...args, root });
    console.log(`HCS ${pin.version}: ${files} files checked against ${SUMS_FILE}, vendored in ${relative(root, dir)}, pin in vendor/hcs/${PIN_FILE}.`);
    return 0;
  } catch (error) {
    console.error(`hcs-sync: ${(error as Error).message}${error instanceof UsageError ? `\n${USAGE}` : ''}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
