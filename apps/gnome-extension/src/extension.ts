import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { DdcutilController } from './services/ddcutil.js';
import { OverlayManager } from './ui/overlay.js';
import { DisplayConfigClient } from './services/display-config.js';
import { IndicatorMenu } from './ui/indicator-menu.js';
import { MonitorInfo, BacklightState } from '@displayctl/core';

type GLibVariant = InstanceType<typeof GLib.Variant>;

export default class DisplayctlExtension extends Extension {
  private indicatorMenu: IndicatorMenu | null = null;
  private ddcController = new DdcutilController();
  private overlayManager = new OverlayManager();
  private displayConfig: DisplayConfigClient | null = null;

  private _monitors: any[] = [];
  private _logicalMonitors: any[] = [];
  private _externalConnectors: string[] = [];
  private _softwareBrightness = new Map<string, number>();
  private _backlightState: BacklightState | null = null;
  private _isUpdatingBrightness = false;

  private _monitorsChangedEmitter: any = null;
  private _monitorsChangedId: number | null = null;
  private _startupTimeoutId: number | null = null;

  enable() {
    this._cleanOrphanMenus();

    const icon = this._createIndicatorIcon();
    this.indicatorMenu = new IndicatorMenu(icon, {
      onBrightnessChanged: (value) => { void this._onBrightnessSliderChanged(value); },
      onPrimaryMonitorSelected: (connector) => { void this._applyPrimaryMonitor(connector); },
      onRefreshRateSelected: (refreshRate) => { void this._applyRefreshRate(refreshRate); },
      onDisplayModeSelected: (mode) => { void this._applyDisplayMode(mode); },
      onMenuOpen: () => { void this._refreshState(false); },
    });
    this.indicatorMenu.attachToPanel();

    this.displayConfig = new DisplayConfigClient();
    this.displayConfig.createProxy(() => {
      void this._refreshState(true);

      // Defer heavy hardware detection to allow login/startup to settle
      this._startupTimeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        5,
        () => {
          void this._refreshState(false);
          this._startupTimeoutId = null;
          return GLib.SOURCE_REMOVE;
        }
      );
    });

