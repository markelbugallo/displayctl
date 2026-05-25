import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DisplayctlExtension extends Extension {
  enable() {
    this._indicator = new PanelMenu.Button(0.0, 'Displayctl');

    const icon = this._createIndicatorIcon();
    this._indicator.add_child(icon);

    const item = new PopupMenu.PopupMenuItem('En desarrollo...');
    item.setSensitive(false);
    this._indicator.menu.addMenuItem(item);

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
    if (this._displayConfigCancellable) {
      this._displayConfigCancellable.cancel();
      this._displayConfigCancellable = null;
    }
    this._displayConfigProxy = null;
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
        let response;
        try {
          response = proxy.call_finish(result);
        } catch (error) {
          console.error('[displayctl] Failed to read monitor state.', error);
          return;
        }

        const [, monitors] = response.deep_unpack();
        const hasExternalMonitor = this._computeHasExternalMonitor(monitors);
        this._setIndicatorVisibility(hasExternalMonitor);
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

  _computeHasExternalMonitor(monitors) {
    if (!Array.isArray(monitors)) {
      return false;
    }

    for (const monitor of monitors) {
      const [monitorInfo, , properties] = monitor;
      const connector = Array.isArray(monitorInfo) ? monitorInfo[0] : null;
      const isBuiltinProperty = this._getPropertyValue(properties, 'is-builtin');
      const isBuiltin = typeof isBuiltinProperty === 'boolean'
        ? isBuiltinProperty
        : this._isBuiltinConnector(connector);

      if (!isBuiltin) {
        return true;
      }
    }

    return false;
  }

  _getPropertyValue(properties, key) {
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
