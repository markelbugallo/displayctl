use crate::theme::is_light_theme;
use crate::utils::encode_wide;
use crate::monitor::{detect_ddc_monitors, set_monitor_brightness_value, DdcMonitor};
use std::sync::Mutex;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM, RECT, BOOL, COLORREF};
use windows::Win32::Devices::Display::PHYSICAL_MONITOR;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, FillRect, CreateSolidBrush, DeleteObject,
    SelectObject, SetTextColor, SetBkMode, DrawTextW, CreateFontW,
    PAINTSTRUCT, InvalidateRect, RoundRect, CreatePen,
    DT_CENTER, DT_VCENTER, DT_SINGLELINE, DT_LEFT, TRANSPARENT,
    PS_NULL, FrameRect, SetPixelV, CreateCompatibleDC, CreateCompatibleBitmap,
    BitBlt, DeleteDC, SRCCOPY,
};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWA_USE_IMMERSIVE_DARK_MODE,
    DWMWCP_ROUND,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetCursorPos,
    GetSystemMetrics, RegisterClassW, SetForegroundWindow, ShowWindow,
    WNDCLASSW, WM_ACTIVATE, WM_DESTROY, WM_LBUTTONUP, WM_LBUTTONDOWN,
    WM_MOUSEMOVE, WM_PAINT, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    SW_SHOW, SM_CYSCREEN, HCURSOR, PostMessageW,
    SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    WM_ERASEBKGND,
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
}

const WS_EX_LAYERED: u32 = 0x00080000;
const LWA_ALPHA: u32 = 0x00000002;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const WM_CLOSE: u32 = 0x0010;

struct MenuState {
    hwnd: HWND,
    monitors: Vec<DdcMonitor>,
    is_dragging_slider: bool,
    slider_value: u32,
    is_bottom_taskbar: bool,
    is_hiding: bool,
}

unsafe impl Send for MenuState {}
unsafe impl Sync for MenuState {}

static MENU_STATE: Mutex<Option<MenuState>> = Mutex::new(None);
static LAST_DESTROY_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static BRIGHTNESS_STATE: Mutex<Option<Vec<(isize, u32)>>> = Mutex::new(None);

fn blend_colors(fg: COLORREF, bg: COLORREF, alpha: f32) -> COLORREF {
    let fg_r = (fg.0 & 0xFF) as f32;
    let fg_g = ((fg.0 >> 8) & 0xFF) as f32;
    let fg_b = ((fg.0 >> 16) & 0xFF) as f32;

    let bg_r = (bg.0 & 0xFF) as f32;
    let bg_g = ((bg.0 >> 8) & 0xFF) as f32;
    let bg_b = ((bg.0 >> 16) & 0xFF) as f32;

    let r = (fg_r * alpha + bg_r * (1.0 - alpha)) as u32;
    let g = (fg_g * alpha + bg_g * (1.0 - alpha)) as u32;
    let b = (fg_b * alpha + bg_b * (1.0 - alpha)) as u32;

    COLORREF(r | (g << 8) | (b << 16))
}

unsafe fn draw_antialiased_thumb(hdc: windows::Win32::Graphics::Gdi::HDC, cx: i32, cy: i32, is_light: bool, accent_color: COLORREF) {
    let bg_color = if is_light { COLORREF(0x00F3F3F3) } else { COLORREF(0x002C2C2C) };
    let track_bg = if is_light { COLORREF(0x00E5E5E5) } else { COLORREF(0x00454545) };
    let outer_thumb_bg = if is_light { COLORREF(0x00D8D8D8) } else { COLORREF(0x00555555) };
    
    for dy in -11..=11 {
        for dx in -11..=11 {
            let px = cx + dx;
            let py = cy + dy;
            let dist = ((dx * dx + dy * dy) as f32).sqrt();
            
            if dist <= 11.0 {
                // Determine the background color mathematically instead of reading with GetPixel
                let bg_pixel_color = if py >= cy - 2 && py <= cy + 1 {
                    if px >= 42 && px < cx {
                        accent_color
                    } else if px >= cx && px <= 284 {
                        track_bg
                    } else {
                        bg_color
                    }
                } else {
                    bg_color
                };
                
                let (target_color, alpha) = if dist <= 4.5 {
                    (accent_color, 1.0)
                } else if dist <= 5.5 {
                    let t = 5.5 - dist;
                    let c = blend_colors(accent_color, outer_thumb_bg, t);
                    (c, 1.0)
                } else if dist <= 9.5 {
                    (outer_thumb_bg, 1.0)
                } else if dist <= 10.5 {
                    let t = 10.5 - dist;
                    (outer_thumb_bg, t)
                } else {
                    continue;
                };
                
                let final_color = blend_colors(target_color, bg_pixel_color, alpha);
                let _ = SetPixelV(hdc, px, py, final_color);
            }
        }
    }
}

