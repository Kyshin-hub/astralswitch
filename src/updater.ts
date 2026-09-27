// Mises à jour automatiques : vérification au démarrage, téléchargement et installation en un clic.
// Les versions sont publiées sur GitHub Releases et signées (voir scripts/release.ps1).

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "./api";

export type UpdateState =
  | { status: "idle" | "checking" | "none" }
  | { status: "available"; version: string; notes?: string }
  | { status: "downloading"; version: string; progress: number | null }
  | { status: "error"; message: string };

type Update = import("@tauri-apps/plugin-updater").Update;

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const pending = useRef<Update | null>(null);

  const check = useCallback(async (manual = false) => {
    if (!isTauri) {
      // Aperçu navigateur : on simule une mise à jour pour voir l'interface
      if (manual) setState({ status: "available", version: "0.2.0", notes: "Aperçu" });
      return;
    }
    setState({ status: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      pending.current = update;
      setState(update ? { status: "available", version: update.version, notes: update.body } : { status: "none" });
    } catch (e) {
      // Au démarrage, une erreur (hors ligne…) reste silencieuse
      setState(manual ? { status: "error", message: String(e) } : { status: "idle" });
    }
  }, []);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    let total = 0, received = 0;
    setState({ status: "downloading", version: update.version, progress: null });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") {
          received += ev.data.chunkLength;
          setState({ status: "downloading", version: update.version, progress: total ? received / total : null });
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setState({ status: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    // Petit délai : on laisse l'application démarrer tranquillement
    const t = window.setTimeout(() => check(false), 3000);
    return () => window.clearTimeout(t);
  }, [check]);

  return { state, check, install };
}
