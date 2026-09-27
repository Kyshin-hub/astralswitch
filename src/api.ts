// Pont vers le backend Rust. Hors de Tauri (simple navigateur), un faux
// backend en mémoire prend le relais pour pouvoir travailler l'interface.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Hotkey = { code: number; ctrl: boolean; alt: boolean; shift: boolean };

export type Character = {
  name: string;
  className: string;
  hotkeys: Hotkey[];
  /** Portrait personnalisé (data URL) */
  image?: string | null;
  online: boolean;
  focused: boolean;
};

export type Team = { id: string; name: string; members: string[] };

export type GlobalHotkeys = { next: Hotkey[]; prev: Hotkey[]; toggle: Hotkey[]; group: Hotkey[] };
export type GlobalAction = keyof GlobalHotkeys;
export type BindTarget = { kind: "global"; which: GlobalAction } | { kind: "character"; name: string };

export type Settings = {
  alwaysOnTop: boolean;
  transparent: boolean;
  directHotkeys: boolean;
  onlyWhenDofusFocused: boolean;
  collapsed: boolean;
  closeToTray: boolean;
  autostart: boolean;
  animations: boolean;
  radial: boolean;
  groupAutoAccept: boolean;
};

export type Notice = { ok: boolean; message: string };
export type SettingKey = keyof Settings;

export type Snapshot = {
  characters: Character[];
  teams: Team[];
  activeTeam: string;
  hotkeys: GlobalHotkeys;
  settings: Settings;
  pending: number;
};

type Unlisten = () => void;

export interface Api {
  getState(): Promise<Snapshot>;
  setTeamMembers(id: string, members: string[]): Promise<Snapshot>;
  createTeam(name: string): Promise<Snapshot>;
  renameTeam(id: string, name: string): Promise<Snapshot>;
  duplicateTeam(id: string): Promise<Snapshot>;
  deleteTeam(id: string): Promise<Snapshot>;
  setActiveTeam(id: string): Promise<Snapshot>;
  /** index null = ajouter ; hotkey null = supprimer */
  setBinding(target: BindTarget, index: number | null, hotkey: Hotkey | null): Promise<Snapshot>;
  setSetting(key: SettingKey, value: boolean): Promise<Snapshot>;
  forgetCharacter(name: string): Promise<Snapshot>;
  startCapture(): Promise<void>;
  cancelCapture(): Promise<void>;
  focusCharacter(name: string): Promise<void>;
  closeCharacter(name: string): Promise<void>;
  setPortrait(name: string, image: string | null): Promise<Snapshot>;
  refresh(): Promise<void>;
  quitApp(): Promise<void>;
  onNavigate(cb: (view: string) => void): Promise<Unlisten>;
  /** Le chef invite en groupe les autres persos connectés de l'équipe active */
  groupTeam(): Promise<void>;
  onNotice(cb: (n: Notice) => void): Promise<Unlisten>;
  onState(cb: (s: Snapshot) => void): Promise<Unlisten>;
  onCaptured(cb: (h: Hotkey | null) => void): Promise<Unlisten>;
}

export const isTauri = "__TAURI_INTERNALS__" in window;

const tauriApi: Api = {
  getState: () => invoke("get_state"),
  setTeamMembers: (id, members) => invoke("set_team_members", { id, members }),
  createTeam: (name) => invoke("create_team", { name }),
  renameTeam: (id, name) => invoke("rename_team", { id, name }),
  duplicateTeam: (id) => invoke("duplicate_team", { id }),
  deleteTeam: (id) => invoke("delete_team", { id }),
  setActiveTeam: (id) => invoke("set_active_team", { id }),
  setBinding: (target, index, hotkey) => invoke("set_binding", { target, index, hotkey }),
  setSetting: (key, value) => invoke("set_setting", { key, value }),
  forgetCharacter: (name) => invoke("forget_character", { name }),
  startCapture: () => invoke("start_capture"),
  cancelCapture: () => invoke("cancel_capture"),
  focusCharacter: (name) => invoke("focus_character", { name }),
  closeCharacter: (name) => invoke("close_character", { name }),
  setPortrait: (name, image) => invoke("set_portrait", { name, image }),
  refresh: () => invoke("refresh"),
  quitApp: () => invoke("quit_app"),
  onNavigate: (cb) => listen<string>("navigate", (e) => cb(e.payload)),
  groupTeam: () => invoke("group_team"),
  onNotice: (cb) => listen<Notice>("notice", (e) => cb(e.payload)),
  onState: (cb) => listen<Snapshot>("state", (e) => cb(e.payload)),
  onCaptured: (cb) => listen<Hotkey | null>("hotkey-captured", (e) => cb(e.payload)),
};

