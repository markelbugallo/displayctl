import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import { RefreshRateMenu } from './refresh-rate-menu.js';
import type { RefreshRateOption } from '../services/display-config.js';

type MonitorMenuEntry = {
  connector: string;
  name: string;
};

type IndicatorMenuHandlers = {
  onBrightnessChanged: (value: number) => void;
  onPrimaryMonitorSelected: (connector: string) => void;
  onRefreshRateSelected: (refreshRate: number) => void;
  onDisplayModeSelected: (mode: string) => void;
  onMenuOpen?: () => void;
};

export class IndicatorMenu {
  private indicator: any;
  private brightnessItem: any = null;
  private brightnessIcon: any = null;
  private brightnessSeparatorItem: any = null;
  private brightnessLabelItem: any = null;
  private primaryMonitorItem: any = null;
  private displayLayoutItem: any = null;
  private refreshRateMenu: RefreshRateMenu | null = null;
  private primaryMonitorItems = new Map<string, any>();
  private displayLayoutItems = new Map<string, any>();
  private menuOpenId: number | null = null;
  private brightnessLabelText: string | null = null;
  private isLidClosedOnlyExternal = false;
  private onPrimaryMonitorSelected: (connector: string) => void;
  private onDisplayModeSelected: (mode: string) => void;

  constructor(icon: any, handlers: IndicatorMenuHandlers) {
    this.indicator = new PanelMenu.Button(0.0, 'Displayctl');
    this.indicator.set_style('padding: 0 4px; -natural-hpadding: 4px; -minimum-hpadding: 4px;');
    this.indicator.add_child(icon);
    this.onPrimaryMonitorSelected = handlers.onPrimaryMonitorSelected;
    this.onDisplayModeSelected = handlers.onDisplayModeSelected;
    this.refreshRateMenu = new RefreshRateMenu({
      onRefreshRateSelected: handlers.onRefreshRateSelected,
    });

    this.buildMenu(handlers.onBrightnessChanged);

    if (handlers.onMenuOpen) {
      this.menuOpenId = this.indicator.menu.connect(
        'open-state-changed',
        (menu: any, isOpen: boolean) => {
          if (isOpen) {
            handlers.onMenuOpen!();
          }
        }
      );
    }
  }

  attachToPanel() {
    Main.panel.addToStatusArea('displayctl', this.indicator, 0, 'right');
  }

  destroy() {
    if (this.menuOpenId !== null && this.indicator?.menu) {
      this.indicator.menu.disconnect(this.menuOpenId);
      this.menuOpenId = null;
    }

    if (this.indicator) {
      this.indicator.destroy();
    }

    this.primaryMonitorItems.clear();
    this.displayLayoutItems.clear();
    this.indicator = null;
    this.brightnessItem = null;
    this.brightnessIcon = null;
    this.brightnessSeparatorItem = null;
    this.brightnessLabelItem = null;
    this.primaryMonitorItem = null;
    this.displayLayoutItem = null;
    this.refreshRateMenu = null;
  }

  setVisible(visible: boolean) {
    if (!this.indicator) {
      return;
    }
    this.indicator.visible = visible;
    this.indicator.reactive = visible;
    this.indicator.can_focus = visible;
  }

