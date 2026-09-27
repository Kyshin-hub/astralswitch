// Fenêtre du menu radial : transparente, sans focus, traversée par la souris.
// Rust l'affiche autour du curseur quand Alt est maintenu et indique l'élément visé.

import { useEffect, useState } from "react";
import { api, isTauri, type Character, type Snapshot } from "./api";
import { Portrait } from "./components";

const RADIUS = 118;

export default function Radial() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const [openKey, setOpenKey] = useState(0);

  useEffect(() => {
    api.getState().then(setSnap);
    const offs: Promise<() => void>[] = [api.onState(setSnap)];
    if (isTauri) {
      offs.push(import("@tauri-apps/api/event").then(({ listen }) => listen<string[]>("radial-open", (e) => {
        setNames(e.payload);
        setHover(null);
        setOpenKey((k) => k + 1); // relance l'animation d'ouverture
      })));
      offs.push(import("@tauri-apps/api/event").then(({ listen }) => listen<number | null>("radial-hover", (e) => setHover(e.payload))));
    }
    return () => { offs.forEach((p) => p.then((f) => f())); };
  }, []);

  // Aperçu navigateur : la team active, sélection à la souris
  const demo = !isTauri;
  const list = demo ? (snap?.teams.find((t) => t.id === snap.activeTeam)?.members ?? []) : names;
  const get = (n: string): Character =>
    snap?.characters.find((c) => c.name === n) ?? { name: n, className: "", hotkeys: [], online: true, focused: false };

  const onMove = (e: React.MouseEvent) => {
    if (!demo || list.length === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < 40) return setHover(null);
    const a = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
    setHover(Math.round(a / ((2 * Math.PI) / list.length)) % list.length);
  };

  const current = hover !== null ? list[hover] : null;

  return (
    <div className={`radial-stage ${demo ? "demo" : ""}`} onMouseMove={onMove}>
      <div className="radial" key={openKey}>
        <div className="radial-ring" />
        {list.map((n, i) => {
          const a = (i / list.length) * 2 * Math.PI;
          const style = { transform: `translate(${Math.sin(a) * RADIUS}px, ${-Math.cos(a) * RADIUS}px)`, animationDelay: `${i * 18}ms` };
          const c = get(n);
          return (
            <div key={n} className={`radial-item ${hover === i ? "on" : ""} ${c.focused ? "current" : ""}`} style={style}>
              <Portrait character={c} size={56} />
            </div>
          );
        })}
        <div className="radial-center">
          {current ? <span className="radial-label">{current}</span> : <img src="/logo.svg" alt="" />}
        </div>
      </div>
      {demo && <span className="radial-demo-note">Aperçu du menu radial · bouge la souris</span>}
    </div>
  );
}
