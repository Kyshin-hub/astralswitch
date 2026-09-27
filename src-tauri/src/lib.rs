mod config;
mod hooks;
mod win;

use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::StateFlags;

use config::{BindTarget, Character, Config, GlobalHotkeys, Hotkey, Settings, Team};
use hooks::{Action, HookEvent};

const POLL_INTERVAL: Duration = Duration::from_millis(300);

struct Inner {
    cfg: Config,
    path: PathBuf,
    windows: Vec<win::GameWindow>,
    last_focused: Option<String>,
    foreground: isize,
    /// Personnages affichés dans le menu radial ouvert
    radial: Vec<(String, isize)>,
}

struct AppState(Mutex<Inner>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CharacterView {
    name: String,
    class_name: String,
    hotkeys: Vec<Hotkey>,
    image: Option<String>,
    online: bool,
    focused: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    characters: Vec<CharacterView>,
    teams: Vec<Team>,
    active_team: String,
    hotkeys: GlobalHotkeys,
    settings: Settings,
    /// Fenêtres Dofus ouvertes mais pas encore connectées à un personnage
    pending: usize,
}

impl Inner {
    fn hwnd_of(&self, name: &str) -> Option<isize> {
        self.windows.iter().find(|w| w.name == name).map(|w| w.hwnd)
    }

    /// Membres connectés de la team active, dans l'ordre d'initiative.
    fn rotation(&self) -> Vec<(String, isize)> {
        let Some(team) = self.cfg.active_team() else { return Vec::new() };
        team.members
            .iter()
            .filter_map(|n| self.hwnd_of(n).map(|h| (n.clone(), h)))
            .collect()
    }

    fn resolve(&self, action: &Action) -> Option<(String, isize)> {
        match action {
            Action::ToggleApp | Action::GroupTeam => None,
            Action::Character(name) => self.hwnd_of(name).map(|h| (name.clone(), h)),
            Action::Next | Action::Prev => {
                let rot = self.rotation();
                if rot.is_empty() {
                    return None;
                }
                let current = rot
                    .iter()
                    .position(|(_, h)| *h == self.foreground)
                    .or_else(|| {
                        let last = self.last_focused.as_deref()?;
                        rot.iter().position(|(n, _)| n == last)
                    });
                let n = rot.len();
                let idx = match (action, current) {
                    (Action::Next, Some(i)) => (i + 1) % n,
                    (Action::Next, None) => 0,
                    (_, Some(i)) => (i + n - 1) % n,
                    (_, None) => n - 1,
                };
                Some(rot[idx].clone())
            }
        }
    }

    /// Met à jour la liste des fenêtres. Retourne true si quelque chose a changé.
    fn sync_windows(&mut self, windows: Vec<win::GameWindow>) -> bool {
        if windows == self.windows {
            return false;
        }
        let mut cfg_changed = false;
        for w in windows.iter().filter(|w| !w.name.is_empty()) {
            match self.cfg.character_mut(&w.name) {
                Some(c) => {
                    if c.class_name != w.class_name && !w.class_name.is_empty() {
                        c.class_name = w.class_name.clone();
                        cfg_changed = true;
                    }
                }
                None => {
                    // Nouveau personnage : on l'ajoute aussi à la team active
                    self.cfg.characters.push(Character {
                        name: w.name.clone(),
                        class_name: w.class_name.clone(),
                        hotkeys: Vec::new(),
                        image: None,
                    });
                    let active = self.cfg.active_team.clone();
                    if let Some(t) = self.cfg.team_mut(&active) {
                        t.members.push(w.name.clone());
                    }
                    cfg_changed = true;
                }
            }
        }
        self.windows = windows;
        hooks::set_dofus_hwnds(self.windows.iter().map(|w| w.hwnd).collect());
        if cfg_changed {
            self.save();
        }
        true
    }

    fn save(&self) {
        self.cfg.save(&self.path);
    }

    fn apply_bindings(&self) {
        let h = &self.cfg.hotkeys;
        let mut b: Vec<(Hotkey, Action)> = Vec::new();
        b.extend(h.next.iter().map(|k| (*k, Action::Next)));
        b.extend(h.prev.iter().map(|k| (*k, Action::Prev)));
        b.extend(h.toggle.iter().map(|k| (*k, Action::ToggleApp)));
        b.extend(h.group.iter().map(|k| (*k, Action::GroupTeam)));
        if self.cfg.settings.direct_hotkeys {
            for c in &self.cfg.characters {
                b.extend(c.hotkeys.iter().map(|k| (*k, Action::Character(c.name.clone()))));
            }
        }
        hooks::set_bindings(b);
        hooks::set_gate(self.cfg.settings.only_when_dofus_focused);
        hooks::set_radial_enabled(self.cfg.settings.radial);
    }

    fn snapshot(&self) -> Snapshot {
        let characters = self
            .cfg
            .characters
            .iter()
            .map(|c| {
                let hwnd = self.hwnd_of(&c.name);
                CharacterView {
                    name: c.name.clone(),
                    class_name: c.class_name.clone(),
                    hotkeys: c.hotkeys.clone(),
                    image: c.image.clone(),
                    online: hwnd.is_some(),
                    focused: hwnd.is_some() && hwnd == Some(self.foreground),
                }
            })
            .collect();
        Snapshot {
            characters,
            teams: self.cfg.teams.clone(),
            active_team: self.cfg.active_team.clone(),
            hotkeys: self.cfg.hotkeys.clone(),
            settings: self.cfg.settings.clone(),
            pending: self.windows.iter().filter(|w| w.name.is_empty()).count(),
        }
    }
}

/// Applique une modification de config, sauvegarde, recharge les raccourcis et notifie l'UI.
fn mutate(app: &AppHandle, state: &State<AppState>, f: impl FnOnce(&mut Config)) -> Snapshot {
    let mut s = state.0.lock().unwrap();
    f(&mut s.cfg);
    s.cfg.ensure_team();
    s.save();
    s.apply_bindings();
    let snap = s.snapshot();
    let _ = app.emit("state", snap.clone());
    snap
}

fn focus_target(app: &AppHandle, target: Option<(String, isize)>) {
    let Some((name, hwnd)) = target else { return };
    win::focus(hwnd);
    let state = app.state::<AppState>();
    let mut s = state.0.lock().unwrap();
    s.last_focused = Some(name);
    s.foreground = hwnd;
    let _ = app.emit("state", s.snapshot());
}

fn emit_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let snap = state.0.lock().unwrap().snapshot();
    let _ = app.emit("state", snap);
}