  updatePrimaryMonitorMenu(
    entries: MonitorMenuEntry[],
    primaryConnector: string | null,
    canApply: boolean,
    isLidClosedOnlyExternal: boolean
  ) {
    this.isLidClosedOnlyExternal = isLidClosedOnlyExternal;
    if (!this.primaryMonitorItem) {
      return;
    }

    this.primaryMonitorItems.clear();
    this.primaryMonitorItem.menu.removeAll();

    if (!entries || entries.length === 0) {
      const emptyItem = new PopupMenu.PopupMenuItem('No monitors detected');
      emptyItem.setSensitive(false);
      this.primaryMonitorItem.menu.addMenuItem(emptyItem);
      this.primaryMonitorItem.label.text = 'Monitor principal';
      return;
    }

    let primaryLabel = '';
    if (isLidClosedOnlyExternal) {
      const externalEntry = entries.find((entry) => {
        return entry.connector && !entry.connector.startsWith('eDP') && !entry.connector.startsWith('LVDS') && !entry.connector.startsWith('DSI');
      });
      primaryLabel = externalEntry ? externalEntry.name : 'Monitor externo';
    } else {
      primaryLabel = entries.find((entry) => entry.connector === primaryConnector)?.name || 'Desconocido';
    }
    this.primaryMonitorItem.label.text = `Monitor principal: ${primaryLabel}`;

    for (const entry of entries) {
      const item = new PopupMenu.PopupMenuItem(entry.name);
      if (item.label) {
        item.label.x_expand = true;
        item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
      }
      this.setMenuItemOrnament(item, entry.connector === primaryConnector);
      item.connect('activate', () => this.onPrimaryMonitorSelected(entry.connector));
      this.primaryMonitorItem.menu.addMenuItem(item);
      this.primaryMonitorItems.set(entry.connector, item);
    }

    if (isLidClosedOnlyExternal) {
      this.primaryMonitorItem.hide();
    } else {
      this.primaryMonitorItem.show();
      this.primaryMonitorItem.setSensitive(canApply);
      this.primaryMonitorItem.reactive = canApply;
      this.primaryMonitorItem.can_focus = canApply;
      if (this.primaryMonitorItem.label) {
        this.primaryMonitorItem.label.set_style('');
      }
      if (this.primaryMonitorItem._triangle) {
        this.primaryMonitorItem._triangle.visible = true;
      }
    }

    this.updateBrightnessSeparatorVisibility();
  }

  updateDisplayLayoutMenu(currentMode: string, canApply: boolean, isLidClosedOnlyExternal: boolean) {
    this.isLidClosedOnlyExternal = isLidClosedOnlyExternal;
    if (!this.displayLayoutItem) {
      return;
    }

    this.displayLayoutItems.clear();
    this.displayLayoutItem.menu.removeAll();

    const options = [
      { mode: 'mirror', label: 'Espejo' },
      { mode: 'join', label: 'Unir pantallas' },
      { mode: 'external-only', label: 'Solo externa' },
      { mode: 'builtin-only', label: 'Solo integrada' }
    ];

    const activeOption = options.find((opt) => opt.mode === currentMode);
    const activeLabel = activeOption ? activeOption.label : 'Desconocido';
    this.displayLayoutItem.label.text = activeLabel;

    for (const option of options) {
      const item = new PopupMenu.PopupMenuItem(option.label);
      if (item.label) {
        item.label.x_expand = true;
        item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
      }
      this.setMenuItemOrnament(item, option.mode === currentMode);
      item.connect('activate', () => {
        this.onDisplayModeSelected(option.mode);
      });
      this.displayLayoutItem.menu.addMenuItem(item);
      this.displayLayoutItems.set(option.mode, item);
    }

    if (isLidClosedOnlyExternal) {
      this.displayLayoutItem.hide();
    } else {
      this.displayLayoutItem.show();
      this.displayLayoutItem.setSensitive(canApply);
      this.displayLayoutItem.reactive = canApply;
      this.displayLayoutItem.can_focus = canApply;
      if (this.displayLayoutItem.label) {
        this.displayLayoutItem.label.set_style('');
      }
      if (this.displayLayoutItem._triangle) {
        this.displayLayoutItem._triangle.visible = true;
      }
    }

    this.updateBrightnessSeparatorVisibility();
  }

  setBrightnessLabel(label: string | null) {
    this.brightnessLabelText = label;

    if (!this.brightnessLabelItem || !this.brightnessSeparatorItem) {
      return;
    }

    if (!label) {
      this.brightnessLabelItem.hide();
      this.brightnessSeparatorItem.hide();
      return;
    }

    this.brightnessLabelItem.label.text = label;
    this.brightnessLabelItem.show();
    this.updateBrightnessSeparatorVisibility();
  }

  updateRefreshRateMenu(label: string | null, options: RefreshRateOption[], canApply: boolean): void {
    if (!this.refreshRateMenu) {
      return;
    }

    this.refreshRateMenu.update(label, options, canApply);
  }

  setBrightnessEnabled(enabled: boolean) {
    if (!this.brightnessItem) {
      return;
    }
    this.brightnessItem.setSensitive(enabled);
  }

  setBrightnessValue(value: number) {
    if (!this.brightnessItem) {
      return;
    }

    if (typeof this.brightnessItem.setValue === 'function') {
      this.brightnessItem.setValue(value);
    } else if (this.brightnessItem.slider) {
      this.brightnessItem.slider.value = value;
    } else if (this.brightnessItem._slider) {
      this.brightnessItem._slider.value = value;
    }
  }

