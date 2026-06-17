use windows::Win32::Devices::Display::{
    GetDisplayConfigBufferSizes, QueryDisplayConfig, DISPLAYCONFIG_MODE_INFO,
    DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL, QDC_ONLY_ACTIVE_PATHS,
    GetNumberOfPhysicalMonitorsFromHMONITOR, GetPhysicalMonitorsFromHMONITOR,
    GetMonitorBrightness, SetMonitorBrightness, DestroyPhysicalMonitors,
    PHYSICAL_MONITOR, DisplayConfigGetDeviceInfo,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME,
    DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED,
    DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED,
    DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, HDC, HMONITOR, GetMonitorInfoW, MONITORINFOEXW,
    EnumDisplaySettingsW, ChangeDisplaySettingsExW, DEVMODEW,
    ENUM_CURRENT_SETTINGS, DM_DISPLAYFREQUENCY, CDS_UPDATEREGISTRY,
    DISP_CHANGE_SUCCESSFUL, ENUM_DISPLAY_SETTINGS_MODE,
    DM_POSITION, CDS_SET_PRIMARY, CDS_NORESET, CDS_RESET,
};
use windows::Win32::Foundation::{BOOL, LPARAM, RECT, HANDLE, HWND};
use windows::core::PCWSTR;

#[allow(dead_code)]
pub struct DdcMonitor {
    pub monitor: PHYSICAL_MONITOR,
    pub name: String,
    pub min_brightness: u32,
    pub current_brightness: u32,
    pub max_brightness: u32,
    pub gdi_device_name: String,
}

#[allow(dead_code)]
pub fn count_external_monitors() -> usize {
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
        let limit = (num_paths as usize).min(paths.len());
        for path in &paths[..limit] {
            let tech = path.targetInfo.outputTechnology;
            if tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL
                && tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED
                && tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED
                && tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS
            {
                external_count += 1;
            }
        }
        external_count
    }
}

unsafe extern "system" fn monitor_enum_proc(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let monitors = &mut *(data.0 as *mut Vec<HMONITOR>);
    monitors.push(hmonitor);
    BOOL::from(true)
}

pub fn get_monitor_handles() -> Vec<HMONITOR> {
    let mut monitors = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(monitor_enum_proc),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }
    monitors
}

pub fn get_friendly_name_for_hmonitor(hmon: HMONITOR) -> Option<String> {
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
            return None;
        }
        let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
        let gdi_device_name = String::from_utf16_lossy(&info.szDevice[..len]);

        let mut num_paths = 0;
        let mut num_modes = 0;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut num_paths, &mut num_modes).is_err() {
            return None;
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
            return None;
        }

        let limit = (num_paths as usize).min(paths.len());
        for path in &paths[..limit] {
            let mut source_name = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source_name.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source_name.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            source_name.header.adapterId = path.sourceInfo.adapterId;
            source_name.header.id = path.sourceInfo.id;

            if DisplayConfigGetDeviceInfo(&mut source_name.header) == 0 {
                let len = source_name.viewGdiDeviceName.iter().position(|&c| c == 0).unwrap_or(source_name.viewGdiDeviceName.len());
                let path_gdi_name = String::from_utf16_lossy(&source_name.viewGdiDeviceName[..len]);

                if path_gdi_name.trim().eq_ignore_ascii_case(gdi_device_name.trim()) {
                    let mut target_name = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
                    target_name.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
                    target_name.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
                    target_name.header.adapterId = path.targetInfo.adapterId;
                    target_name.header.id = path.targetInfo.id;

                    if DisplayConfigGetDeviceInfo(&mut target_name.header) == 0 {
                        let len = target_name.monitorFriendlyDeviceName.iter().position(|&c| c == 0).unwrap_or(target_name.monitorFriendlyDeviceName.len());
                        let friendly_name = String::from_utf16_lossy(&target_name.monitorFriendlyDeviceName[..len]);
                        let name_trimmed = friendly_name.trim().to_string();
                        if !name_trimmed.is_empty() {
                            return Some(name_trimmed);
                        }
                    }
                }
            }
        }
    }
    None
}

