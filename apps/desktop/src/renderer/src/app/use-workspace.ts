import type { Run, WorkspaceSnapshot } from "@clawler/contracts";
import type { MessageKey } from "@clawler/i18n";
import { useCallback, useEffect, useState } from "react";
import { bridge } from "../platform/bridge";
import { errorMessageKey, mergeRun } from "../shared/presentation";

export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [error, setError] = useState<MessageKey>();
  const [notice, setNotice] = useState<MessageKey>();
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setWorkspace(await bridge.getWorkspace());
      setError(undefined);
    } catch (failure) {
      setError(errorMessageKey(failure));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void bridge
      .getWorkspace()
      .then((value) => {
        if (active) setWorkspace(value);
      })
      .catch((failure: unknown) => {
        if (active) setError(errorMessageKey(failure));
      });
    const unsubscribe = bridge.onRunChanged((run) => {
      setWorkspace((current) => {
        if (!current) return current;
        return { ...current, runs: mergeRun(current.runs, run) };
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function action(operation: () => Promise<void>): Promise<void> {
    setPending(true);
    setNotice(undefined);
    try {
      await operation();
    } catch (failure) {
      setNotice(errorMessageKey(failure));
    } finally {
      setPending(false);
    }
  }

  function acceptRun(run: Run): void {
    setWorkspace((current) => {
      if (!current) return current;
      return { ...current, runs: mergeRun(current.runs, run) };
    });
  }

  return { workspace, error, notice, pending, refresh, action, acceptRun, setNotice };
}