unsafe extern "system" fn menu_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);

            let is_light = is_light_theme();
            let (monitor_name, has_monitor, slider_value) = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| {
                    (
                        s.monitors.first().map(|m| m.name.clone()),
                        !s.monitors.is_empty(),
                        s.slider_value,
                    )
                }).unwrap_or((None, false, 50))
            };

            // Get window client dimensions
            let mut rect = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect);
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;

            // Create memory DC and compatible bitmap for double buffering
            let mem_hdc = CreateCompatibleDC(hdc);
            let mem_bitmap = CreateCompatibleBitmap(hdc, width, height);
            let old_bitmap = SelectObject(mem_hdc, mem_bitmap);

            // Colors (Windows 11 palette)
            let bg_color = if is_light { COLORREF(0x00F3F3F3) } else { COLORREF(0x002C2C2C) };
            let text_color = if is_light { COLORREF(0x00000000) } else { COLORREF(0x00D0D0D0) };
            let border_color = if is_light { COLORREF(0x00D0D0D0) } else { COLORREF(0x003B3B3B) };

            // 1. Draw background to memory DC
            let bg_brush = CreateSolidBrush(bg_color);
            let _ = FillRect(mem_hdc, &rect, bg_brush);
            let _ = DeleteObject(bg_brush);

            // 2. Draw border to memory DC
            let border_brush = CreateSolidBrush(border_color);
            let _ = FrameRect(mem_hdc, &rect, border_brush);
            let _ = DeleteObject(border_brush);

            // Setup memory GDI drawing configuration
            let _ = SetBkMode(mem_hdc, TRANSPARENT);

            // 3. Draw Subtitle / Status as the main Header
            let font_sub = CreateFontW(
                14, 0, 0, 0, 600, 0, 0, 0, // Semi-bold 600
                0, 0, 0, 4,
                0, PCWSTR(encode_wide("Segoe UI Variable Text").as_ptr()),
            );
            let old_font = SelectObject(mem_hdc, font_sub);
            let _ = SetTextColor(mem_hdc, text_color);

            let status_text_str = if has_monitor {
                monitor_name.unwrap_or_else(|| "Monitor externo".to_string())
            } else {
                "No se detectaron monitores externos".to_string()
            };
            let mut status_text = encode_wide(&status_text_str);
            let mut sub_rect = RECT { left: 16, top: 16, right: 284, bottom: 32 };
            let _ = DrawTextW(mem_hdc, &mut status_text, &mut sub_rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
            let _ = DeleteObject(font_sub);

            // 4. Draw Brightness Slider (if monitor is present, Y=44 to Y=60)
            if has_monitor {
                // Sun Icon (Segoe MDL2 Assets brightness outline)
                let font_icon = CreateFontW(
                    14, 0, 0, 0, 400, 0, 0, 0,
                    0, 0, 0, 4,
                    0, PCWSTR(encode_wide("Segoe MDL2 Assets").as_ptr()),
                );
                let _ = SelectObject(mem_hdc, font_icon);
                let _ = SetTextColor(mem_hdc, text_color);
                let mut icon_text = encode_wide("\u{E706}");
                let mut icon_rect = RECT { left: 16, top: 44, right: 34, bottom: 60 };
                let _ = DrawTextW(mem_hdc, &mut icon_text, &mut icon_rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                let _ = DeleteObject(font_icon);

                // Slider Track
                let accent_color = if is_light { COLORREF(0x00C06700) } else { COLORREF(0x00FFCD60) };
                let track_bg = if is_light { COLORREF(0x00E5E5E5) } else { COLORREF(0x00454545) };

                // Thumb ranges from X=48 to X=278 (width 230) inside track bounds X=42 to X=284
                let x_thumb = 48 + (230 * slider_value / 100) as i32;

                // Create a null pen so RoundRect/Ellipse don't draw a black border
                let null_pen = CreatePen(PS_NULL, 0, COLORREF(0));
                let old_pen = SelectObject(mem_hdc, null_pen);

                // Draw full Inactive track (track background pill, Y=50 to Y=54, height 4px)
                let inactive_brush = CreateSolidBrush(track_bg);
                let old_brush = SelectObject(mem_hdc, inactive_brush);
                let _ = RoundRect(mem_hdc, 42, 50, 284, 54, 4, 4);
                let _ = SelectObject(mem_hdc, old_brush);
                let _ = DeleteObject(inactive_brush);

                // Draw Active track (accent color pill, Y=50 to Y=54, height 4px)
                let active_brush = CreateSolidBrush(accent_color);
                let old_brush = SelectObject(mem_hdc, active_brush);
                let _ = RoundRect(mem_hdc, 42, 50, x_thumb, 54, 4, 4);
                let _ = SelectObject(mem_hdc, old_brush);
                let _ = DeleteObject(active_brush);

                // Restore pen and delete null pen before drawing the custom thumb
                let _ = SelectObject(mem_hdc, old_pen);
                let _ = DeleteObject(null_pen);

                // Draw mathematically antialiased thumb concentric circles (centered at Y=52)
                draw_antialiased_thumb(mem_hdc, x_thumb, 52, is_light, accent_color);
            }

            // Restore original memory GDI objects
            let _ = SelectObject(mem_hdc, old_font);

            // Copy offscreen memory bitmap to screen HDC in one go
            let _ = BitBlt(hdc, 0, 0, width, height, mem_hdc, 0, 0, SRCCOPY);

            // Clean up offscreen resources
            let _ = SelectObject(mem_hdc, old_bitmap);
            let _ = DeleteObject(mem_bitmap);
            let _ = DeleteDC(mem_hdc);

            let _ = EndPaint(hwnd, &mut ps);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;

            let has_monitor = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| !s.monitors.is_empty()).unwrap_or(false)
            };

            // Hit detection ranges Y=36 to Y=68 for the slider (centered at Y=52)
            if has_monitor && y >= 36 && y <= 68 && x >= 30 && x <= 290 {
                let mut state_opt = MENU_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_mut() {
                    state.is_dragging_slider = true;
                    let val = ((x - 48) as f32 / 230.0 * 100.0) as i32;
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

            let is_dragging = {
                let state_opt = MENU_STATE.lock().unwrap();
                state_opt.as_ref().map(|s| s.is_dragging_slider).unwrap_or(false)
            };

            if is_dragging {
                let mut state_opt = MENU_STATE.lock().unwrap();
                if let Some(state) = state_opt.as_mut() {
                    let val = ((x - 48) as f32 / 230.0 * 100.0) as i32;
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
                // Focus lost, check if dragging. If not dragging, animate hide and destroy
                let is_dragging = {
                    let state_opt = MENU_STATE.lock().unwrap();
                    state_opt.as_ref().map(|s| s.is_dragging_slider).unwrap_or(false)
                };
                if !is_dragging {
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
                // Clean up physical monitor handles to prevent leaks
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

fn animate_hide_and_destroy(hwnd: HWND, is_bottom_taskbar: bool) {
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
        let step_delay = std::time::Duration::from_millis(10); // 120ms total

        for i in 0..=steps {
            let progress = i as f32 / steps as f32;
            
            // Opacity: 255 -> 0
            let opacity = ((1.0 - progress) * 255.0) as u8;
            
            // Ease in quadratic: t^2
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
        let width = 300;
        let height = if has_monitor { 80 } else { 48 };

        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);

        let screen_height = GetSystemMetrics(SM_CYSCREEN);

        let mut work_area = RECT::default();
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work_area as *mut _ as *mut std::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );

        // Position it center-aligned horizontally with the tray
        let mut x = cursor.x - width / 2;
        if x + width > work_area.right {
            x = work_area.right - width - 12;
        }
        if x < work_area.left + 12 {
            x = work_area.left + 12;
        }

        let is_bottom_taskbar = work_area.bottom < screen_height;

        // Position vertically floating above/below the taskbar by a fixed 12px margin
        let y = if is_bottom_taskbar {
            // Taskbar is at the bottom (standard Windows 11 layout)
            work_area.bottom - height - 12
        } else if work_area.top > 0 {
            // Taskbar is at the top
            work_area.top + 12
        } else {
            // Fallback (taskbar on side or hidden)
            let mut val = cursor.y - height / 2;
            if val + height > work_area.bottom {
                val = work_area.bottom - height - 12;
            }
            if val < work_area.top + 12 {
                val = work_area.top + 12;
            }
            val
        };

        let class_name = encode_wide("BrightnessMenuClass");
        let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap();
        let hinstance = windows::Win32::Foundation::HINSTANCE(instance.0);

        // Create the window with WS_EX_LAYERED and WS_POPUP (initially hidden)
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(WS_EX_LAYERED),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(encode_wide("BrightnessMenu").as_ptr()),
            WS_POPUP,
            x,
            y,
            width,
            height,
            HWND::default(),
            None,
            hinstance,
            None,
        ).unwrap();

        let slider_value = if has_monitor { monitors[0].current_brightness } else { 50 };

        // Setup state
        {
            let mut state = MENU_STATE.lock().unwrap();
            *state = Some(MenuState {
                hwnd,
                monitors,
                is_dragging_slider: false,
                slider_value,
                is_bottom_taskbar,
                is_hiding: false,
            });
        }

        // Configure DWM attributes
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

        // Configure initial opacity to 0
        let _ = SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);

        // Spawn custom smooth ease-out slide animation thread
        let start_y = if is_bottom_taskbar { y + 16 } else { y - 16 };
        let target_y = y;
        let final_x = x;
        let hwnd_raw = hwnd.0 as isize;

        std::thread::spawn(move || {
            let hwnd = HWND(hwnd_raw as *mut _);
            let steps = 15;
            let step_delay = std::time::Duration::from_millis(10); // 150ms total

            for i in 0..=steps {
                let progress = i as f32 / steps as f32;
                
                // Opacity: 0 -> 255
                let opacity = (progress * 255.0) as u8;
                
                // Ease out quadratic: 1 - (1 - t)^2
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

            // Ensure final position and opacity is 100% correct
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
