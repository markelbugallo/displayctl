import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

type GLibVariant = InstanceType<typeof GLib.Variant>;

export type MonitorMenuEntry = {
  connector: string;
  name: string;
};

export type DisplayConfigState = {
  serial: number;
  monitors: any[];
  logicalMonitors: any[];
  properties: any;
};

export class DisplayConfigClient {
  private proxy: any = null;
  private cancellable: any = null;

  createProxy(onReady?: () => void) {
    if (this.cancellable) {
      this.cancellable.cancel();
    }

    this.cancellable = new Gio.Cancellable();
    Gio.DBusProxy.new_for_bus(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      'org.gnome.Mutter.DisplayConfig',
      '/org/gnome/Mutter/DisplayConfig',
      'org.gnome.Mutter.DisplayConfig',
      this.cancellable,
      (source: any, result: any) => {
        try {
          this.proxy = Gio.DBusProxy.new_for_bus_finish(result);
        } catch (error: any) {
          if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            return;
          }
          console.error('Failed to create DisplayConfig proxy', error);
          return;
        }

        onReady?.();
      }
    );
  }

  destroy() {
    if (this.cancellable) {
      this.cancellable.cancel();
      this.cancellable = null;
    }
    this.proxy = null;
  }

  isReady(): boolean {
    return !!this.proxy;
  }

  canApplyMonitorsConfig(): boolean {
    if (!this.proxy) {
      return false;
    }

    const canApplyVariant = this.proxy.get_cached_property('CanApplyMonitorsConfig');
    if (!canApplyVariant) {
      return true;
    }

    return canApplyVariant.deep_unpack();
  }

  async getCurrentState(): Promise<DisplayConfigState | null> {
    if (!this.proxy) {
      return null;
    }

    return new Promise((resolve) => {
      this.proxy.call(
        'GetCurrentState',
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (proxy: any, result: any) => {
          try {
            const response = proxy.call_finish(result);
            const [serial, monitors, logicalMonitors, properties] = response.deep_unpack();
            resolve({
              serial,
              monitors: monitors || [],
              logicalMonitors: logicalMonitors || [],
              properties,
            });
          } catch (error) {
            console.error('Failed to read monitor state', error);
            resolve(null);
          }
        }
      );
    });
  }

  async applyPrimaryMonitor(connector: string): Promise<boolean> {
    if (!this.proxy) {
      return false;
    }

    if (!this.canApplyMonitorsConfig()) {
      console.error('Cannot apply monitor configuration changes.');
      return false;
    }

    const state = await this.getCurrentState();
    if (!state) {
      return false;
    }

    const modeByConnector = this.getCurrentModeByConnector(state.monitors);
    const updatedLogicalMonitors: any[] = [];
    let foundConnector = false;

    for (const logicalMonitor of state.logicalMonitors || []) {
      const [x, y, scale, transform, isPrimary, monitors] = logicalMonitor;
      const updatedMonitors: any[] = [];

      for (const monitor of monitors) {
        let connectorName = '';
        let monitorProperties: any = {};

        if (Array.isArray(monitor)) {
          if (Array.isArray(monitor[0])) {
            connectorName = monitor[0][0];
            monitorProperties = monitor[2] || {};
          } else {
            connectorName = monitor[0];
            monitorProperties = {};
          }
        } else if (typeof monitor === 'string') {
          connectorName = monitor;
          monitorProperties = {};
        }

        if (!connectorName) {
          console.error('Could not determine connector name from monitor:', monitor);
          return false;
        }

        const currentModeId = modeByConnector.get(connectorName);
        if (!currentModeId) {
          console.error(`No available mode for connector ${connectorName}.`);
          return false;
        }

        updatedMonitors.push([connectorName, currentModeId, monitorProperties]);
        if (connectorName === connector) {
          foundConnector = true;
        }
      }

      const newIsPrimary = monitors.some((m: any) => {
        let connName = '';
        if (Array.isArray(m)) {
          if (Array.isArray(m[0])) {
            connName = m[0][0];
          } else {
            connName = m[0];
          }
        } else if (typeof m === 'string') {
          connName = m;
        }
        return connName === connector;
      });

      updatedLogicalMonitors.push([x, y, scale, transform, newIsPrimary, updatedMonitors]);
    }

    if (!foundConnector) {
      console.error(`Connector ${connector} not found.`);
      return false;
    }

    const configProperties = this.getApplyConfigProperties(state.properties);
    const params = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [
      state.serial,
      3,
      updatedLogicalMonitors,
      configProperties,
    ]);

    return new Promise((resolve) => {
      this.proxy.call(
        'ApplyMonitorsConfig',
        params,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (applyProxy: any, applyResult: any) => {
          try {
            applyProxy.call_finish(applyResult);
            resolve(true);
          } catch (error) {
            console.error('Failed to set primary monitor:', error);
            resolve(false);
          }
        }
      );
    });
  }

  getExternalConnectors(monitors: any[]): string[] {
    const result: string[] = [];
    for (const monitor of monitors || []) {
      const [monitorInfo, , properties] = monitor;
      const connector = Array.isArray(monitorInfo) ? monitorInfo[0] : null;
      if (!connector) {
        continue;
      }
      const isBuiltinProperty = this.getPropertyValue(properties, 'is-builtin');
      const isBuiltin = typeof isBuiltinProperty === 'boolean'
        ? isBuiltinProperty
        : this.isBuiltinConnector(connector);
      if (!isBuiltin) {
        result.push(connector);
      }
    }
    return result;
  }

  getMonitorEntries(monitors: any[]): MonitorMenuEntry[] {
    const entries = (monitors || []).map((monitor: any) => {
      const [info, , properties] = monitor;
      const connector = Array.isArray(info) ? info[0] : 'unknown';
      return {
        connector,
        name: this.getMonitorDisplayName(info, properties),
      };
    });

    const nameCounts = new Map<string, number>();
    for (const entry of entries) {
      nameCounts.set(entry.name, (nameCounts.get(entry.name) || 0) + 1);
    }

    for (const entry of entries) {
      if (nameCounts.get(entry.name)! > 1) {
        entry.name = `${entry.name} (${entry.connector})`;
      }
    }

    return entries;
  }

  getPrimaryConnector(logicalMonitors: any[], primaryMonitor?: any): string | null {
    if (primaryMonitor && typeof primaryMonitor.x === 'number' && typeof primaryMonitor.y === 'number') {
      for (const logicalMonitor of logicalMonitors || []) {
        const [x, y, , , , monitors] = logicalMonitor;
        if (x === primaryMonitor.x && y === primaryMonitor.y && monitors && monitors.length > 0) {
          const firstMonitor = monitors[0];
          if (Array.isArray(firstMonitor)) {
            if (Array.isArray(firstMonitor[0])) {
              return firstMonitor[0][0];
            }
            return firstMonitor[0];
          } else if (typeof firstMonitor === 'string') {
            return firstMonitor;
          }
        }
      }
    }

    for (const logicalMonitor of logicalMonitors || []) {
      const [, , , , isPrimary, monitors] = logicalMonitor;
      if (isPrimary && monitors && monitors.length > 0) {
        const firstMonitor = monitors[0];
        if (Array.isArray(firstMonitor)) {
          if (Array.isArray(firstMonitor[0])) {
            return firstMonitor[0][0];
          }
          return firstMonitor[0];
        } else if (typeof firstMonitor === 'string') {
          return firstMonitor;
        }
      }
    }
    return null;
  }

  private getMonitorDisplayName(monitorInfo: any, properties: any): string {
    const displayName = this.getPropertyValue(properties, 'display-name');
    if (displayName) {
      return displayName;
    }
    const [connector, vendor, product, serial] = monitorInfo || [];
    const displayNameParts = [vendor, product, serial].filter((item) => item && item !== 'unknown');
    return displayNameParts.length > 0 ? displayNameParts.join(' ') : (connector || 'Unknown');
  }

  private getCurrentModeByConnector(monitors: any[]): Map<string, string> {
    const modeByConnector = new Map<string, string>();
    for (const monitor of monitors || []) {
      const [monitorInfo, modes, properties] = monitor;
      const connector = Array.isArray(monitorInfo) ? monitorInfo[0] : null;
      if (!connector) {
        continue;
      }
      const currentMode = this.getModeIdForMonitor(modes);
      if (currentMode) {
        modeByConnector.set(connector, currentMode);
      }
    }
    return modeByConnector;
  }

  private getModeIdForMonitor(modes: any[]): string | null {
    for (const mode of modes || []) {
      const modeId = mode[0];
      const properties = mode[6];
      const isCurrent = this.getPropertyValue(properties, 'is-current') === true;
      if (isCurrent) {
        return modeId;
      }
    }
    for (const mode of modes || []) {
      const modeId = mode[0];
      const properties = mode[6];
      const isPreferred = this.getPropertyValue(properties, 'is-preferred') === true;
      if (isPreferred) {
        return modeId;
      }
    }
    if (modes && modes.length > 0) {
      return modes[0][0];
    }
    return null;
  }

  private getApplyConfigProperties(properties: any): Record<string, GLibVariant> {
    const result: Record<string, GLibVariant> = {};
    const layoutMode = this.getPropertyValue(properties, 'layout-mode');
    if (layoutMode !== null && layoutMode !== undefined) {
      result['layout-mode'] = new GLib.Variant('u', layoutMode);
    }
    return result;
  }

  private getPropertyValue(properties: any, key: string): any {
    if (!properties) {
      return null;
    }

    let dict = properties;
    if (properties instanceof GLib.Variant) {
      dict = properties.deep_unpack();
    }

    if (dict && dict[key] !== undefined) {
      const val = dict[key];
      if (val instanceof GLib.Variant) {
        return val.deep_unpack();
      }
      return val;
    }

    return null;
  }

  private isBuiltinConnector(connector: string): boolean {
    return connector.startsWith('eDP') || connector.startsWith('LVDS') || connector.startsWith('DSI');
  }
}