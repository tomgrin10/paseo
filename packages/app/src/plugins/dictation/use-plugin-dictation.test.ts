import { describe, expect, it } from "vitest";
import {
  resolvePluginDictationStatus,
  resolvePluginDictationUnavailable,
} from "./use-plugin-dictation";

describe("plugin dictation availability", () => {
  it("is available when the host is connected and ready", () => {
    expect(
      resolvePluginDictationUnavailable({
        isConnected: true,
        isReady: true,
        unavailableMessage: null,
      }),
    ).toBeNull();
  });

  it("reports a disconnected host before anything else", () => {
    expect(
      resolvePluginDictationUnavailable({
        isConnected: false,
        isReady: false,
        unavailableMessage: "Speech-to-text model is downloading",
      }),
    ).toEqual({ reason: "disconnected", message: null });
  });

  it("passes the host's reason through", () => {
    expect(
      resolvePluginDictationUnavailable({
        isConnected: true,
        isReady: true,
        unavailableMessage: "Speech-to-text model is downloading",
      }),
    ).toEqual({ reason: "not_ready", message: "Speech-to-text model is downloading" });
  });

  it("is not ready without a reason when the host says dictation is off", () => {
    expect(
      resolvePluginDictationUnavailable({
        isConnected: true,
        isReady: false,
        unavailableMessage: null,
      }),
    ).toEqual({ reason: "not_ready", message: null });
  });
});

describe("plugin dictation status", () => {
  it.each([
    ["idle", "idle"],
    ["recording", "listening"],
    ["paused", "listening"],
    ["uploading", "transcribing"],
    ["failed", "idle"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(resolvePluginDictationStatus(status)).toBe(expected);
  });
});
