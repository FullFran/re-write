import pkg from '../../package.json' with { type: 'json' };
import { REWRITE_CAPABILITIES } from './ids.ts';

export interface HostProfile {
  id?: string;
  version?: string;
  platform: { os: string; architecture: string; variant?: string };
  contributionKinds: string[];
  mediaTypes: string[];
  builtins: string[];
  activationPolicy?: 'all-or-nothing' | 'partial';
}

const architectures: Record<string, string> = { x64: 'amd64', ia32: '386', arm: 'arm', arm64: 'arm64', ppc64: 'ppc64le', s390x: 's390x', riscv64: 'riscv64' };
export const REWRITE_HOST: HostProfile = {
  id: 'com.fullfran.rewrite', version: pkg.version,
  platform: { os: process.platform, architecture: architectures[process.arch] ?? process.arch },
  contributionKinds: ['skill', 'mcp-server', 'x-rewrite-extractor', 'x-rewrite-check', 'x-rewrite-importer', 'x-rewrite-instructions'],
  mediaTypes: ['application/vnd.oci.image.layer.v1.tar+gzip'],
  builtins: REWRITE_CAPABILITIES.filter(c => c.provider === 'host' && !('issue' in c)).map(c => c.ref),
  activationPolicy: 'all-or-nothing',
};
