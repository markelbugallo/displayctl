use crate::theme::is_light_theme;
use crate::utils::encode_wide;
use crate::monitor::set_refresh_rate;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM, RECT, BOOL, COLORREF};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, FillRect, CreateSolidBrush, DeleteObject,
    SelectObject, SetTextColor, SetBkMode, DrawTextW, CreateFontW,
    PAINTSTRUCT, InvalidateRect, CreatePen, Ellipse, CreateCompatibleDC,
    CreateCompatibleBitmap, BitBlt, DeleteDC, SRCCOPY, ClientToScreen,
    TRANSPARENT, DT_LEFT, DT_SINGLELINE, DT_VCENTER, FrameRect,
};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWA_USE_IMMERSIVE_DARK_MODE,
    DWMWCP_ROUND,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetCursorPos, RegisterClassW, SetForegroundWindow,
    ShowWindow, WNDCLASSW, WM_ACTIVATE, WM_DESTROY, WM_LBUTTONUP, WM_MOUSEMOVE,
    WM_PAINT, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, SW_SHOW, HCURSOR,
    PostMessageW, WM_CLOSE, DefWindowProcW,
};

pub(crate) struct SelectorState {
    pub(crate) hwnd: HWND,
    pub(crate) parent_hwnd: HWND,
    pub(crate) rates: Vec<u32>,
    pub(crate) current_rate: u32,
    pub(crate) hovered_index: Option<usize>,
    pub(crate) is_selecting: bool,
}

unsafe impl Send for SelectorState {}
unsafe impl Sync for SelectorState {}

pub(crate) fn show_selector_popup(parent_hwnd: HWND) {
    // Check if dropdown was recently closed to prevent reopen toggle issues
    let recently_closed = {
        let last_destroy = super::DROPDOWN_LAST_DESTROY_TIME.lock().unwrap();
        if let Some(instant) = *last_destroy {
            instant.elapsed() < std::time::Duration::from_millis(200)
        } else {
            false
        }
    };
    if recently_closed {
        let mut last_destroy = super::DROPDOWN_LAST_DESTROY_TIME.lock().unwrap();
        *last_destroy = None;
        return;
    }

    let hwnd_to_destroy = {
        let state_opt = super::DROPDOWN_STATE.lock().unwrap();
        state_opt.as_ref().map(|s| s.hwnd)
    };
    if let Some(hwnd) = hwnd_to_destroy {
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        return;
    }

    let (rates, current_rate) = {
        let state_opt = super::MENU_STATE.lock().unwrap();
        if let Some(s) = state_opt.as_ref() {
            (s.refresh_rates.clone(), s.current_refresh_rate)
        } else {
            (Vec::new(), 60)
        }
    };
    if rates.is_empty() {
        return;
    }

    static SELECTOR_REGISTER_ONCE: std::sync::Once = std::sync::Once::new();
    SELECTOR_REGISTER_ONCE.call_once(|| {
        unsafe {
            let class_name = encode_wide("SelectorWindowClass");
            let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap();
            let hinstance = windows::Win32::Foundation::HINSTANCE(instance.0);

            let wnd_class = WNDCLASSW {
                lpfnWndProc: Some(selector_wnd_proc),
                hInstance: hinstance,
                lpszClassName: PCWSTR(class_name.as_ptr()),
                hCursor: windows::Win32::UI::WindowsAndMessaging::LoadCursorW(
                    None,
                    windows::Win32::UI::WindowsAndMessaging::IDC_ARROW,
                ).unwrap_or(HCURSOR::default()),
                ..WNDCLASSW::default()
            };
            RegisterClassW(&wnd_class);
        }
    });

    unsafe {
        // The dropdown button is from X=204 to 304, Y=44 to 74 relative to parent client area.
        let rect = RECT { left: 204, top: 44, right: 304, bottom: 74 };
        let mut pt = POINT { x: rect.left, y: rect.top };
        let _ = ClientToScreen(parent_hwnd, &mut pt);

        let width = 100;
        let height = (rates.len() * 28) as i32;
        let x_coord = pt.x;
        let y_coord = pt.y - height - 4;

        let class_name = encode_wide("SelectorWindowClass");
        let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap();
        let hinstance = windows::Win32::Foundation::HINSTANCE(instance.0);

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(WS_EX_LAYERED),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(encode_wide("SelectorWindow").as_ptr()),
            WS_POPUP,
            x_coord,
            y_coord,
            width,
            height,
            parent_hwnd,
            None,
            hinstance,
            None,
        ).unwrap();

        {
            let mut menu_state = super::MENU_STATE.lock().unwrap();
            if let Some(ms) = menu_state.as_mut() {
                ms.dropdown_hwnd = Some(hwnd);
            }
        }

        {
            let mut state = super::DROPDOWN_STATE.lock().unwrap();
            *state = Some(SelectorState {
                hwnd,
                parent_hwnd,
                rates,
                current_rate,
                hovered_index: None,
                is_selecting: false,
            });
        }

        let is_light = is_light_theme();
        let corner_preference = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner_preference as *const _ as *const _,
            std::mem::size_of::<u32>() as u32,
        );

        let dark_mode: BOOL = BOOL::from(!is_light);
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark_mode as *const _ as *const _,
            std::mem::size_of::<BOOL>() as u32,
        );

        let _ = SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
    }
}

