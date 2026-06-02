# Hardware Mode Configuration Guide (DDC/CI)

This guide walks you through configuring your Linux system to enable **Hardware Mode** in `displayctl`. Hardware Mode uses the DDC/CI protocol to directly adjust your external monitor's physical backlight and brightness, avoiding the need for software overlays.

By following this guide, you will set up passwordless, safe, and root-free access to your monitor's DDC/CI interface.

---

## Prerequisites

1. **Enable DDC/CI on your Monitor**: Open your monitor's physical On-Screen Display (OSD) menu and ensure **DDC/CI** is enabled.
2. **Video Connection**: Connect your monitor using a native video cable (HDMI, DisplayPort, or USB-C). Cheap adapters or older docking stations can block I2C communication.

---

## Step-by-Step Configuration

### 1. Install `ddcutil`
`ddcutil` is the underlying tool that communicates with external monitors. Install it using your distribution's package manager:

* **Ubuntu / Debian**:
  ```bash
  sudo apt update && sudo apt install -y ddcutil
  ```
* **Fedora**:
  ```bash
  sudo dnf install -y ddcutil
  ```
* **Arch Linux**:
  ```bash
  sudo pacman -S ddcutil
  ```

---

### 2. Enable the `i2c-dev` Kernel Module
External monitors are controlled via the I2C protocol. The kernel module `i2c-dev` exposes your graphics card's I2C buses under `/dev/i2c-*` so user-space software like `displayctl` can communicate with them.

Run the following commands to load it now and ensure it loads automatically on boot:

```bash
# Load the module immediately
sudo modprobe i2c-dev

# Persist the module across reboots
echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c.conf
```

---

### 3. Configure Safe User-Level Permissions (`udev` rule)
By default, files under `/dev/i2c-*` are restricted to root. To allow `displayctl` to control the screen brightness without needing `sudo`, we can set up a secure `udev` rule.

We use systemd's `uaccess` tag. This grants read/write permissions dynamically to whichever user is currently physically logged in (active seat), without adding your user to permanent system groups like `i2c` or `video` (which can be a security risk).

1. Create a new rules file:
   ```bash
   sudo nano /etc/udev/rules.d/45-ddcutil-i2c.rules
   ```
2. Paste the following line:
   ```udev
   KERNEL=="i2c-[0-9]*", ATTRS{class}=="0x030000", TAG+="uaccess"
   ```
   * **`KERNEL=="i2c-[0-9]*"`**: Filters and targets I2C bus device nodes.
   * **`ATTRS{class}=="0x030000"`**: Limits access exclusively to I2C buses belonging to graphics controllers, keeping other sensitive system I2C devices protected.
   * **`TAG+="uaccess"`**: Tells `systemd-logind` to dynamically hand over access permissions to the active local desktop user.

---

### NVIDIA Proprietary Drivers (Additional Step)
If you are using an NVIDIA graphics card with the **proprietary NVIDIA driver**, the driver may block standard I2C communication. You need to enable a registry option to support DDC/CI.

1. Create or edit the X11 configuration file:
   ```bash
   sudo mkdir -p /etc/X11/xorg.conf.d/
   sudo nano /etc/X11/xorg.conf.d/10-nvidia-ddc.conf
   ```
2. Add the following content:
   ```text
   Section "Device"
       Identifier "NvidiaCard"
       Driver "nvidia"
       Option "RegistryDwords" "RMUseSwI2c=0x01; RMI2cSpeed=100"
   EndSection
   ```
3. **Reboot your system** to apply the NVIDIA registry and udev configurations.

---

## Verification

Once the system has rebooted, verify that your active user has correct hardware access by running:

```bash
ddcutil detect
```

### Successful Output Example:
```text
Display 1
   I2C bus:             /dev/i2c-5
   Display technology:  DDC/CI
   Monitor:             DEL:DELL U2415:123456789
   DDC communication:   OK
```
If you see **`DDC communication: OK`**, `displayctl` will automatically detect your monitor and use Hardware Mode.