// ---------- Menu radial ----------

const RADIAL_SIZE: f64 = 360.0;

fn create_radial_window(app: &tauri::App) -> tauri::Result<()> {
    let w = tauri::WebviewWindowBuilder::new(app, "radial", tauri::WebviewUrl::App("index.html#radial".into()))
        .title("AstralSwitch radial")
        .inner_size(RADIAL_SIZE, RADIAL_SIZE)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .build()?;
    // Le menu ne capte jamais la souris : la sélection se fait par la direction du curseur
    let _ = w.set_ignore_cursor_events(true);
    Ok(())
}

fn open_radial(app: &AppHandle, seq: u64) {
    let Some(w) = app.get_webview_window("radial") else { return };
    let state = app.state::<AppState>();
    let items = state.0.lock().unwrap().rotation();
    let center = win::cursor_pos();
    if !hooks::radial_try_open(seq, items.len(), center) {
        return;
    }
    let names: Vec<String> = items.iter().map(|(n, _)| n.clone()).collect();
    state.0.lock().unwrap().radial = items;
    let _ = app.emit_to("radial", "radial-open", names);
    if let Ok(size) = w.outer_size() {
        let (x, y) = (center.0 - size.width as i32 / 2, center.1 - size.height as i32 / 2);
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    if let Ok(h) = w.hwnd() {
        win::show_no_activate(h.0 as isize);
    }
}

fn close_radial(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("radial") {
        let _ = w.hide();
    }
}

// ---------- Grouper l'équipe (invitations en jeu) ----------

static GROUPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct Notice {
    ok: bool,
    message: String,
}

fn notify(app: &AppHandle, ok: bool, message: impl Into<String>) {
    let _ = app.emit_to("main", "notice", Notice { ok, message: message.into() });
}

/// Le chef (1er perso connecté de la team active) invite tous les autres persos connectés.
/// Toujours déclenché par l'utilisateur (bouton ou raccourci).
fn start_group(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_RETURN;

    let (rotation, auto_accept) = {
        let state = app.state::<AppState>();
        let s = state.0.lock().unwrap();
        (s.rotation(), s.cfg.settings.group_auto_accept)
    };
    if rotation.len() < 2 {
        notify(app, false, "Il faut au moins 2 personnages connectés dans l'équipe active.");
        return;
    }
    if GROUPING.swap(true, Ordering::SeqCst) {
        return; // déjà en cours
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let ms = |n| std::thread::sleep(Duration::from_millis(n));
        let (leader, leader_hwnd) = rotation[0].clone();
        win::focus(leader_hwnd);
        ms(300);
        for (name, _) in &rotation[1..] {
            win::send_key(VK_RETURN); // ouvre le chat
            ms(180);
            win::send_text(&format!("/invite {name}"), Duration::from_millis(8));
            ms(80);
            win::send_key(VK_RETURN); // envoie
            ms(450);
        }
        if auto_accept {
            ms(500);
            for (_, hwnd) in &rotation[1..] {
                win::focus(*hwnd);
                ms(350);
                win::send_key(VK_RETURN); // valide la fenêtre d'invitation
                ms(250);
            }
            win::focus(leader_hwnd);
        }
        GROUPING.store(false, Ordering::SeqCst);
        let n = rotation.len() - 1;
        notify(&app, true, format!("{leader} a invité {n} personnage{}.", if n > 1 { "s" } else { "" }));
    });
}

