import { useEffect, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { api, isTauri, type Hotkey, type Notice, type Snapshot } from "./api";
import {
  IconBar, IconChevronLeft, IconDots, IconGear, IconKeyboard, IconPower, IconUser, IconUsers, WindowControls, appWindow,
} from "./components";
import { hotkeyParts } from "./keys";
import { useUpdater } from "./updater";
import { CharactersView, CompactList, SettingsView, TeamsView, UpdateCard, type CaptureTarget, sameTarget } from "./views";

type View = "characters" | "teams" | "settings";

const NORMAL_SIZE = { w: 820, h: 580 };
const compactSize = (members: number) => ({ w: 72, h: Math.min(8 + 40 + 8 + Math.max(members, 1) * 60 + 8 + 38 + 10, 1000) });

const NAV: { view: View; label: string; Icon: (p: { size?: number }) => React.ReactElement }[] = [
  { view: "characters", label: "Personnages", Icon: IconUser },
  { view: "teams", label: "Équipes", Icon: IconUsers },
  { view: "settings", label: "Paramètres", Icon: IconGear },
];

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("characters");
  const [capture, setCaptureState] = useState<CaptureTarget | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const updater = useUpdater();
  const noticeTimer = useRef<number>(undefined);
  const captureRef = useRef<CaptureTarget | null>(null);
  const setCapture = (t: CaptureTarget | null) => { captureRef.current = t; setCaptureState(t); };

  useEffect(() => {
    api.getState().then(setSnap);
    const offs = [
      api.onState(setSnap),
      api.onNavigate((v) => setView(v === "teams" ? "teams" : "settings")),
      api.onNotice((n) => {
        setNotice(n);
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
      }),
      api.onCaptured(async (hk: Hotkey | null) => {
        const target = captureRef.current;
        setCapture(null);
        if (!target || !hk) return;
        setSnap(await api.setBinding(target.target, target.index, hk));
      }),
    ];
    return () => { offs.forEach((p) => p.then((f) => f())); };
  }, []);

  const collapsed = !!snap?.settings.collapsed;
  const members = snap?.teams.find((t) => t.id === snap.activeTeam)?.members.length ?? 0;
  const size = collapsed ? compactSize(members) : NORMAL_SIZE;

  // La barre compacte colle à son contenu ; en sortant, on revient à la taille normale
  const wasCollapsed = useRef<boolean | null>(null);
  useEffect(() => {
    if (!snap) return;
    if (collapsed || wasCollapsed.current === true) {
      appWindow().then((w) => w?.setSize(new LogicalSize(size.w, size.h)));
    }
    wasCollapsed.current = collapsed;
  }, [snap === null, collapsed, size.w, size.h]);

  // Changer de vue annule une capture en cours
  useEffect(() => {
    if (captureRef.current) { api.cancelCapture(); setCapture(null); }
  }, [view]);

  if (!snap) return null;

  const toggleCapture = (t: CaptureTarget) => {
    if (sameTarget(capture, t)) { api.cancelCapture(); setCapture(null); return; }
    setCapture(t);
    api.startCapture();
  };
  const setCollapsed = (v: boolean) => api.setSetting("collapsed", v).then(setSnap);
  const online = snap.characters.filter((c) => c.online).length;
  const nextKey = snap.hotkeys.next[0];

  const rootClass = ["app", snap.settings.transparent && "glass", !snap.settings.animations && "no-anim", collapsed && "collapsed"]
    .filter(Boolean).join(" ");

  const app = (
    <div className={rootClass}>
      {collapsed ? (
        <div className="strip">
          <div className="drag-handle" data-tauri-drag-region title="Déplacer"><IconDots size={16} /></div>
          <CompactList snap={snap} />
          <button className="chevron-btn" onClick={() => setCollapsed(false)} title="Ouvrir la fenêtre complète"><IconChevronLeft /></button>
        </div>
      ) : (
        <>
          <aside className="sidebar" data-tauri-drag-region>
            <div className="brand" data-tauri-drag-region>
              <img src="/logo.svg" alt="" draggable={false} />
              <div>
                <div className="brand-name">AstralSwitch</div>
                <div className="brand-version">v{__APP_VERSION__}</div>
              </div>
            </div>
            <nav className="nav">
              {NAV.map(({ view: v, label, Icon }) => (
                <button key={v} className={`nav-btn ${view === v ? "on" : ""}`} onClick={() => setView(v)}>
                  <Icon size={19} /><span>{label}</span>
                </button>
              ))}
            </nav>
            <div className="spacer" data-tauri-drag-region />
            <UpdateCard state={updater.state} onInstall={updater.install} />
            <div className="status">
              <div><span className={`status-dot ${online ? "on" : ""}`} />{online} compte{online > 1 ? "s" : ""}</div>
              <div><IconKeyboard size={14} />{nextKey ? `${hotkeyParts(nextKey).join(" + ")} actif` : "Aucun raccourci"}</div>
            </div>
            <div className="sidebar-actions">
              <button className="square-btn" onClick={() => api.quitApp()} title="Quitter AstralSwitch" aria-label="Quitter"><IconPower size={17} /></button>
              <button className="square-btn" onClick={() => setCollapsed(true)} title="Mode barre compacte" aria-label="Mode barre compacte"><IconBar size={17} /></button>
            </div>
          </aside>
          <main className="main">
            <header className="topbar" data-tauri-drag-region><WindowControls /></header>
            <div className="content" key={view}>
              {view === "characters" && <CharactersView snap={snap} setSnap={setSnap} />}
              {view === "teams" && <TeamsView snap={snap} setSnap={setSnap} />}
              {view === "settings" && <SettingsView snap={snap} setSnap={setSnap} capture={capture} toggleCapture={toggleCapture} updater={updater} />}
            </div>
          </main>
        </>
      )}
      {notice && !collapsed && <div className={`toast ${notice.ok ? "" : "error"}`} role="status">{notice.message}</div>}
    </div>
  );

  // Dans le navigateur, on simule la taille de la fenêtre Tauri
  return isTauri ? app : (
    <div className="browser-stage">
      <div className="browser-frame" style={{ width: size.w, height: size.h }}>{app}</div>
      <span className="browser-note">Aperçu navigateur · données fictives</span>
    </div>
  );
}
