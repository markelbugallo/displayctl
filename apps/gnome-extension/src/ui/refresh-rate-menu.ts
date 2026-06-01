import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type { RefreshRateOption } from '../services/display-config.js';

type RefreshRateMenuHandlers = {
  onRefreshRateSelected: (refreshRate: number) => void;
};

export class RefreshRateMenu {
  private readonly root: any;
  private readonly handlers: RefreshRateMenuHandlers;
  private readonly dropdownBox: any;
  private readonly dropdownLabel: any;
  private readonly dropdownArrow: any;
  private readonly menu: any;
  private readonly menuManager: any;
  private parentMenu: any = null;

  constructor(handlers: RefreshRateMenuHandlers) {
    this.handlers = handlers;

    // Use a flat PopupBaseMenuItem instead of PopupSubMenuMenuItem
    this.root = new PopupMenu.PopupBaseMenuItem({
      activate: false,
      reactive: true,
      can_focus: true,
    });

    try {
      // 1. Static/fixed label on the left (matches original design but now fixed)
      const label = new St.Label({
        text: 'Tasa de refresco',
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      this.root.add_child(label);

      // 2. Styled dropdown button/box on the right
      this.dropdownBox = new St.BoxLayout({
        style_class: 'button',
        style: 'padding: 4px 8px; border-radius: 6px; spacing: 6px;',
        reactive: true,
        can_focus: true,
        track_hover: true,
      });

      this.dropdownLabel = new St.Label({
        text: '--- Hz',
        y_align: Clutter.ActorAlign.CENTER,
      });
      this.dropdownBox.add_child(this.dropdownLabel);

      this.dropdownArrow = new St.Icon({
        icon_name: 'pan-down-symbolic',
        style_class: 'popup-menu-arrow',
      });
      this.dropdownBox.add_child(this.dropdownArrow);

      this.root.add_child(this.dropdownBox);

      // 3. Floating PopupMenu anchored to the dropdownBox
      this.menu = new PopupMenu.PopupMenu(this.dropdownBox, 0.5, St.Side.TOP);
      this.menu.actor.name = 'displayctl-refresh-rate-popup';
      this.menu.actor.visible = false;
      
      // Add menu actor to UI Group
      Main.uiGroup.add_child(this.menu.actor);

      // Register the menu in a PopupMenuManager to handle click outside
      this.menuManager = new PopupMenu.PopupMenuManager(this.dropdownBox);
      this.menuManager.addMenu(this.menu);

      // Connect click/button-press to toggle the menu
      this.dropdownBox.connect('button-press-event', (actor: any, event: any) => {
        if (event.get_button() !== 1) {
          return Clutter.EVENT_PROPAGATE;
        }
        if (this.parentMenu && this.parentMenu.isOpen) {
          this.menu.toggle();
        }
        return Clutter.EVENT_STOP;
      });

      // Prevent button-release propagation on left-click to avoid activation side-effects
      this.dropdownBox.connect('button-release-event', (actor: any, event: any) => {
        if (event.get_button() === 1) {
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      // Cleanup floating menu on destroy to prevent memory leaks in Main.uiGroup
      this.root.connect('destroy', () => {
        if (this.menu) {
          this.menu.destroy();
        }
      });
    } catch (e) {
      console.error('[displayctl] refresh-rate-menu: construction error: ' + e);
    }
  }

  get item(): any {
    return this.root;
  }

  public setParentMenu(parentMenu: any): void {
    this.parentMenu = parentMenu;
    this.parentMenu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
      if (!isOpen && this.menu) {
        this.menu.close();
      }
    });
  }

  public update(currentLabel: string | null, options: RefreshRateOption[], canApply: boolean): void {
    // Ensure the Hz menu is closed if the parent menu is closed
    if (this.parentMenu && !this.parentMenu.isOpen && this.menu.isOpen) {
      this.menu.close();
    }

    this.menu.removeAll();

    // Update the dropdown label text with the active rate
    if (this.dropdownLabel) {
      this.dropdownLabel.text = currentLabel || '--- Hz';
    }

    if (!options || options.length === 0) {
      const emptyItem = new PopupMenu.PopupMenuItem('No hay tasas disponibles');
      emptyItem.setSensitive(false);
      this.menu.addMenuItem(emptyItem);
      this.dropdownBox.reactive = false;
      this.dropdownBox.track_hover = false;
      this.dropdownBox.opacity = 128;
      return;
    }

    for (const option of options) {
      const item = new PopupMenu.PopupMenuItem(option.label);
      item.setOrnament(option.isCurrent ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
      item.connect('activate', () => {
        this.handlers.onRefreshRateSelected(option.refreshRate);
        this.menu.close();
      });
      this.menu.addMenuItem(item);
    }

    this.dropdownBox.reactive = canApply;
    this.dropdownBox.track_hover = canApply;
    this.dropdownBox.opacity = canApply ? 255 : 128;
    this.root.setSensitive(canApply);
  }
}
