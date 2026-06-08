<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/displayctl_icon_white.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/displayctl_icon_black.png">
    <img alt="displayctl logo" src="assets/displayctl_icon_black.png" width="128" height="128">
  </picture>
</p>

<h1 align="center">displayctl</h1>

<p align="center">
  <strong>Sleek GNOME Shell extension for Linux and a lightweight background app for Windows 11.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME-45--50-blueviolet?style=flat-square" alt="GNOME Shell Support">
  <img src="https://img.shields.io/badge/Platform-Linux%20%7C%20Windows%2011-blue?style=flat-square" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-GPL%203.0-green?style=flat-square" alt="License">
</p>

---

`displayctl` is a cross-platform utility to manage external monitors. On Linux, it runs as a native GNOME Shell extension, and on Windows 11, it operates as a highly optimized, very lightweight background application sitting in the system tray. It focuses on offering a fast, integrated menu for essential external display settings without spawning heavy GUI windows or consuming noticeable system resources.

## Features

- **Backlight Control**: Adjust external monitor brightness via a native slider.
- **Display Configurations**: Select primary monitor, change refresh rates, and toggle layout modes (mirror, join, external-only) dynamically.
- **Zero Configuration**: Works out of the box on Windows 11 (using native APIs) and falls back gracefully to software dimming on GNOME if hardware mode is not configured.

---

## Operating Modes

`displayctl` supports two operation modes for controlling external monitor brightness:

1. **Hardware Mode (DDC/CI - Recommended)**  
   Communicates directly with your monitor's physical backlight hardware through the DDC/CI protocol. Brightness adjustments are native, real-time, and do not affect color contrast or accuracy.
   
2. **Software Mode (Dimming Overlay Fallback)**  
   When hardware control is unavailable or unconfigured, the extension gracefully falls back to a software dimming overlay. It overlays a transparent black layer at the shell layer to dim the screen visually.

> [!TIP]
> Hardware Mode requires a one-time configuration **only on Linux**. Read the [Hardware Mode Configuration Guide](HARDWARE.md) to set it up. On Windows, it works out of the box without any extra configuration.

---

## Installation

### Linux (GNOME Extension)

Download the extension archive from the **`gnome-50`** release and run:

```bash
gnome-extensions install displayctl@mbg.zip
```
*Note: On GNOME Shell with Wayland, you may need to log out and log back in for the shell to register the newly installed extension.*

### Windows

Download the setup installer (`displayctl-setup.exe`) from the latest **`windows-11`** release.

> [!IMPORTANT]
> Since the installer is an unsigned executable, Windows Defender / **SmartScreen** may show a security warning ("Windows protegió su PC" or "Windows protected your PC"). You can safely bypass this by clicking on **"Más información"** ("More info") and then **"Ejecutar de todas formas"** ("Run anyway").

---

## License

This project is licensed under the [GPL 3.0 License](LICENSE).
