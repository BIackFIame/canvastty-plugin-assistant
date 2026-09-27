import type { S1BoundCredential } from '../shared/systemOne.ts';

/**
 * Keys of the assistant's backends (assistant spec §5.9), on top of the plugin's own secrets:
 * - write-only for the settings page: it learns only whether a key exists;
 * - each owner bound to one origin; a key is read in main only at call time, after the privacy gate;
 * - keyless servers get no header at all; keys never cross between backends.
 */

export interface DecisionSecretsLike {
  statusFor(owner: string): Promise<{ configured: boolean; origin: string | null }>;
  getBound(owner: string, origin: string): Promise<S1BoundCredential | null>;
  generationFor(owner: string): number;
}

export class AssistantSecrets {
  private readonly store: DecisionSecretsLike;
  constructor(store: DecisionSecretsLike) { this.store = store; }

  async status(owner: string | null): Promise<{ configured: boolean }> {
    if (!owner) return { configured: false };
    return { configured: (await this.store.statusFor(owner)).configured };
  }

  /**
   * The key for `owner`, bound to `origin`, or null when none is stored. A key saved for another address is
   * `unavailable`: it is never sent anywhere else.
   */
  async credential(owner: string | null, origin: string): Promise<{ credential: S1BoundCredential | null; unavailable: boolean }> {
    if (!owner) return { credential: null, unavailable: false };
    try { return { credential: await this.store.getBound(owner, origin), unavailable: false }; }
    catch { return { credential: null, unavailable: true }; }
  }

  generation(owner: string | null): number { return owner ? this.store.generationFor(owner) : 0; }
}