unsafe extern "system" fn selector_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);

            let is_light = is_light_theme();
            let (rates, current_rate, hovered_index) = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| {
                    (s.rates.clone(), s.current_rate, s.hovered_index)
                }).unwrap_or((Vec::new(), 60, None))
            };

            let mut rect = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect);
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;

            let mem_hdc = CreateCompatibleDC(hdc);
            let mem_bitmap = CreateCompatibleBitmap(hdc, width, height);
            let old_bitmap = SelectObject(mem_hdc, mem_bitmap);

            let bg_color = if is_light { COLORREF(0x00FFFFFF) } else { COLORREF(0x002C2C2C) };
            let text_color = if is_light { COLORREF(0x00000000) } else { COLORREF(0x00D0D0D0) };
            let border_color = if is_light { COLORREF(0x00D0D0D0) } else { COLORREF(0x003B3B3B) };
            let hover_bg = if is_light { COLORREF(0x00F0F0F0) } else { COLORREF(0x003D3D3D) };

            let bg_brush = CreateSolidBrush(bg_color);
            let _ = FillRect(mem_hdc, &rect, bg_brush);
            let _ = DeleteObject(bg_brush);

            let border_brush = CreateSolidBrush(border_color);
            let _ = FrameRect(mem_hdc, &rect, border_brush);
            let _ = DeleteObject(border_brush);

            let _ = SetBkMode(mem_hdc, TRANSPARENT);
            let font = CreateFontW(
                16, 0, 0, 0, 400, 0, 0, 0,
                0, 0, 0, 4,
                0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
            );
            let old_font = SelectObject(mem_hdc, font);

            for (i, rate) in rates.iter().enumerate() {
                let item_rect = RECT {
                    left: 1,
                    top: (i as i32 * 28) + 1,
                    right: width - 1,
                    bottom: ((i as i32 + 1) * 28) - 1,
                };

                // Draw hover background if needed
                if hovered_index == Some(i) {
                    let hover_brush = CreateSolidBrush(hover_bg);
                    let _ = FillRect(mem_hdc, &item_rect, hover_brush);
                    let _ = DeleteObject(hover_brush);
                }

                // Draw selection indicator
                if *rate == current_rate {
                    let dot_brush = CreateSolidBrush(COLORREF(0x00FFFFFF));
                    let dot_pen = CreatePen(
                        windows::Win32::Graphics::Gdi::PS_SOLID,
                        1,
                        if is_light { COLORREF(0x00808080) } else { COLORREF(0x00FFFFFF) },
                    );
                    let old_brush = SelectObject(mem_hdc, dot_brush);
                    let old_pen = SelectObject(mem_hdc, dot_pen);

                    let cy = (i as i32 * 28) + 14;
                    let cx = width - 18;
                    let r = 3;
                    let _ = Ellipse(mem_hdc, cx - r, cy - r, cx + r + 1, cy + r + 1);

                    let _ = SelectObject(mem_hdc, old_brush);
                    let _ = DeleteObject(dot_brush);
                    let _ = SelectObject(mem_hdc, old_pen);
                    let _ = DeleteObject(dot_pen);
                }

                let mut text = encode_wide(&format!("{} Hz", rate));
                let mut text_rect = RECT {
                    left: 16,
                    top: i as i32 * 28,
                    right: width - 28,
                    bottom: (i as i32 + 1) * 28,
                };
                let _ = SetTextColor(mem_hdc, text_color);
                let _ = DrawTextW(mem_hdc, &mut text, &mut text_rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
            }

            let _ = SelectObject(mem_hdc, old_font);
            let _ = DeleteObject(font);

            let _ = BitBlt(hdc, 0, 0, width, height, mem_hdc, 0, 0, SRCCOPY);

            let _ = SelectObject(mem_hdc, old_bitmap);
            let _ = DeleteObject(mem_bitmap);
            let _ = DeleteDC(mem_hdc);

            let _ = EndPaint(hwnd, &mut ps);
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            let idx = (y / 28) as usize;
            let len = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| s.rates.len()).unwrap_or(0)
            };
            if idx < len {
                let mut state_opt = super::DROPDOWN_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_mut() {
                    if state.hovered_index != Some(idx) {
                        state.hovered_index = Some(idx);
                        unsafe {
                            let _ = InvalidateRect(hwnd, None, BOOL::from(false));
                        }
                    }
                }
            } else {
                let mut state_opt = super::DROPDOWN_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_mut() {
                    if state.hovered_index.is_some() {
                        state.hovered_index = None;
                        unsafe {
                            let _ = InvalidateRect(hwnd, None, BOOL::from(false));
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            let idx = (y / 28) as usize;
            let (selected_rate, parent_hwnd) = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_ref() {
                    if idx < state.rates.len() {
                        (Some(state.rates[idx]), Some(state.parent_hwnd))
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                }
            };
            if let (Some(rate), Some(parent)) = (selected_rate, parent_hwnd) {
                {
                    let mut state_opt = super::DROPDOWN_STATE.lock().unwrap();
                    if let Some(state) = state_opt.as_mut() {
                        state.is_selecting = true;
                    }
                }
                let gdi_device = {
                    let state_opt = super::MENU_STATE.lock().unwrap();
                    state_opt.as_ref().and_then(|s| s.monitors.first().map(|m| m.gdi_device_name.clone()))
                };
                if let Some(gdi_device) = gdi_device {
                    set_refresh_rate(&gdi_device, rate);
                    let mut menu_state = super::MENU_STATE.lock().unwrap();
                    if let Some(ms) = menu_state.as_mut() {
                        ms.current_refresh_rate = rate;
                    }
                }
                unsafe {
                    let _ = InvalidateRect(parent, None, BOOL::from(false));
                }
            }
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_ACTIVATE => {
            let active = (wparam.0 & 0xFFFF) as u32;
            if active == 0 {
                unsafe {
                    let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            {
                let mut last_destroy = super::DROPDOWN_LAST_DESTROY_TIME.lock().unwrap();
                *last_destroy = Some(std::time::Instant::now());
            }
            let (is_selecting, parent_hwnd) = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| (s.is_selecting, s.parent_hwnd)).unwrap_or((false, HWND::default()))
            };
            
            let mut state_opt = super::DROPDOWN_STATE.lock().unwrap();
            *state_opt = None;
            
            let mut menu_state = super::MENU_STATE.lock().unwrap();
            if let Some(ms) = menu_state.as_mut() {
                ms.dropdown_hwnd = None;
                
                unsafe {
                    let mut cursor = POINT::default();
                    let _ = GetCursorPos(&mut cursor);
                    
                    let mut parent_rect = RECT::default();
                    let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(parent_hwnd, &mut parent_rect);
                    
                    let in_parent = windows::Win32::Graphics::Gdi::PtInRect(&parent_rect, cursor).as_bool();
                    if is_selecting || in_parent {
                        let _ = SetForegroundWindow(parent_hwnd);
                    } else {
                        if !ms.is_hiding {
                            ms.is_hiding = true;
                            let is_bottom_taskbar = ms.is_bottom_taskbar;
                            super::animate_hide_and_destroy(parent_hwnd, is_bottom_taskbar);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[link(name = "user32")]
extern "system" {
    fn SetLayeredWindowAttributes(hwnd: HWND, crKey: u32, bAlpha: u8, dwFlags: u32) -> BOOL;
}

const WS_EX_LAYERED: u32 = 0x00080000;
const LWA_ALPHA: u32 = 0x00000002;
