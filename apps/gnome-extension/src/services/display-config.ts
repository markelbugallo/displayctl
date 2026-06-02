import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

type GLibVariant = InstanceType<typeof GLib.Variant>;

export type MonitorModeEntry = {
  id: string;
  refreshRate: number;
  isCurrent: boolean;
  isPreferred: boolean;
  width: number;
  height: number;
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

    const rawModes = this.getModesForConnector(state.monitors, connector);
    const currentMode = rawModes.find((m) => {
      const properties = m[6];
      return this.getPropertyValue(properties, 'is-current') === true;
    }) || rawModes[0];

    if (!currentMode) {
      console.error(`No current mode found for connector ${connector}.`);
      return false;
    }

    const currentWidth = Number(currentMode[1]);
    const currentHeight = Number(currentMode[2]);

    const targetModeId = this.getModeIdForRefreshRateAndResolution(
      rawModes,
      refreshRate,
      currentWidth,
      currentHeight
    );
    if (!targetModeId) {
      console.error(`No mode found for connector ${connector} at ${refreshRate} Hz with resolution ${currentWidth}x${currentHeight}.`);
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

    const currentMode = rawModes.find((m) => {
      const properties = m[6];
      return this.getPropertyValue(properties, 'is-current') === true;
    }) || rawModes[0];

    const currentWidth = currentMode ? Number(currentMode[1]) : 0;
    const currentHeight = currentMode ? Number(currentMode[2]) : 0;

    const currentModeId = this.getModeIdForMonitor(rawModes);
    const allModes = this.getMonitorModeEntries(rawModes);
    
    // Filter to only modes with the current resolution
    const modes = allModes.filter((m) => m.width === currentWidth && m.height === currentHeight);

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
        const width = Number(mode?.[1]);
        const height = Number(mode?.[2]);
        const refreshRate = Number(mode?.[3]);
        const properties = mode?.[6];

        if (!modeId || !Number.isFinite(refreshRate)) {
          return null;
        }

        return {
          id: String(modeId),
          width,
          height,
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

  private getModeIdForRefreshRateAndResolution(
    modes: any[],
    refreshRate: number,
    width: number,
    height: number
  ): string | null {
    const normalizedRefreshRate = this.normalizeRefreshRate(refreshRate);
    const availableModes = this.getMonitorModeEntries(modes);
    if (availableModes.length === 0) {
      return null;
    }

    const matchingModes = availableModes.filter(
      (mode) =>
        mode.width === width &&
        mode.height === height &&
        this.normalizeRefreshRate(mode.refreshRate) === normalizedRefreshRate
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

  getConnectors(state: DisplayConfigState) {
    let builtinConnector = '';
    let externalConnector = '';

    for (const monitor of state.monitors || []) {
      const [monitorInfo] = monitor;
      const connector = Array.isArray(monitorInfo) ? monitorInfo[0] : null;
      if (!connector) continue;

      if (this.isBuiltinConnector(connector)) {
        if (!builtinConnector) builtinConnector = connector;
      } else {
        if (!externalConnector) externalConnector = connector;
      }
    }

    // Fallbacks if we can't find one of them
    if (!builtinConnector && state.monitors.length > 0) {
      const [info] = state.monitors[0];
      builtinConnector = Array.isArray(info) ? info[0] : '';
    }
    if (!externalConnector && state.monitors.length > 1) {
      const [info] = state.monitors[1];
      externalConnector = Array.isArray(info) ? info[0] : '';
    }

    return { builtinConnector, externalConnector };
  }

  private getBestModeId(monitors: any[], connector: string): string | null {
    const rawModes = this.getModesForConnector(monitors, connector);
    if (rawModes.length === 0) {
      return null;
    }

    for (const mode of rawModes) {
      const properties = mode[6];
      if (this.getPropertyValue(properties, 'is-preferred') === true) {
        return mode[0];
      }
    }

    for (const mode of rawModes) {
      const properties = mode[6];
      if (this.getPropertyValue(properties, 'is-current') === true) {
        return mode[0];
      }
    }

    return rawModes[0][0];
  }

  private getConnectorsInLogicalMonitor(logicalMonitor: any): string[] {
    const [, , , , , monitors] = logicalMonitor;
    const result: string[] = [];
    for (const m of monitors || []) {
      const { connectorName } = this.getConnectorFromMonitor(m);
      if (connectorName) {
        result.push(connectorName);
      }
    }
    return result;
  }

  getCurrentDisplayMode(state: DisplayConfigState): string {
    const { builtinConnector, externalConnector } = this.getConnectors(state);
    if (!builtinConnector || !externalConnector) {
      return 'unknown';
    }

    let hasBuiltin = false;
    let hasExternal = false;
    let isMirrored = false;

    for (const logicalMonitor of state.logicalMonitors || []) {
      const connectors = this.getConnectorsInLogicalMonitor(logicalMonitor);
      const containsBuiltin = connectors.includes(builtinConnector);
      const containsExternal = connectors.includes(externalConnector);

      if (containsBuiltin && containsExternal) {
        isMirrored = true;
      }
      if (containsBuiltin) {
        hasBuiltin = true;
      }
      if (containsExternal) {
        hasExternal = true;
      }
    }

    if (isMirrored) {
      return 'mirror';
    }
    if (hasBuiltin && hasExternal) {
      return 'join';
    }
    if (hasBuiltin) {
      return 'builtin-only';
    }
    if (hasExternal) {
      return 'external-only';
    }
    return 'unknown';
  }

  async applyDisplayMode(mode: string): Promise<boolean> {
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

    const { builtinConnector, externalConnector } = this.getConnectors(state);
    if (!builtinConnector || !externalConnector) {
      console.error('Cannot apply display mode because either builtin or external connector is missing.');
      return false;
    }

    let updatedLogicalMonitors: any[] = [];

    // Find current scales to preserve them
    let builtinScale = 1.0;
    let externalScale = 1.0;
    let wasExternalPrimary = false;

    for (const lm of state.logicalMonitors || []) {
      const isPrimary = lm[4];
      if (this.logicalMonitorContainsConnector(lm[5], builtinConnector)) {
        builtinScale = lm[2];
      }
      if (this.logicalMonitorContainsConnector(lm[5], externalConnector)) {
        externalScale = lm[2];
        if (isPrimary) {
          wasExternalPrimary = true;
        }
      }
    }

    if (mode === 'builtin-only') {
      const builtinModeId = this.getBestModeId(state.monitors, builtinConnector);
      if (!builtinModeId) return false;

      updatedLogicalMonitors = [
        [
          0,
          0,
          builtinScale,
          0,
          true,
          [
            [builtinConnector, builtinModeId, {}]
          ]
        ]
      ];
    } else if (mode === 'external-only') {
      const externalModeId = this.getBestModeId(state.monitors, externalConnector);
      if (!externalModeId) return false;

      updatedLogicalMonitors = [
        [
          0,
          0,
          externalScale,
          0,
          true,
          [
            [externalConnector, externalModeId, {}]
          ]
        ]
      ];
    } else if (mode === 'mirror') {
      const builtinModes = this.getMonitorModeEntries(this.getModesForConnector(state.monitors, builtinConnector));
      const externalModes = this.getMonitorModeEntries(this.getModesForConnector(state.monitors, externalConnector));

      const builtinResolutions = new Set(builtinModes.map((m) => `${m.width}x${m.height}`));
      const commonResolutions = externalModes.filter((m) => builtinResolutions.has(`${m.width}x${m.height}`));

      commonResolutions.sort((a, b) => (b.width * b.height) - (a.width * a.height));

      let targetWidth = 1920;
      let targetHeight = 1080;

      if (commonResolutions.length > 0) {
        targetWidth = commonResolutions[0].width;
        targetHeight = commonResolutions[0].height;
      } else {
        const builtinBest = this.getBestModeId(state.monitors, builtinConnector);
        const builtinBestMode = builtinModes.find((m) => m.id === builtinBest);
        if (builtinBestMode) {
          targetWidth = builtinBestMode.width;
          targetHeight = builtinBestMode.height;
        }
      }

      let builtinModeId = null;
      const builtinMatch = builtinModes.find((m) => m.width === targetWidth && m.height === targetHeight);
      if (builtinMatch) {
        builtinModeId = builtinMatch.id;
      } else {
        builtinModeId = this.getBestModeId(state.monitors, builtinConnector);
      }

      let externalModeId = null;
      const externalMatch = externalModes.find((m) => m.width === targetWidth && m.height === targetHeight);
      if (externalMatch) {
        externalModeId = externalMatch.id;
      } else {
        externalModeId = this.getBestModeId(state.monitors, externalConnector);
      }

      if (!builtinModeId || !externalModeId) return false;

      updatedLogicalMonitors = [
        [
          0,
          0,
          builtinScale,
          0,
          true,
          [
            [builtinConnector, builtinModeId, {}],
            [externalConnector, externalModeId, {}]
          ]
        ]
      ];
    } else if (mode === 'join') {
      const builtinModeId = this.getBestModeId(state.monitors, builtinConnector);
      const externalModeId = this.getBestModeId(state.monitors, externalConnector);
      if (!builtinModeId || !externalModeId) return false;

      const builtinModes = this.getMonitorModeEntries(this.getModesForConnector(state.monitors, builtinConnector));
      const builtinMode = builtinModes.find((m) => m.id === builtinModeId);
      const builtinWidth = builtinMode ? builtinMode.width : 1920;

      const layoutMode = this.getPropertyValue(state.properties, 'layout-mode');
      const scaleDivider = (layoutMode === 1) ? 1.0 : builtinScale;
      const externalX = Math.round(builtinWidth / scaleDivider);

      updatedLogicalMonitors = [
        [
          0,
          0,
          builtinScale,
          0,
          !wasExternalPrimary,
          [
            [builtinConnector, builtinModeId, {}]
          ]
        ],
        [
          externalX,
          0,
          externalScale,
          0,
          wasExternalPrimary,
          [
            [externalConnector, externalModeId, {}]
          ]
        ]
      ];
    } else {
      console.error(`Unknown display mode: ${mode}`);
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
            console.error('Failed to apply display mode configuration:', error);
            resolve(false);
          }
        }
      );
    });
  }

  private isBuiltinConnector(connector: string): boolean {
    return connector.startsWith('eDP') || connector.startsWith('LVDS') || connector.startsWith('DSI');
  }
}