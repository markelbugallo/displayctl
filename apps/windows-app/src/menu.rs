pub(crate) mod paint;
pub(crate) mod selector;

use crate::theme::is_light_theme;
use crate::utils::encode_wide;
use crate::monitor::{detect_ddc_monitors, set_monitor_brightness_value, DdcMonitor, get_refresh_rates};
use std::sync::Mutex;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM, RECT, BOOL, COLORREF};
use windows::Win32::Devices::Display::PHYSICAL_MONITOR;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, FillRect, CreateSolidBrush, DeleteObject,
    SelectObject, SetTextColor, SetBkMode, DrawTextW, CreateFontW,
    PAINTSTRUCT, InvalidateRect, RoundRect, CreatePen,
    DT_CENTER, DT_VCENTER, DT_SINGLELINE, DT_LEFT, TRANSPARENT,
    PS_NULL, FrameRect, CreateCompatibleDC, CreateCompatibleBitmap,
    BitBlt, DeleteDC, SRCCOPY,
};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWA_USE_IMMERSIVE_DARK_MODE,
    DWMWCP_ROUND,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetCursorPos,
    RegisterClassW, SetForegroundWindow, ShowWindow,
    WNDCLASSW, WM_ACTIVATE, WM_DESTROY, WM_LBUTTONUP, WM_LBUTTONDOWN,
    WM_MOUSEMOVE, WM_PAINT, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    SW_SHOW, HCURSOR, PostMessageW, WM_ERASEBKGND,
};

#[link(name = "user32")]
extern "system" {
    fn SetLayeredWindowAttributes(hwnd: HWND, crKey: u32, bAlpha: u8, dwFlags: u32) -> BOOL;
    fn SetWindowPos(
        hWnd: HWND,
        hWndInsertAfter: HWND,
        X: i32,
        Y: i32,
        cx: i32,
        cy: i32,
        uFlags: u32,
    ) -> BOOL;
    fn SetCapture(hWnd: HWND) -> HWND;
    fn ReleaseCapture() -> BOOL;
    fn GetDpiForWindow(hwnd: HWND) -> u32;
}

const WS_EX_LAYERED: u32 = 0x00080000;
const LWA_ALPHA: u32 = 0x00000002;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const WM_CLOSE: u32 = 0x0010;

pub(crate) struct MenuState {
    pub(crate) hwnd: HWND,
    pub(crate) monitors: Vec<DdcMonitor>,
    pub(crate) is_dragging_slider: bool,
    pub(crate) slider_value: u32,
    pub(crate) is_bottom_taskbar: bool,
    pub(crate) is_hiding: bool,
    pub(crate) refresh_rates: Vec<u32>,
    pub(crate) current_refresh_rate: u32,
    pub(crate) dropdown_hwnd: Option<HWND>,
    pub(crate) active_monitors: Vec<crate::monitor::ActiveMonitor>,
    pub(crate) scale: f32,
}

unsafe impl Send for MenuState {}
unsafe impl Sync for MenuState {}

pub(crate) static MENU_STATE: Mutex<Option<MenuState>> = Mutex::new(None);
pub(crate) static LAST_DESTROY_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);
pub(crate) static DROPDOWN_LAST_DESTROY_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);
pub(crate) static BRIGHTNESS_STATE: Mutex<Option<Vec<(isize, u32)>>> = Mutex::new(None);
pub(crate) static DROPDOWN_STATE: Mutex<Option<self::selector::SelectorState>> = Mutex::new(None);

