import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimDictation,
  getActiveDictation,
  releaseDictation,
  type DictationClaim,
} from "@/dictation/active-dictation";

function claim() {
  const cancel = vi.fn<() => void>();
  const value: DictationClaim = { cancel };
  return Object.assign(value, { cancel });
}

afterEach(() => {
  const current = getActiveDictation();
  if (current) releaseDictation(current);
});

describe("active dictation", () => {
  it("cancels the previous holder when another dictation starts", async () => {
    const composer = claim();
    const plugin = claim();
    claimDictation(composer);
    claimDictation(plugin);
    await Promise.resolve();
    await Promise.resolve();
    expect(composer.cancel).toHaveBeenCalledTimes(1);
    expect(plugin.cancel).not.toHaveBeenCalled();
    expect(getActiveDictation()).toBe(plugin);
  });

  it("does not cancel a holder that claims again", async () => {
    const composer = claim();
    claimDictation(composer);
    claimDictation(composer);
    await Promise.resolve();
    expect(composer.cancel).not.toHaveBeenCalled();
  });

  it("releases only the current holder", () => {
    const composer = claim();
    const plugin = claim();
    claimDictation(composer);
    claimDictation(plugin);
    releaseDictation(composer);
    expect(getActiveDictation()).toBe(plugin);
    releaseDictation(plugin);
    expect(getActiveDictation()).toBeNull();
  });
});
