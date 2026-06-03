#![cfg_attr(not(test), windows_subsystem = "windows")]

use std::sync::OnceLock;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, POINT, WPARAM, HANDLE, HINSTANCE};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
};
use windows::Win32::Devices::Display::{
    GetDisplayConfigBufferSizes, QueryDisplayConfig, DISPLAYCONFIG_MODE_INFO,
    DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegNotifyChangeKeyValue, RegOpenKeyExW, RegQueryValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, REG_NOTIFY_CHANGE_LAST_SET,
};
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, DestroyIcon, DestroyMenu, DestroyWindow,
    DispatchMessageW, GetCursorPos, GetMessageW, PostMessageW, PostQuitMessage, RegisterClassW,
    SetForegroundWindow, TrackPopupMenu, TranslateMessage, CreateWindowExW, DefWindowProcW, HICON,
    ICONINFO, MSG, WNDCLASSW, WM_COMMAND, WM_DESTROY, WM_LBUTTONUP, WM_RBUTTONUP, WM_USER,
    MF_GRAYED, MF_SEPARATOR, MF_STRING, TPM_LEFTALIGN, TPM_RIGHTBUTTON,
};

const ICON_BLACK_PNG: &[u8] = include_bytes!("../../../assets/displayctl_icon_black.png");
const ICON_WHITE_PNG: &[u8] = include_bytes!("../../../assets/displayctl_icon_white.png");

const WM_THEME_CHANGED: u32 = WM_USER + 1;
const WM_TRAY_ICON_CALLBACK: u32 = WM_USER + 2;

struct AppState {
    icon_black: HICON,
    icon_white: HICON,
}

static APP_STATE: OnceLock<AppState> = OnceLock::new();

fn encode_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn create_icon_from_png(png_bytes: &[u8]) -> Result<HICON, Box<dyn std::error::Error>> {
    let decoder = png::Decoder::new(png_bytes);
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf)?;

    let width = info.width;
    let height = info.height;

    let mut bgra_pixels = vec![0u8; (width * height * 4) as usize];
    match info.color_type {
        png::ColorType::Rgba => {
            for i in 0..(width * height) as usize {
                let r = buf[i * 4];
                let g = buf[i * 4 + 1];
                let b = buf[i * 4 + 2];
                let a = buf[i * 4 + 3];
                bgra_pixels[i * 4] = b;
                bgra_pixels[i * 4 + 1] = g;
                bgra_pixels[i * 4 + 2] = r;
                bgra_pixels[i * 4 + 3] = a;
            }
        }
        png::ColorType::Rgb => {
            for i in 0..(width * height) as usize {
                let r = buf[i * 3];
                let g = buf[i * 3 + 1];
                let b = buf[i * 3 + 2];
                bgra_pixels[i * 4] = b;
                bgra_pixels[i * 4 + 1] = g;
                bgra_pixels[i * 4 + 2] = r;
                bgra_pixels[i * 4 + 3] = 255;
            }
        }
        _ => return Err("Unsupported color type".into()),
    }

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut bits = std::ptr::null_mut();
    let hbm_color = CreateDIBSection(
        HDC::default(),
        &bmi,
        DIB_RGB_COLORS,
        &mut bits,
        HANDLE::default(),
        0,
    )?;

    if !bits.is_null() {
        std::ptr::copy_nonoverlapping(bgra_pixels.as_ptr(), bits as *mut u8, bgra_pixels.len());
    }

    let mask_bits = vec![0u8; ((width + 15) / 16 * 2 * height) as usize];
    let hbm_mask = CreateBitmap(
        width as i32,
        height as i32,
        1,
        1,
        Some(mask_bits.as_ptr() as *const _),
    )?;

    let icon_info = ICONINFO {
        fIcon: BOOL::from(true),
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: hbm_mask,
        hbmColor: hbm_color,
    };

    let hicon = CreateIconIndirect(&icon_info)?;

    let _ = DeleteObject(hbm_color);
    let _ = DeleteObject(hbm_mask);

    Ok(hicon)
}

fn is_light_theme() -> bool {
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
        let mut value_type = 0u32;
        let mut data = 0u32;
        let mut data_len = std::mem::size_of::<u32>() as u32;

        let res = RegQueryValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut value_type),
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut data_len),
        );

        let _ = RegCloseKey(hkey);

        res.is_ok() && data != 0
    }
}