#[tauri::command]
fn group_team(app: AppHandle) {
    start_group(&app);
}

fn apply_always_on_top(app: &AppHandle, value: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(value);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

/// Icône dans la zone de notification : clic gauche = afficher/masquer, clic droit = menu.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("open", "Ouvrir")?,
            &item("refresh", "Rafraîchir")?,
            &item("teams", "Équipes")?,
            &item("settings", "Paramètres")?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "Quitter")?,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("AstralSwitch")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "refresh" => emit_state(app),
            // L'interface change d'onglet à la réception de "navigate"
            view @ ("teams" | "settings") => {
                show_main(app);
                let _ = app.emit_to("main", "navigate", view);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

// ---------- Commandes appelées depuis React ----------

#[tauri::command]
fn get_state(state: State<AppState>) -> Snapshot {
    state.0.lock().unwrap().snapshot()
}

#[tauri::command]
fn set_team_members(app: AppHandle, state: State<AppState>, id: String, members: Vec<String>) -> Snapshot {
    mutate(&app, &state, |c| {
        if let Some(t) = c.team_mut(&id) {
            t.members = members;
        }
    })
}

#[tauri::command]
fn create_team(app: AppHandle, state: State<AppState>, name: String) -> Snapshot {
    mutate(&app, &state, |c| {
        c.teams.push(Team { id: config::new_id(), name, members: Vec::new() });
    })
}

#[tauri::command]
fn rename_team(app: AppHandle, state: State<AppState>, id: String, name: String) -> Snapshot {
    mutate(&app, &state, |c| {
        if let Some(t) = c.team_mut(&id) {
            t.name = name;
        }
    })
}

#[tauri::command]
fn duplicate_team(app: AppHandle, state: State<AppState>, id: String) -> Snapshot {
    mutate(&app, &state, |c| {
        if let Some(pos) = c.teams.iter().position(|t| t.id == id) {
            let mut copy = c.teams[pos].clone();
            copy.id = config::new_id();
            copy.name = format!("{} (copie)", copy.name);
            c.teams.insert(pos + 1, copy);
        }
    })
}

#[tauri::command]
fn delete_team(app: AppHandle, state: State<AppState>, id: String) -> Snapshot {
    mutate(&app, &state, |c| {
        if c.teams.len() > 1 {
            c.teams.retain(|t| t.id != id);
        }
    })
}

#[tauri::command]
fn set_active_team(app: AppHandle, state: State<AppState>, id: String) -> Snapshot {
    mutate(&app, &state, |c| c.active_team = id)
}

/// Ajoute (index = null), remplace ou supprime (hotkey = null) un raccourci d'une action.
#[tauri::command]
fn set_binding(
    app: AppHandle,
    state: State<AppState>,
    target: BindTarget,
    index: Option<usize>,
    hotkey: Option<Hotkey>,
) -> Snapshot {
    mutate(&app, &state, |c| c.set_binding(&target, index, hotkey))
}

#[tauri::command]
fn set_setting(app: AppHandle, state: State<AppState>, key: String, value: bool) -> Snapshot {
    match key.as_str() {
        "alwaysOnTop" => apply_always_on_top(&app, value),
        "autostart" => {
            let launcher = app.autolaunch();
            let _ = if value { launcher.enable() } else { launcher.disable() };
        }
        _ => {}
    }
    mutate(&app, &state, |c| {
        let s = &mut c.settings;
        match key.as_str() {
            "alwaysOnTop" => s.always_on_top = value,
            "transparent" => s.transparent = value,
            "directHotkeys" => s.direct_hotkeys = value,
            "onlyWhenDofusFocused" => s.only_when_dofus_focused = value,
            "collapsed" => s.collapsed = value,
            "closeToTray" => s.close_to_tray = value,
            "autostart" => s.autostart = value,
            "animations" => s.animations = value,
            "radial" => s.radial = value,
            "groupAutoAccept" => s.group_auto_accept = value,
            _ => {}
        }
    })
}

#[tauri::command]
fn forget_character(app: AppHandle, state: State<AppState>, name: String) -> Snapshot {
    mutate(&app, &state, |c| {
        c.characters.retain(|ch| ch.name != name);
        for t in &mut c.teams {
            t.members.retain(|m| *m != name);
        }
    })
}

#[tauri::command]
fn start_capture() {
    hooks::start_capture();
}

#[tauri::command]
fn cancel_capture() {
    hooks::cancel_capture();
}

#[tauri::command]
fn focus_character(app: AppHandle, state: State<AppState>, name: String) {
    let target = state.0.lock().unwrap().resolve(&Action::Character(name));
    focus_target(&app, target);
}

#[tauri::command]
fn close_character(state: State<AppState>, name: String) {
    if let Some(h) = state.0.lock().unwrap().hwnd_of(&name) {
        win::close(h);
    }
}

/// Portrait personnalisé (data URL déjà redimensionnée), ou None pour revenir à l'emblème.
#[tauri::command]
fn set_portrait(app: AppHandle, state: State<AppState>, name: String, image: Option<String>) -> Snapshot {
    mutate(&app, &state, |c| {
        if let Some(ch) = c.character_mut(&name) {
            ch.image = image;
        }
    })
}

#[tauri::command]
fn refresh(app: AppHandle) {
    emit_state(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------- Threads de fond ----------

fn poll_loop(app: AppHandle) {
    loop {
        let windows = win::list_dofus_windows();
        let fg = win::foreground();
        {
            let state = app.state::<AppState>();
            let mut s = state.0.lock().unwrap();
            let mut changed = s.sync_windows(windows);
            if fg != s.foreground {
                s.foreground = fg;
                if let Some(w) = s.windows.iter().find(|w| w.hwnd == fg && !w.name.is_empty()) {
                    s.last_focused = Some(w.name.clone());
                }
                changed = true;
            }
            if changed {
                let _ = app.emit("state", s.snapshot());
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn event_loop(app: AppHandle, rx: mpsc::Receiver<HookEvent>) {
    for ev in rx {
        match ev {
            HookEvent::Action(Action::ToggleApp) => toggle_main(&app),
            HookEvent::Action(Action::GroupTeam) => start_group(&app),
            HookEvent::Action(action) => {
                let target = {
                    let state = app.state::<AppState>();
                    let mut s = state.0.lock().unwrap();
                    // Rafraîchit le premier plan au moment exact de l'appui
                    s.foreground = win::foreground();
                    s.resolve(&action)
                };
                focus_target(&app, target);
            }
            HookEvent::Captured(hk) => {
                let _ = app.emit("hotkey-captured", hk);
            }
            HookEvent::RadialArm(seq) => {
                // Alt doit être tenu un court instant (un simple appui reste un Alt normal)
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(220));
                    open_radial(&app, seq);
                });
            }
            HookEvent::RadialHover(i) => {
                let _ = app.emit_to("radial", "radial-hover", i);
            }
            HookEvent::RadialRelease(choice) => {
                close_radial(&app);
                let target = {
                    let state = app.state::<AppState>();
                    let s = state.0.lock().unwrap();
                    choice.and_then(|i| s.radial.get(i).cloned())
                };
                focus_target(&app, target);
            }
            HookEvent::RadialCancel => close_radial(&app),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Doit être le premier plugin : une 2e instance réaffiche simplement la 1re
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        // Seule la position est mémorisée : la taille dépend de la vue
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .with_denylist(&["radial"])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // Mises à jour automatiques (GitHub Releases, signées)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            if let (WindowEvent::CloseRequested { api, .. }, "main") = (event, window.label()) {
                let state = window.app_handle().state::<AppState>();
                if state.0.lock().unwrap().cfg.settings.close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            build_tray(app)?;
            create_radial_window(app)?;
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("config.json");
            // Reprise de la config de l'ancien nom (Switchix)
            if !path.exists() {
                if let Some(old) = dir.parent().map(|p| p.join("fr.switchix.app").join("config.json")) {
                    let _ = std::fs::copy(old, &path);
                }
            }
            let inner = Inner {
                cfg: Config::load(&path),
                path,
                windows: Vec::new(),
                last_focused: None,
                foreground: 0,
                radial: Vec::new(),
            };
            inner.apply_bindings();
            apply_always_on_top(app.handle(), inner.cfg.settings.always_on_top);
            app.manage(AppState(Mutex::new(inner)));

            let (tx, rx) = mpsc::channel();
            hooks::start(tx);
            let handle = app.handle().clone();
            std::thread::spawn(move || event_loop(handle, rx));
            let handle = app.handle().clone();
            std::thread::spawn(move || poll_loop(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_team_members,
            create_team,
            rename_team,
            duplicate_team,
            delete_team,
            set_active_team,
            set_binding,
            set_setting,
            forget_character,
            start_capture,
            cancel_capture,
            focus_character,
            close_character,
            set_portrait,
            group_team,
            refresh,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de AstralSwitch");
}
