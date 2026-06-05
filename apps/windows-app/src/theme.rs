use crate::utils::encode_wide;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::System::Registry::{
    RegCloseKey, RegNotifyChangeKeyValue, RegOpenKeyExW, RegQueryValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, REG_NOTIFY_CHANGE_LAST_SET,
};
use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_USER};

pub const WM_THEME_CHANGED: u32 = WM_USER + 1;

pub fn is_light_theme() -> bool {
    unsafe {
        let mut hkey = HKEY::default();
        let subkey = encode_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        ).is_err() {
            return false;
        }

        let value_name = encode_wide("SystemUsesLightTheme");
        let mut data = 0u32;
        let mut data_len = std::mem::size_of::<u32>() as u32;

        let res = RegQueryValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            None,
            None,
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut data_len),
        );

        let _ = RegCloseKey(hkey);

        res.is_ok() && data != 0
    }
}

pub fn monitor_theme_changes(hwnd: HWND) {
    let hwnd_raw = hwnd.0 as isize;
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut _);
        unsafe {
            let mut hkey = HKEY::default();
            let subkey = encode_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey.as_ptr()),
                0,
                KEY_READ,
                &mut hkey,
            ).is_ok() {
                loop {
                    let res = RegNotifyChangeKeyValue(
                        hkey,
                        true,
                        REG_NOTIFY_CHANGE_LAST_SET,
                        HANDLE::default(),
                        false,
                    );
                    if res.is_err() {
                        break;
                    }
                    let _ = PostMessageW(hwnd, WM_THEME_CHANGED, WPARAM(0), LPARAM(0));
                }
                let _ = RegCloseKey(hkey);
            }
        }
    });
}