fn count_external_monitors() -> usize {
    unsafe {
        let mut num_paths = 0;
        let mut num_modes = 0;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut num_paths, &mut num_modes).is_err() {
            return 0;
        }

        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); num_paths as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); num_modes as usize];

        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut num_paths,
            paths.as_mut_ptr(),
            &mut num_modes,
            modes.as_mut_ptr(),
            None,
        ).is_err() {
            return 0;
        }

        let mut external_count = 0;
        for path in &paths[..num_paths as usize] {
            let tech = path.targetInfo.outputTechnology;
            if tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL {
                external_count += 1;
            }
        }
        external_count
    }
}

fn update_tray_icon(hwnd: HWND, add: bool) {
    unsafe {
        let state = APP_STATE.get().unwrap();
        let use_light = is_light_theme();
        let hicon = if use_light { state.icon_black } else { state.icon_white };

        let mut tooltip_arr = [0u16; 128];
        let tooltip_wide = encode_wide("displayctl");
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

fn delete_tray_icon(hwnd: HWND) {
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

fn monitor_theme_changes(hwnd: HWND) {
    std::thread::spawn(move || {
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

unsafe fn show_context_menu(hwnd: HWND) {
    if let Ok(hmenu) = CreatePopupMenu() {
        let menu_title = encode_wide("displayctl");
        let _ = AppendMenuW(hmenu, MF_GRAYED | MF_STRING, 1000, PCWSTR(menu_title.as_ptr()));
        let _ = AppendMenuW(hmenu, MF_SEPARATOR, 0, PCWSTR::null());

        let count = count_external_monitors();
        let monitor_status = if count == 0 {
            "No se detectaron monitores externos".to_string()
        } else if count == 1 {
            "1 monitor externo detectado".to_string()
        } else {
            format!("{} monitores externos detectados", count)
        };

        let status_wide = encode_wide(&monitor_status);
        let _ = AppendMenuW(hmenu, MF_GRAYED | MF_STRING, 1001, PCWSTR(status_wide.as_ptr()));
        let _ = AppendMenuW(hmenu, MF_SEPARATOR, 0, PCWSTR::null());

        let exit_wide = encode_wide("Salir");
        let _ = AppendMenuW(hmenu, MF_STRING, 2000, PCWSTR(exit_wide.as_ptr()));

        let mut pos = POINT::default();
        let _ = GetCursorPos(&mut pos);

        let _ = SetForegroundWindow(hwnd);
        let _ = TrackPopupMenu(
            hmenu,
            TPM_LEFTALIGN | TPM_RIGHTBUTTON,
            pos.x,
            pos.y,
            0,
            hwnd,
            None,
        );

        let _ = DestroyMenu(hmenu);
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_THEME_CHANGED => {
            update_tray_icon(hwnd, false);
            LRESULT(0)
        }
        WM_TRAY_ICON_CALLBACK => {
            let event = lparam.0 as u32;
            if event == WM_RBUTTONUP || event == WM_LBUTTONUP {
                show_context_menu(hwnd);
            }
            LRESULT(0)
        }
        WM_COMMAND => {
            let id = wparam.0 as u16;
            if id == 2000 {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            delete_tray_icon(hwnd);
            if let Some(state) = APP_STATE.get() {
                let _ = DestroyIcon(state.icon_black);
                let _ = DestroyIcon(state.icon_white);
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let icon_black = unsafe { create_icon_from_png(ICON_BLACK_PNG)? };
    let icon_white = unsafe { create_icon_from_png(ICON_WHITE_PNG)? };
    let _ = APP_STATE.set(AppState {
        icon_black,
        icon_white,
    });

    unsafe {
        let class_name = encode_wide("DisplayctlWindowClass");
        let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)?;
        let hinstance = HINSTANCE(instance.0);

        let wnd_class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..WNDCLASSW::default()
        };

        RegisterClassW(&wnd_class);

        let hwnd = CreateWindowExW(
            Default::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(encode_wide("DisplayctlWindow").as_ptr()),
            Default::default(),
            0,
            0,
            0,
            0,
            HWND::default(),
            None,
            hinstance,
            None,
        )?;

        update_tray_icon(hwnd, true);
        monitor_theme_changes(hwnd);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    Ok(())
}
