import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { calculateSoftwareOpacity } from '@displayctl/core';

export class OverlayManager {
  private overlays = new Map<string, InstanceType<typeof St.Widget>>();

  /**
   * Refreshes the software brightness overlays on all monitors.
   * Creates overlays for software-controlled external monitors, updates their position and size to match monitor geometries, and adjusts their opacity according to target brightness levels.
   * 
   * @param externalConnectors List of detected external connectors
   * @param activeSoftwareBrightness Map of connector name to normalized brightness level (0.0 to 1.0)
   * @param logicalMonitors Array of logical monitor properties retrieved from Mutter DBus
   * @param currentHardwareConnector Current hardware-controlled connector (to exclude from overlay)
   */
  public updateOverlays(
    externalConnectors: string[],
    activeSoftwareBrightness: Map<string, number>,
    logicalMonitors: any[],
    currentHardwareConnector?: string
  ): void {
    if (!this.overlays) return;

    if (externalConnectors.length === 0) {
      this.clearOverlays();
      return;
    }

    const activeConnectors = new Set(externalConnectors);

    // Clean up overlays that are no longer active
    for (const [connector, overlay] of this.overlays.entries()) {
      if (!activeConnectors.has(connector)) {
        overlay.destroy();
        this.overlays.delete(connector);
      }
    }

    for (const connector of externalConnectors) {
      const isHardware = currentHardwareConnector === connector;

      if (isHardware) {
        const overlay = this.overlays.get(connector);
        if (overlay) {
          overlay.destroy();
          this.overlays.delete(connector);
        }
        continue;
      }

      const geom = this.getMonitorGeometryByConnector(connector, logicalMonitors);
      if (!geom) {
        continue;
      }

      let overlay = this.overlays.get(connector);
      if (!overlay) {
        overlay = new St.Widget({
          name: `displayctl-overlay-${connector}`,
          style: 'background-color: black;',
          reactive: false,
        });
        Main.uiGroup.add_child(overlay);
        this.overlays.set(connector, overlay);
      }

      overlay.set_position(geom.x, geom.y);
      overlay.set_size(geom.width, geom.height);

      const brightness = activeSoftwareBrightness.get(connector) ?? 1.0;
      const opacity = calculateSoftwareOpacity(brightness);
      
      overlay.opacity = opacity;
      overlay.visible = brightness < 1.0;
    }
  }


  // Destroys and clears all active software overlays.

  public clearOverlays(): void {
    if (this.overlays) {
      for (const overlay of this.overlays.values()) {
        if (overlay) {
          overlay.destroy();
        }
      }
      this.overlays.clear();
    }
  }

  private getMonitorGeometryByConnector(connector: string, logicalMonitors: any[]): any | null {
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
}