unsafe extern "system" fn menu_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);

            let is_light = is_light_theme();
            let (monitor_name, has_monitor, slider_value, current_refresh_rate, active_monitors, scale) = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| {
                    (
                        s.monitors.first().map(|m| m.name.clone()),
                        !s.monitors.is_empty(),
                        s.slider_value,
                        s.current_refresh_rate,
                        s.active_monitors.clone(),
                        s.scale,
                    )
                }).unwrap_or((None, false, 50, 60, Vec::new(), 1.0))
            };

            let mut rect = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect);
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;

            let mem_hdc = CreateCompatibleDC(hdc);
            let mem_bitmap = CreateCompatibleBitmap(hdc, width, height);
            let old_bitmap = SelectObject(mem_hdc, mem_bitmap);

            let bg_color = if is_light { COLORREF(0x00F3F3F3) } else { COLORREF(0x002C2C2C) };
            let text_color = if is_light { COLORREF(0x00000000) } else { COLORREF(0x00D0D0D0) };
            let border_color = if is_light { COLORREF(0x00D0D0D0) } else { COLORREF(0x003B3B3B) };

            let bg_brush = CreateSolidBrush(bg_color);
            let _ = FillRect(mem_hdc, &rect, bg_brush);
            let _ = DeleteObject(bg_brush);

            let border_brush = CreateSolidBrush(border_color);
            let _ = FrameRect(mem_hdc, &rect, border_brush);
            let _ = DeleteObject(border_brush);

            let _ = SetBkMode(mem_hdc, TRANSPARENT);

            let font_sub = CreateFontW(
                -((11.0 * scale) as i32), 0, 0, 0, 600, 0, 0, 0,
                0, 0, 0, 6,
                0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
            );
            let old_font = SelectObject(mem_hdc, font_sub);

            if !has_monitor {
                let status_text_color = if is_light { COLORREF(0x008E8E8E) } else { COLORREF(0x008E8E8E) };
                let _ = SetTextColor(mem_hdc, status_text_color);
                let mut status_text = encode_wide("No se detectaron monitores externos");
                let mut sub_rect = RECT { 
                    left: (20.0 * scale) as i32, 
                    top: 0, 
                    right: width - (20.0 * scale) as i32, 
                    bottom: height 
                };
                let _ = DrawTextW(mem_hdc, &mut status_text, &mut sub_rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
            }
            let _ = SelectObject(mem_hdc, old_font);
            let _ = DeleteObject(font_sub);

            if has_monitor {
                // --- Monitor Principal Row ---
                let font_label = CreateFontW(
                    -((13.0 * scale) as i32), 0, 0, 0, 600, 0, 0, 0,
                    0, 0, 0, 6,
                    0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
                );
                let old_font_label = SelectObject(mem_hdc, font_label);
                let _ = SetTextColor(mem_hdc, text_color);

                let mut label_text = encode_wide("Monitor principal");
                let mut label_rect = RECT { 
                    left: (20.0 * scale) as i32, 
                    top: (12.0 * scale) as i32, 
                    right: width - (130.0 * scale) as i32, 
                    bottom: (44.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut label_text, &mut label_rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

                let _ = SelectObject(mem_hdc, old_font_label);
                let _ = DeleteObject(font_label);

                 let font_text = CreateFontW(
                    -((12.0 * scale) as i32), 0, 0, 0, 600, 0, 0, 0,
                    0, 0, 0, 6,
                    0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
                );
                let old_font_text = SelectObject(mem_hdc, font_text);

                let btn_bg_color = if is_light { COLORREF(0x00FFFFFF) } else { COLORREF(0x003D3D3D) };
                let btn_border_color = if is_light { COLORREF(0x00D0D0D0) } else { COLORREF(0x00454545) };
                
                // Primary monitor button rect
                let btn_rect1 = RECT { 
                    left: (220.0 * scale) as i32, 
                    top: (12.0 * scale) as i32, 
                    right: (320.0 * scale) as i32, 
                    bottom: (44.0 * scale) as i32 
                };
                let btn_brush1 = CreateSolidBrush(btn_bg_color);
                let old_brush = SelectObject(mem_hdc, btn_brush1);
                let btn_pen1 = CreatePen(windows::Win32::Graphics::Gdi::PS_SOLID, 1, btn_border_color);
                let old_pen = SelectObject(mem_hdc, btn_pen1);

                let _ = RoundRect(mem_hdc, btn_rect1.left, btn_rect1.top, btn_rect1.right, btn_rect1.bottom, 4, 4);

                let _ = SelectObject(mem_hdc, old_brush);
                let _ = DeleteObject(btn_brush1);
                let _ = SelectObject(mem_hdc, old_pen);
                let _ = DeleteObject(btn_pen1);

                let primary_monitor_name = active_monitors.iter()
                    .find(|m| m.is_primary)
                    .map(|m| m.friendly_name.clone())
                    .unwrap_or_else(|| "Principal".to_string());
                let display_primary_name = if primary_monitor_name.chars().count() > 10 {
                    primary_monitor_name.chars().take(8).collect::<String>() + "..."
                } else {
                    primary_monitor_name
                };

                let mut btn_text1 = encode_wide(&display_primary_name);
                let mut btn_text_rect1 = RECT { 
                    left: (228.0 * scale) as i32, 
                    top: (12.0 * scale) as i32, 
                    right: (302.0 * scale) as i32, 
                    bottom: (44.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut btn_text1, &mut btn_text_rect1, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

                 let font_icon_small = CreateFontW(
                    -((8.0 * scale) as i32), 0, 0, 0, 400, 0, 0, 0,
                    0, 0, 0, 6,
                    0, PCWSTR(encode_wide("Segoe MDL2 Assets").as_ptr()),
                );
                let old_font_icon = SelectObject(mem_hdc, font_icon_small);
                let mut arrow_text = encode_wide("\u{E70D}");
                let mut arrow_rect1 = RECT { 
                    left: (302.0 * scale) as i32, 
                    top: (12.0 * scale) as i32, 
                    right: (318.0 * scale) as i32, 
                    bottom: (44.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut arrow_text, &mut arrow_rect1, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                
                let _ = SelectObject(mem_hdc, old_font_icon);
                let _ = DeleteObject(font_icon_small);

                // --- Separator line (below primary monitor row) ---
                let sep_color = if is_light { COLORREF(0x00D0D0D0) } else { COLORREF(0x003B3B3B) };
                let sep_pen = CreatePen(windows::Win32::Graphics::Gdi::PS_SOLID, 1, sep_color);
                let old_sep_pen = SelectObject(mem_hdc, sep_pen);
                let _ = windows::Win32::Graphics::Gdi::MoveToEx(mem_hdc, (20.0 * scale) as i32, (54.0 * scale) as i32, None);
                let _ = windows::Win32::Graphics::Gdi::LineTo(mem_hdc, width - (20.0 * scale) as i32, (54.0 * scale) as i32);
                let _ = SelectObject(mem_hdc, old_sep_pen);
                let _ = DeleteObject(sep_pen);

                // --- Monitor label (below separator) ---
                let font_monitor_label = CreateFontW(
                    -((12.0 * scale) as i32), 0, 0, 0, 700, 0, 0, 0, 
                    0, 0, 0, 6,
                    0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
                );
                let old_font_monitor = SelectObject(mem_hdc, font_monitor_label);
                let monitor_label_color = if is_light { COLORREF(0x008E8E8E) } else { COLORREF(0x008E8E8E) };
                let _ = SetTextColor(mem_hdc, monitor_label_color);
                let monitor_label_str = monitor_name.unwrap_or_else(|| "Integrada".to_string());
                let monitor_label_display = if monitor_label_str.chars().count() > 20 {
                    "Integrada".to_string()
                } else {
                    monitor_label_str
                };
                let mut monitor_label_text = encode_wide(&monitor_label_display);
                let mut monitor_label_rect = RECT { 
                    left: (20.0 * scale) as i32, 
                    top: (58.0 * scale) as i32, 
                    right: width - (20.0 * scale) as i32, 
                    bottom: (74.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut monitor_label_text, &mut monitor_label_rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                let _ = SelectObject(mem_hdc, old_font_monitor);
                let _ = DeleteObject(font_monitor_label);

                // --- Refresh Rate Row ---
                let font_label = CreateFontW(
                    -((13.0 * scale) as i32), 0, 0, 0, 600, 0, 0, 0,
                    0, 0, 0, 6,
                    0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
                );
                let old_font_label = SelectObject(mem_hdc, font_label);
                let _ = SetTextColor(mem_hdc, text_color);

                let mut label_text = encode_wide("Tasa de refresco");
                let mut label_rect = RECT { 
                    left: (20.0 * scale) as i32, 
                    top: (80.0 * scale) as i32, 
                    right: width - (130.0 * scale) as i32, 
                    bottom: (112.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut label_text, &mut label_rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

                let _ = SelectObject(mem_hdc, old_font_label);
                let _ = DeleteObject(font_label);

                // Draw refresh rate button
                let btn_rect2 = RECT { 
                    left: (220.0 * scale) as i32, 
                    top: (80.0 * scale) as i32, 
                    right: (320.0 * scale) as i32, 
                    bottom: (112.0 * scale) as i32 
                };
                let btn_brush2 = CreateSolidBrush(btn_bg_color);
                let old_brush = SelectObject(mem_hdc, btn_brush2);
                let btn_pen2 = CreatePen(windows::Win32::Graphics::Gdi::PS_SOLID, 1, btn_border_color);
                let old_pen = SelectObject(mem_hdc, btn_pen2);

                let _ = RoundRect(mem_hdc, btn_rect2.left, btn_rect2.top, btn_rect2.right, btn_rect2.bottom, 4, 4);

                let _ = SelectObject(mem_hdc, old_brush);
                let _ = DeleteObject(btn_brush2);
                let _ = SelectObject(mem_hdc, old_pen);
                let _ = DeleteObject(btn_pen2);

                let _ = SelectObject(mem_hdc, font_text);
                let mut btn_text2 = encode_wide(&format!("{} Hz", current_refresh_rate));
                let mut btn_text_rect2 = RECT { 
                    left: (228.0 * scale) as i32, 
                    top: (80.0 * scale) as i32, 
                    right: (302.0 * scale) as i32, 
                    bottom: (112.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut btn_text2, &mut btn_text_rect2, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

                let font_icon_small = CreateFontW(
                    -((8.0 * scale) as i32), 0, 0, 0, 400, 0, 0, 0,
                    0, 0, 0, 6,
                    0, PCWSTR(encode_wide("Segoe MDL2 Assets").as_ptr()),
                );
                let old_font_icon = SelectObject(mem_hdc, font_icon_small);
                let mut arrow_text = encode_wide("\u{E70D}");
                let mut arrow_rect2 = RECT { 
                    left: (302.0 * scale) as i32, 
                    top: (80.0 * scale) as i32, 
                    right: (318.0 * scale) as i32, 
                    bottom: (112.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut arrow_text, &mut arrow_rect2, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                
                // Deselect and delete font_icon_small
                let _ = SelectObject(mem_hdc, old_font_icon);
                let _ = DeleteObject(font_icon_small);

                // Now restore old_font_text (the default font) and delete font_text
                let _ = SelectObject(mem_hdc, old_font_text);
                let _ = DeleteObject(font_text);

                // --- Brightness Slider ---
                let font_icon = CreateFontW(
                    -((12.0 * scale) as i32), 0, 0, 0, 400, 0, 0, 0,
                    0, 0, 0, 6,
                    0, PCWSTR(encode_wide("Segoe MDL2 Assets").as_ptr()),
                );
                let old_font_slider = SelectObject(mem_hdc, font_icon);
                let _ = SetTextColor(mem_hdc, text_color);
                let mut icon_text = encode_wide("\u{E706}");
                let mut icon_rect = RECT { 
                    left: (20.0 * scale) as i32, 
                    top: (122.0 * scale) as i32, 
                    right: (42.0 * scale) as i32, 
                    bottom: (146.0 * scale) as i32 
                };
                let _ = DrawTextW(mem_hdc, &mut icon_text, &mut icon_rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                let _ = SelectObject(mem_hdc, old_font_slider);
                let _ = DeleteObject(font_icon);

                let accent_color = if is_light { COLORREF(0x00C06700) } else { COLORREF(0x00FFCD60) };
                let track_bg = if is_light { COLORREF(0x00E5E5E5) } else { COLORREF(0x00454545) };

                let x_thumb = ((48.0 + (272.0 * slider_value as f32 / 100.0)) * scale) as i32;

                let null_pen = CreatePen(PS_NULL, 0, COLORREF(0));
                let old_pen = SelectObject(mem_hdc, null_pen);

                let inactive_brush = CreateSolidBrush(track_bg);
                let old_brush = SelectObject(mem_hdc, inactive_brush);
                let _ = RoundRect(mem_hdc, (48.0 * scale) as i32, (132.0 * scale) as i32, (320.0 * scale) as i32, (136.0 * scale) as i32, 4, 4);
                let _ = SelectObject(mem_hdc, old_brush);
                let _ = DeleteObject(inactive_brush);

                let active_brush = CreateSolidBrush(accent_color);
                let old_brush = SelectObject(mem_hdc, active_brush);
                let _ = RoundRect(mem_hdc, (48.0 * scale) as i32, (132.0 * scale) as i32, x_thumb, (136.0 * scale) as i32, 4, 4);
                let _ = SelectObject(mem_hdc, old_brush);
                let _ = DeleteObject(active_brush);

                let _ = SelectObject(mem_hdc, old_pen);
                let _ = DeleteObject(null_pen);

                self::paint::draw_antialiased_thumb(
                    mem_hdc,
                    x_thumb,
                    (134.0 * scale) as i32,
                    is_light,
                    accent_color,
                    (48.0 * scale) as i32,
                    (320.0 * scale) as i32,
                    scale,
                );
            }

            let _ = SelectObject(mem_hdc, old_font);
            let _ = BitBlt(hdc, 0, 0, width, height, mem_hdc, 0, 0, SRCCOPY);

            let _ = SelectObject(mem_hdc, old_bitmap);
            let _ = DeleteObject(mem_bitmap);
            let _ = DeleteDC(mem_hdc);

            let _ = EndPaint(hwnd, &mut ps);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;

            let (has_monitor, scale) = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| (!s.monitors.is_empty(), s.scale)).unwrap_or((false, 1.0))
            };

            // Hit detection for primary monitor dropdown button
            if has_monitor && x >= (220.0 * scale) as i32 && x <= (320.0 * scale) as i32 && y >= (12.0 * scale) as i32 && y <= (44.0 * scale) as i32 {
                let monitors = {
                    let state_opt = MENU_STATE.lock().unwrap();
                    state_opt.as_ref().map(|s| s.active_monitors.clone()).unwrap_or(Vec::new())
                };
                self::selector::show_selector_popup(hwnd, self::selector::SelectorType::PrimaryMonitor { monitors }, scale);
                return LRESULT(0);
            }

            // Hit detection for refresh rate dropdown button
            if has_monitor && x >= (220.0 * scale) as i32 && x <= (320.0 * scale) as i32 && y >= (80.0 * scale) as i32 && y <= (112.0 * scale) as i32 {
                let (rates, current_rate) = {
                    let state_opt = MENU_STATE.lock().unwrap();
                    state_opt.as_ref().map(|s| (s.refresh_rates.clone(), s.current_refresh_rate)).unwrap_or((Vec::new(), 60))
                };
                self::selector::show_selector_popup(hwnd, self::selector::SelectorType::RefreshRate { rates, current_rate }, scale);
                return LRESULT(0);
            }

            if has_monitor && y >= (120.0 * scale) as i32 && y <= (148.0 * scale) as i32 && x >= (36.0 * scale) as i32 && x <= (332.0 * scale) as i32 {
                let mut state_opt = MENU_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_mut() {
                    state.is_dragging_slider = true;
                    let val = (((x as f32 / scale) - 48.0) / 272.0 * 100.0) as i32;
                    let brightness = val.clamp(0, 100) as u32;
                    state.slider_value = brightness;

                    {
                        let mut target_opt = BRIGHTNESS_STATE.lock().unwrap();
                        *target_opt = Some(state.monitors.iter().map(|m| (m.monitor.hPhysicalMonitor.0 as isize, brightness)).collect());
                    }

                    unsafe {
                        let _ = SetCapture(hwnd);
                        let _ = InvalidateRect(hwnd, None, BOOL::from(false));
                    }
                }
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;

            let (is_dragging, scale) = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| (s.is_dragging_slider, s.scale)).unwrap_or((false, 1.0))
            };

            if is_dragging {
                let mut state_opt = MENU_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_mut() {
                    let val = (((x as f32 / scale) - 48.0) / 272.0 * 100.0) as i32;
                    let brightness = val.clamp(0, 100) as u32;
                    state.slider_value = brightness;

                    {
                        let mut target_opt = BRIGHTNESS_STATE.lock().unwrap();
                        *target_opt = Some(state.monitors.iter().map(|m| (m.monitor.hPhysicalMonitor.0 as isize, brightness)).collect());
                    }

                    unsafe {
                        let _ = InvalidateRect(hwnd, None, BOOL::from(false));
                    }
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let is_dragging = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| s.is_dragging_slider).unwrap_or(false)
            };

            if is_dragging {
                let mut state_opt = MENU_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_mut() {
                    state.is_dragging_slider = false;
                    unsafe {
                        let _ = ReleaseCapture();
                        let _ = InvalidateRect(hwnd, None, BOOL::from(false));
                    }
                }
            }
            LRESULT(0)
        }
        WM_ACTIVATE => {
            let active = (wparam.0 & 0xFFFF) as u32;
            if active == 0 {
                let activated_hwnd = HWND(lparam.0 as *mut _);
                let is_dragging = {
                    let state_opt = MENU_STATE.lock().unwrap();
                    state_opt.as_ref().map(|s| s.is_dragging_slider).unwrap_or(false)
                };
                let is_dropdown_activation = {
                    let state_opt = MENU_STATE.lock().unwrap();
                    state_opt.as_ref().map(|s| s.dropdown_hwnd == Some(activated_hwnd)).unwrap_or(false)
                };
                if !is_dragging && !is_dropdown_activation {
                    let should_hide = {
                        let mut state_opt = MENU_STATE.lock().unwrap();
                        if let Some(state) = state_opt.as_mut() {
                            if !state.is_hiding {
                                state.is_hiding = true;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };
                    if should_hide {
                        let is_bottom_taskbar = {
                            let state_opt = MENU_STATE.lock().unwrap();
                            state_opt.as_ref().map(|s| s.is_bottom_taskbar).unwrap_or(true)
                        };
                        animate_hide_and_destroy(hwnd, is_bottom_taskbar);
                    }
                }
            }
            LRESULT(0)
        }
        WM_ERASEBKGND => {
            LRESULT(1)
        }
        WM_DESTROY => {
            let mut state_opt = MENU_STATE.lock().unwrap();
            if let Some(state) = state_opt.as_mut() {
                let pms: Vec<PHYSICAL_MONITOR> = state.monitors.iter().map(|m| m.monitor).collect();
                if !pms.is_empty() {
                    unsafe {
                        let _ = windows::Win32::Devices::Display::DestroyPhysicalMonitors(&pms);
                    }
                }
            }
            *state_opt = None;
            let mut last_destroy = LAST_DESTROY_TIME.lock().unwrap();
            *last_destroy = Some(std::time::Instant::now());
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

pub(crate) fn animate_hide_and_destroy(hwnd: HWND, is_bottom_taskbar: bool) {
    let hwnd_raw = hwnd.0 as isize;
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut _);
        
        let mut rect = RECT::default();
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
        }
        let start_y = rect.top;
        let target_y = if is_bottom_taskbar {
            rect.top + 16
        } else {
            rect.top - 16
        };
        
        let steps = 12;
        let step_delay = std::time::Duration::from_millis(10);

        for i in 0..=steps {
            let progress = i as f32 / steps as f32;
            let opacity = ((1.0 - progress) * 255.0) as u8;
            let ease = progress * progress;
            let current_y = start_y + ((target_y - start_y) as f32 * ease) as i32;

            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    HWND::default(),
                    rect.left,
                    current_y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
                let _ = SetLayeredWindowAttributes(hwnd, 0, opacity, LWA_ALPHA);
            }
            
            std::thread::sleep(step_delay);
        }

        unsafe {
            let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    });
}

pub fn show_menu(_owner_hwnd: HWND) {
    let is_open = {
        let state = MENU_STATE.lock().unwrap();
        state.is_some()
    };
    if is_open {
        unsafe {
            let hwnd_to_destroy = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| s.hwnd)
            };
            if let Some(hwnd) = hwnd_to_destroy {
                let _ = DestroyWindow(hwnd);
            }
        }
        return;
    }

    let recently_closed = {
        let last_destroy = LAST_DESTROY_TIME.lock().unwrap();
        if let Some(instant) = *last_destroy {
            instant.elapsed() < std::time::Duration::from_millis(200)
        } else {
            false
        }
    };
    if recently_closed {
        let mut last_destroy = LAST_DESTROY_TIME.lock().unwrap();
        *last_destroy = None;
        return;
    }

    static REGISTER_ONCE: std::sync::Once = std::sync::Once::new();
    REGISTER_ONCE.call_once(|| {
        unsafe {
            let class_name = encode_wide("BrightnessMenuClass");
            let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap();
            let hinstance = windows::Win32::Foundation::HINSTANCE(instance.0);

            let wnd_class = WNDCLASSW {
                lpfnWndProc: Some(menu_wnd_proc),
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

    static WORKER_ONCE: std::sync::Once = std::sync::Once::new();
    WORKER_ONCE.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let updates = {
                    let mut state = BRIGHTNESS_STATE.lock().unwrap();
                    state.take()
                };
                if let Some(monitors_to_update) = updates {
                    for (h_physical_raw, val) in monitors_to_update {
                        let h_physical = windows::Win32::Foundation::HANDLE(h_physical_raw as *mut _);
                        let _ = set_monitor_brightness_value(h_physical, val);
                    }
                }
            }
        });
    });

    let monitors = detect_ddc_monitors();
    let has_monitor = !monitors.is_empty();

    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);

        let class_name = encode_wide("BrightnessMenuClass");
        let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap();
        let hinstance = windows::Win32::Foundation::HINSTANCE(instance.0);

        // Create window initially hidden and small at cursor position so Windows places it on the correct monitor
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(WS_EX_LAYERED),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(encode_wide("BrightnessMenu").as_ptr()),
            WS_POPUP,
            cursor.x,
            cursor.y,
            10,
            10,
            HWND::default(),
            None,
            hinstance,
            None,
        ).unwrap();

        let dpi = GetDpiForWindow(hwnd);
        let scale = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 } * 0.88;

        let scaled_width = (340.0 * scale) as i32;
        let scaled_height = if has_monitor { (156.0 * scale) as i32 } else { (56.0 * scale) as i32 };

        let hmonitor = windows::Win32::Graphics::Gdi::MonitorFromWindow(
            hwnd,
            windows::Win32::Graphics::Gdi::MONITOR_DEFAULTTONEAREST,
        );
        let mut monitor_info = windows::Win32::Graphics::Gdi::MONITORINFOEXW::default();
        monitor_info.monitorInfo.cbSize = std::mem::size_of::<windows::Win32::Graphics::Gdi::MONITORINFOEXW>() as u32;
        let _ = windows::Win32::Graphics::Gdi::GetMonitorInfoW(
            hmonitor,
            &mut monitor_info as *mut _ as *mut _,
        );
        let work_area = monitor_info.monitorInfo.rcWork;
        let monitor_rect = monitor_info.monitorInfo.rcMonitor;

        let mut x = cursor.x - scaled_width / 2;
        if x + scaled_width > work_area.right {
            x = work_area.right - scaled_width - 12;
        }
        if x < work_area.left + 12 {
            x = work_area.left + 12;
        }

        let is_bottom_taskbar = work_area.bottom < monitor_rect.bottom;

        let y = if is_bottom_taskbar {
            work_area.bottom - scaled_height - 12
        } else if work_area.top > monitor_rect.top {
            work_area.top + 12
        } else {
            let mut val = cursor.y - scaled_height / 2;
            if val + scaled_height > work_area.bottom {
                val = work_area.bottom - scaled_height - 12;
            }
            if val < work_area.top + 12 {
                val = work_area.top + 12;
            }
            val
        };

        let _ = SetWindowPos(
            hwnd,
            HWND::default(),
            x,
            y,
            scaled_width,
            scaled_height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );

        let slider_value = if has_monitor { monitors[0].current_brightness } else { 50 };

        let (mut refresh_rates, current_refresh_rate) = if has_monitor {
            get_refresh_rates(&monitors[0].gdi_device_name)
        } else {
            (Vec::new(), 60)
        };
        if refresh_rates.is_empty() {
            refresh_rates = vec![current_refresh_rate];
        }

        let active_monitors = crate::monitor::get_active_monitors();

        {
            let mut state = MENU_STATE.lock().unwrap();
            *state = Some(MenuState {
                hwnd,
                monitors,
                is_dragging_slider: false,
                slider_value,
                is_bottom_taskbar,
                is_hiding: false,
                refresh_rates,
                current_refresh_rate,
                dropdown_hwnd: None,
                active_monitors,
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

        let _ = SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);

        let start_y = if is_bottom_taskbar { y + 16 } else { y - 16 };
        let target_y = y;
        let final_x = x;
        let hwnd_raw = hwnd.0 as isize;

        std::thread::spawn(move || {
            let hwnd = HWND(hwnd_raw as *mut _);
            let steps = 15;
            let step_delay = std::time::Duration::from_millis(10);

            for i in 0..=steps {
                let progress = i as f32 / steps as f32;
                let opacity = (progress * 255.0) as u8;
                let ease = 1.0 - (1.0 - progress) * (1.0 - progress);
                let current_y = start_y - ((start_y - target_y) as f32 * ease) as i32;

                let _ = SetWindowPos(
                    hwnd,
                    HWND::default(),
                    final_x,
                    current_y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
                let _ = SetLayeredWindowAttributes(hwnd, 0, opacity, LWA_ALPHA);
                
                std::thread::sleep(step_delay);
            }

            let _ = SetWindowPos(
                hwnd,
                HWND::default(),
                final_x,
                target_y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            let _ = SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
        });
    }
}
