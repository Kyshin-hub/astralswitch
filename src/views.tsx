import { useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import { api, type BindTarget, type Character, type GlobalAction, type Hotkey, type Snapshot, type Team } from "./api";
import {
  Bindings, ClassEmblem, IconCopy, IconFocus, IconGear, IconImage, IconKeyboard, IconPencil, IconPlay, IconPlus,
  IconPower, IconRefresh, IconSearch, IconStar, IconTrash, IconUsers, Keycaps, MemberCard, MoreMenu, Portrait,
  PortraitArt, Tile, Toggle, pickPortrait,
} from "./components";
import { classColor } from "./classes";
import type { UpdateState, useUpdater } from "./updater";

/** index null = nouveau raccourci, sinon remplacement de celui à cet index */
export type CaptureTarget = { target: BindTarget; index: number | null };
export const sameTarget = (a: CaptureTarget | null, b: CaptureTarget) =>
  !!a && JSON.stringify(a) === JSON.stringify(b);

type SetSnap = (s: Snapshot) => void;

function lookup(snap: Snapshot) {
  const map = new Map(snap.characters.map((c) => [c.name, c]));
  return (name: string): Character => map.get(name) ?? { name, className: "", hotkeys: [], online: false, focused: false };
}

const activeTeam = (snap: Snapshot) => snap.teams.find((t) => t.id === snap.activeTeam);

function characterMenu(c: Character, setSnap: SetSnap) {
  return [
    { label: "Basculer sur ce personnage", icon: <IconFocus size={15} />, onClick: () => api.focusCharacter(c.name), hidden: !c.online },
    { label: c.image ? "Changer l'image…" : "Choisir une image…", icon: <IconImage size={15} />,
      onClick: () => pickPortrait().then((img) => { if (img) api.setPortrait(c.name, img).then(setSnap); }) },
    { label: "Retirer l'image", icon: <IconImage size={15} />, onClick: () => api.setPortrait(c.name, null).then(setSnap), hidden: !c.image },
    { label: "Fermer le client", icon: <IconPower size={15} />, onClick: () => api.closeCharacter(c.name), hidden: !c.online, danger: true },
    { label: "Oublier ce personnage", icon: <IconTrash size={15} />, onClick: () => api.forgetCharacter(c.name).then(setSnap), hidden: c.online, danger: true },
  ];
}

/** Le chef (1er perso connecté de l'équipe active) invite tous les autres en groupe, en jeu. */
function GroupButton() {
  return (
    <button className="primary-btn tall" onClick={() => api.groupTeam()}
      title="Le premier personnage connecté de l'équipe active invite tous les autres dans son groupe (commande /invite)">
      <IconUsers size={16} /> Grouper
    </button>
  );
}

// ---------- Personnages ----------

function CharacterCard(props: { character: Character; position?: number; setSnap: SetSnap }) {
  const c = props.character;
  const cls = ["char-card", c.focused && "focused", !c.online && "offline"].filter(Boolean).join(" ");
  return (
    <div className={cls} role="button" tabIndex={0} style={{ ["--class-color" as string]: classColor(c.className) }}
      onClick={() => c.online && api.focusCharacter(c.name)}
      onKeyDown={(e) => { if (e.key === "Enter" && c.online) api.focusCharacter(c.name); }}
      title={c.online ? `Basculer sur ${c.name}` : `${c.name} est hors ligne`}>
      {c.image && <img className="card-bg" src={c.image} alt="" draggable={false} />}
      <div className="card-art"><PortraitArt character={c} emblemSize={62} /></div>
      <div className="card-emblem"><ClassEmblem className={c.className} fallback={c.name} size={30} /></div>
      <div className="card-info">
        <div className="card-name">{c.name}</div>
        <div className="card-class">{c.className || "Classe inconnue"}</div>
        <div className={`card-status ${c.online ? "on" : ""}`}><span className="status-dot" />{c.online ? "En ligne" : "Hors ligne"}</div>
      </div>
      <div className="card-side">
        {props.position !== undefined && <span className="card-pos" title="Position dans le cycle">{props.position}</span>}
        {c.hotkeys[0] && <Keycaps hotkey={c.hotkeys[0]} />}
      </div>
      <MoreMenu items={characterMenu(c, props.setSnap)} />
    </div>
  );
}

export function CharactersView(props: { snap: Snapshot; setSnap: SetSnap }) {
  const { snap, setSnap } = props;
  const [query, setQuery] = useState("");
  const [spinning, setSpinning] = useState(false);
  const get = lookup(snap);
  const members = activeTeam(snap)?.members ?? [];
  // La team active d'abord (dans l'ordre du cycle), puis les autres personnages
  const ordered = [
    ...members.map(get),
    ...snap.characters.filter((c) => !members.includes(c.name)),
  ];
  const q = query.trim().toLowerCase();
  const list = q ? ordered.filter((c) => `${c.name} ${c.className}`.toLowerCase().includes(q)) : ordered;

  const refresh = () => {
    setSpinning(true);
    api.refresh().finally(() => setTimeout(() => setSpinning(false), 600));
  };

  return (
    <div className="view">
      <div className="search-row">
        <label className="search">
          <IconSearch size={17} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un personnage…" spellCheck={false} />
        </label>
        <GroupButton />
        <button className={`square-btn ${spinning ? "spinning" : ""}`} onClick={refresh} title="Rafraîchir" aria-label="Rafraîchir">
          <IconRefresh size={18} />
        </button>
      </div>

      {snap.pending > 0 && (
        <div className="notice"><span className="spinner" />
          {snap.pending} fenêtre{snap.pending > 1 ? "s" : ""} Dofus en attente de connexion
        </div>
      )}

      <div className="card-list">
        {list.map((c) => {
          const i = members.indexOf(c.name);
          return <CharacterCard key={c.name} character={c} position={i >= 0 ? i + 1 : undefined} setSnap={setSnap} />;
        })}
        {list.length === 0 && (
          <div className="empty">
            {q ? "Aucun personnage ne correspond à ta recherche." : "Lance Dofus et connecte tes personnages : ils apparaîtront ici automatiquement."}
          </div>
        )}
      </div>
    </div>
  );
}

/** Barre compacte : portraits de la team active uniquement. */
export function CompactList(props: { snap: Snapshot }) {
  const get = lookup(props.snap);
  const members = activeTeam(props.snap)?.members ?? [];
  return (
    <div className="compact-list">
      {members.map((n) => <Tile key={n} character={get(n)} onClick={() => api.focusCharacter(n)} />)}
    </div>
  );
}

// ---------- Équipes ----------

function InlineName(props: { value: string; onDone: (v: string | null) => void; className?: string }) {
  const [value, setValue] = useState(props.value);
  const commit = () => { const v = value.trim(); props.onDone(v && v !== props.value ? v : null); };
  return (
    <input className={`inline-input ${props.className ?? ""}`} autoFocus value={value} onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") props.onDone(null); }} />
  );
}

export function TeamsView(props: { snap: Snapshot; setSnap: SetSnap }) {
  const { snap, setSnap } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const get = lookup(snap);
  const main = activeTeam(snap)!;
  const others = snap.teams.filter((t) => t.id !== snap.activeTeam);
  const outside = snap.characters.filter((c) => !main.members.includes(c.name));

  const rename = (t: Team) => (v: string | null) => { setEditing(null); if (v) api.renameTeam(t.id, v).then(setSnap); };
  const saveMembers = (members: string[]) => api.setTeamMembers(main.id, members).then(setSnap);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const m = main.members;
    saveMembers(arrayMove(m, m.indexOf(String(active.id)), m.indexOf(String(over.id))));
  };
  const teamMenu = (t: Team, isMain: boolean) => [
    { label: "Jouer cette équipe", icon: <IconPlay size={13} />, onClick: () => api.setActiveTeam(t.id).then(setSnap), hidden: isMain },
    { label: "Renommer", icon: <IconPencil size={15} />, onClick: () => setEditing(t.id) },
    { label: "Dupliquer", icon: <IconCopy size={15} />, onClick: () => api.duplicateTeam(t.id).then(setSnap) },
    { label: "Supprimer", icon: <IconTrash size={15} />, onClick: () => api.deleteTeam(t.id).then(setSnap), danger: true, hidden: snap.teams.length < 2 },
  ];

  return (
    <div className="view">
      <div className="view-head">
        <div className="view-head-title">
          {editing === main.id
            ? <InlineName value={main.name} onDone={rename(main)} className="big" />
            : <h1 className="view-title">{main.name}</h1>}
          <button className="icon-btn" onClick={() => setEditing(main.id)} title="Renommer" aria-label="Renommer"><IconPencil size={15} /></button>
          <span className="active-pill"><IconStar size={12} /> Active</span>
        </div>
        <div className="view-head-actions">
          <button className="ghost-btn" onClick={() => api.groupTeam()} title="Inviter tous les persos connectés dans le groupe du premier">
            <IconUsers size={15} /> Grouper
          </button>
          <button className="primary-btn" onClick={() => setAdding(!adding)} disabled={outside.length === 0}>
            <IconPlus size={15} /> Ajouter
          </button>
          <button className="square-btn" onClick={() => api.duplicateTeam(main.id).then(setSnap)} title="Dupliquer" aria-label="Dupliquer"><IconCopy size={16} /></button>
          <div className="square-more"><MoreMenu items={teamMenu(main, true)} /></div>
        </div>
      </div>

      {adding && outside.length > 0 && (
        <div className="picker">
          <span className="picker-label">Ajouter à {main.name} :</span>
          {outside.map((c) => (
            <button key={c.name} className="chip" onClick={() => { saveMembers([...main.members, c.name]); if (outside.length === 1) setAdding(false); }}>
              <Portrait character={c} size={22} /> {c.name}
            </button>
          ))}
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={main.members} strategy={rectSortingStrategy}>
          <div className="member-grid">
            {main.members.map((n) => (
              <MemberCard key={n} character={get(n)} onRemove={() => saveMembers(main.members.filter((m) => m !== n))} />
            ))}
            {main.members.length === 0 && <div className="empty">Ajoute des personnages avec « Ajouter ».</div>}
          </div>
        </SortableContext>
      </DndContext>

      <div className="view-head sub">
        <h2 className="section-title big">Autres équipes</h2>
        <button className="primary-btn" onClick={() => api.createTeam(`Team ${snap.teams.length + 1}`).then(setSnap)}>
          <IconPlus size={15} /> Ajouter
        </button>
      </div>

      <div className="team-cards">
        {others.map((t) => (
          <div key={t.id} className="team-card" role="button" tabIndex={0} title="Jouer cette équipe"
            onClick={() => editing !== t.id && api.setActiveTeam(t.id).then(setSnap)}>
            <div className="team-card-head">
              <div className="team-card-title">
                {editing === t.id ? <InlineName value={t.name} onDone={rename(t)} /> : <span className="team-card-name">{t.name}</span>}
                <span className="team-card-count">{t.members.length} personnage{t.members.length > 1 ? "s" : ""}</span>
              </div>
              <MoreMenu items={teamMenu(t, false)} />
            </div>
            <div className="mini-avatars">
              {t.members.slice(0, 5).map((n) => <span key={n} className="mini"><Portrait character={get(n)} size={26} /></span>)}
              {t.members.length > 5 && <span className="mini more-count">+{t.members.length - 5}</span>}
            </div>
          </div>
        ))}
        {others.length === 0 && <p className="hint">Crée d'autres compositions, puis clique dessus pour les jouer.</p>}
      </div>
    </div>
  );
}

// ---------- Mises à jour ----------

type Updater = ReturnType<typeof useUpdater>;

/** Encart dans la barre latérale quand une nouvelle version est disponible. */
export function UpdateCard(props: { state: UpdateState; onInstall: () => void }) {
  const s = props.state;
  if (s.status !== "available" && s.status !== "downloading") return null;
  return (
    <div className="update-card">
      <div className="update-title"><IconRefresh size={13} /> Version {s.version}</div>
      {s.status === "available" ? (
        <button className="primary-btn small" onClick={props.onInstall}>Mettre à jour</button>
      ) : (
        <div className="progress" title="Téléchargement…">
          <div className="progress-bar" style={{ width: s.progress === null ? "35%" : `${Math.round(s.progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function updateLabel(s: UpdateState): string {
  switch (s.status) {
    case "checking": return "Recherche en cours…";
    case "none": return "AstralSwitch est à jour.";
    case "available": return `La version ${s.version} est disponible.`;
    case "downloading": return `Téléchargement de la version ${s.version}…`;
    case "error": return `Impossible de vérifier : ${s.message}`;
    default: return "Les mises à jour sont vérifiées à chaque démarrage.";
  }
}

// ---------- Paramètres ----------

function Row(props: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-icon">{props.icon}</span>
      <div className="row-text">
        <div className="row-title">{props.title}</div>
        {props.desc && <div className="row-desc">{props.desc}</div>}
      </div>
      {props.children}
    </div>
  );
}

type SettingsProps = {
  snap: Snapshot;
  setSnap: SetSnap;
  capture: CaptureTarget | null;
  toggleCapture: (t: CaptureTarget) => void;
  updater?: Updater;
};

function BindingsFor(props: SettingsProps & { target: BindTarget; hotkeys: Hotkey[] }) {
  const { target, capture } = props;
  const key = JSON.stringify(target);
  const capturingIndex = capture && JSON.stringify(capture.target) === key ? capture.index : undefined;
  return (
    <Bindings hotkeys={props.hotkeys} capturingIndex={capturingIndex}
      onCapture={(index) => props.toggleCapture({ target, index })}
      onRemove={(index) => api.setBinding(target, index, null).then(props.setSnap)} />
  );
}

export function SettingsView(props: SettingsProps) {
  const { snap, setSnap } = props;
  const s = snap.settings;
  const set = (key: keyof typeof s) => (v: boolean) => api.setSetting(key, v).then(setSnap);
  const global = (which: GlobalAction) => <BindingsFor {...props} target={{ kind: "global", which }} hotkeys={snap.hotkeys[which]} />;

  return (
    <div className="view">
      <h1 className="view-title">Paramètres</h1>

      <section className="group">
        <h2 className="group-title">Interface</h2>
        <Row icon={<IconStar size={14} />} title="Fenêtre au premier plan" desc="La fenêtre reste visible par-dessus les autres applications.">
          <Toggle checked={s.alwaysOnTop} onChange={set("alwaysOnTop")} label="Fenêtre au premier plan" />
        </Row>
        <Row icon={<IconStar size={14} />} title="Fond transparent" desc="Rend l'arrière-plan de la fenêtre transparent.">
          <Toggle checked={s.transparent} onChange={set("transparent")} label="Fond transparent" />
        </Row>
        <Row icon={<IconStar size={14} />} title="Animations" desc="Transitions et effets lumineux de l'interface.">
          <Toggle checked={s.animations} onChange={set("animations")} label="Animations" />
        </Row>
        <Row icon={<IconStar size={14} />} title="Rester dans la barre système" desc="La croix masque AstralSwitch au lieu de le quitter.">
          <Toggle checked={s.closeToTray} onChange={set("closeToTray")} label="Rester dans la barre système" />
        </Row>
        <Row icon={<IconStar size={14} />} title="Lancer au démarrage de Windows">
          <Toggle checked={s.autostart} onChange={set("autostart")} label="Lancer au démarrage" />
        </Row>
      </section>

      <section className="group">
        <h2 className="group-title">Raccourcis clavier</h2>
        <Row icon={<IconKeyboard size={14} />} title="Personnage suivant">{global("next")}</Row>
        <Row icon={<IconKeyboard size={14} />} title="Personnage précédent">{global("prev")}</Row>
        <Row icon={<IconKeyboard size={14} />} title="Menu radial" desc="Maintenir Alt, viser un personnage puis relâcher.">
          <div className="bindings">
            <kbd className={`keycap ${s.radial ? "" : "muted"}`}>Alt (maintenir)</kbd>
            <Toggle checked={s.radial} onChange={set("radial")} label="Menu radial" />
          </div>
        </Row>
        <Row icon={<IconKeyboard size={14} />} title="Afficher / masquer la fenêtre">{global("toggle")}</Row>
        <Row icon={<IconUsers size={14} />} title="Grouper l'équipe" desc="Le 1er perso connecté de l'équipe active invite les autres (/invite).">{global("group")}</Row>
        <Row icon={<IconUsers size={14} />} title="Accepter automatiquement" desc="Après les invitations, appuie sur Entrée sur chaque perso invité pour accepter.">
          <Toggle checked={s.groupAutoAccept} onChange={set("groupAutoAccept")} label="Accepter automatiquement" />
        </Row>
        <Row icon={<IconGear size={14} />} title="Uniquement en jeu" desc="Les raccourcis ne marchent que quand Dofus est au premier plan.">
          <Toggle checked={s.onlyWhenDofusFocused} onChange={set("onlyWhenDofusFocused")} label="Uniquement en jeu" />
        </Row>
      </section>

      <section className="group">
        <div className="group-head">
          <h2 className="group-title">Accès direct aux personnages</h2>
          <Toggle checked={s.directHotkeys} onChange={set("directHotkeys")} label="Accès direct" />
        </div>
        <div className={s.directHotkeys ? "" : "disabled-block"}>
          {snap.characters.map((c) => (
            <div className="row" key={c.name}>
              <span className="row-icon portrait-icon"><Portrait character={c} size={24} /></span>
              <div className="row-text"><div className="row-title">{c.name}</div></div>
              <BindingsFor {...props} target={{ kind: "character", name: c.name }} hotkeys={c.hotkeys} />
            </div>
          ))}
          {snap.characters.length === 0 && <p className="hint pad">Connecte tes personnages pour leur attribuer une touche.</p>}
        </div>
      </section>

      {props.updater && (
        <section className="group">
          <h2 className="group-title">À propos</h2>
          <Row icon={<IconRefresh size={14} />} title={`AstralSwitch v${__APP_VERSION__}`} desc={updateLabel(props.updater.state)}>
            {props.updater.state.status === "available"
              ? <button className="primary-btn small" onClick={props.updater.install}>Mettre à jour</button>
              : <button className="ghost-btn" onClick={() => props.updater!.check(true)}
                  disabled={props.updater.state.status === "checking" || props.updater.state.status === "downloading"}>
                  Vérifier les mises à jour
                </button>}
          </Row>
        </section>
      )}

      <p className="hint">
        <b>+</b> ajoute un raccourci, un clic le change, <b>×</b> ou clic droit le retire, Échap annule.
        Combinaisons Ctrl / Alt / Maj, souris 4 / 5, molette et touches envoyées par un logiciel de souris (G Hub, Synapse…) acceptées.
      </p>
    </div>
  );
}

