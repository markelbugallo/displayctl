import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DisplayctlExtension extends Extension {
  enable() {
    this._indicator = new PanelMenu.Button(0.0, 'Displayctl');

    const icon = this._createIndicatorIcon();
    this._indicator.add_child(icon);

    this._brightnessItem = null;
    this._brightnessIcon = null;
    this._statusItem = null;
    this._backlightState = null;
    this._externalConnectors = [];
    this._overlays = new Map();
    this._softwareBrightness = new Map();
    this._logicalMonitors = [];
    this._isUpdatingBrightness = false;
    this._targetHardwareBrightness = null;
    this._currentHardwareBrightness = null;
    this._isDdcutilRunning = false;
    this._currentSoftwareBrightness = new Map();
    this._ddcutilTimeoutId = null;
    this._ddcBusCache = new Map();
    this._buildMenu();

    this._indicator.visible = false;
    this._hasExternalMonitor = false;
    this._displayConfigProxy = null;
    this._displayConfigCancellable = null;
    this._createDisplayConfigProxy();
    this._monitorsChangedEmitter = Main.layoutManager;
    this._monitorsChangedId = this._monitorsChangedEmitter.connect(
      'monitors-changed',
      () => this._updateIndicatorVisibility()
    );
    this._menuOpenId = this._indicator.menu.connect('open-state-changed', (menu, isOpen) => {
      if (isOpen) {
        this._refreshBrightness();
      }
    });

    // Right box, left of the built-in system icons.
    Main.panel.addToStatusArea('displayctl', this._indicator, 0, 'right');
    this._updateIndicatorVisibility();
  }

  disable() {
    if (this._monitorsChangedId && this._monitorsChangedEmitter) {
      this._monitorsChangedEmitter.disconnect(this._monitorsChangedId);
      this._monitorsChangedId = null;
      this._monitorsChangedEmitter = null;
    }
    if (this._menuOpenId && this._indicator?.menu) {
      this._indicator.menu.disconnect(this._menuOpenId);
      this._menuOpenId = null;
    }
    if (this._displayConfigCancellable) {
      this._displayConfigCancellable.cancel();
      this._displayConfigCancellable = null;
    }
    this._displayConfigProxy = null;
    this._backlightState = null;

    if (this._ddcutilTimeoutId) {
      GLib.source_remove(this._ddcutilTimeoutId);
      this._ddcutilTimeoutId = null;
    }

    this._clearOverlays();
    this._overlays = null;
    this._softwareBrightness = null;
    this._currentSoftwareBrightness = null;
    this._targetHardwareBrightness = null;
    this._currentHardwareBrightness = null;
    this._logicalMonitors = [];
    this._ddcBusCache = null;

    this._brightnessItem = null;
    this._brightnessIcon = null;
    this._statusItem = null;

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }

  _panelIsLight() {
    const themeNode = Main.panel?.get_theme_node?.();
    const background = themeNode?.get_background_color?.();
    if (!background) {
      return false;
    }

    if (typeof background.alpha === 'number' && background.alpha < 220) {
      return true;
    }

    const brightness = (background.red + background.green + background.blue) / (3 * 255);
    return brightness > 0.6;
  }

  _getIconFile() {
    if (!this.dir) {
      console.warn('[displayctl] Extension directory is not available to load icon.');
      return null;
    }

    const extensionIcon = this.dir
      .get_child('assets')
      .get_child('displayctl_icon_white.png');
    if (extensionIcon.query_exists(null)) {
      return extensionIcon;
    }

    let repoRoot = this.dir;
    for (let i = 0; i < 3 && repoRoot; i += 1) {
      repoRoot = repoRoot.get_parent();
    }

    if (repoRoot) {
      const repoIcon = repoRoot
        .get_child('assets')
        .get_child('displayctl_icon_white.png');
      if (repoIcon.query_exists(null)) {
        return repoIcon;
      }
    }

    console.warn('[displayctl] Icon not found at assets/displayctl_icon_white.png.');
    return null;
  }

  _createIndicatorIcon() {
    const iconFile = this._getIconFile();
    if (iconFile) {
      const icon = new St.Icon({
        gicon: new Gio.FileIcon({file: iconFile}),
        icon_size: 16,
        style_class: 'system-status-icon',
      });
      const baseStyle = '-st-icon-style: regular; padding: 2px; border-radius: 999px;';
      if (this._panelIsLight()) {
        icon.set_style(`${baseStyle} background-color: rgba(0, 0, 0, 0.45);`);
      } else {
        icon.set_style(baseStyle);
      }
      return icon;
    }

    return new St.Icon({
      icon_name: 'video-display-symbolic',
      icon_size: 16,
      style_class: 'system-status-icon',
    });
  }

  _createDisplayConfigProxy() {
    if (this._displayConfigCancellable) {
      this._displayConfigCancellable.cancel();
    }

    this._displayConfigCancellable = new Gio.Cancellable();
    Gio.DBusProxy.new_for_bus(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      'org.gnome.Mutter.DisplayConfig',
      '/org/gnome/Mutter/DisplayConfig',
      'org.gnome.Mutter.DisplayConfig',
      this._displayConfigCancellable,
      (source, result) => {
        if (!this._indicator) {
          return;
        }

        try {
          this._displayConfigProxy = Gio.DBusProxy.new_for_bus_finish(result);
        } catch (error) {
          if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            return;
          }
          console.error('[displayctl] Failed to create DisplayConfig proxy.', error);
          return;
        }

        this._updateIndicatorVisibility();
      }
    );
  }

  _updateIndicatorVisibility() {
    if (!this._displayConfigProxy || !this._indicator) {
      return;
    }

    this._displayConfigProxy.call(
      'GetCurrentState',
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (proxy, result) => {
        if (!this._indicator || !this._displayConfigProxy) {
          return;
        }

        let response;
        try {
          response = proxy.call_finish(result);
        } catch (error) {
          console.error('[displayctl] Failed to read monitor state.', error);
          return;
        }

        const [, monitors, logicalMonitors] = response.deep_unpack();
        this._logicalMonitors = logicalMonitors || [];
        const externalConnectors = this._getExternalConnectors(monitors);
        this._externalConnectors = externalConnectors;
        const hasExternalMonitor = externalConnectors.length > 0;
        this._setIndicatorVisibility(hasExternalMonitor);
        this._updateOverlays(this._logicalMonitors);

        if (hasExternalMonitor) {
          this._detectDdcBuses();
        } else if (this._ddcBusCache) {
          this._ddcBusCache.clear();
        }

        this._refreshBrightness();
      }
    );
  }

  _setIndicatorVisibility(visible) {
    this._hasExternalMonitor = visible;
    if (this._indicator) {
      this._indicator.visible = visible;
      this._indicator.reactive = visible;
      this._indicator.can_focus = visible;
    }
  }

  _getExternalConnectors(monitors) {
    if (!Array.isArray(monitors)) {
      return [];
    }

    const connectors = [];
    for (const monitor of monitors) {
      const [monitorInfo, , properties] = monitor;
      const connector = Array.isArray(monitorInfo) ? monitorInfo[0] : null;
      if (!connector) {
        continue;
      }
      const isBuiltinProperty = this._getPropertyValue(properties, 'is-builtin');
      const isBuiltin = typeof isBuiltinProperty === 'boolean'
        ? isBuiltinProperty
        : this._isBuiltinConnector(connector);

      if (!isBuiltin) {
        connectors.push(connector);
      }
    }

    return connectors;
  }

  _buildMenu() {
    if (!this._indicator || this._brightnessItem) {
      return;
    }

    const hasPopupSlider = typeof PopupMenu.PopupSliderMenuItem === 'function';
    this._brightnessItem = hasPopupSlider
      ? new PopupMenu.PopupSliderMenuItem(0)
      : new PopupMenu.PopupBaseMenuItem({activate: false});
    this._brightnessIcon = new St.Icon({
      icon_name: 'display-brightness-symbolic',
      style_class: 'popup-menu-icon',
    });
    if (this._brightnessItem.insert_child_at_index) {
      this._brightnessItem.insert_child_at_index(this._brightnessIcon, 0);
    } else if (this._brightnessItem.actor?.insert_child_at_index) {
      this._brightnessItem.actor.insert_child_at_index(this._brightnessIcon, 0);
    } else {
      this._brightnessItem.add_child(this._brightnessIcon);
    }
    if (hasPopupSlider) {
      this._brightnessItem.setSensitive(false);
      this._brightnessItem.connect('value-changed', (item, value) => {
        this._onBrightnessSliderChanged(value);
      });
    } else {
      const slider = new Slider.Slider(0);
      this._brightnessItem.slider = slider;
      this._brightnessItem._slider = slider;
      const baseSetSensitive = typeof this._brightnessItem.setSensitive === 'function'
        ? this._brightnessItem.setSensitive.bind(this._brightnessItem)
        : null;
      this._brightnessItem.setSensitive = (enabled) => {
        if (baseSetSensitive) {
          baseSetSensitive(enabled);
        }
        this._brightnessItem.reactive = enabled;
        this._brightnessItem.can_focus = enabled;
        slider.reactive = enabled;
        slider.can_focus = enabled;
        slider.opacity = enabled ? 255 : 128;
      };
      this._brightnessItem.setSensitive(false);
      slider.connect('notify::value', () => {
        this._onBrightnessSliderChanged(slider.value);
      });
      if (this._brightnessItem.add_child) {
        this._brightnessItem.add_child(slider);
      } else if (this._brightnessItem.actor?.add_child) {
        this._brightnessItem.actor.add_child(slider);
      }
    }
    this._indicator.menu.addMenuItem(this._brightnessItem);
  }

  _onBrightnessSliderChanged(value) {
    if (this._isUpdatingBrightness || !this._backlightState) {
      return;
    }

    const state = this._backlightState;
    const clampedValue = Math.max(0, Math.min(1, value));

    if (state.isHardware) {
      const {min, max, value: currentValue} = state;
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return;
      }

      const target = Math.round(min + clampedValue * (max - min));
      const clamped = Math.max(min, Math.min(max, target));
      if (clamped === currentValue) {
        return;
      }

      this._targetHardwareBrightness = clamped;
      if (this._currentHardwareBrightness === null) {
        this._currentHardwareBrightness = currentValue;
      }
      this._backlightState.value = clamped;
      this._processHardwareBrightnessTransition();
    } else {
      const {connector} = state;
      const targetBrightness = Math.max(0.1, clampedValue);
      this._softwareBrightness.set(connector, targetBrightness);
      this._backlightState.value = targetBrightness;

      this._processSoftwareBrightnessTransition(connector, targetBrightness);
    }
  }

  _processHardwareBrightnessTransition() {
    if (this._isDdcutilRunning) {
      return;
    }

    const state = this._backlightState;
    if (!state || !state.isHardware) {
      return;
    }

    if (this._currentHardwareBrightness === null) {
      this._currentHardwareBrightness = state.value;
    }

    const target = this._targetHardwareBrightness;
    const current = this._currentHardwareBrightness;

    if (target === null || current === target) {
      return;
    }

    const nextValue = target;

    this._isDdcutilRunning = true;
    const bus = state.bus;

    const argv = ['ddcutil'];
    if (bus !== undefined) {
      argv.push('--bus', String(bus));
    }
    argv.push('setvcp', '10', String(nextValue));
    if (bus !== undefined) {
      argv.push('--noverify');
    }

    try {
      let proc = new Gio.Subprocess({
        argv: argv,
        flags: Gio.SubprocessFlags.NONE,
      });
      proc.init(null);
      proc.wait_async(null, (obj, res) => {
        this._isDdcutilRunning = false;
        try {
          obj.wait_finish(res);
          this._currentHardwareBrightness = nextValue;
        } catch (e) {
          console.error('[displayctl] ddcutil setvcp failed:', e);
        }
        this._processHardwareBrightnessTransition();
      });
    } catch (e) {
      this._isDdcutilRunning = false;
      console.error('[displayctl] Failed to run ddcutil setvcp:', e);
    }
  }

  _processSoftwareBrightnessTransition(connector, target) {
    this._currentSoftwareBrightness.set(connector, target);
    const overlay = this._overlays.get(connector);
    if (overlay) {
      overlay.opacity = Math.round((1 - target) * 255);
      overlay.visible = target < 1.0;
    }
  }

  _refreshBrightness() {
    if (!this._brightnessItem) {
      return;
    }

    if (!this._externalConnectors || this._externalConnectors.length === 0) {
      this._setBrightnessItemEnabled(false);
      if (this._statusItem) {
        this._statusItem.label.text = 'No external monitors';
      }
      return;
    }

    if (!GLib.find_program_in_path('ddcutil')) {
      this._setupSoftwareBrightnessFallback();
      return;
    }

    if (this._isDdcutilRunning) {
      return;
    }

    this._isDdcutilRunning = true;

    const connector = this._externalConnectors[0];
    const bus = this._ddcBusCache ? this._ddcBusCache.get(connector) : undefined;

    const argv = ['ddcutil'];
    if (bus !== undefined) {
      argv.push('--bus', String(bus));
    }
    argv.push('getvcp', '10', '--brief');

    try {
      let proc = new Gio.Subprocess({
        argv: argv,
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENT,
      });
      proc.init(null);
      proc.communicate_utf8_async(null, null, (obj, res) => {
        this._isDdcutilRunning = false;
        try {
          const [success, stdout] = obj.communicate_utf8_finish(res);
          if (success && stdout) {
            const parsed = this._parseDdcutilGetvcp(stdout);
            if (parsed) {
              const {current, max} = parsed;
              const normalized = Math.max(0, Math.min(1, current / max));
              this._backlightState = {
                connector: connector,
                bus: bus,
                min: 0,
                max,
                value: current,
                isHardware: true,
              };
              this._targetHardwareBrightness = current;
              this._currentHardwareBrightness = current;
              this._isUpdatingBrightness = true;
              try {
                this._setBrightnessSliderValue(normalized);
              } finally {
                this._isUpdatingBrightness = false;
              }
              this._setBrightnessItemEnabled(true);
              if (this._statusItem) {
                this._statusItem.label.text = bus !== undefined
                  ? `Control: Hardware (DDC/CI - Bus ${bus})`
                  : 'Control: Hardware (DDC/CI)';
              }
              this._updateOverlays(this._logicalMonitors);
              return;
            }
          }
        } catch (e) {
          console.error('[displayctl] ddcutil getvcp failed:', e);
        }
        this._setupSoftwareBrightnessFallback();
      });
    } catch (e) {
      this._isDdcutilRunning = false;
      console.error('[displayctl] Failed to run ddcutil getvcp:', e);
      this._setupSoftwareBrightnessFallback();
    }
  }

  _parseDdcutilGetvcp(stdout) {
    if (!stdout) {
      return null;
    }
    const matches = stdout.match(/VCP\s+(?:10|0x10)\s+\S+\s+(\d+)(?:\s+(\d+))?/i);
    if (matches) {
      const current = parseInt(matches[1], 10);
      const max = matches[2] ? parseInt(matches[2], 10) : 100;
      if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
        return {current, max};
      }
    }
    return null;
  }

  _detectDdcBuses() {
    if (!GLib.find_program_in_path('ddcutil')) {
      return;
    }

    if (this._isDdcutilRunning) {
      return;
    }

    this._isDdcutilRunning = true;

    try {
      let proc = new Gio.Subprocess({
        argv: ['ddcutil', 'detect', '--brief', '--skip-ddc-checks'],
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENT,
      });
      proc.init(null);
      proc.communicate_utf8_async(null, null, (obj, res) => {
        this._isDdcutilRunning = false;
        try {
          const [success, stdout] = obj.communicate_utf8_finish(res);
          if (success && stdout) {
            const displays = this._parseDdcutilDetect(stdout);
            const newCache = new Map();
            for (const conn of this._externalConnectors) {
              const matched = this._matchConnectorToDdc(conn, displays);
              if (matched) {
                newCache.set(conn, matched.bus);
              }
            }
            this._ddcBusCache = newCache;
            this._refreshBrightness();
          }
        } catch (e) {
          console.error('[displayctl] ddcutil detect failed:', e);
        }
      });
    } catch (e) {
      this._isDdcutilRunning = false;
      console.error('[displayctl] Failed to launch ddcutil detect:', e);
    }
  }

  _parseDdcutilDetect(stdout) {
    const displays = [];
    const lines = stdout.split(/\r?\n/);
    let currentDisplay = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Display ')) {
        if (currentDisplay && currentDisplay.bus !== null) {
          displays.push(currentDisplay);
        }
        currentDisplay = { bus: null, drmConnector: '' };
      } else if (trimmed.startsWith('Invalid display')) {
        if (currentDisplay && currentDisplay.bus !== null) {
          displays.push(currentDisplay);
        }
        currentDisplay = null;
      } else if (currentDisplay) {
        const busMatch = trimmed.match(/I2C bus:\s*(.+)/);
        if (busMatch) {
          const busPath = busMatch[1].trim();
          const busNumMatch = busPath.match(/i2c-(\d+)/);
          if (busNumMatch) {
            currentDisplay.bus = parseInt(busNumMatch[1], 10);
          }
        }
        const drmMatch = trimmed.match(/DRM connector:\s*(\S+)/);
        if (drmMatch) {
          currentDisplay.drmConnector = drmMatch[1].trim();
        }
      }
    }
    if (currentDisplay && currentDisplay.bus !== null) {
      displays.push(currentDisplay);
    }
    return displays;
  }

  _matchConnectorToDdc(gnomeConnector, ddcDisplays) {
    if (!gnomeConnector || !ddcDisplays || ddcDisplays.length === 0) {
      return null;
    }

    for (const ddc of ddcDisplays) {
      if (ddc.drmConnector === gnomeConnector || ddc.drmConnector.endsWith(gnomeConnector)) {
        return ddc;
      }
    }

    const m = gnomeConnector.match(/^([A-Za-z\-]+)[\-\s]?(\d+)$/);
    if (m) {
      const type = m[1].toLowerCase().replace(/[^a-z]/g, '');
      const num = m[2];

      for (const ddc of ddcDisplays) {
        const ddcDrm = ddc.drmConnector.toLowerCase();
        if (ddcDrm.includes(type)) {
          const endsWithNum = new RegExp(`[\\-\\s_]${num}$`);
          if (endsWithNum.test(ddcDrm) || ddcDrm.endsWith(num)) {
            return ddc;
          }
        }
      }
    }

    if (ddcDisplays.length === 1) {
      return ddcDisplays[0];
    }

    return null;
  }

  _setupSoftwareBrightnessFallback() {
    if (!this._externalConnectors || this._externalConnectors.length === 0) {
      this._setBrightnessItemEnabled(false);
      if (this._statusItem) {
        this._statusItem.label.text = 'No external monitors';
      }
      return;
    }

    const connector = this._externalConnectors[0];
    const brightness = this._softwareBrightness.get(connector) ?? 1.0;

    this._backlightState = {
      connector,
      value: brightness,
      isHardware: false,
    };

    this._isUpdatingBrightness = true;
    try {
      this._setBrightnessSliderValue(brightness);
    } finally {
      this._isUpdatingBrightness = false;
    }
    this._setBrightnessItemEnabled(true);
    if (this._statusItem) {
      this._statusItem.label.text = 'Control: Software (Overlay)';
    }
    this._updateOverlays(this._logicalMonitors);
  }

  _clearOverlays() {
    if (this._overlays) {
      for (const overlay of this._overlays.values()) {
        if (overlay) {
          overlay.destroy();
        }
      }
      this._overlays.clear();
    }
  }

  _getMonitorGeometryByConnector(connector, logicalMonitors) {
    if (!Array.isArray(logicalMonitors)) {
      return null;
    }

    for (const lm of logicalMonitors) {
      const [x, y, scale, transform, isPrimary, connectors] = lm;
      if (!Array.isArray(connectors)) {
        continue;
      }
      for (const connInfo of connectors) {
        const connName = Array.isArray(connInfo) ? connInfo[0] : connInfo;
        if (connName === connector) {
          for (const monitor of Main.layoutManager.monitors) {
            if (monitor.x === x && monitor.y === y) {
              return monitor;
            }
          }
        }
      }
    }
    return null;
  }

  _updateOverlays(logicalMonitors) {
    if (!this._overlays) {
      return;
    }

    if (!this._externalConnectors || this._externalConnectors.length === 0) {
      this._clearOverlays();
      return;
    }

    const activeConnectors = new Set(this._externalConnectors);

    for (const [connector, overlay] of this._overlays.entries()) {
      if (!activeConnectors.has(connector)) {
        overlay.destroy();
        this._overlays.delete(connector);
      }
    }

    for (const connector of this._externalConnectors) {
      const isHardware = this._backlightState &&
                         this._backlightState.connector === connector &&
                         this._backlightState.isHardware;

      if (isHardware) {
        const overlay = this._overlays.get(connector);
        if (overlay) {
          overlay.destroy();
          this._overlays.delete(connector);
        }
        continue;
      }

      const geom = this._getMonitorGeometryByConnector(connector, logicalMonitors);
      if (!geom) {
        continue;
      }

      let overlay = this._overlays.get(connector);
      if (!overlay) {
        overlay = new St.Widget({
          name: `displayctl-overlay-${connector}`,
          style: 'background-color: black;',
          reactive: false,
        });
        Main.uiGroup.add_child(overlay);
        this._overlays.set(connector, overlay);
      }

      overlay.set_position(geom.x, geom.y);
      overlay.set_size(geom.width, geom.height);

      const brightness = this._softwareBrightness.get(connector) ?? 1.0;
      this._currentSoftwareBrightness.set(connector, brightness);
      overlay.opacity = Math.round((1 - brightness) * 255);
      overlay.visible = brightness < 1.0;
    }
  }

  _setBrightnessItemEnabled(enabled) {
    if (!this._brightnessItem) {
      return;
    }

    this._brightnessItem.setSensitive(enabled);
    if (!enabled) {
      this._backlightState = null;
    }
  }

  _setBrightnessSliderValue(value) {
    if (!this._brightnessItem) {
      return;
    }

    if (typeof this._brightnessItem.setValue === 'function') {
      this._brightnessItem.setValue(value);
      return;
    }

    if (this._brightnessItem.slider) {
      this._brightnessItem.slider.value = value;
      return;
    }

    if (this._brightnessItem._slider) {
      this._brightnessItem._slider.value = value;
    }
  }

  _getPropertyValue(properties, key) {
    if (properties instanceof GLib.Variant) {
      properties = properties.deep_unpack();
    }
    if (!properties || !(key in properties)) {
      return undefined;
    }

    const value = properties[key];
    if (value instanceof GLib.Variant) {
      return value.deep_unpack();
    }

    return value;
  }

  _isBuiltinConnector(connector) {
    if (!connector) {
      return false;
    }

    const builtInPrefixes = ['eDP', 'LVDS', 'DSI'];
    return builtInPrefixes.some((prefix) => connector.startsWith(prefix));
  }
}
