import { createContext, useContext } from "react";
import type { PageName, Settings, Vault } from "./types";
export interface OutlookRecoveryTarget {
  id?: number;
  email?: string;
  group_id?: number;
  send_mail?: boolean;
}
export interface Workspace {
  settings?: Settings;
  revision: number;
  refresh: () => void;
  navigate: (page: PageName, query?: string) => void;
  vault: (draft: Partial<Vault>) => void;
  outlook: (id: number, email: string) => void;
  repairOutlook: (target: OutlookRecoveryTarget) => void;
  mail: (id: number) => void;
  code: (path: string) => void;
  confirm: (
    title: string,
    description: string,
    action: () => Promise<unknown>,
  ) => void;
}
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("Missing workspace");
  return ctx;
}
