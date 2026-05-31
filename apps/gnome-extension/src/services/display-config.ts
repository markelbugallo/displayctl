import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

type GLibVariant = InstanceType<typeof GLib.Variant>;

export type MonitorModeEntry = {
  id: string;
  refreshRate: number;
  isCurrent: boolean;
  isPreferred: boolean;
};

export type RefreshRateOption = {
  refreshRate: number;
  label: string;
  isCurrent: boolean;
};

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

  async setPrimaryMonitor(connector: string): Promise<boolean> {
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
    return this.applyMonitorConfiguration(state, modeByConnector, connector, new Map());
  }

  async applyPrimaryMonitor(connector: string): Promise<boolean> {
    return this.setPrimaryMonitor(connector);
  }

  async applyMonitorRefreshRate(connector: string, refreshRate: number): Promise<boolean> {
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

    const targetModeId = this.getModeIdForRefreshRate(this.getModesForConnector(state.monitors, connector), refreshRate);
    if (!targetModeId) {
      console.error(`No mode found for connector ${connector} at ${refreshRate} Hz.`);
      return false;
    }

    const modeByConnector = this.getCurrentModeByConnector(state.monitors);
    return this.applyMonitorConfiguration(state, modeByConnector, null, new Map([[connector, targetModeId]]));
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

  getRefreshRateOptions(monitors: any[], connector: string): RefreshRateOption[] {
    const rawModes = this.getModesForConnector(monitors, connector);
    if (rawModes.length === 0) {
      return [];
    }

    const currentModeId = this.getModeIdForMonitor(rawModes);
    const modes = this.getMonitorModeEntries(rawModes);
    const groupedModes = new Map<number, MonitorModeEntry[]>();

    for (const mode of modes) {
      const normalizedRefreshRate = this.normalizeRefreshRate(mode.refreshRate);
      const existing = groupedModes.get(normalizedRefreshRate);
      if (existing) {
        existing.push(mode);
      } else {
        groupedModes.set(normalizedRefreshRate, [mode]);
      }
    }

    return Array.from(groupedModes.entries())
      .sort(([left], [right]) => left - right)
      .map(([refreshRate, options]) => {
        const selectedMode =
          options.find((option) => option.id === currentModeId) ||
          options.find((option) => option.isCurrent) ||
          options.find((option) => option.isPreferred) ||
          options[0];

        return {
          refreshRate,
          label: `${refreshRate} Hz`,
          isCurrent: selectedMode?.id === currentModeId,
        };
      });
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

  private getModesForConnector(monitors: any[], connector: string): any[] {
    const monitor = (monitors || []).find((entry: any) => {
      const [monitorInfo] = entry || [];
      return Array.isArray(monitorInfo) && monitorInfo[0] === connector;
    });

    if (!monitor) {
      return [];
    }

    const [, modes] = monitor;
    return modes || [];
  }

  private getMonitorModeEntries(modes: any[]): MonitorModeEntry[] {
    return (modes || [])
      .map((mode: any) => {
        const modeId = mode?.[0];
        const refreshRate = Number(mode?.[3]);
        const properties = mode?.[6];

        if (!modeId || !Number.isFinite(refreshRate)) {
          return null;
        }

        return {
          id: String(modeId),
          refreshRate,
          isCurrent: this.getPropertyValue(properties, 'is-current') === true,
          isPreferred: this.getPropertyValue(properties, 'is-preferred') === true,
        } satisfies MonitorModeEntry;
      })
      .filter((mode: MonitorModeEntry | null): mode is MonitorModeEntry => mode !== null);
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

  private getModeIdForRefreshRate(modes: any[], refreshRate: number): string | null {
    const normalizedRefreshRate = this.normalizeRefreshRate(refreshRate);
    const availableModes = this.getMonitorModeEntries(modes);
    if (availableModes.length === 0) {
      return null;
    }

    const matchingModes = availableModes.filter(
      (mode) => this.normalizeRefreshRate(mode.refreshRate) === normalizedRefreshRate
    );
    if (matchingModes.length === 0) {
      return null;
    }

    const currentModeId = this.getModeIdForMonitor(modes);
    const selectedMode =
      matchingModes.find((mode) => mode.id === currentModeId) ||
      matchingModes.find((mode) => mode.isCurrent) ||
      matchingModes.find((mode) => mode.isPreferred) ||
      matchingModes[0];

    return selectedMode?.id || null;
  }

  private normalizeRefreshRate(refreshRate: number): number {
    return Math.round(refreshRate);
  }

  private async applyMonitorConfiguration(
    state: DisplayConfigState,
    modeByConnector: Map<string, string>,
    primaryConnector: string | null,
    overrides: Map<string, string>
  ): Promise<boolean> {
    const updatedLogicalMonitors: any[] = [];
    let foundTarget = overrides.size === 0 && primaryConnector === null;

    for (const logicalMonitor of state.logicalMonitors || []) {
      const [x, y, scale, transform, isPrimary, monitors] = logicalMonitor;
      const updatedMonitors: any[] = [];

      for (const monitor of monitors || []) {
        const { connectorName, monitorProperties } = this.getConnectorFromMonitor(monitor);
        if (!connectorName) {
          console.error('Could not determine connector name from monitor:', monitor);
          return false;
        }

        const modeId = overrides.get(connectorName) || modeByConnector.get(connectorName);
        if (!modeId) {
          console.error(`No available mode for connector ${connectorName}.`);
          return false;
        }

        if (overrides.has(connectorName)) {
          foundTarget = true;
        }

        if (primaryConnector && connectorName === primaryConnector) {
          foundTarget = true;
        }

        updatedMonitors.push([connectorName, modeId, monitorProperties]);
      }

      const newIsPrimary = primaryConnector
        ? this.logicalMonitorContainsConnector(monitors, primaryConnector)
        : isPrimary;

      updatedLogicalMonitors.push([x, y, scale, transform, newIsPrimary, updatedMonitors]);
    }

    if (!foundTarget) {
      if (primaryConnector) {
        console.error(`Connector ${primaryConnector} not found.`);
      } else {
        console.error('No matching monitor mode override was applied.');
      }
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
      this.proxy!.call(
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
            console.error('Failed to apply monitor configuration:', error);
            resolve(false);
          }
        }
      );
    });
  }

  private getConnectorFromMonitor(monitor: any): { connectorName: string; monitorProperties: any } {
    let connectorName = '';
    let monitorProperties: any = {};

    if (Array.isArray(monitor)) {
      if (Array.isArray(monitor[0])) {
        connectorName = monitor[0][0];
      } else {
        connectorName = monitor[0];
      }
    } else if (typeof monitor === 'string') {
      connectorName = monitor;
    }

    return { connectorName, monitorProperties };
  }

  private logicalMonitorContainsConnector(monitors: any[], connector: string): boolean {
    return (monitors || []).some((monitor: any) => {
      const { connectorName } = this.getConnectorFromMonitor(monitor);
      return connectorName === connector;
    });
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