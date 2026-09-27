//! Raccourcis globaux clavier + souris via hooks bas niveau (WH_KEYBOARD_LL / WH_MOUSE_LL).
//!
//! Les callbacks de hook doivent rendre la main très vite : ils se contentent de
//! reconnaître le raccourci et d'envoyer un événement sur un canal. Le vrai
//! travail (changement de focus) est fait par un autre thread.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_ESCAPE, VK_MENU, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetTimer, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_RBUTTONDOWN,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use crate::config::{Hotkey, MOUSE_MIDDLE, MOUSE_X1, MOUSE_X2};
use crate::win;

#[derive(Clone, Debug)]
pub enum Action {
    Next,
    Prev,
    Character(String),
    ToggleApp,
    GroupTeam,
}

pub enum HookEvent {
    Action(Action),
    /// `None` = capture annulée (Échap)
    Captured(Option<Hotkey>),
    /// Alt vient d'être enfoncé seul : ouvrir le menu radial s'il est toujours tenu après un court délai
    RadialArm(u64),
    RadialHover(Option<usize>),
    /// Alt relâché avec le menu ouvert : choisir l'élément survolé
    RadialRelease(Option<usize>),
    RadialCancel,
}

// ---------- Menu radial (maintenir Alt) ----------

struct Radial {
    seq: u64,
    armed: bool,
    open: bool,
    center: (i32, i32),
    count: usize,
    hover: Option<usize>,
}

static RADIAL: Mutex<Radial> =
    Mutex::new(Radial { seq: 0, armed: false, open: false, center: (0, 0), count: 0, hover: None });
static RADIAL_ENABLED: AtomicBool = AtomicBool::new(true);
static ALT_DOWN: AtomicBool = AtomicBool::new(false);
/// Rayon (en pixels physiques) sous lequel rien n'est sélectionné
const RADIAL_DEAD_ZONE: f64 = 40.0;

pub fn set_radial_enabled(v: bool) {
    RADIAL_ENABLED.store(v, Ordering::Relaxed);
}

/// Ouvre le menu si Alt est toujours tenu depuis l'armement `seq`.
pub fn radial_try_open(seq: u64, count: usize, center: (i32, i32)) -> bool {
    let mut r = RADIAL.lock().unwrap();
    if !r.armed || r.seq != seq || count == 0 || !ALT_DOWN.load(Ordering::Relaxed) {
        return false;
    }
    r.open = true;
    r.count = count;
    r.center = center;
    r.hover = None;
    true
}

fn radial_disarm() {
    let mut r = RADIAL.lock().unwrap();
    r.armed = false;
    if r.open {
        r.open = false;
        send(HookEvent::RadialCancel);
    }
}

/// Index de l'élément dans la direction du curseur (0 = en haut, sens horaire).
pub fn radial_index(center: (i32, i32), pt: (i32, i32), count: usize) -> Option<usize> {
    let (dx, dy) = ((pt.0 - center.0) as f64, (pt.1 - center.1) as f64);
    if count == 0 || dx.hypot(dy) < RADIAL_DEAD_ZONE {
        return None;
    }
    let tau = std::f64::consts::TAU;
    let angle = dx.atan2(-dy).rem_euclid(tau);
    let step = tau / count as f64;
    Some(((angle / step).round() as usize) % count)
}

fn on_alt(down: bool) {
    if down {
        if ALT_DOWN.swap(true, Ordering::Relaxed) {
            return; // auto-répétition
        }
        if RADIAL_ENABLED.load(Ordering::Relaxed) && gate_open() {
            let mut r = RADIAL.lock().unwrap();
            r.seq += 1;
            r.armed = true;
            send(HookEvent::RadialArm(r.seq));
        }
    } else {
        ALT_DOWN.store(false, Ordering::Relaxed);
        let mut r = RADIAL.lock().unwrap();
        r.armed = false;
        if r.open {
            r.open = false;
            send(HookEvent::RadialRelease(r.hover));
        }
    }
}

