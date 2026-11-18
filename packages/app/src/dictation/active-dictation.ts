// One client records from one microphone at a time. The composer and plugin dictation share
// useDictation, and a start claims the microphone: the previous holder is cancelled, so two
// streams never feed the same audio engine.

export interface DictationClaim {
  cancel(): Promise<void> | void;
}

let active: DictationClaim | null = null;

export function claimDictation(claim: DictationClaim): void {
  const previous = active;
  active = claim;
  if (previous && previous !== claim) {
    void Promise.resolve()
      .then(() => previous.cancel())
      .catch(() => undefined);
  }
}

export function releaseDictation(claim: DictationClaim): void {
  if (active === claim) {
    active = null;
  }
}

export function getActiveDictation(): DictationClaim | null {
  return active;
}
