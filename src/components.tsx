import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Character, Hotkey } from "./api";
import { isTauri } from "./api";
import { classColor, classGradient, normalizeClass } from "./classes";
import { hotkeyParts } from "./keys";
import { portraitFor } from "./portraits";

// ---------- Icônes (SVG inline) ----------

type IconProps = { size?: number };
const icon = (paths: ReactNode, filled = false) => (props: IconProps) => (
  <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"}
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths}
  </svg>
);
export const IconUser = icon(<><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c.8-4 3.8-6 7.5-6s6.7 2 7.5 6" /></>);
export const IconUsers = icon(<><circle cx="9" cy="8.5" r="3.5" /><path d="M2.5 19.5c.6-3.4 3.2-5.2 6.5-5.2s5.9 1.8 6.5 5.2" /><path d="M15.5 5.3a3.4 3.4 0 010 6.4M17.5 14.6c2.2.6 3.6 2.3 4 4.9" /></>);
export const IconGear = icon(<><circle cx="12" cy="12" r="3.2" /><path d="M19.4 13.5l1.6 1.2-1.9 3.3-1.9-.7a7.3 7.3 0 01-2.2 1.3l-.3 2h-3.8l-.3-2a7.3 7.3 0 01-2.2-1.3l-1.9.7-1.9-3.3 1.6-1.2a7 7 0 010-3l-1.6-1.2 1.9-3.3 1.9.7a7.3 7.3 0 012.2-1.3l.3-2h3.8l.3 2a7.3 7.3 0 012.2 1.3l1.9-.7 1.9 3.3-1.6 1.2a7 7 0 010 3z" /></>);
export const IconDots = icon(<>{[6, 12, 18].flatMap((y) => [9, 15].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.7" />))}</>, true);
export const IconMore = icon(<>{[6, 12, 18].map((x) => <circle key={x} cx={x} cy="12" r="1.8" />)}</>, true);
export const IconChevronLeft = icon(<path d="M15 5l-7 7 7 7" />);
export const IconChevronRight = icon(<path d="M9 5l7 7-7 7" />);
export const IconClose = icon(<path d="M18 6L6 18M6 6l12 12" />);
export const IconMin = icon(<path d="M5 12h14" />);
export const IconMax = icon(<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />);
export const IconPencil = icon(<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />);
export const IconCopy = icon(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></>);
export const IconPlay = icon(<path d="M7 4.5v15l12-7.5z" />, true);
export const IconTrash = icon(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />);
export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);
export const IconSearch = icon(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>);
export const IconRefresh = icon(<><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>);
export const IconPower = icon(<><path d="M12 3v8" /><path d="M6.3 6.8a8 8 0 1011.4 0" /></>);
export const IconStar = icon(<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />);
export const IconImage = icon(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="M20 16l-5-5-8.5 8.5" /></>);
export const IconFocus = icon(<><path d="M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4" /><circle cx="12" cy="12" r="2.5" /></>);
export const IconBar = icon(<><rect x="8" y="3.5" width="8" height="17" rx="2" /><path d="M10.5 7.5h3M10.5 11h3M10.5 14.5h3" /></>);
export const IconKeyboard = icon(<><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" /></>);
export const IconCaret = icon(<path d="M6 15l6-6 6 6z" />, true);

// ---------- Fenêtre ----------

export async function appWindow() {
  if (!isTauri) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function WindowControls() {
  return (
    <div className="win-controls">
      <button className="win-btn" onClick={() => appWindow().then((w) => w?.minimize())} aria-label="Réduire"><IconMin size={14} /></button>
      <button className="win-btn" onClick={() => appWindow().then((w) => w?.toggleMaximize())} aria-label="Agrandir"><IconMax size={12} /></button>
      <button className="win-btn danger" onClick={() => appWindow().then((w) => w?.close())} aria-label="Fermer"><IconClose size={14} /></button>
    </div>
  );
}

// ---------- Portraits ----------

/** Emblème de la classe (`public/classes/…`), ou pastille colorée avec l'initiale. */
export function ClassEmblem(props: { className: string; fallback?: string; size: number }) {
  const key = normalizeClass(props.className);
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (!key) { setSrc(null); return; }
    portraitFor(key).then((s) => { if (alive) setSrc(s); });
    return () => { alive = false; };
  }, [key]);
  const style = { width: props.size, height: props.size };
  if (src === undefined) return <span className="emblem" style={style} />;
  if (src === null) {
    return (
      <span className="emblem fallback" style={{ ...style, background: classGradient(props.className), fontSize: props.size * 0.42 }}>
        {(props.fallback ?? props.className).charAt(0).toUpperCase()}
      </span>
    );
  }
  return <img className="emblem" style={style} src={src} alt="" draggable={false} />;
}

/** Portrait du personnage : image personnalisée si définie, sinon emblème de classe. */
export function Portrait(props: { character: Character; size: number }) {
  const c = props.character;
  if (c.image) {
    return <img className="portrait photo" style={{ width: props.size, height: props.size }} src={c.image} alt="" draggable={false} />;
  }
  return <ClassEmblem className={c.className} fallback={c.name} size={props.size} />;
}

/** Grand visuel (carte) : image en plein cadre, ou emblème sur un fond aux couleurs de la classe. */
export function PortraitArt(props: { character: Character; emblemSize: number }) {
  const c = props.character;
  if (c.image) return <img className="art-img" src={c.image} alt="" draggable={false} />;
  return (
    <div className="art-emblem" style={{ ["--class-color" as string]: classColor(c.className) }}>
      <ClassEmblem className={c.className} fallback={c.name} size={props.emblemSize} />
    </div>
  );
}

/** Choix d'une image locale, recadrée en carré et réduite à 256 px (webp). */
export function pickPortrait(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        // Recadrage centré, légèrement vers le haut (visages)
        const sx = (img.naturalWidth - side) / 2;
        const sy = Math.max(0, (img.naturalHeight - side) / 3);
        canvas.getContext("2d")!.drawImage(img, sx, sy, side, side, 0, 0, 256, 256);
        URL.revokeObjectURL(img.src);
        resolve(canvas.toDataURL("image/webp", 0.88));
      };
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(file);
    };
    input.click();
  });
}

