const dotted = '[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+';
const dottedPattern = new RegExp(`^(?:${dotted})$`);
const capabilityPattern = new RegExp(`^(${dotted})@(0|[1-9][0-9]{0,8})$`);
const extensionPattern = /^x-[a-z0-9]+(-[a-z0-9]+)*$/;

// JavaScript's $ also matches before a final newline; require a complete match.
function matches(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

export function isDottedId(value: string): boolean { return matches(dottedPattern, value); }
export function isExtensionName(value: string): boolean { return matches(extensionPattern, value); }

export function parseCapabilityRef(value: string): { ok: true; id: string; major: number } | { ok: false; reason: string } {
  const match = capabilityPattern.exec(value);
  if (!match || match[0].length !== value.length) return { ok: false, reason: 'Invalid capability reference' };
  return { ok: true, id: match[1], major: Number(value.slice(value.lastIndexOf('@') + 1)) };
}

export function capabilitySatisfies(required: string, provided: string): boolean {
  const need = parseCapabilityRef(required);
  const have = parseCapabilityRef(provided);
  return need.ok && have.ok && need.id === have.id && need.major === have.major;
}

export const REWRITE_NAMESPACE = 'com.fullfran.rewrite';
export const REWRITE_EXTENSION_PREFIX = 'x-rewrite';
export function isRewriteOwned(id: string): boolean {
  return isDottedId(id) && (id === REWRITE_NAMESPACE || id.startsWith(`${REWRITE_NAMESPACE}.`));
}

export const REWRITE_CAPABILITIES = [
  { ref: 'com.fullfran.rewrite.book.read@1', major: 1, provider: 'host', mcpTools: ['list_books', 'list_scenes', 'read_scene'], contract: 'Read books and scenes.' },
  { ref: 'com.fullfran.rewrite.claims.read@1', major: 1, provider: 'host', mcpTools: ['list_claims'], contract: 'Read claims.' },
  { ref: 'com.fullfran.rewrite.claims.propose@1', major: 1, provider: 'host', mcpTools: ['propose_claims'], contract: 'Propose claims.' },
  { ref: 'com.fullfran.rewrite.revision.propose@1', major: 1, provider: 'host', mcpTools: ['propose_revision', 'list_proposals', 'get_proposal'], contract: 'Propose revisions and inspect proposals.' },
  { ref: 'com.fullfran.rewrite.continuity.check@1', major: 1, provider: 'host', movesTo: 'com.fullfran.rewrite.knowledge-order', mcpTools: ['inspect_continuity'], contract: 'Inspect continuity.' },
  { ref: 'com.fullfran.rewrite.findings.read@1', major: 1, provider: 'host', mcpTools: ['list_findings', 'get_analysis_guide'], contract: 'Read narrative findings and analysis guide.' },
  { ref: 'com.fullfran.rewrite.findings.propose@1', major: 1, provider: 'host', mcpTools: ['propose_findings'], contract: 'Propose narrative findings.' },
  { ref: 'com.fullfran.rewrite.claims.extract@1', major: 1, provider: 'package', mcpTools: [], contract: 'Extract claim candidates through the CLI.' },
  { ref: 'com.fullfran.rewrite.entities.read@1', major: 1, provider: 'host', mcpTools: [], contract: 'Read narrative entities.', issue: 12 },
  { ref: 'com.fullfran.rewrite.events.read@1', major: 1, provider: 'host', mcpTools: [], contract: 'Read narrative events.', issue: 15 },
] as const;

export const REWRITE_PERMISSIONS = [
  'com.fullfran.rewrite.book.read', 'com.fullfran.rewrite.book.import',
  'com.fullfran.rewrite.claims.propose', 'com.fullfran.rewrite.findings.propose',
  'com.fullfran.rewrite.revision.propose',
] as const;
export const REVIEW_DECIDE = 'com.fullfran.rewrite.review.decide';
export const BOOK_CREATE = 'com.fullfran.rewrite.book.create';
