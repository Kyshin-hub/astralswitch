//! Détection et pilotage des fenêtres Dofus Unity via l'API Win32.

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, WPARAM};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW, SetForegroundWindow,
    SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_RESTORE,
    SW_SHOWNOACTIVATE, WM_CLOSE,
};

/// Marque les touches envoyées par AstralSwitch (le hook les laisse passer sans les interpréter).
pub const INPUT_TAG: usize = 0x4153_5457; // "ASTW"

fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: INPUT_TAG },
        },
    }
}

fn send(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Appui + relâchement d'une touche (virtual-key + scan code, pour Unity).
pub fn send_key(vk: VIRTUAL_KEY) {
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
    send(&[key_input(vk.0, scan, KEYBD_EVENT_FLAGS(0)), key_input(vk.0, scan, KEYEVENTF_KEYUP)]);
}

/// Tape un texte caractère par caractère (saisie Unicode, indépendante du clavier AZERTY/QWERTY).
pub fn send_text(text: &str, delay: std::time::Duration) {
    for unit in text.encode_utf16() {
        send(&[key_input(0, unit, KEYEVENTF_UNICODE), key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]);
        std::thread::sleep(delay);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameWindow {
    pub hwnd: isize,
    pub pid: u32,
    /// Vide tant que le personnage n'est pas connecté
    pub name: String,
    pub class_name: String,
}

fn hwnd(h: isize) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

fn wide_to_string(buf: &[u16], len: i32) -> String {
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

/// Titre Dofus Unity connecté : "Pseudo - Classe - 3.x.x.x - Release".
/// À l'écran de connexion : "Dofus 3.x.x.x - Release" → pas de personnage.
fn parse_title(title: &str) -> (String, String) {
    let parts: Vec<&str> = title.split(" - ").map(str::trim).collect();
    match parts.as_slice() {
        [name, class, _, ..] if !name.is_empty() && !is_login_title(name) => (name.to_string(), class.to_string()),
        _ => (String::new(), String::new()),
    }
}

/// "Dofus", "Dofus 3.6.12.16"…
pub fn is_login_title(name: &str) -> bool {
    let rest = name.strip_prefix("Dofus").unwrap_or("x");
    rest.trim().chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn is_dofus_process(pid: u32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid) else {
            return false;
        };
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return false;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        let exe = path.rsplit('\\').next().unwrap_or_default().to_lowercase();
        exe.starts_with("dofus")
    }
}

unsafe extern "system" fn enum_proc(h: HWND, lp: LPARAM) -> BOOL {
    let out = &mut *(lp.0 as *mut Vec<GameWindow>);
    if !IsWindowVisible(h).as_bool() {
        return BOOL(1);
    }
    let mut cls = [0u16; 64];
    let n = GetClassNameW(h, &mut cls);
    if wide_to_string(&cls, n) != "UnityWndClass" {
        return BOOL(1);
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, Some(&mut pid as *mut u32));
    if !is_dofus_process(pid) {
        return BOOL(1);
    }
    let mut buf = [0u16; 256];
    let len = GetWindowTextW(h, &mut buf);
    let (name, class_name) = parse_title(&wide_to_string(&buf, len));
    out.push(GameWindow { hwnd: h.0 as isize, pid, name, class_name });
    BOOL(1)
}

pub fn list_dofus_windows() -> Vec<GameWindow> {
    let mut out: Vec<GameWindow> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

pub fn window_pid(h: isize) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd(h), Some(&mut pid as *mut u32));
    }
    pid
}

/// Met la fenêtre au premier plan en contournant la restriction
/// de Windows sur SetForegroundWindow (AttachThreadInput).
pub fn focus(h: isize) -> bool {
    unsafe {
        let w = hwnd(h);
        if IsIconic(w).as_bool() {
            let _ = ShowWindow(w, SW_RESTORE);
        }
        let fg = GetForegroundWindow();
        if fg == w {
            return true;
        }
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let attached =
            fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, BOOL(1)).as_bool();
        let _ = BringWindowToTop(w);
        let ok = SetForegroundWindow(w).as_bool();
        if attached {
            let _ = AttachThreadInput(me, fg_thread, BOOL(0));
        }
        ok
    }
}

pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

/// Affiche une fenêtre par-dessus tout sans lui donner le focus (le jeu garde le clavier).
pub fn show_no_activate(h: isize) {
    unsafe {
        let w = hwnd(h);
        let _ = ShowWindow(w, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(w, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
    }
}

/// Demande poliment la fermeture du client (équivalent de la croix).
pub fn close(h: isize) {
    unsafe {
        let _ = PostMessageW(hwnd(h), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
}

#[cfg(test)]
mod tests {
    use super::parse_title;

    #[test]
    fn parses_unity_title() {
        assert_eq!(
            parse_title("Kyrial - Iop - 3.1.12.4 - Release"),
            ("Kyrial".into(), "Iop".into())
        );
        assert_eq!(parse_title("Dofus"), (String::new(), String::new()));
        assert_eq!(parse_title("Dofus 3.6.12.16 - Release"), (String::new(), String::new()));
        assert_eq!(
            parse_title("Cosma-Nyx - Eliotrope - 3.6.12.16 - Release"),
            ("Cosma-Nyx".into(), "Eliotrope".into())
        );
    }
}