    this._monitorsChangedEmitter = Main.layoutManager;
    this._monitorsChangedId = this._monitorsChangedEmitter.connect('monitors-changed',
      () => { void this._refreshState(false); }
    );
  }

  private _cleanOrphanMenus() {
    try {
      const children = Main.uiGroup.get_children();
      if (!Array.isArray(children)) return;

      children.forEach((child: any) => {
        if (!child) return;

        // Clean up identified popup menus
        if (child.name === 'displayctl-refresh-rate-popup') {
          try {
            console.log('[displayctl] Destroying identified refresh rate popup');
            child.destroy();
          } catch (e) {}
        }
      });
    } catch (e) {
      console.error('[displayctl] Error during _cleanOrphanMenus execution:', e);
    }
  }

  disable() {
    if (this._startupTimeoutId) {
      try {
        GLib.Source.remove(this._startupTimeoutId);
      } catch (err) {
        console.error('[displayctl] Error removing startup timeout:', err);
      }
      this._startupTimeoutId = null;
    }

    if (this._monitorsChangedId && this._monitorsChangedEmitter) {
      try {
        this._monitorsChangedEmitter.disconnect(this._monitorsChangedId);
      } catch (err) {
        console.error('[displayctl] Error disconnecting monitors-changed listener:', err);
      }
      this._monitorsChangedId = null;
      this._monitorsChangedEmitter = null;
    }

    if (this.displayConfig) {
      try {
        this.displayConfig.destroy();
      } catch (err) {
        console.error('[displayctl] Error destroying displayConfig:', err);
      }
      this.displayConfig = null;
    }

    if (this.indicatorMenu) {
      try {
        this.indicatorMenu.destroy();
      } catch (err) {
        console.error('[displayctl] Error destroying indicatorMenu:', err);
      }
      this.indicatorMenu = null;
    }

    try {
      this.ddcController.clear();
    } catch (err) {
      console.error('[displayctl] Error clearing ddcController:', err);
    }

    try {
      this.overlayManager.clearOverlays();
    } catch (err) {
      console.error('[displayctl] Error clearing overlays:', err);
    }

    this._softwareBrightness.clear();
    this._monitors = [];
    this._logicalMonitors = [];
    this._externalConnectors = [];
    this._backlightState = null;
    this._isUpdatingBrightness = false;
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

    return null;
  }

  private async _refreshState(skipDdc = false) {
    if (!this.displayConfig || !this.indicatorMenu) return;

    if (!skipDdc && this._startupTimeoutId) {
      try {
        GLib.Source.remove(this._startupTimeoutId);
      } catch (e) {}
      this._startupTimeoutId = null;
    }

    try {
      const state = await this.displayConfig.getCurrentState();
      if (!state) {
        this.indicatorMenu.setVisible(false);
        return;
      }

      this._monitors = state.monitors || [];
      this._logicalMonitors = state.logicalMonitors || [];
      this._externalConnectors = this._getExternalConnectors(this._monitors);
      const hasExternal = this._externalConnectors.length > 0;
      this.indicatorMenu.setVisible(hasExternal);

      const entries = this.displayConfig.getMonitorEntries(this._monitors);
      const primary = this.displayConfig.getPrimaryConnector(this._logicalMonitors, Main.layoutManager.primaryMonitor);
      const canApply = this.displayConfig.canApplyMonitorsConfig();
      this.indicatorMenu.updatePrimaryMonitorMenu(entries, primary, canApply);
      this._updateRefreshRateMenu(canApply);

      const currentMode = this.displayConfig.getCurrentDisplayMode(state);
      this.indicatorMenu.updateDisplayLayoutMenu(currentMode, canApply);

      if (skipDdc) {
        await this._refreshBrightness(true);
        return;
      }

      if (this.ddcController.isBusy()) {
        return;
      }

      if (hasExternal) {
        await this.ddcController.detectDdcBuses(this._externalConnectors);
      }

      await this._refreshBrightness(false);
    } catch (err: any) {
      console.error('[displayctl] Error inside _refreshState:', err, err?.stack);
    }
  }

  private _getExternalConnectors(monitors: any[]): string[] {
    if (!Array.isArray(monitors)) return [];
    const connectors: string[] = [];
    for (const monitor of monitors) {
      const [monitorInfo, , properties] = monitor;
      const connector = Array.isArray(monitorInfo) ? monitorInfo[0] : null;
      if (!connector) continue;
      const isBuiltinProperty = this._getPropertyValue(properties, 'is-builtin');
      const isBuiltin = typeof isBuiltinProperty === 'boolean'
        ? isBuiltinProperty
        : this._isBuiltinConnector(connector);
      if (!isBuiltin) connectors.push(connector);
    }
    return connectors;
  }

  private async _refreshBrightness(skipDdc = false) {
    if (!this.indicatorMenu) return;
    if (this.ddcController.isBusy()) {
      return;
    }

    if (!this._externalConnectors || this._externalConnectors.length === 0) {
      this.indicatorMenu.setBrightnessEnabled(false);
      this.indicatorMenu.setBrightnessLabel(null);
      return;
    }

    const connector = this._externalConnectors[0];
    const entries = this.displayConfig ? this.displayConfig.getMonitorEntries(this._monitors) : [];
    const monitorName = entries.find((entry) => entry.connector === connector)?.name || 'Monitor externo';
    this.indicatorMenu.setBrightnessLabel(monitorName);

    const monitor: MonitorInfo = {
      id: connector,
      name: monitorName,
      isExternal: true,
    };

    if (!skipDdc && this.ddcController.isDdcutilAvailable()) {
      const hwState = await this.ddcController.getHardwareBrightness(monitor);
      if (hwState) {
        this._backlightState = hwState;
        this._isUpdatingBrightness = true;
        try {
          this.indicatorMenu.setBrightnessValue(hwState.value);
        } finally {
          this._isUpdatingBrightness = false;
        }
        this.indicatorMenu.setBrightnessEnabled(true);
        this.overlayManager.updateOverlays(this._externalConnectors, this._softwareBrightness, this._logicalMonitors, connector);
        return;
      }
    }

    const brightness = this._softwareBrightness.get(connector) ?? 1.0;
    this._backlightState = {
      connector,
      value: brightness,
      isHardware: false,
    } as BacklightState;
    this._isUpdatingBrightness = true;
    try { this.indicatorMenu.setBrightnessValue(brightness); } finally { this._isUpdatingBrightness = false; }
    this.indicatorMenu.setBrightnessEnabled(true);
    this.overlayManager.updateOverlays(this._externalConnectors, this._softwareBrightness, this._logicalMonitors, undefined);
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
      const connector = state.connector;
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

  private async _applyPrimaryMonitor(connector: string) {
    if (!this.displayConfig) return;
    const ok = await this.displayConfig.setPrimaryMonitor(connector);
    if (ok) {
      void this._refreshState();
    }
  }

  private async _applyDisplayMode(mode: string) {
    if (!this.displayConfig) return;
    const ok = await this.displayConfig.applyDisplayMode(mode);
    if (ok) {
      void this._refreshState();
    }
  }

  private async _applyRefreshRate(refreshRate: number) {
    try {
      if (!this.displayConfig || this._externalConnectors.length === 0) return;
      const connector = this._externalConnectors[0];
      const ok = await this.displayConfig.applyMonitorRefreshRate(connector, refreshRate);
      if (ok) {
        void this._refreshState();
      }
    } catch (err: any) {
      console.error('[displayctl] Error inside _applyRefreshRate:', err, err?.stack);
    }
  }

  private _updateRefreshRateMenu(canApply: boolean) {
    if (!this.indicatorMenu || !this.displayConfig || this._externalConnectors.length === 0) {
      if (this.indicatorMenu) {
        this.indicatorMenu.updateRefreshRateMenu(null, [], false);
      }
      return;
    }

    const connector = this._externalConnectors[0];
    const options = this.displayConfig.getRefreshRateOptions(this._monitors, connector);
    const currentLabel = options.find((option) => option.isCurrent)?.label ?? null;
    this.indicatorMenu.updateRefreshRateMenu(currentLabel, options, canApply);
  }

  private _getPropertyValue(properties: any, key: string): any {
    if (!properties) return undefined;
    if (properties instanceof GLib.Variant) {
      properties = properties.deep_unpack();
    }
    if (!(key in properties)) return undefined;

    const value = properties[key];
    if (value instanceof GLib.Variant) {
      return value.deep_unpack();
    }
    return value;
  }

  private _isBuiltinConnector(connector: string): boolean {
    if (!connector) return false;
    const builtInPrefixes = ['eDP', 'LVDS', 'DSI'];
    return builtInPrefixes.some((p) => connector.startsWith(p));
  }
}