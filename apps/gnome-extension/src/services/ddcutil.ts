import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { IDisplayController, MonitorInfo, BacklightState } from '@displayctl/core';

export class DdcutilController implements IDisplayController {
  private isRunning = false;
  private ddcBusCache = new Map<string, number>();
  private targetBrightnessMap = new Map<string, number>();
  private currentBrightnessMap = new Map<string, number>();

  public isBusy(): boolean {
    return this.isRunning;
  }

  //Checks if `ddcutil` command-line tool is installed in the system path.
  public isDdcutilAvailable(): boolean {
    return GLib.find_program_in_path('ddcutil') !== null;
  }

  /**
   * Detects physical monitors and matches them against I2C buses.
   * 
   * @param externalConnectors List of active external connectors detected via Mutter
   */
  public async detectDdcBuses(externalConnectors: string[]): Promise<Map<string, number>> {
    if (!this.isDdcutilAvailable() || this.isRunning || externalConnectors.length === 0) {
      return this.ddcBusCache;
    }

    this.isRunning = true;
    return new Promise((resolve) => {
      try {
        const proc = new Gio.Subprocess({
          argv: ['ddcutil', 'detect', '--brief', '--skip-ddc-checks'],
          flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENT,
        });
        proc.init(null);

        proc.communicate_utf8_async(null, null, (obj: any, res: any) => {
          this.isRunning = false;
          try {
            const [success, stdout] = obj!.communicate_utf8_finish(res);
            if (success && stdout) {
              const ddcDisplays = this.parseDdcutilDetect(stdout);
              const newCache = new Map<string, number>();

              for (const conn of externalConnectors) {
                const matched = this.matchConnectorToDdc(conn, ddcDisplays);
                if (matched !== null) {
                  newCache.set(conn, matched.bus);
                }
              }
              this.ddcBusCache = newCache;
            }
          } catch (e) {
            console.error('[displayctl] ddcutil detect failed:', e);
          }
          resolve(this.ddcBusCache);
        });
      } catch (e) {
        this.isRunning = false;
        console.error('[displayctl] Failed to launch ddcutil detect:', e);
        resolve(this.ddcBusCache);
      }
    });
  }


  // Retrieves the current hardware backlight value via DDC/CI VCP code 10.
  public async getHardwareBrightness(monitor: MonitorInfo): Promise<BacklightState | null> {
    if (!this.isDdcutilAvailable() || this.isRunning) {
      return null;
    }

    this.isRunning = true;
    const bus = this.ddcBusCache.get(monitor.id);

    const argv = ['ddcutil'];
    if (bus !== undefined) {
      argv.push('--bus', String(bus));
    }
    argv.push('getvcp', '10', '--brief');

    return new Promise((resolve) => {
      try {
        const proc = new Gio.Subprocess({
          argv: argv,
          flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENT,
        });
        proc.init(null);

        proc.communicate_utf8_async(null, null, (obj: any, res: any) => {
          this.isRunning = false;
          try {
            const [success, stdout] = obj!.communicate_utf8_finish(res);
            if (success && stdout) {
              const parsed = this.parseDdcutilGetvcp(stdout);
              if (parsed) {
                const { current, max } = parsed;
                const normalized = current / max;
                
                this.currentBrightnessMap.set(monitor.id, normalized);
                this.targetBrightnessMap.set(monitor.id, normalized);

                resolve({
                  connector: monitor.id,
                  bus: bus,
                  min: 0,
                  max,
                  value: normalized,
                  isHardware: true,
                });
                return;
              }
            }
          } catch (e) {
            console.error('[displayctl] ddcutil getvcp failed:', e);
          }
          resolve(null);
        });
      } catch (e) {
        this.isRunning = false;
        console.error('[displayctl] Failed to run ddcutil getvcp:', e);
        resolve(null);
      }
    });
  }

  // Sets the physical monitor brightness via DDC/CI VCP code 10 using a queue.
  public async setHardwareBrightness(
    monitor: MonitorInfo,
    state: BacklightState,
    value: number
  ): Promise<void> {
    if (!this.isDdcutilAvailable()) {
      return;
    }

    this.targetBrightnessMap.set(monitor.id, value);

    if (this.isRunning) {
      return;
    }

    void this.processBrightnessQueue(monitor, state);
  }

  private async processBrightnessQueue(
    monitor: MonitorInfo,
    state: BacklightState
  ): Promise<void> {
    const target = this.targetBrightnessMap.get(monitor.id);
    if (target === undefined) {
      return;
    }

    const current = this.currentBrightnessMap.get(monitor.id);
    if (current === target) {
      return;
    }

    this.isRunning = true;

    const min = state.min ?? 0;
    const max = state.max ?? 100;
    const bus = state.bus ?? this.ddcBusCache.get(monitor.id);

    const targetVal = Math.round(min + target * (max - min));
    const clampedVal = Math.max(min, Math.min(max, targetVal));

    const argv = ['ddcutil'];
    if (bus !== undefined) {
      argv.push('--bus', String(bus));
    }
    argv.push('setvcp', '10', String(clampedVal));
    if (bus !== undefined) {
      argv.push('--noverify');
    }

    return new Promise<void>((resolve) => {
      try {
        const proc = new Gio.Subprocess({
          argv: argv,
          flags: Gio.SubprocessFlags.NONE,
        });
        proc.init(null);

        proc.wait_async(null, (obj: any, res: any) => {
          this.isRunning = false;
          try {
            obj!.wait_finish(res);
            this.currentBrightnessMap.set(monitor.id, target);
          } catch (e) {
            console.error('[displayctl] ddcutil setvcp failed:', e);
          }
          void this.processBrightnessQueue(monitor, state).then(resolve);
        });
      } catch (e) {
        this.isRunning = false;
        console.error('[displayctl] Failed to run ddcutil setvcp:', e);
        resolve();
      }
    });
  }

  private parseDdcutilGetvcp(stdout: string): { current: number; max: number } | null {
    if (!stdout) {
      return null;
    }
    const matches = stdout.match(/VCP\s+(?:10|0x10)\s+\S+\s+(\d+)(?:\s+(\d+))?/i);
    if (matches) {
      const current = parseInt(matches[1], 10);
      const max = matches[2] ? parseInt(matches[2], 10) : 100;
      if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
        return { current, max };
      }
    }
    return null;
  }

  private parseDdcutilDetect(stdout: string): Array<{ bus: number; drmConnector: string }> {
    const displays: Array<{ bus: number; drmConnector: string }> = [];
    const lines = stdout.split(/\r?\n/);
    let currentDisplay: { bus: number | null; drmConnector: string } | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Display ')) {
        if (currentDisplay && currentDisplay.bus !== null) {
          displays.push(currentDisplay as { bus: number; drmConnector: string });
        }
        currentDisplay = { bus: null, drmConnector: '' };
      } else if (trimmed.startsWith('Invalid display')) {
        if (currentDisplay && currentDisplay.bus !== null) {
          displays.push(currentDisplay as { bus: number; drmConnector: string });
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
      displays.push(currentDisplay as { bus: number; drmConnector: string });
    }

    return displays;
  }

  private matchConnectorToDdc(
    gnomeConnector: string,
    ddcDisplays: Array<{ bus: number; drmConnector: string }>
  ): { bus: number; drmConnector: string } | null {
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
}