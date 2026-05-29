import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { DdcutilController } from './ddcutil.js';
import { OverlayManager } from './overlay.js';
import { MonitorInfo, BacklightState } from '@displayctl/core';

export default class DisplayctlExtension extends Extension {
  private _indicator: any = null;
  private _brightnessItem: any = null;
  private _brightnessIcon: any = null;
  private _backlightState: BacklightState | null = null;
  private _externalConnectors: string[] = [];
  private _softwareBrightness = new Map<string, number>();
  private _logicalMonitors: any[] = [];
  private _isUpdatingBrightness = false;
  
  private _displayConfigProxy: any = null;
  private _displayConfigCancellable: any = null;
  private _monitorsChangedEmitter: any = null;
  private _monitorsChangedId: number | null = null;
  private _menuOpenId: number | null = null;

  private ddcController = new DdcutilController();
  private overlayManager = new OverlayManager();

  enable() {
    this._indicator = new PanelMenu.Button(0.0, 'Displayctl');

    const icon = this._createIndicatorIcon();
    this._indicator.add_child(icon);

    this._brightnessItem = null;
    this._brightnessIcon = null;
    this._backlightState = null;
    this._externalConnectors = [];
    this._softwareBrightness = new Map();
    this._logicalMonitors = [];
    this._isUpdatingBrightness = false;

    this._buildMenu();

    this._indicator.visible = false;
    this._displayConfigProxy = null;
    this._displayConfigCancellable = null;
    this._createDisplayConfigProxy();
    
    this._monitorsChangedEmitter = Main.layoutManager;
    this._monitorsChangedId = this._monitorsChangedEmitter.connect(
      'monitors-changed',
      () => this._updateIndicatorVisibility()
    );
    this._menuOpenId = this._indicator.menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
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

    this.overlayManager.clearOverlays();
    this._softwareBrightness.clear();
    this._logicalMonitors = [];

    this._brightnessItem = null;
    this._brightnessIcon = null;

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }

  private _getIconFile(): any | null {
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

    let repoRoot: any | null = this.dir;
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

  private _createIndicatorIcon(): any {
    const iconFile = this._getIconFile();
    if (iconFile) {
      return new St.Icon({
        gicon: new Gio.FileIcon({ file: iconFile }),
        icon_size: 16,
        style_class: 'system-status-icon',
      });
    }

    return new St.Icon({
      icon_name: 'video-display-symbolic',
      icon_size: 16,
      style_class: 'system-status-icon',
    });
  }

  private _createDisplayConfigProxy() {
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
      (source: any, result: any) => {
        if (!this._indicator) {
          return;
        }

        try {
          this._displayConfigProxy = Gio.DBusProxy.new_for_bus_finish(result);
        } catch (error: any) {
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

  private _updateIndicatorVisibility() {
    if (!this._displayConfigProxy || !this._indicator) {
      return;
    }

    this._displayConfigProxy.call(
      'GetCurrentState',
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      async (proxy: any, result: any) => {
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
        
        if (hasExternalMonitor) {
          await this.ddcController.detectDdcBuses(this._externalConnectors);
        }

        this._refreshBrightness();
      }
    );
  }

  private _setIndicatorVisibility(visible: boolean) {
    if (this._indicator) {
      this._indicator.visible = visible;
      this._indicator.reactive = visible;
      this._indicator.can_focus = visible;
    }
  }

  private _getExternalConnectors(monitors: any[]): string[] {
    if (!Array.isArray(monitors)) {
      return [];
    }

    const connectors: string[] = [];
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

  private _buildMenu() {
    if (!this._indicator || this._brightnessItem) {
      return;
    }

    const hasPopupSlider = typeof (PopupMenu as any).PopupSliderMenuItem === 'function';
    this._brightnessItem = hasPopupSlider
      ? new (PopupMenu as any).PopupSliderMenuItem(0)
      : new PopupMenu.PopupBaseMenuItem({ activate: false });
      
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
      this._brightnessItem.connect('value-changed', (item: any, value: number) => {
        this._onBrightnessSliderChanged(value);
      });
    } else {
      const slider = new Slider.Slider(0);
      this._brightnessItem.slider = slider;
      this._brightnessItem._slider = slider;
      const baseSetSensitive = typeof this._brightnessItem.setSensitive === 'function'
        ? this._brightnessItem.setSensitive.bind(this._brightnessItem)
        : null;
        
      this._brightnessItem.setSensitive = (enabled: boolean) => {
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

  private async _onBrightnessSliderChanged(value: number) {
    if (this._isUpdatingBrightness || !this._backlightState) {
      return;
    }

    const state = this._backlightState;
    const clampedValue = Math.max(0, Math.min(1, value));

    if (state.isHardware) {
      const monitor: MonitorInfo = {
        id: state.connector,
        name: 'External DDC Monitor',
        isExternal: true,
        bus: state.bus,
      };
      this._backlightState.value = clampedValue;
      await this.ddcController.setHardwareBrightness(monitor, state, clampedValue);
    } else {
      const { connector } = state;
      const targetBrightness = Math.max(0.1, clampedValue);
      this._softwareBrightness.set(connector, targetBrightness);
      this._backlightState.value = targetBrightness;

      this.overlayManager.updateOverlays(
        this._externalConnectors,
        this._softwareBrightness,
        this._logicalMonitors,
        undefined
      );
    }
  }

  private async _refreshBrightness() {
    if (!this._brightnessItem) {
      return;
    }

    if (!this._externalConnectors || this._externalConnectors.length === 0) {
      this._setBrightnessItemEnabled(false);
      return;
    }

    const connector = this._externalConnectors[0];
    const monitor: MonitorInfo = {
      id: connector,
      name: 'External DDC Monitor',
      isExternal: true,
    };

    if (this.ddcController.isDdcutilAvailable()) {
      const hwState = await this.ddcController.getHardwareBrightness(monitor);
      if (hwState) {
        this._backlightState = hwState;
        this._isUpdatingBrightness = true;
        try {
          this._setBrightnessSliderValue(hwState.value);
        } finally {
          this._isUpdatingBrightness = false;
        }
        this._setBrightnessItemEnabled(true);
        this.overlayManager.updateOverlays(
          this._externalConnectors,
          this._softwareBrightness,
          this._logicalMonitors,
          connector // Exclude hardware monitor from overlay
        );
        return;
      }
    }

    this._setupSoftwareBrightnessFallback();
  }

  private _setupSoftwareBrightnessFallback() {
    if (!this._externalConnectors || this._externalConnectors.length === 0) {
      this._setBrightnessItemEnabled(false);
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
    this.overlayManager.updateOverlays(
      this._externalConnectors,
      this._softwareBrightness,
      this._logicalMonitors,
      undefined // overlay on all external monitors
    );
  }

  private _setBrightnessItemEnabled(enabled: boolean) {
    if (!this._brightnessItem) {
      return;
    }

    this._brightnessItem.setSensitive(enabled);
    if (!enabled) {
      this._backlightState = null;
    }
  }

  private _setBrightnessSliderValue(value: number) {
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

  private _getPropertyValue(properties: any, key: string): any {
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

  private _isBuiltinConnector(connector: string): boolean {
    if (!connector) {
      return false;
    }

    const builtInPrefixes = ['eDP', 'LVDS', 'DSI'];
    return builtInPrefixes.some((prefix) => connector.startsWith(prefix));
  }
}
