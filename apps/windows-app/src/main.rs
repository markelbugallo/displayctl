#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod theme;
mod tray;
mod monitor;
mod menu;
mod utils;

use std::sync::OnceLock;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, LRESULT, WPARAM, HINSTANCE};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, DestroyIcon, DispatchMessageW, GetMessageW,
    PostQuitMessage, RegisterClassW, TranslateMessage, CreateWindowExW, DefWindowProcW, HICON,
    ICONINFO, MSG, WNDCLASSW, WM_DESTROY, WM_LBUTTONUP, WM_RBUTTONUP,
};
use windows::Win32::System::Console::{
    SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT,
};
use utils::encode_wide;
use theme::{monitor_theme_changes, WM_THEME_CHANGED};
use tray::{update_tray_icon, delete_tray_icon, WM_TRAY_ICON_CALLBACK};
use menu::show_menu;

static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn console_ctrl_handler(ctrl_type: u32) -> BOOL {
    if ctrl_type == CTRL_C_EVENT || ctrl_type == CTRL_BREAK_EVENT || ctrl_type == CTRL_CLOSE_EVENT {
        let hwnd_val = MAIN_HWND.load(Ordering::SeqCst);
        if hwnd_val != 0 {
            let hwnd = HWND(hwnd_val as *mut _);
            let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::WM_DESTROY,
                WPARAM(0),
                LPARAM(0),
            );
            return BOOL::from(true);
        }
    }
    BOOL::from(false)
}

const ICON_BLACK_PNG: &[u8] = include_bytes!("../../../assets/displayctl_icon_black.png");
const ICON_WHITE_PNG: &[u8] = include_bytes!("../../../assets/displayctl_icon_white.png");

pub struct AppState {
    pub icon_black: HICON,
    pub icon_white: HICON,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

static APP_STATE: OnceLock<AppState> = OnceLock::new();

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
    );
    if hbm_mask.0.is_null() {
        return Err("CreateBitmap failed".into());
    }

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

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_THEME_CHANGED => {
            if let Some(state) = APP_STATE.get() {
                update_tray_icon(hwnd, false, state.icon_black, state.icon_white);
            }
            LRESULT(0)
        }
        WM_TRAY_ICON_CALLBACK => {
            let event = lparam.0 as u32;
            if event == WM_RBUTTONUP || event == WM_LBUTTONUP {
                show_menu(hwnd);
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
        let _ = SetConsoleCtrlHandler(Some(console_ctrl_handler), true);

        let class_name = encode_wide("BrightnessWindowClass");
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
            PCWSTR(encode_wide("BrightnessWindow").as_ptr()),
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

        MAIN_HWND.store(hwnd.0 as isize, Ordering::SeqCst);

        update_tray_icon(hwnd, true, icon_black, icon_white);
        monitor_theme_changes(hwnd);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    Ok(())
}