  private buildMenu(onBrightnessChanged: (value: number) => void) {
    this.indicator.menu.box.set_style('width: 250px;');

    this.primaryMonitorItem = new PopupMenu.PopupSubMenuMenuItem('Monitor principal');
    if (this.primaryMonitorItem.label) {
      this.primaryMonitorItem.label.x_expand = true;
      this.primaryMonitorItem.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    }
    this.indicator.menu.addMenuItem(this.primaryMonitorItem, 0);

    this.displayLayoutItem = new PopupMenu.PopupSubMenuMenuItem('Pantallas');
    if (this.displayLayoutItem.label) {
      this.displayLayoutItem.label.x_expand = true;
      this.displayLayoutItem.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    }
    this.indicator.menu.addMenuItem(this.displayLayoutItem, 1);

    this.brightnessSeparatorItem = new PopupMenu.PopupSeparatorMenuItem();
    this.indicator.menu.addMenuItem(this.brightnessSeparatorItem);

    this.brightnessLabelItem = new PopupMenu.PopupMenuItem('', {
      reactive: false,
      can_focus: false,
    });
    if (this.brightnessLabelItem.label) {
      this.brightnessLabelItem.label.set_style('font-weight: 300;');
      this.brightnessLabelItem.label.set_x_align(0);
      this.brightnessLabelItem.label.x_expand = true;
      this.brightnessLabelItem.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    }
    this.indicator.menu.addMenuItem(this.brightnessLabelItem);

    this.indicator.menu.addMenuItem(this.refreshRateMenu!.item);
    this.refreshRateMenu!.setParentMenu(this.indicator.menu);

    const hasPopupSlider = typeof (PopupMenu as any).PopupSliderMenuItem === 'function';
    if (hasPopupSlider) {
      this.brightnessItem = new (PopupMenu as any).PopupSliderMenuItem(0);
    } else {
      this.brightnessItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
    }

    this.brightnessIcon = new St.Icon({
      icon_name: 'display-brightness-symbolic',
      style_class: 'popup-menu-icon',
    });

    if (this.brightnessItem.insert_child_at_index) {
      this.brightnessItem.insert_child_at_index(this.brightnessIcon, 0);
    } else if (this.brightnessItem.add_child) {
      this.brightnessItem.add_child(this.brightnessIcon);
    }

    if (hasPopupSlider) {
      this.brightnessItem.setSensitive(false);
      this.brightnessItem.connect('value-changed', (item: any, value: number) => {
        onBrightnessChanged(value);
      });
    } else {
      const slider = new Slider.Slider(0);
      this.brightnessItem.slider = slider;
      this.brightnessItem._slider = slider;

      const baseSetSensitive =
        typeof this.brightnessItem.setSensitive === 'function'
          ? this.brightnessItem.setSensitive.bind(this.brightnessItem)
          : null;

      this.brightnessItem.setSensitive = (enabled: boolean) => {
        if (baseSetSensitive) {
          baseSetSensitive(enabled);
        }

        this.brightnessItem.reactive = enabled;
        this.brightnessItem.can_focus = enabled;

        if (slider) {
          slider.reactive = enabled;
          slider.can_focus = enabled;
        }

        if (this.brightnessIcon) {
          this.brightnessIcon.opacity = enabled ? 255 : 90;
        }
      };

      this.brightnessItem.setSensitive(false);

      slider.connect('notify::value', () => {
        onBrightnessChanged(slider.value);
      });

      if (this.brightnessItem.add_child) {
        this.brightnessItem.add_child(slider);
      } else if (this.brightnessItem.add) {
        this.brightnessItem.add(slider);
      }
    }

    this.indicator.menu.addMenuItem(this.brightnessItem);
  }

  private updateBrightnessSeparatorVisibility() {
    if (!this.brightnessSeparatorItem || !this.brightnessLabelItem) {
      return;
    }

    if (!this.brightnessLabelText || this.isLidClosedOnlyExternal) {
      this.brightnessSeparatorItem.hide();
      return;
    }

    this.brightnessSeparatorItem.show();
  }

  private setMenuItemOrnament(item: any, active: boolean) {
    item.setOrnament(active ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
  }
}