// ---------- Faux backend pour le navigateur ----------

function createMock(): Api {
  const hk = (code: number): Hotkey => ({ code, ctrl: false, alt: false, shift: false });
  const ch = (name: string, className: string, extra: Partial<Character> = {}): Character => ({
    name, className, hotkeys: [], online: true, focused: false, ...extra,
  });
  const characters = [
    ch("Valkyr-Astral", "Pandawa", { hotkeys: [hk(0x70), { code: 0x31, ctrl: true, alt: false, shift: false }], focused: true }),
    ch("Cosma-Nyx", "Eliotrope", { hotkeys: [hk(0x71)] }),
    ch("Lyre-Astral", "Crâ"),
    ch("Brakmaris", "Iop"),
    ch("Nyla-Astral", "Eniripsa"),
    ch("Osmose", "Osamodas", { online: false }),
    ch("Kadrane", "Enutrof"),
    ch("Xeltik", "Xélor"),
  ];
  const all = characters.map((c) => c.name);
  let s: Snapshot = {
    characters,
    teams: [
      { id: "a", name: "Team principale", members: all.slice(0, 5) },
      { id: "b", name: "2e team", members: [all[2], all[0], all[5], all[1]] },
      { id: "c", name: "Team donjon", members: [all[4], all[6], all[7]] },
    ],
    activeTeam: "a",
    hotkeys: { next: [hk(0x09), hk(0x1_0005)], prev: [{ code: 0x09, ctrl: false, alt: false, shift: true }, hk(0x1_0004)], toggle: [], group: [] },
    settings: { alwaysOnTop: true, transparent: false, directHotkeys: true, onlyWhenDofusFocused: true, collapsed: false, closeToTray: true, autostart: false, animations: true, radial: true, groupAutoAccept: false },
    pending: 0,
  };
  const bus = new EventTarget();
  const update = async (f: (s: Snapshot) => void) => {
    s = structuredClone(s);
    f(s);
    bus.dispatchEvent(new CustomEvent("state", { detail: s }));
    return s;
  };
  const team = (st: Snapshot, id: string) => st.teams.find((t) => t.id === id);
  const list = (st: Snapshot, t: BindTarget) =>
    t.kind === "global" ? st.hotkeys[t.which] : st.characters.find((c) => c.name === t.name)?.hotkeys;
  const unbind = (st: Snapshot, h: Hotkey) => {
    const other = (x: Hotkey) => !(x.code === h.code && x.ctrl === h.ctrl && x.alt === h.alt && x.shift === h.shift);
    for (const k of ["next", "prev", "toggle", "group"] as const) st.hotkeys[k] = st.hotkeys[k].filter(other);
    for (const c of st.characters) c.hotkeys = c.hotkeys.filter(other);
  };

  let captureHandler: ((e: KeyboardEvent | MouseEvent) => void) | null = null;
  const stopCapture = () => {
    if (!captureHandler) return;
    window.removeEventListener("keydown", captureHandler, true);
    window.removeEventListener("mousedown", captureHandler, true);
    captureHandler = null;
  };

  return {
    getState: async () => s,
    setTeamMembers: (id, members) => update((st) => { const t = team(st, id); if (t) t.members = members; }),
    createTeam: (name) => update((st) => { st.teams.push({ id: String(Date.now()), name, members: [] }); }),
    renameTeam: (id, name) => update((st) => { const t = team(st, id); if (t) t.name = name; }),
    duplicateTeam: (id) => update((st) => {
      const i = st.teams.findIndex((t) => t.id === id);
      if (i >= 0) st.teams.splice(i + 1, 0, { ...st.teams[i], id: String(Date.now()), name: `${st.teams[i].name} (copie)` });
    }),
    deleteTeam: (id) => update((st) => {
      if (st.teams.length > 1) st.teams = st.teams.filter((t) => t.id !== id);
      if (!team(st, st.activeTeam)) st.activeTeam = st.teams[0].id;
    }),
    setActiveTeam: (id) => update((st) => { st.activeTeam = id; }),
    setBinding: (target, index, hotkey) => update((st) => {
      let pos: number | null = null;
      const before = list(st, target);
      if (before && index !== null && index < before.length) { before.splice(index, 1); pos = index; }
      if (!hotkey) return;
      unbind(st, hotkey);
      const l = list(st, target);
      if (l) l.splice(Math.min(pos ?? l.length, l.length), 0, hotkey);
    }),
    setSetting: (key, value) => update((st) => { st.settings[key] = value; }),
    forgetCharacter: (name) => update((st) => {
      st.characters = st.characters.filter((c) => c.name !== name);
      st.teams.forEach((t) => (t.members = t.members.filter((m) => m !== name)));
    }),
    focusCharacter: async (name) => { await update((st) => st.characters.forEach((c) => (c.focused = c.online && c.name === name))); },
    closeCharacter: async (name) => { await update((st) => { const c = st.characters.find((c) => c.name === name); if (c) { c.online = false; c.focused = false; } }); },
    setPortrait: (name, image) => update((st) => { const c = st.characters.find((c) => c.name === name); if (c) c.image = image; }),
    refresh: async () => { await update(() => {}); },
    quitApp: async () => alert("Quitter (aperçu navigateur)"),
    onNavigate: async () => () => {},
    groupTeam: async () => {
      const online = (s.teams.find((t) => t.id === s.activeTeam)?.members ?? []).filter((n) => s.characters.find((c) => c.name === n)?.online);
      const detail = online.length < 2
        ? { ok: false, message: "Il faut au moins 2 personnages connectés dans l'équipe active." }
        : { ok: true, message: `${online[0]} a invité ${online.length - 1} personnages.` };
      setTimeout(() => bus.dispatchEvent(new CustomEvent("notice", { detail })), 400);
    },
    onNotice: async (cb) => {
      const l = (e: Event) => cb((e as CustomEvent<Notice>).detail);
      bus.addEventListener("notice", l);
      return () => bus.removeEventListener("notice", l);
    },
    cancelCapture: async () => stopCapture(),
    startCapture: async () => {
      stopCapture();
      captureHandler = (e) => {
        let code: number;
        if (e instanceof KeyboardEvent) {
          if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
          code = e.keyCode;
        } else {
          if (e.button === 0 || e.button === 2) return; // clics gauche/droit ignorés
          code = e.button === 1 ? 0x1_0003 : e.button === 3 ? 0x1_0004 : 0x1_0005;
        }
        e.preventDefault();
        e.stopPropagation();
        stopCapture();
        const h = code === 27 ? null : { code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
        bus.dispatchEvent(new CustomEvent("captured", { detail: h }));
      };
      window.addEventListener("keydown", captureHandler, true);
      window.addEventListener("mousedown", captureHandler, true);
    },
    onState: async (cb) => {
      const l = (e: Event) => cb((e as CustomEvent<Snapshot>).detail);
      bus.addEventListener("state", l);
      return () => bus.removeEventListener("state", l);
    },
    onCaptured: async (cb) => {
      const l = (e: Event) => cb((e as CustomEvent<Hotkey | null>).detail);
      bus.addEventListener("captured", l);
      return () => bus.removeEventListener("captured", l);
    },
  };
}

export const api: Api = isTauri ? tauriApi : createMock();