static TX: OnceLock<Mutex<Sender<HookEvent>>> = OnceLock::new();
static BINDINGS: Mutex<Vec<(Hotkey, Action)>> = Mutex::new(Vec::new());
static DOFUS_HWNDS: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static GATE: AtomicBool = AtomicBool::new(true);
static CAPTURING: AtomicBool = AtomicBool::new(false);
/// Touche → instant du dernier appui, pour reconnaître l'auto-répétition.
/// Une entrée expire d'elle-même : si un relâchement n'a jamais été vu
/// (hook momentanément retiré, macro sans « relâché »), la touche n'est pas bloquée.
static HELD: Mutex<Option<HashMap<u32, u32>>> = Mutex::new(None);
/// Au-delà, un nouvel appui n'est plus considéré comme une répétition
const REPEAT_WINDOW_MS: u32 = 1100;

fn is_repeat(vk: u32, now: u32) -> bool {
    let mut held = HELD.lock().unwrap();
    let held = held.get_or_insert_with(HashMap::new);
    let repeat = held.get(&vk).is_some_and(|&t| now.wrapping_sub(t) < REPEAT_WINDOW_MS);
    held.insert(vk, now);
    repeat
}
/// Bitmask des boutons souris dont on a avalé le "down" → avaler aussi le "up"
static SWALLOWED_MOUSE: AtomicU32 = AtomicU32::new(0);

// Les événements « injectés » (touches envoyées par un logiciel de souris/clavier
// type G Hub, Razer Synapse, AutoHotkey…) sont volontairement traités comme de
// vraies touches : sinon une macro souris → F9 serait invisible.

pub fn set_bindings(b: Vec<(Hotkey, Action)>) {
    *BINDINGS.lock().unwrap() = b;
}

pub fn set_dofus_hwnds(h: Vec<isize>) {
    *DOFUS_HWNDS.lock().unwrap() = h;
}

pub fn set_gate(only_when_dofus_focused: bool) {
    GATE.store(only_when_dofus_focused, Ordering::Relaxed);
}

pub fn start_capture() {
    CAPTURING.store(true, Ordering::Relaxed);
}

pub fn cancel_capture() {
    CAPTURING.store(false, Ordering::Relaxed);
}

fn send(ev: HookEvent) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().unwrap().send(ev);
    }
}

fn is_down(vk: u16) -> bool {
    unsafe { GetAsyncKeyState(vk as i32) < 0 }
}

fn current_mods(code: u32) -> Hotkey {
    Hotkey {
        code,
        ctrl: is_down(VK_CONTROL.0),
        alt: is_down(VK_MENU.0),
        shift: is_down(VK_SHIFT.0),
    }
}

fn is_modifier(vk: u32) -> bool {
    matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C | 0xA0..=0xA5)
}

/// Les raccourcis ne sont actifs que si Dofus (ou AstralSwitch) est au premier plan.
fn gate_open() -> bool {
    if !GATE.load(Ordering::Relaxed) {
        return true;
    }
    let fg = win::foreground();
    if DOFUS_HWNDS.lock().unwrap().contains(&fg) {
        return true;
    }
    win::window_pid(fg) == std::process::id()
}

/// Retourne true si l'événement doit être avalé.
fn on_press(code: u32) -> bool {
    let hk = current_mods(code);
    if CAPTURING.swap(false, Ordering::Relaxed) {
        send(HookEvent::Captured((code != VK_ESCAPE.0 as u32).then_some(hk)));
        return true;
    }
    let action = BINDINGS
        .lock()
        .unwrap()
        .iter()
        .find(|(b, _)| *b == hk)
        .map(|(_, a)| a.clone());
    match action {
        Some(a) if gate_open() => {
            send(HookEvent::Action(a));
            true
        }
        _ => false,
    }
}

