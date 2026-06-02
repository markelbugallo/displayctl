<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/displayctl_icon_white.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/displayctl_icon_black.png">
    <img alt="displayctl logo" src="assets/displayctl_icon_black.png" width="128" height="128">
  </picture>
</p>

<h1 align="center">displayctl</h1>

<p align="center">
  <strong>Sleek GNOME Shell control for external displays.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-displayctl--gnome--50-blue?style=flat-square" alt="Release Name">
  <img src="https://img.shields.io/badge/GNOME-45--50-blueviolet?style=flat-square" alt="GNOME Shell Support">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
</p>

---

`displayctl` adds a minimal, native top-bar indicator to manage external monitors directly from GNOME Shell. It focuses on offering a fast, integrated menu for essential external display settings without spawning extra windows.

## Features

- **Backlight Control**: Adjust external monitor brightness via a native slider.
- **Display Configurations**: Select primary monitor, change refresh rates, and toggle layout modes (mirror, join, external-only) dynamically.
- **Zero Configuration Fallback**: Works out of the box on any GNOME Shell environment.

---

## Operating Modes

`displayctl` supports two operation modes for controlling external monitor brightness:

1. **Hardware Mode (DDC/CI - Recommended)**  
   Communicates directly with your monitor's physical backlight hardware through the DDC/CI protocol. Brightness adjustments are native, real-time, and do not affect color contrast or accuracy.
   
2. **Software Mode (Dimming Overlay Fallback)**  
   When hardware control is unavailable or unconfigured, the extension gracefully falls back to a software dimming overlay. It overlays a transparent black layer at the shell layer to dim the screen visually.

> [!TIP]
> Hardware Mode requires a one-time configuration on your system. Read the [Hardware Mode Configuration Guide](HARDWARE.md) to set it up.

---

## Installation

Download the extension archive from the latest **`v1.0`** release (**`displayctl-gnome-50`**) and run:

```bash
gnome-extensions install displayctl@mbg.zip
```
*Note: On GNOME Shell with Wayland, you may need to log out and log back in for the shell to register the newly installed extension.*

---

## License

This project is licensed under the [GPL 3.0 License](LICENSE).
