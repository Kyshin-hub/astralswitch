use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

/// Codes spéciaux pour les boutons de souris (au-delà des virtual-keys clavier).
pub const MOUSE_MIDDLE: u32 = 0x1_0003;
pub const MOUSE_X1: u32 = 0x1_0004;
pub const MOUSE_X2: u32 = 0x1_0005;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hotkey {
    pub code: u32,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
}

impl Hotkey {
    pub const fn plain(code: u32) -> Self {
        Self { code, ctrl: false, alt: false, shift: false }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub name: String,
    #[serde(default)]
    pub class_name: String,
    /// Plusieurs raccourcis possibles (« F1 ou Souris 4 »)
    #[serde(default, alias = "hotkey", deserialize_with = "one_or_many")]
    pub hotkeys: Vec<Hotkey>,
    /// Portrait personnalisé (data URL, redimensionné côté interface)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// Accepte l'ancien format (un seul raccourci ou null) et le nouveau (liste).
fn one_or_many<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Hotkey>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        Many(Vec<Hotkey>),
        One(Option<Hotkey>),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::Many(v) => v,
        OneOrMany::One(o) => o.into_iter().collect(),
    })
}

/// Cible d'un raccourci, telle qu'envoyée par l'interface.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BindTarget {
    Global { which: String },
    Character { name: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    /// Ordre = ordre d'initiative
    pub members: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalHotkeys {
    #[serde(deserialize_with = "one_or_many")]
    pub next: Vec<Hotkey>,
    #[serde(deserialize_with = "one_or_many")]
    pub prev: Vec<Hotkey>,
    /// Afficher / masquer AstralSwitch
    #[serde(deserialize_with = "one_or_many")]
    pub toggle: Vec<Hotkey>,
    /// Inviter tous les persos connectés dans le groupe du chef
    #[serde(deserialize_with = "one_or_many")]
    pub group: Vec<Hotkey>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub always_on_top: bool,
    pub transparent: bool,
    pub direct_hotkeys: bool,
    pub only_when_dofus_focused: bool,
    /// Barre de portraits repliée
    pub collapsed: bool,
    /// La croix masque la fenêtre au lieu de quitter
    pub close_to_tray: bool,
    pub autostart: bool,
    pub animations: bool,
    /// Maintenir Alt pour afficher le menu radial
    pub radial: bool,
    /// Après les invitations, valider (Entrée) sur chaque perso invité
    pub group_auto_accept: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            always_on_top: true,
            transparent: false,
            direct_hotkeys: true,
            only_when_dofus_focused: true,
            collapsed: false,
            close_to_tray: true,
            autostart: false,
            animations: true,
            radial: true,
            group_auto_accept: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub characters: Vec<Character>,
    pub teams: Vec<Team>,
    pub active_team: String,
    pub hotkeys: GlobalHotkeys,
    pub settings: Settings,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            characters: Vec::new(),
            teams: Vec::new(),
            active_team: String::new(),
            hotkeys: GlobalHotkeys {
                next: vec![Hotkey::plain(MOUSE_X2)],
                prev: vec![Hotkey::plain(MOUSE_X1)],
                toggle: Vec::new(),
                group: Vec::new(),
            },
            settings: Settings::default(),
        }
    }
}

pub fn new_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("t{nanos:x}")
}

impl Config {
    pub fn load(path: &Path) -> Self {
        let mut cfg: Config = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Nettoie les faux personnages créés par l'écran de connexion ("Dofus 3.x - Release")
        cfg.characters.retain(|c| !crate::win::is_login_title(&c.name));
        let names: Vec<String> = cfg.characters.iter().map(|c| c.name.clone()).collect();
        for t in &mut cfg.teams {
            t.members.retain(|m| names.contains(m));
        }
        cfg.ensure_team();
        cfg
    }