fn is_bound(code: u32) -> bool {
    CAPTURING.load(Ordering::Relaxed) || BINDINGS.lock().unwrap().iter().any(|(b, _)| b.code == code)
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        LAST_HOOK_TICK.store(kb.time, Ordering::Relaxed);
        if kb.dwExtraInfo == win::INPUT_TAG {
            // Touches tapées par AstralSwitch lui-même (invitation de groupe) : on n'y touche pas
            return CallNextHookEx(HHOOK::default(), code, wparam, lparam);
        }
        let vk = kb.vkCode;
        let msg = wparam.0 as u32;
        let is_down_msg = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        if matches!(vk, 0x12 | 0xA4 | 0xA5) {
            // Alt n'est jamais avalé : le jeu le reçoit normalement
            on_alt(is_down_msg);
        } else if is_down_msg && !CAPTURING.load(Ordering::Relaxed) {
            // Toute autre touche pendant Alt = combinaison (Alt+Tab…) : pas de menu radial
            radial_disarm();
        }
        if !is_modifier(vk) {
            if is_down_msg {
                if is_repeat(vk, kb.time) {
                    // Auto-répétition : on n'agit pas, mais on garde le même comportement d'avalement
                    if is_bound(vk) && gate_open() {
                        return LRESULT(1);
                    }
                } else if on_press(vk) {
                    return LRESULT(1);
                }
            } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
                HELD.lock().unwrap().get_or_insert_with(HashMap::new).remove(&vk);
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        LAST_HOOK_TICK.store(ms.time, Ordering::Relaxed);
        {
            let msg = wparam.0 as u32;
            match msg {
                WM_MOUSEMOVE => {
                    let mut r = RADIAL.lock().unwrap();
                    if r.open {
                        let hover = radial_index(r.center, (ms.pt.x, ms.pt.y), r.count);
                        if hover != r.hover {
                            r.hover = hover;
                            send(HookEvent::RadialHover(hover));
                        }
                    }
                }
                // Alt+clic est utilisé en jeu : un clic annule le menu radial
                WM_LBUTTONDOWN | WM_RBUTTONDOWN => radial_disarm(),
                _ => {}
            }
            let xbtn = (ms.mouseData >> 16) & 0xFFFF;
            let button = match msg {
                WM_MBUTTONDOWN | WM_MBUTTONUP => Some(MOUSE_MIDDLE),
                WM_XBUTTONDOWN | WM_XBUTTONUP if xbtn == 1 => Some(MOUSE_X1),
                WM_XBUTTONDOWN | WM_XBUTTONUP if xbtn == 2 => Some(MOUSE_X2),
                _ => None,
            };
            if let Some(b) = button {
                let bit = 1u32 << (b & 0xF);
                let down = msg == WM_MBUTTONDOWN || msg == WM_XBUTTONDOWN;
                if down {
                    if on_press(b) {
                        SWALLOWED_MOUSE.fetch_or(bit, Ordering::Relaxed);
                        return LRESULT(1);
                    }
                } else if SWALLOWED_MOUSE.fetch_and(!bit, Ordering::Relaxed) & bit != 0 {
                    return LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// Test de bout en bout avec les vrais hooks Windows : `cargo test --lib -- --ignored`
/// (envoie de vraies touches au système, donc désactivé par défaut).
#[cfg(test)]
mod live_tests {
    use super::*;
    use std::time::Duration;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };

    fn key(vk: u16, up: bool) {
        let flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    fn capture(rx: &std::sync::mpsc::Receiver<HookEvent>) -> Option<Hotkey> {
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).expect("aucun événement du hook") {
                HookEvent::Captured(h) => return h,
                _ => continue,
            }
        }
    }

    #[test]
    #[ignore]
    fn captures_oem_102_even_after_lost_keyup() {
        let (tx, rx) = std::sync::mpsc::channel();
        start(tx);
        std::thread::sleep(Duration::from_millis(300));

        // 1) Capture normale de « < » (VK_OEM_102)
        start_capture();
        key(0xE2, false);
        key(0xE2, true);
        assert_eq!(capture(&rx).map(|h| h.code), Some(0xE2));

        // 2) Appui dont le relâchement est perdu, puis nouvelle capture un peu plus tard
        key(0xE2, false); // pas de keyup
        std::thread::sleep(Duration::from_millis(1300));
        start_capture();
        key(0xE2, false);
        key(0xE2, true);
        assert_eq!(capture(&rx).map(|h| h.code), Some(0xE2));
    }
}

#[cfg(test)]
mod tests {
    use super::radial_index;

    #[test]
    fn radial_directions() {
        let c = (100, 100);
        assert_eq!(radial_index(c, (100, 20), 4), Some(0)); // haut
        assert_eq!(radial_index(c, (180, 100), 4), Some(1)); // droite
        assert_eq!(radial_index(c, (100, 180), 4), Some(2)); // bas
        assert_eq!(radial_index(c, (20, 100), 4), Some(3)); // gauche
        assert_eq!(radial_index(c, (105, 95), 4), None); // zone morte
    }
}

// ---------- Installation + chien de garde ----------
//
// Windows retire silencieusement un hook bas niveau qui répond trop lentement
// (PC chargé, jeu qui rame…). Sans surveillance, plus aucun raccourci ne marche
// jusqu'au redémarrage. On vérifie donc régulièrement que les hooks voient bien
// les saisies, et on les réinstalle sinon.

/// Horodatage (GetTickCount) du dernier événement vu par nos hooks
static LAST_HOOK_TICK: AtomicU32 = AtomicU32::new(0);
const WATCHDOG_MS: u32 = 2000;
/// Réinstallation préventive, même si tout semble aller bien
const REFRESH_EVERY_TICKS: u32 = 15;

/// Une saisie système a eu lieu sans que nos hooks la voient → ils ont été retirés.
fn hooks_missed_input() -> bool {
    let mut lii = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if !unsafe { GetLastInputInfo(&mut lii) }.as_bool() {
        return false;
    }
    let seen = LAST_HOOK_TICK.load(Ordering::Relaxed);
    (lii.dwTime.wrapping_sub(seen) as i32) > 1500
}

unsafe fn install(hmod: HINSTANCE) -> (HHOOK, HHOOK) {
    let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hmod, 0);
    let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0);
    if kb.is_err() || ms.is_err() {
        eprintln!("AstralSwitch: impossible d'installer les hooks ({kb:?}, {ms:?})");
    }
    (kb.unwrap_or_default(), ms.unwrap_or_default())
}

/// Installe les hooks dans un thread dédié avec sa propre boucle de messages.
pub fn start(tx: Sender<HookEvent>) {
    let _ = TX.set(Mutex::new(tx));
    std::thread::spawn(|| unsafe {
        let hmod = GetModuleHandleW(PCWSTR::null())
            .map(|m| HINSTANCE(m.0))
            .unwrap_or_default();
        let (mut kb, mut ms) = install(hmod);
        // Timer de thread : WM_TIMER arrive dans cette boucle de messages
        SetTimer(HWND::default(), 0, WATCHDOG_MS, None);
        let mut ticks = 0u32;
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            if msg.message == WM_TIMER {
                ticks += 1;
                let missed = hooks_missed_input();
                if missed || ticks >= REFRESH_EVERY_TICKS {
                    if missed {
                        eprintln!("AstralSwitch: hooks retirés par Windows, réinstallation");
                    }
                    let _ = UnhookWindowsHookEx(kb);
                    let _ = UnhookWindowsHookEx(ms);
                    (kb, ms) = install(hmod);
                    // Évite de reboucler sur la même saisie manquée
                    let mut lii = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
                    if GetLastInputInfo(&mut lii).as_bool() {
                        LAST_HOOK_TICK.store(lii.dwTime, Ordering::Relaxed);
                    }
                    ticks = 0;
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
