use crate::theme::is_light_theme;
use crate::utils::encode_wide;
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

#[derive(Clone, Debug)]
pub(crate) enum SelectorType {
    RefreshRate { rates: Vec<u32>, current_rate: u32 },
    PrimaryMonitor { monitors: Vec<crate::monitor::ActiveMonitor> },
    Projection { current_topology: u32 },
}

pub(crate) struct SelectorState {
    pub(crate) hwnd: HWND,
    pub(crate) parent_hwnd: HWND,
    pub(crate) selector_type: SelectorType,
    pub(crate) hovered_index: Option<usize>,
    pub(crate) is_selecting: bool,
    pub(crate) scale: f32,
}

unsafe impl Send for SelectorState {}
unsafe impl Sync for SelectorState {}

pub(crate) fn show_selector_popup(parent_hwnd: HWND, selector_type: SelectorType, scale: f32) {
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

    let items_count = match &selector_type {
        SelectorType::RefreshRate { rates, .. } => rates.len(),
        SelectorType::PrimaryMonitor { monitors } => monitors.len(),
        SelectorType::Projection { .. } => 4,
    };
    if items_count == 0 {
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
        let is_hz = matches!(selector_type, SelectorType::RefreshRate { .. });
        let rect = match &selector_type {
            SelectorType::RefreshRate { .. } => RECT {
                left: (220.0 * scale) as i32,
                top: (116.0 * scale) as i32,
                right: (320.0 * scale) as i32,
                bottom: (148.0 * scale) as i32,
            },
            SelectorType::PrimaryMonitor { .. } => RECT {
                left: (220.0 * scale) as i32,
                top: (12.0 * scale) as i32,
                right: (320.0 * scale) as i32,
                bottom: (44.0 * scale) as i32,
            },
            SelectorType::Projection { .. } => RECT {
                left: (220.0 * scale) as i32,
                top: (48.0 * scale) as i32,
                right: (320.0 * scale) as i32,
                bottom: (80.0 * scale) as i32,
            },
        };
        let mut pt = POINT { x: rect.left, y: rect.top };
        let _ = ClientToScreen(parent_hwnd, &mut pt);

        let width = if is_hz { (100.0 * scale) as i32 } else { (200.0 * scale) as i32 };
        let height = (items_count as f32 * 32.0 * scale) as i32;
        let x_coord = if is_hz { pt.x } else { pt.x - (100.0 * scale) as i32 };
        let y_coord = pt.y - height - (4.0 * scale) as i32;

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
                selector_type,
                hovered_index: None,
                is_selecting: false,
                scale,
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
            let (selector_type, hovered_index, scale) = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| {
                    (s.selector_type.clone(), s.hovered_index, s.scale)
                }).unwrap_or((SelectorType::RefreshRate { rates: Vec::new(), current_rate: 60 }, None, 1.0))
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
                -((12.0 * scale) as i32), 0, 0, 0, 600, 0, 0, 0,
                0, 0, 0, 6, // CLEARTYPE_NATURAL_QUALITY
                0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
            );
            let old_font = SelectObject(mem_hdc, font);

            let items_count = match &selector_type {
                SelectorType::RefreshRate { rates, .. } => rates.len(),
                SelectorType::PrimaryMonitor { monitors } => monitors.len(),
                SelectorType::Projection { .. } => 4,
            };

            for i in 0..items_count {
                let item_height = (32.0 * scale) as i32;
                let item_rect = RECT {
                    left: 1,
                    top: (i as i32 * item_height) + 1,
                    right: width - 1,
                    bottom: ((i as i32 + 1) * item_height) - 1,
                };

                // Draw hover background if needed
                if hovered_index == Some(i) {
                    let hover_brush = CreateSolidBrush(hover_bg);
                    let _ = FillRect(mem_hdc, &item_rect, hover_brush);
                    let _ = DeleteObject(hover_brush);
                }

                // Determine text and selection indicator
                let (text_str, is_selected) = match &selector_type {
                    SelectorType::RefreshRate { rates, current_rate } => {
                        (format!("{} Hz", rates[i]), rates[i] == *current_rate)
                    }
                    SelectorType::PrimaryMonitor { monitors } => {
                        (monitors[i].friendly_name.clone(), monitors[i].is_primary)
                    }
                    SelectorType::Projection { current_topology } => {
                        let text = match i {
                            0 => "Extender",
                            1 => "Duplicar",
                            2 => "Solo integrada",
                            3 => "Solo externa",
                            _ => "",
                        };
                        let target_val = match i {
                            0 => 4, // Extend
                            1 => 2, // Clone
                            2 => 1, // Internal
                            3 => 8, // External
                            _ => 0,
                        };
                        (text.to_string(), *current_topology == target_val)
                    }
                };

                // Draw selection indicator
                if is_selected {
                    let dot_brush = CreateSolidBrush(COLORREF(0x00FFFFFF));
                    let dot_pen = CreatePen(
                        windows::Win32::Graphics::Gdi::PS_SOLID,
                        1,
                        if is_light { COLORREF(0x00808080) } else { COLORREF(0x00FFFFFF) },
                    );
                    let old_brush = SelectObject(mem_hdc, dot_brush);
                    let old_pen = SelectObject(mem_hdc, dot_pen);

                    let cy = (i as i32 * item_height) + item_height / 2;
                    let cx = width - (16.0 * scale) as i32;
                    let r = (3.5 * scale) as i32;
                    let _ = Ellipse(mem_hdc, cx - r, cy - r, cx + r + 1, cy + r + 1);

                    let _ = SelectObject(mem_hdc, old_brush);
                    let _ = DeleteObject(dot_brush);
                    let _ = SelectObject(mem_hdc, old_pen);
                    let _ = DeleteObject(dot_pen);
                }

                let mut text = encode_wide(&text_str);
                let mut text_rect = RECT {
                    left: (12.0 * scale) as i32,
                    top: i as i32 * item_height,
                    right: width - (24.0 * scale) as i32,
                    bottom: (i as i32 + 1) * item_height,
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
            let scale = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| s.scale).unwrap_or(1.0)
            };
            let item_height = (32.0 * scale) as i32;
            let idx = if item_height > 0 { (y / item_height) as usize } else { 0 };
            let len = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| {
                    match &s.selector_type {
                        SelectorType::RefreshRate { rates, .. } => rates.len(),
                        SelectorType::PrimaryMonitor { monitors } => monitors.len(),
                        SelectorType::Projection { .. } => 4,
                    }
                }).unwrap_or(0)
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
            let scale = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| s.scale).unwrap_or(1.0)
            };
            let item_height = (32.0 * scale) as i32;
            let idx = if item_height > 0 { (y / item_height) as usize } else { 0 };
            
            let (selector_type, parent_hwnd) = {
                let state_opt = super::DROPDOWN_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_ref() {
                    (Some(state.selector_type.clone()), Some(state.parent_hwnd))
                } else {
                    (None, None)
                }
            };

            if let (Some(sel_type), Some(parent)) = (selector_type, parent_hwnd) {
                let should_hide_menu = matches!(sel_type, SelectorType::PrimaryMonitor { .. }) || matches!(sel_type, SelectorType::Projection { .. });
                if !should_hide_menu {
                    let mut state_opt = super::DROPDOWN_STATE.lock().unwrap();
                    if let Some(state) = state_opt.as_mut() {
                        state.is_selecting = true;
                    }
                }

                match sel_type {
                    SelectorType::RefreshRate { rates, .. } => {
                        if idx < rates.len() {
                            let rate = rates[idx];
                            let gdi_device = {
                                let state_opt = super::MENU_STATE.lock().unwrap();
                                state_opt.as_ref().and_then(|s| s.monitors.first().map(|m| m.gdi_device_name.clone()))
                            };
                            if let Some(gdi_device) = gdi_device {
                                crate::monitor::set_refresh_rate(&gdi_device, rate);
                                let mut menu_state = super::MENU_STATE.lock().unwrap();
                                if let Some(ms) = menu_state.as_mut() {
                                    ms.current_refresh_rate = rate;
                                }
                            }
                        }
                        unsafe {
                            let _ = InvalidateRect(parent, None, BOOL::from(false));
                        }
                    }
                    SelectorType::PrimaryMonitor { monitors } => {
                        if idx < monitors.len() {
                            let target_gdi = monitors[idx].gdi_device_name.clone();
                            std::thread::spawn(move || {
                                crate::monitor::set_primary_monitor(&target_gdi);
                            });

                            let mut menu_state = super::MENU_STATE.lock().unwrap();
                            if let Some(ms) = menu_state.as_mut() {
                                if !ms.is_hiding {
                                    ms.is_hiding = true;
                                    let is_bottom_taskbar = ms.is_bottom_taskbar;
                                    super::animate_hide_and_destroy(parent, is_bottom_taskbar);
                                }
                            }
                        }
                    }
                    SelectorType::Projection { .. } => {
                        if idx < 4 {
                            let target_topology = match idx {
                                0 => 4, // Extend
                                1 => 2, // Clone
                                2 => 1, // Internal
                                3 => 8, // External
                                _ => 4,
                            };
                            std::thread::spawn(move || {
                                crate::monitor::set_display_topology(target_topology);
                            });

                            let mut menu_state = super::MENU_STATE.lock().unwrap();
                            if let Some(ms) = menu_state.as_mut() {
                                if !ms.is_hiding {
                                    ms.is_hiding = true;
                                    let is_bottom_taskbar = ms.is_bottom_taskbar;
                                    super::animate_hide_and_destroy(parent, is_bottom_taskbar);
                                }
                            }
                        }
                    }
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
                    if !ms.is_hiding && (is_selecting || in_parent) {
                        let _ = SetForegroundWindow(parent_hwnd);
                    } else if !ms.is_hiding {
                        ms.is_hiding = true;
                        let is_bottom_taskbar = ms.is_bottom_taskbar;
                        super::animate_hide_and_destroy(parent_hwnd, is_bottom_taskbar);
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
