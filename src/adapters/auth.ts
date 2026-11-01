import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';

export interface AuthConfig {
  issuer: string;
  resource: string;
  reviewOrigin: string;
}

const ALGORITHMS = ['RS256'];
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Verifies tokens issued by Clerk. It only reads them: login, consent and
 * issuance belong to the provider, so there is no credential here to leak.
 *
 * Two kinds of token exist, and each opens exactly one door. An agent holds an
 * access token, whose audience is this server. A person in the browser holds a
 * session token. An agent's token must never open the review API, because then
 * an agent could approve its own proposals.
 */
export class TokenVerifier {
  private readonly config: AuthConfig;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: AuthConfig) {
    this.config = config;
    this.keys = createRemoteJWKSet(new URL(`${config.issuer.replace(/\/$/, '')}/.well-known/jwks.json`), {
      timeoutDuration: 5_000,
      // A flood of invented key ids costs at most one fetch a minute.
      cooldownDuration: 60_000,
      // Trust in these keys comes from where they were fetched, so a redirect is refused.
      [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'error' }),
    });
  }

  private subjectOf(payload: JWTPayload): string {
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no subject');
    return payload.sub;
  }

  /** For the MCP: the token must have been issued for this server. */
  async verifyAccessToken(raw: string): Promise<string> {
    const { payload } = await jwtVerify(raw, this.keys, {
      issuer: this.config.issuer,
      audience: this.config.resource,
      algorithms: ALGORITHMS,
      requiredClaims: ['exp'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    return this.subjectOf(payload);
  }

  /**
   * For the review page: a browser session on our own origin. An access token
   * has an audience and no session, so it fails here. A missing azp is refused
   * too, even though Clerk documents that it can be omitted.
   */
  async verifySessionToken(raw: string): Promise<string> {
    const { payload } = await jwtVerify(raw, this.keys, {
      issuer: this.config.issuer,
      algorithms: ALGORITHMS,
      requiredClaims: ['exp', 'sid', 'azp'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.aud !== undefined) throw new Error('session token must not have an audience');
    if (payload.azp !== this.config.reviewOrigin) throw new Error('session token is from another origin');
    return this.subjectOf(payload);
  }
}
