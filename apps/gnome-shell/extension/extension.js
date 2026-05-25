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

    // Right box, left of the built-in system icons.
    Main.panel.addToStatusArea('displayctl', this._indicator, 0, 'right');
  }

  disable() {
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }

  _getResolvedExtensionPath() {
    if (typeof GLib.realpath === 'function') {
      const resolved = GLib.realpath(this.path);
      if (resolved) {
        return resolved;
      }
    }

    return this.path;
  }

  _getIconPath() {
    const resolvedExtensionPath = this._getResolvedExtensionPath();
    const extensionPath = GLib.build_filenamev([
      resolvedExtensionPath,
      'assets',
      'displayctl_icon_white.png',
    ]);

    if (GLib.file_test(extensionPath, GLib.FileTest.EXISTS)) {
      return extensionPath;
    }

    console.warn('[displayctl] Icon not found at assets/displayctl_icon_white.png.');
    return null;
  }

  _createIndicatorIcon() {
    const icon = new St.Icon({
      icon_name: 'video-display-symbolic',
      style_class: 'system-status-icon',
    });

    const iconPath = this._getIconPath();
    if (iconPath) {
      const iconFile = Gio.File.new_for_path(iconPath);
      icon.gicon = new Gio.FileIcon({file: iconFile});
    }

    return icon;
  }
}