pub fn detect_ddc_monitors() -> Vec<DdcMonitor> {
    let hmonitors = get_monitor_handles();
    let mut results = Vec::new();

    for hmon in hmonitors {
        if is_hmonitor_external(hmon) {
            unsafe {
                let mut count = 0;
                if GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count).is_ok() && count > 0 {
                    let mut physical_monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
                    if GetPhysicalMonitorsFromHMONITOR(hmon, &mut physical_monitors).is_ok() {
                        for pm in physical_monitors {
                            let mut min = 0;
                            let mut cur = 0;
                            let mut max = 0;
                            if GetMonitorBrightness(pm.hPhysicalMonitor, &mut min, &mut cur, &mut max) != 0 {
                                let friendly_name = get_friendly_name_for_hmonitor(hmon);
                                let display_name = friendly_name.unwrap_or_else(|| {
                                    let desc = pm.szPhysicalMonitorDescription;
                                    let len = desc.iter().position(|&c| c == 0).unwrap_or(128);
                                    let name = String::from_utf16_lossy(&desc[..len]);
                                    if name.trim().is_empty() { "Monitor externo".to_string() } else { name }
                                });

                                let mut info = MONITORINFOEXW::default();
                                info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
                                let gdi_device_name = if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
                                    let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
                                    String::from_utf16_lossy(&info.szDevice[..len])
                                } else {
                                    String::new()
                                };

                                results.push(DdcMonitor {
                                    monitor: pm,
                                    name: display_name,
                                    min_brightness: min,
                                    current_brightness: cur,
                                    max_brightness: max,
                                    gdi_device_name,
                                });
                            } else {
                                // If DDC/CI is not supported on this handle, release it immediately
                                let _ = DestroyPhysicalMonitors(&[pm]);
                            }
                        }
                    }
                }
            }
        }
    }
    results
}

pub fn set_monitor_brightness_value(h_physical: HANDLE, val: u32) -> bool {
    unsafe {
        SetMonitorBrightness(h_physical, val) != 0
    }
}

