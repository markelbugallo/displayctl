use crate::theme::is_light_theme;
use crate::utils::encode_wide;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
    NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{HICON, WM_USER};

pub const WM_TRAY_ICON_CALLBACK: u32 = WM_USER + 2;

pub fn update_tray_icon(hwnd: HWND, add: bool, icon_black: HICON, icon_white: HICON) {
    unsafe {
        let use_light = is_light_theme();
        let hicon = if use_light { icon_black } else { icon_white };

        let mut tooltip_arr = [0u16; 128];
        let tooltip_wide = encode_wide("Control de brillo");
        let len = tooltip_wide.len().min(127);
        tooltip_arr[..len].copy_from_slice(&tooltip_wide[..len]);

        let nid = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: 1,
            uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
            uCallbackMessage: WM_TRAY_ICON_CALLBACK,
            hIcon: hicon,
            szTip: tooltip_arr,
            ..Default::default()
        };

        let action = if add { NIM_ADD } else { NIM_MODIFY };
        let _ = Shell_NotifyIconW(action, &nid);
    }
}

pub fn delete_tray_icon(hwnd: HWND) {
    unsafe {
        let nid = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: 1,
            ..Default::default()
        };
        let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}
