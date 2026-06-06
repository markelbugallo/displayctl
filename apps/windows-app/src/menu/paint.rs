use windows::Win32::Foundation::COLORREF;
use windows::Win32::Graphics::Gdi::{HDC, SetPixelV};

pub(crate) fn blend_colors(fg: COLORREF, bg: COLORREF, alpha: f32) -> COLORREF {
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

pub(crate) unsafe fn draw_antialiased_thumb(hdc: HDC, cx: i32, cy: i32, is_light: bool, accent_color: COLORREF) {
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
                    if px >= 44 && px < cx {
                        accent_color
                    } else if px >= cx && px <= 304 {
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
