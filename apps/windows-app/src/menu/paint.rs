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

pub(crate) unsafe fn draw_antialiased_thumb(
    hdc: HDC,
    cx: i32,
    cy: i32,
    is_light: bool,
    accent_color: COLORREF,
    track_start: i32,
    track_end: i32,
    scale: f32,
) {
    let bg_color = if is_light { COLORREF(0x00F3F3F3) } else { COLORREF(0x002C2C2C) };
    let track_bg = if is_light { COLORREF(0x00E5E5E5) } else { COLORREF(0x00454545) };
    let outer_thumb_bg = if is_light { COLORREF(0x00D8D8D8) } else { COLORREF(0x00555555) };
    
    let max_r = (7.0 * scale) as i32;
    let r_outer_max = 7.0 * scale;
    let r_outer_min = 5.5 * scale;
    let r_inner_max = 3.5 * scale;
    let r_inner_min = 2.5 * scale;
    
    let half_track_height = (2.0 * scale) as i32;
    
    for dy in -max_r..=max_r {
        for dx in -max_r..=max_r {
            let px = cx + dx;
            let py = cy + dy;
            let dist = ((dx * dx + dy * dy) as f32).sqrt();
            
            if dist <= r_outer_max {
                let bg_pixel_color = if py >= cy - half_track_height && py <= cy + half_track_height - 1 {
                    if px >= track_start && px < cx {
                        accent_color
                    } else if px >= cx && px <= track_end {
                        track_bg
                    } else {
                        bg_color
                    }
                } else {
                    bg_color
                };
                
                let (target_color, alpha) = if dist <= r_inner_min {
                    (accent_color, 1.0)
                } else if dist <= r_inner_max {
                    let t = (r_inner_max - dist) / (r_inner_max - r_inner_min);
                    let c = blend_colors(accent_color, outer_thumb_bg, t);
                    (c, 1.0)
                } else if dist <= r_outer_min {
                    (outer_thumb_bg, 1.0)
                } else if dist <= r_outer_max {
                    let t = (r_outer_max - dist) / (r_outer_max - r_outer_min);
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
