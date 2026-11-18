import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PluginDictation,
  PluginDictationOptions,
  PluginDictationStatus,
  PluginDictationUnavailable,
} from "@getpaseo/plugin/client";

import { useDictation, type DictationStatus } from "@/hooks/use-dictation";
import { useIsDictationReady } from "@/hooks/use-is-dictation-ready";
import {
  useHostRuntimeAgentDirectoryStatus,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { usePluginInstallationHost } from "../installation-host";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";

export function resolvePluginDictationUnavailable(input: {
  isConnected: boolean;
  isReady: boolean;
  unavailableMessage: string | null;
}): PluginDictationUnavailable | null {
  if (!input.isConnected) {
    return { reason: "disconnected", message: null };
  }
  if (input.unavailableMessage) {
    return { reason: "not_ready", message: input.unavailableMessage };
  }
  if (!input.isReady) {
    return { reason: "not_ready", message: null };
  }
  return null;
}

export function resolvePluginDictationStatus(status: DictationStatus): PluginDictationStatus {
  switch (status) {
    case "recording":
    case "paused":
      return "listening";
    case "uploading":
      return "transcribing";
    case "failed":
    case "idle":
      return "idle";
  }
}

/**
 * Plugin access to the composer's dictation: same speech-to-text settings, audio source and
 * microphone permission. Only the final text reaches the plugin; it never sends anything.
 */
export function usePluginDictation(options: PluginDictationOptions): PluginDictation {
  const installationHost = usePluginInstallationHost();
  const serverId = options.serverId ?? installationHost ?? "";
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const agentDirectoryStatus = useHostRuntimeAgentDirectoryStatus(serverId);
  const isReady = useIsDictationReady({ serverId, isConnected, agentDirectoryStatus });
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  const unavailableMessage = resolveVoiceUnavailableMessage({ serverInfo, mode: "dictation" });
  const unavailable = useMemo(
    () => resolvePluginDictationUnavailable({ isConnected, isReady, unavailableMessage }),
    [isConnected, isReady, unavailableMessage],
  );
  const unavailableRef = useRef(unavailable);
  unavailableRef.current = unavailable;

  const onTextRef = useRef(options.onText);
  useEffect(() => {
    onTextRef.current = options.onText;
  }, [options.onText]);

  const [error, setError] = useState<string | null>(null);

  const dictation = useDictation({
    client,
    onTranscript: (text) => onTextRef.current(text),
    onError: (failure) => setError(failure.message),
    canStart: () => unavailableRef.current === null,
    canConfirm: () => client?.isConnected ?? false,
  });

  // Plugins get no retry surface: a failed transcription reports its error and returns to idle.
  const { status: dictationStatus, discardFailedDictation } = dictation;
  useEffect(() => {
    if (dictationStatus === "failed") {
      discardFailedDictation();
    }
  }, [dictationStatus, discardFailedDictation]);

  const { startDictation, confirmDictation, cancelDictation } = dictation;
  const start = useCallback(async () => {
    setError(null);
    await startDictation();
  }, [startDictation]);

  return useMemo(
    () => ({
      unavailable,
      status: resolvePluginDictationStatus(dictationStatus),
      volume: dictation.volume,
      error,
      start,
      stop: confirmDictation,
      cancel: cancelDictation,
    }),
    [
      unavailable,
      dictationStatus,
      dictation.volume,
      error,
      start,
      confirmDictation,
      cancelDictation,
    ],
  );
}
