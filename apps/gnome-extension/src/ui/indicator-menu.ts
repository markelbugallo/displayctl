import St from 'gi://St';

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
  onMenuOpen?: () => void;
};

export class IndicatorMenu {
  private indicator: any;
  private brightnessItem: any = null;
  private brightnessIcon: any = null;
  private brightnessSeparatorItem: any = null;
  private brightnessLabelItem: any = null;
  private primaryMonitorItem: any = null;
  private refreshRateMenu: RefreshRateMenu | null = null;
  private primaryMonitorItems = new Map<string, any>();
  private menuOpenId: number | null = null;
  private onPrimaryMonitorSelected: (connector: string) => void;

  constructor(icon: any, handlers: IndicatorMenuHandlers) {
    this.indicator = new PanelMenu.Button(0.0, 'Displayctl');
    this.indicator.add_child(icon);
    this.onPrimaryMonitorSelected = handlers.onPrimaryMonitorSelected;
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
    this.indicator = null;
    this.brightnessItem = null;
    this.brightnessIcon = null;
    this.brightnessSeparatorItem = null;
    this.brightnessLabelItem = null;
    this.primaryMonitorItem = null;
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
    canApply: boolean
  ) {
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

    const primaryLabel =
      entries.find((entry) => entry.connector === primaryConnector)?.name || 'Desconocido';
    this.primaryMonitorItem.label.text = `Monitor principal: ${primaryLabel}`;

    for (const entry of entries) {
      const item = new PopupMenu.PopupMenuItem(entry.name);
      this.setMenuItemOrnament(item, entry.connector === primaryConnector);
      item.connect('activate', () => this.onPrimaryMonitorSelected(entry.connector));
      this.primaryMonitorItem.menu.addMenuItem(item);
      this.primaryMonitorItems.set(entry.connector, item);
    }

    this.primaryMonitorItem.setSensitive(canApply);
  }

  setBrightnessLabel(label: string | null) {
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
    this.brightnessSeparatorItem.show();
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
    this.primaryMonitorItem = new PopupMenu.PopupSubMenuMenuItem('Monitor principal');
    this.indicator.menu.addMenuItem(this.primaryMonitorItem, 0);

    this.brightnessSeparatorItem = new PopupMenu.PopupSeparatorMenuItem();
    this.indicator.menu.addMenuItem(this.brightnessSeparatorItem);

    this.brightnessLabelItem = new PopupMenu.PopupMenuItem('', {
      reactive: false,
      can_focus: false,
    });
    if (this.brightnessLabelItem.label) {
      this.brightnessLabelItem.label.set_style('font-weight: 300;');
      this.brightnessLabelItem.label.set_x_align(0);
    }
    this.indicator.menu.addMenuItem(this.brightnessLabelItem);

    this.indicator.menu.addMenuItem(this.refreshRateMenu!.item);

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

  private setMenuItemOrnament(item: any, active: boolean) {
    item.setOrnament(active ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
  }
}