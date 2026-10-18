/**
 * Menus déroulants « Notion » sans dépendance (version autonome de
 * js/ui/dropdown.js de l'application 3DTech, sans Tailwind).
 *
 * - NotionPopover.open(trigger, { content, align, minWidth, maxWidth, maxHeight })
 *   affiche un panneau flottant positionné sous le bouton, fermé au clic
 *   extérieur, à Échap et au redimensionnement.
 * - openNotionDropdown(event, config) : liste à choix unique avec recherche
 *   (même configuration que dans l'application : items, value, onSelect…).
 */
(function () {
  let active = null; // { el, trigger, onClose }

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

  function close() {
    if (!active) return;
    const { el, onClose } = active;
    active = null;
    el.remove();
    if (typeof onClose === 'function') onClose();
  }

  function place(el, trigger, align) {
    const rect = trigger.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = align === 'right' ? rect.right - box.width : rect.left;
    if (top + box.height > window.innerHeight - 10) top = Math.max(10, rect.top - box.height - 6);
    if (left + box.width > window.innerWidth - 10) left = window.innerWidth - box.width - 10;
    left = Math.max(10, left);
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  function open(trigger, opts = {}) {
    if (active && active.trigger === trigger) { close(); return null; }
    close();
    const el = document.createElement('div');
    el.className = 'notion-dropdown-menu';
    el.style.minWidth = opts.minWidth || '220px';
    el.style.maxWidth = opts.maxWidth || '360px';
    el.style.maxHeight = opts.maxHeight || '360px';
    if (typeof opts.content === 'string') el.innerHTML = opts.content;
    else if (opts.content) el.appendChild(opts.content);
    document.body.appendChild(el);
    active = { el, trigger, onClose: opts.onClose };
    place(el, trigger, opts.align);
    return el;
  }

  function reposition() {
    if (active) place(active.el, active.trigger, active.el.dataset.align);
  }

  document.addEventListener('click', (e) => {
    if (active && !active.el.contains(e.target) && !active.trigger.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
  window.addEventListener('resize', close, { passive: true });

  /** Champ de recherche standard (icône loupe, autofocus). */
  function searchField(placeholder) {
    return `<div class="notion-dropdown-search">
      <span class="ms">search</span>
      <input type="text" placeholder="${esc(placeholder)}" autocomplete="off">
    </div>`;
  }

  function openNotionDropdown(eventOrEl, config = {}) {
    if (eventOrEl && eventOrEl.stopPropagation) { eventOrEl.stopPropagation(); eventOrEl.preventDefault(); }
    const trigger = eventOrEl && eventOrEl.currentTarget ? eventOrEl.currentTarget : eventOrEl;
    if (!(trigger instanceof HTMLElement)) return;
    const {
      items = [], value = null, onSelect = () => {}, placeholder = 'Rechercher...',
      showSearch = items.length > 5, title = '', align = 'left', minWidth = '220px', maxHeight = '360px'
    } = config;

    const content = document.createElement('div');
    content.className = 'notion-dropdown-body';
    content.innerHTML = `
      ${title ? `<div class="notion-dropdown-title">${esc(title)}</div>` : ''}
      ${showSearch ? searchField(placeholder) : ''}
      <div class="notion-dropdown-list"></div>`;
    const el = open(trigger, { content, align, minWidth, maxHeight });
    if (!el) return;
    el.dataset.align = align;
    const list = el.querySelector('.notion-dropdown-list');

    function render(query) {
      const q = normalize(query);
      const shown = items.filter(it => !q || normalize(it.label).includes(q) || normalize(it.value).includes(q) || normalize(it.badge).includes(q));
      if (!shown.length) {
        list.innerHTML = `<div class="notion-dropdown-empty">—</div>`;
        return;
      }
      list.innerHTML = shown.map(it => {
        const selected = String(it.value) === String(value);
        return `<div class="notion-dropdown-item${selected ? ' is-selected' : ''}${it.disabled ? ' is-disabled' : ''}" data-val="${esc(String(it.value))}">
          ${it.icon ? `<span class="ms">${esc(it.icon)}</span>` : ''}
          <span class="notion-dropdown-label">${esc(it.label)}</span>
          ${it.badge ? `<span class="notion-dropdown-badge">${esc(it.badge)}</span>` : ''}
          ${selected ? '<span class="ms notion-dropdown-check">check</span>' : ''}
        </div>`;
      }).join('');
      const current = list.querySelector('.is-selected');
      if (current) current.scrollIntoView({ block: 'nearest' });
    }

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.notion-dropdown-item');
      if (!row || row.classList.contains('is-disabled')) return;
      const val = row.getAttribute('data-val');
      const item = items.find(it => String(it.value) === val);
      close();
      onSelect(item ? item.value : val, item);
    });

    render('');
    const input = el.querySelector('.notion-dropdown-search input');
    if (input) {
      input.addEventListener('input', () => render(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = list.querySelector('.notion-dropdown-item:not(.is-disabled)');
        if (first) first.click();
      });
      setTimeout(() => input.focus(), 30);
    }
    reposition();
  }

  window.NotionPopover = { open, close, reposition, searchField, esc, normalize };
  window.openNotionDropdown = openNotionDropdown;
  window.closeNotionDropdown = close;
})();