// ---------- Tuile compacte (mode barre) ----------

export function Tile(props: { character: Character; onClick?: () => void }) {
  const c = props.character;
  const cls = ["tile", c.focused && "focused", !c.online && "offline"].filter(Boolean).join(" ");
  return (
    <button className={cls} onClick={props.onClick} title={c.online ? c.name : `${c.name} (hors ligne)`}>
      <Portrait character={c} size={44} />
    </button>
  );
}

// ---------- Carte membre triable (équipes) ----------

export function MemberCard(props: { character: Character; onRemove: () => void; leader?: boolean }) {
  const c = props.character;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.name });
  const cls = ["member", c.focused && "focused", !c.online && "offline", isDragging && "dragging"].filter(Boolean).join(" ");
  return (
    <div ref={setNodeRef} className={cls} style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes} {...listeners} title="Glisser pour réordonner">
      <div className="member-art">
        <PortraitArt character={c} emblemSize={58} />
        {c.image && <span className="member-badge"><ClassEmblem className={c.className} size={22} /></span>}
      </div>
      <div className="member-name">{c.name}</div>
      <div className="member-class"><span className="class-dot" style={{ background: classColor(c.className) }} />{c.className || "—"}</div>
      <div className="member-actions">
        <button className="icon-btn danger" onPointerDown={(e) => e.stopPropagation()} onClick={props.onRemove} aria-label={`Retirer ${c.name}`} title="Retirer de l'équipe">
          <IconTrash size={13} />
        </button>
      </div>
    </div>
  );
}

// ---------- Menu déroulant « … » ----------

export type MenuItem = { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; hidden?: boolean };

export function MoreMenu(props: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="more" ref={ref} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button className={`more-btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-label={props.label ?? "Plus d'actions"} aria-expanded={open}>
        <IconMore size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {props.items.filter((i) => !i.hidden).map((i) => (
            <button key={i.label} role="menuitem" className={`menu-item ${i.danger ? "danger" : ""}`}
              onClick={() => { setOpen(false); i.onClick(); }}>
              {i.icon}<span>{i.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Contrôles ----------

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={props.checked} aria-label={props.label}
      className={`toggle ${props.checked ? "on" : ""}`} onClick={() => props.onChange(!props.checked)}>
      <span className="knob" />
    </button>
  );
}

/** Combinaison affichée en touches de clavier : [Ctrl] + [⇧ Maj] + [F1] */
export function Keycaps(props: { hotkey: Hotkey }) {
  return (
    <span className="keycaps">
      {hotkeyParts(props.hotkey).map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="keycap-plus">+</span>}
          <kbd className="keycap">{p}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

const Listening = () => <span className="keycap listening">Appuie sur une touche…</span>;

/**
 * Liste des raccourcis d'une action : « [F1] ou [Ctrl] + [1] » + bouton d'ajout.
 * `capturingIndex` : undefined = pas de capture sur cette ligne, null = ajout, n = remplacement.
 */
export function Bindings(props: {
  hotkeys: Hotkey[];
  capturingIndex: number | null | undefined;
  onCapture: (index: number | null) => void;
  onRemove: (index: number) => void;
}) {
  const { hotkeys, capturingIndex } = props;
  const adding = capturingIndex === null;
  return (
    <div className="bindings">
      {hotkeys.map((h, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="or">ou</span>}
          <span className="binding">
            <button className="binding-keys" onClick={() => props.onCapture(i)} title="Clic : changer · Clic droit : retirer"
              onContextMenu={(e) => { e.preventDefault(); props.onRemove(i); }}>
              {capturingIndex === i ? <Listening /> : <Keycaps hotkey={h} />}
            </button>
            <button className="binding-remove" onClick={() => props.onRemove(i)} aria-label="Retirer ce raccourci"><IconClose size={9} /></button>
          </span>
        </Fragment>
      ))}
      {adding && <>{hotkeys.length > 0 && <span className="or">ou</span>}<button className="binding-keys" onClick={() => props.onCapture(null)}><Listening /></button></>}
      {!adding && (
        <button className="binding-add" onClick={() => props.onCapture(null)} title="Ajouter un raccourci" aria-label="Ajouter un raccourci">
          <IconPlus size={13} />
        </button>
      )}
    </div>
  );
}

export function IconButton(props: { title: string; onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button className={`icon-btn ${props.danger ? "danger" : ""}`} title={props.title} aria-label={props.title}
      onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}
