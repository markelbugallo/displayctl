import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type { RefreshRateOption } from '../services/display-config.js';

type RefreshRateMenuHandlers = {
  onRefreshRateSelected: (refreshRate: number) => void;
};

export class RefreshRateMenu {
  private readonly root: any;
  private readonly handlers: RefreshRateMenuHandlers;

  constructor(handlers: RefreshRateMenuHandlers) {
    this.handlers = handlers;
    // Use a standard sub-menu item but intercept clicks so only the right side opens the submenu
    this.root = new PopupMenu.PopupSubMenuMenuItem('Tasa de refresco');

    const isDescendantOf = (child: any, parent: any): boolean => {
      if (!child || !parent) return false;
      if (child === parent) return true;
      if (typeof parent.contains === 'function') {
        try {
          return parent.contains(child);
        } catch (e) {
          // fallback
        }
      }
      let current = child;
      while (current) {
        if (current === parent) return true;
        current = current.get_parent ? current.get_parent() : null;
      }
      return false;
    };

    try {
      // Enable markup support on the label for beautiful rich styling
      const label = this.root.label as any;
      if (label && label.clutter_text) {
        label.clutter_text.use_markup = true;
      }

      // Override the standard activate method to do nothing,
      // completely preventing the row click from opening the submenu
      this.root.activate = (event: any) => {
        // no-op
      };

      // Keep the menu item reactive to intercept clicks on the right side
      const menuActor = (this.root.actor || this.root) as any;
      if (menuActor) {
        menuActor.reactive = true;

        const handleEvent = (actor: any, event: any) => {
          try {
            const source = event.get_source ? event.get_source() : null;
            if (source && this.root.menu && this.root.menu.actor && isDescendantOf(source, this.root.menu.actor)) {
              return false;
            }

            // Get stage coordinates of the click
            const [stageX] = event.get_coords();

            // Determine actor position and width on stage using robust fallback mechanism
            let actorX = 0;
            let actorWidth = actor.get_width ? actor.get_width() : 0;

            if (typeof actor.get_transformed_position === 'function') {
              const pos = actor.get_transformed_position();
              if (pos && pos.length > 0) {
                actorX = pos[0];
              }
            } else {
              const allocation = actor.get_allocation_box ? actor.get_allocation_box() : actor.get_allocation();
              const extents = allocation.get_extents ? allocation.get_extents() : allocation;
              actorX = extents.x || 0;
            }

            if (typeof actor.get_transformed_size === 'function') {
              const size = actor.get_transformed_size();
              if (size && size.length > 0) {
                actorWidth = size[0];
              }
            } else {
              const allocation = actor.get_allocation_box ? actor.get_allocation_box() : actor.get_allocation();
              const extents = allocation.get_extents ? allocation.get_extents() : allocation;
              actorWidth = extents.width || (actor.get_width ? actor.get_width() : 0);
            }

            const localX = stageX - actorX;

            // If clicked on the right side (where the active value and arrow are), toggle submenu.
            // Using actorWidth - 140 covers the right area perfectly.
            if (localX >= actorWidth - 140) {
              if (this.root.menu) {
                this.root.menu.toggle();
              }
            }
          } catch (e) {
            console.error('[displayctl] refresh-rate-menu: event handler error: ' + e);
          }

          // Stop propagation to prevent default activation behavior
          return true;
        };

        const handleOtherEvent = (actor: any, event: any) => {
          try {
            const source = event.get_source ? event.get_source() : null;
            if (source && this.root.menu && this.root.menu.actor && isDescendantOf(source, this.root.menu.actor)) {
              return false;
            }
          } catch (e) {
            console.error('[displayctl] refresh-rate-menu: event handler error: ' + e);
          }
          return true;
        };

        menuActor.connect('button-press-event', handleEvent);
        menuActor.connect('button-release-event', handleOtherEvent);
        menuActor.connect('touch-event', handleOtherEvent);
      }
    } catch (e) {
      console.error('[displayctl] refresh-rate-menu: construction error: ' + e);
    }
  }

  get item(): any {
    return this.root;
  }

  public update(currentLabel: string | null, options: RefreshRateOption[], canApply: boolean): void {
    this.root.menu.removeAll();

    // Update the main row label with the current active rate
    const label = this.root.label as any;
    if (label && label.clutter_text) {
      if (currentLabel) {
        label.clutter_text.set_markup(
          `Tasa de refresco: <span color="#999999">${currentLabel}</span>`
        );
      } else {
        label.clutter_text.set_markup('Tasa de refresco');
      }
    }

    if (!options || options.length === 0) {
      const emptyItem = new PopupMenu.PopupMenuItem('No hay tasas disponibles');
      emptyItem.setSensitive(false);
      this.root.menu.addMenuItem(emptyItem);
      this.root.setSensitive(false);
      return;
    }

    for (const option of options) {
      const item = new PopupMenu.PopupMenuItem(option.label);
      item.setOrnament(option.isCurrent ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
      item.connect('activate', () => {
        this.handlers.onRefreshRateSelected(option.refreshRate);
      });
      this.root.menu.addMenuItem(item);
    }

    this.root.setSensitive(canApply);
  }
}

