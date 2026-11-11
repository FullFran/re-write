/** Rules for the text a person saves into a scene. Pure: no files, no git. */

/** The largest scene a person can save, in UTF-8 bytes. */
export const MAX_SCENE_BYTES = 1_048_576;

/** Text that cannot be stored exactly as the person wrote it. */
export class InvalidSceneTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSceneTextError';
  }
}

/**
 * Refuses text that would not round-trip: a NUL character, a lone UTF-16 surrogate (which
 * UTF-8 would silently replace), or a scene larger than MAX_SCENE_BYTES.
 */
export function checkSceneText(text: string): void {
  if (text.includes('\u0000')) throw new InvalidSceneTextError('a scene cannot contain NUL characters');
  if (!text.isWellFormed()) throw new InvalidSceneTextError('the text is not valid Unicode (a lone surrogate)');
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_SCENE_BYTES) {
    throw new InvalidSceneTextError(`the scene is larger than ${MAX_SCENE_BYTES} bytes (${size})`);
  }
}

/** True when these bytes are exactly the UTF-8 encoding of some text, so reading and writing them back loses nothing. */
export function isExactUtf8(bytes: Buffer): boolean {
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}