pub fn get_refresh_rates(gdi_device_name: &str) -> (Vec<u32>, u32) {
    let mut rates = Vec::new();
    let mut current_rate = 60;
    if gdi_device_name.is_empty() {
        return (rates, current_rate);
    }
    unsafe {
        let device_wide = crate::utils::encode_wide(gdi_device_name);
        
        let mut current_devmode = DEVMODEW::default();
        current_devmode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if EnumDisplaySettingsW(
            PCWSTR(device_wide.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut current_devmode,
        ).as_bool() {
            current_rate = current_devmode.dmDisplayFrequency;
        }

        let mut i = 0;
        loop {
            let mut devmode = DEVMODEW::default();
            devmode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
            if !EnumDisplaySettingsW(
                PCWSTR(device_wide.as_ptr()),
                ENUM_DISPLAY_SETTINGS_MODE(i),
                &mut devmode,
            ).as_bool() {
                break;
            }
            if devmode.dmPelsWidth == current_devmode.dmPelsWidth 
               && devmode.dmPelsHeight == current_devmode.dmPelsHeight 
            {
                let freq = devmode.dmDisplayFrequency;
                if freq > 0 && !rates.contains(&freq) {
                    rates.push(freq);
                }
            }
            i += 1;
        }
    }
    rates.sort_unstable();
    (rates, current_rate)
}



pub fn set_refresh_rate(gdi_device_name: &str, rate: u32) -> bool {
    if gdi_device_name.is_empty() {
        return false;
    }
    unsafe {
        let device_wide = crate::utils::encode_wide(gdi_device_name);
        
        let mut devmode = DEVMODEW::default();
        devmode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if !EnumDisplaySettingsW(
            PCWSTR(device_wide.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut devmode,
        ).as_bool() {
            return false;
        }

        devmode.dmDisplayFrequency = rate;
        devmode.dmFields |= DM_DISPLAYFREQUENCY;

        let res = ChangeDisplaySettingsExW(
            PCWSTR(device_wide.as_ptr()),
            Some(&devmode),
            HWND::default(),
            CDS_UPDATEREGISTRY,
            None,
        );
        
        if res == DISP_CHANGE_SUCCESSFUL {
            let _ = ChangeDisplaySettingsExW(
                PCWSTR::null(),
                None,
                HWND::default(),
                CDS_RESET,
                None,
            );
            true
        } else {
            false
        }
    }
}

#[derive(Clone, Debug)]
pub struct ActiveMonitor {
    pub gdi_device_name: String,
    pub friendly_name: String,
    pub is_primary: bool,
}

pub fn get_active_monitors() -> Vec<ActiveMonitor> {
    let handles = get_monitor_handles();
    let mut results = Vec::new();
    for hmon in handles {
        unsafe {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
                let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
                let gdi_device_name = String::from_utf16_lossy(&info.szDevice[..len]);
                let is_primary = (info.monitorInfo.dwFlags & 1) != 0;
                
                let friendly_name = if is_hmonitor_internal(hmon) {
                    "Integrada".to_string()
                } else {
                    get_friendly_name_for_hmonitor(hmon)
                        .unwrap_or_else(|| {
                            if is_primary {
                                "Pantalla principal".to_string()
                            } else {
                                format!("Pantalla secundaria ({})", gdi_device_name.trim())
                            }
                        })
                };

                results.push(ActiveMonitor {
                    gdi_device_name,
                    friendly_name,
                    is_primary,
                });
            }
        }
    }
    results
}

pub fn set_primary_monitor(target_gdi_name: &str) -> bool {
    let handles = get_monitor_handles();
    let mut monitor_devmodes = Vec::new();
    let mut target_pos = None;

    for hmon in &handles {
        unsafe {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(*hmon, &mut info as *mut _ as *mut _).as_bool() {
                let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
                let gdi_name = String::from_utf16_lossy(&info.szDevice[..len]);
                
                let device_wide = crate::utils::encode_wide(&gdi_name);
                let mut devmode = DEVMODEW::default();
                devmode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
                if EnumDisplaySettingsW(
                    PCWSTR(device_wide.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut devmode,
                ).as_bool() {
                    let pos_x = devmode.Anonymous1.Anonymous2.dmPosition.x;
                    let pos_y = devmode.Anonymous1.Anonymous2.dmPosition.y;
                    
                    if gdi_name.trim().eq_ignore_ascii_case(target_gdi_name.trim()) {
                        target_pos = Some((pos_x, pos_y));
                    }
                    monitor_devmodes.push((gdi_name, devmode));
                }
            }
        }
    }

    let (dx, dy) = match target_pos {
        Some(pos) => pos,
        None => return false,
    };

    monitor_devmodes.sort_by(|a, b| {
        if a.0.trim().eq_ignore_ascii_case(target_gdi_name.trim()) {
            std::cmp::Ordering::Less
        } else if b.0.trim().eq_ignore_ascii_case(target_gdi_name.trim()) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });

    for (gdi_name, mut devmode) in monitor_devmodes {
        unsafe {
            let cur_x = devmode.Anonymous1.Anonymous2.dmPosition.x;
            let cur_y = devmode.Anonymous1.Anonymous2.dmPosition.y;
            
            devmode.Anonymous1.Anonymous2.dmPosition.x = cur_x - dx;
            devmode.Anonymous1.Anonymous2.dmPosition.y = cur_y - dy;
            devmode.dmFields |= DM_POSITION;

            let device_wide = crate::utils::encode_wide(&gdi_name);
            let flags = if gdi_name.trim().eq_ignore_ascii_case(target_gdi_name.trim()) {
                CDS_SET_PRIMARY | CDS_UPDATEREGISTRY | CDS_NORESET
            } else {
                CDS_UPDATEREGISTRY | CDS_NORESET
            };

            let _ = ChangeDisplaySettingsExW(
                PCWSTR(device_wide.as_ptr()),
                Some(&devmode),
                HWND::default(),
                flags,
                None,
            );
        }
    }

    unsafe {
        let res = ChangeDisplaySettingsExW(
            PCWSTR::null(),
            None,
            HWND::default(),
            CDS_RESET,
            None,
        );
        res == DISP_CHANGE_SUCCESSFUL
    }
}

pub fn is_hmonitor_external(hmon: HMONITOR) -> bool {
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
            return false;
        }
        let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
        let gdi_device_name = String::from_utf16_lossy(&info.szDevice[..len]);

        let mut num_paths = 0;
        let mut num_modes = 0;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut num_paths, &mut num_modes).is_err() {
            return false;
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
            return false;
        }

        let limit = (num_paths as usize).min(paths.len());
        for path in &paths[..limit] {
            let mut source_name = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source_name.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source_name.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            source_name.header.adapterId = path.sourceInfo.adapterId;
            source_name.header.id = path.sourceInfo.id;

            if DisplayConfigGetDeviceInfo(&mut source_name.header) == 0 {
                let len = source_name.viewGdiDeviceName.iter().position(|&c| c == 0).unwrap_or(source_name.viewGdiDeviceName.len());
                let path_gdi_name = String::from_utf16_lossy(&source_name.viewGdiDeviceName[..len]);

                if path_gdi_name.trim().eq_ignore_ascii_case(gdi_device_name.trim()) {
                    let tech = path.targetInfo.outputTechnology;
                    return tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL
                        && tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED
                        && tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED
                        && tech != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS;
                }
            }
        }
    }
    false
}

pub fn is_hmonitor_internal(hmon: HMONITOR) -> bool {
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
            return false;
        }
        let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
        let gdi_device_name = String::from_utf16_lossy(&info.szDevice[..len]);

        let mut num_paths = 0;
        let mut num_modes = 0;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut num_paths, &mut num_modes).is_err() {
            return false;
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
            return false;
        }

        let limit = (num_paths as usize).min(paths.len());
        for path in &paths[..limit] {
            let mut source_name = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source_name.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source_name.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            source_name.header.adapterId = path.sourceInfo.adapterId;
            source_name.header.id = path.sourceInfo.id;

            if DisplayConfigGetDeviceInfo(&mut source_name.header) == 0 {
                let len = source_name.viewGdiDeviceName.iter().position(|&c| c == 0).unwrap_or(source_name.viewGdiDeviceName.len());
                let path_gdi_name = String::from_utf16_lossy(&source_name.viewGdiDeviceName[..len]);

                if path_gdi_name.trim().eq_ignore_ascii_case(gdi_device_name.trim()) {
                    let tech = path.targetInfo.outputTechnology;
                    return tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL
                        || tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED
                        || tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED
                        || tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS;
                }
            }
        }
    }
    false
}
