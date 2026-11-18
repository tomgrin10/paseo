import { createContext, useContext } from "react";

/** The host whose installation renders the current plugin surface. */
export const PluginInstallationHostContext = createContext<string | null>(null);

export function usePluginInstallationHost(): string | null {
  return useContext(PluginInstallationHostContext);
}