    pub fn save(&self, path: &Path) {
        if let Ok(json) = serde_json::to_string_pretty(self) {
            // Écriture atomique : fichier temporaire puis renommage
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, path);
            }
        }
    }

    /// Garantit qu'il existe au moins une team et qu'une team est active.
    pub fn ensure_team(&mut self) {
        if self.teams.is_empty() {
            self.teams.push(Team {
                id: new_id(),
                name: "Team principale".into(),
                members: self.characters.iter().map(|c| c.name.clone()).collect(),
            });
        }
        if !self.teams.iter().any(|t| t.id == self.active_team) {
            self.active_team = self.teams[0].id.clone();
        }
    }

    pub fn active_team(&self) -> Option<&Team> {
        self.teams.iter().find(|t| t.id == self.active_team)
    }

    pub fn team_mut(&mut self, id: &str) -> Option<&mut Team> {
        self.teams.iter_mut().find(|t| t.id == id)
    }

    pub fn character_mut(&mut self, name: &str) -> Option<&mut Character> {
        self.characters.iter_mut().find(|c| c.name == name)
    }

    /// Retire un raccourci de partout pour éviter les doublons.
    pub fn unbind(&mut self, hk: Hotkey) {
        let h = &mut self.hotkeys;
        for list in [&mut h.next, &mut h.prev, &mut h.toggle, &mut h.group] {
            list.retain(|k| *k != hk);
        }
        for c in &mut self.characters {
            c.hotkeys.retain(|k| *k != hk);
        }
    }

    pub fn bindings_mut(&mut self, target: &BindTarget) -> Option<&mut Vec<Hotkey>> {
        match target {
            BindTarget::Global { which } => match which.as_str() {
                "next" => Some(&mut self.hotkeys.next),
                "prev" => Some(&mut self.hotkeys.prev),
                "toggle" => Some(&mut self.hotkeys.toggle),
                "group" => Some(&mut self.hotkeys.group),
                _ => None,
            },
            BindTarget::Character { name } => self.character_mut(name).map(|c| &mut c.hotkeys),
        }
    }

    /// Ajoute (`index` = None), remplace ou supprime (`hotkey` = None) un raccourci.
    pub fn set_binding(&mut self, target: &BindTarget, index: Option<usize>, hotkey: Option<Hotkey>) {
        // Remplacer = supprimer l'ancien puis insérer le nouveau à la même place
        let mut pos = None;
        if let (Some(i), Some(list)) = (index, self.bindings_mut(target)) {
            if i < list.len() {
                list.remove(i);
                pos = Some(i);
            }
        }
        let Some(hk) = hotkey else { return };
        self.unbind(hk);
        let Some(list) = self.bindings_mut(target) else { return };
        let at = pos.unwrap_or(list.len()).min(list.len());
        list.insert(at, hk);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F1: Hotkey = Hotkey::plain(0x70);
    const F2: Hotkey = Hotkey::plain(0x71);

    #[test]
    fn reads_old_single_hotkey_format() {
        let json = r#"{"characters":[{"name":"A","hotkey":{"code":112}}],
                       "hotkeys":{"next":{"code":113},"prev":null}}"#;
        let cfg: Config = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.characters[0].hotkeys, vec![F1]);
        assert_eq!(cfg.hotkeys.next, vec![F2]);
        assert!(cfg.hotkeys.prev.is_empty());
    }

    #[test]
    fn add_replace_remove_and_dedupe() {
        let mut cfg = Config::default();
        cfg.characters.push(Character { name: "A".into(), class_name: String::new(), hotkeys: vec![], image: None });
        let next = BindTarget::Global { which: "next".into() };
        let a = BindTarget::Character { name: "A".into() };

        cfg.set_binding(&next, None, Some(F1));
        assert_eq!(cfg.hotkeys.next, vec![Hotkey::plain(MOUSE_X2), F1]);
        // F1 réassigné au perso A : retiré de "suivant"
        cfg.set_binding(&a, None, Some(F1));
        assert_eq!(cfg.hotkeys.next, vec![Hotkey::plain(MOUSE_X2)]);
        assert_eq!(cfg.characters[0].hotkeys, vec![F1]);
        // Remplacement à la même place
        cfg.set_binding(&next, Some(0), Some(F2));
        assert_eq!(cfg.hotkeys.next, vec![F2]);
        // Suppression
        cfg.set_binding(&a, Some(0), None);
        assert!(cfg.characters[0].hotkeys.is_empty());
    }
}