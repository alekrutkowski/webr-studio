import { $, escapeHtml } from './utils.js?v=1.2.11';

function svg(id) {
  return `<svg class="ui-icon" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

export class UI {
  constructor() {
    this.toastRegion = $('#toast-region');
    this.confirmDialog = $('#confirm-dialog');
    this.inputDialog = $('#input-dialog');
    this.menu = $('#menu-popover');
    this.contextMenu = $('#context-menu');
    this.confirmResolver = null;
    this.inputResolver = null;
    this.bindDialogs();
  }

  bindDialogs() {
    $('#confirm-accept').addEventListener('click', () => {
      this.confirmResolver?.(true);
      this.confirmResolver = null;
      this.confirmDialog.close('accept');
    });
    this.confirmDialog.addEventListener('close', () => {
      if (this.confirmResolver) this.confirmResolver(false);
      this.confirmResolver = null;
    });
    $('#input-dialog-accept').addEventListener('click', () => {
      const value = $('#input-dialog-value').value;
      this.inputResolver?.(value);
      this.inputResolver = null;
      this.inputDialog.close('accept');
    });
    this.inputDialog.addEventListener('close', () => {
      if (this.inputResolver) this.inputResolver(null);
      this.inputResolver = null;
    });
    $('#input-dialog-value').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        $('#input-dialog-accept').click();
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!this.menu.hidden && !this.menu.contains(event.target) && !event.target.closest('.menu-trigger')) this.hideMenus();
      if (!this.contextMenu.hidden && !this.contextMenu.contains(event.target)) this.hideMenus();
    });
    window.addEventListener('blur', () => this.hideMenus());
    window.addEventListener('resize', () => this.hideMenus());
  }

  toast(title, message = '', type = 'info', duration = 4400) {
    const node = document.createElement('article');
    node.className = `toast ${type}`;
    const iconId = type === 'success' ? 'i-check' : type === 'error' ? 'i-x' : type === 'warning' ? 'i-clock' : 'i-help';
    node.innerHTML = `
      <span class="toast-icon">${svg(iconId)}</span>
      <div><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ''}</div>
      <button class="toast-close" aria-label="Dismiss">${svg('i-x')}</button>`;
    const remove = () => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      window.setTimeout(() => node.remove(), 160);
    };
    node.querySelector('.toast-close').addEventListener('click', remove);
    this.toastRegion.append(node);
    if (duration) window.setTimeout(remove, duration);
    return node;
  }

  confirm(title, message, { acceptLabel = 'Continue', danger = true } = {}) {
    if (this.confirmDialog.open) this.confirmDialog.close();
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const accept = $('#confirm-accept');
    accept.textContent = acceptLabel;
    accept.className = `button ${danger ? 'danger' : 'primary'}`;
    this.confirmDialog.showModal();
    return new Promise(resolve => { this.confirmResolver = resolve; });
  }

  prompt(title, message = '', { value = '', placeholder = '', acceptLabel = 'Continue' } = {}) {
    if (this.inputDialog.open) this.inputDialog.close();
    $('#input-title').textContent = title;
    $('#input-message').textContent = message;
    const input = $('#input-dialog-value');
    input.value = value;
    input.placeholder = placeholder;
    $('#input-dialog-accept').textContent = acceptLabel;
    this.inputDialog.showModal();
    window.setTimeout(() => { input.focus(); input.select(); }, 30);
    return new Promise(resolve => { this.inputResolver = resolve; });
  }

  showMenu(anchor, items, { context = false, x = 0, y = 0 } = {}) {
    this.hideMenus();
    const menu = context ? this.contextMenu : this.menu;
    menu.replaceChildren();
    for (const item of items) {
      if (item.type === 'separator') {
        const divider = document.createElement('div');
        divider.className = 'menu-separator';
        menu.append(divider);
        continue;
      }
      if (item.type === 'label') {
        const label = document.createElement('div');
        label.className = 'menu-label';
        label.textContent = item.label;
        menu.append(label);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `menu-item${item.checked ? ' checked' : ''}`;
      button.disabled = Boolean(item.disabled);
      button.innerHTML = `<span class="menu-check">${item.icon ? svg(item.icon) : ''}</span><span>${escapeHtml(item.label)}</span>${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : '<span></span>'}`;
      button.addEventListener('click', async () => {
        this.hideMenus();
        try {
          await item.action?.();
        } catch (error) {
          this.toast('Action failed', error?.message || String(error), 'error', 0);
        }
      });
      menu.append(button);
    }
    menu.hidden = false;
    const rect = anchor?.getBoundingClientRect();
    const left = context ? x : rect?.left || x;
    const top = context ? y : (rect?.bottom || y) + 3;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(5, Math.min(left, window.innerWidth - width - 5))}px`;
    menu.style.top = `${Math.max(5, Math.min(top, window.innerHeight - height - 5))}px`;
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    menu._anchor = anchor;
  }

  hideMenus() {
    for (const menu of [this.menu, this.contextMenu]) {
      menu.hidden = true;
      menu._anchor?.setAttribute('aria-expanded', 'false');
      menu._anchor = null;
    }
  }
}
