import { readFileSync } from 'node:fs';
import type { ClaimCandidate } from '../domain/claim.ts';

export const ANNOTATION_EXTRACTOR = 'fixture-annotations';

export interface Extraction {
  extractor: string;
  candidates: ClaimCandidate[];
}

/**
 * Deterministic stand-in for a model: it loads claims annotated by hand. No LLM
 * runs here. A real extractor would return this same shape, and its output
 * would pass through the same mechanical quote validation.
 */
export function loadAnnotations(path: string): Extraction {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Extraction>;
  if (typeof data.extractor !== 'string' || !Array.isArray(data.candidates)) {
    throw new Error(`${path} needs "extractor" and "candidates"`);
  }
  return { extractor: data.extractor, candidates: data.candidates };
}
