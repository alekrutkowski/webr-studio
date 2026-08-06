import {
  $, debounce, downloadBlob, downloadText, escapeHtml, inferColumnType,
  parseDelimited, basename, copyText
} from './utils.js?v=1.2.11';

function buttonIcon(id, className = '') {
  const classes = ['ui-icon', className].filter(Boolean).join(' ');
  return `<svg class="${classes}" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

function csvEscape(value, delimiter = ',') {
  const text = value == null ? '' : String(value);
  if (text.includes('"') || text.includes('\n') || text.includes(delimiter)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export class DataViewer {
  constructor({ container, engine, callbacks = {} }) {
    this.container = container;
    this.engine = engine;
    this.callbacks = callbacks;
    this.source = null;
    this.info = null;
    this.viewKind = '';
    this.treeRecords = [];
    this.treeFilter = '';
    this.state = this.defaultState();
    this.localRows = [];
    this.localColumns = [];
    this.localFiltered = [];
    this.loadingToken = 0;
    this.pendingRefresh = false;
    this.history = [];
    this.historyIndex = -1;
    this.refreshDebounced = debounce(() => this.refresh(), 260);
    this.treeFilterDebounced = debounce(() => this.renderTree(), 100);
    this.engine?.addEventListener?.('state', event => {
      if (event.detail?.state !== 'ready' || !this.pendingRefresh) return;
      this.pendingRefresh = false;
      this.refresh();
    });
  }

  defaultState() {
    return {
      page: 1,
      pageSize: 100,
      globalFilter: '',
      columnFilters: {},
      sortColumn: '',
      sortDirection: 'asc'
    };
  }

  resetState() {
    this.state = this.defaultState();
    this.treeFilter = '';
  }

  clear() {
    this.source = null;
    this.info = null;
    this.viewKind = '';
    this.treeRecords = [];
    this.localRows = [];
    this.localColumns = [];
    this.localFiltered = [];
    this.history = [];
    this.historyIndex = -1;
    this.container.className = 'data-viewer empty-state';
    this.container.innerHTML = `${buttonIcon('i-table')}<p>Open a data frame, list, environment, CSV, or TSV file to inspect it.</p>`;
    this.callbacks.onTitle?.('Data viewer');
  }

  remember(entry) {
    const current = this.history[this.historyIndex];
    const same = current && current.kind === entry.kind && current.name === entry.name && current.path === entry.path;
    if (same) {
      this.history[this.historyIndex] = entry;
      return;
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(entry);
    if (this.history.length > 60) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  async navigateHistory(direction) {
    const target = this.historyIndex + direction;
    if (target < 0 || target >= this.history.length) return;
    this.historyIndex = target;
    const entry = this.history[target];
    if (entry.kind === 'r') await this.openObject(entry.name, entry.displayName, { history: false });
    else await this.openDelimited(entry.path, entry.text, entry.delimiter, { history: false });
  }

  async openObject(name, displayName = name, { history = true } = {}) {
    if (!this.engine?.ready) return this.renderError('The webR runtime is not ready.');
    if (this.engine.running) return this.renderError('R is busy. Reopen this object after the current operation finishes.');
    this.source = { kind: 'r', name, displayName };
    this.resetState();
    this.renderLoading(`Opening ${displayName}…`);
    try {
      const objectInfo = await this.engine.getViewerObjectInfo(name);
      this.info = { ...objectInfo, name: displayName };
      this.viewKind = objectInfo.kind;
      if (history) this.remember({ kind: 'r', name, displayName });
      if (objectInfo.kind === 'data') {
        this.info = { ...await this.engine.getDataFrameInfo(name), ...objectInfo, name: displayName };
        await this.refresh();
      } else {
        this.treeRecords = await this.engine.getObjectTree(name);
        const root = this.treeRecords.find(record => record.id === 'root');
        if (root) root.label = displayName;
        this.renderTree();
      }
      this.callbacks.onTitle?.(displayName);
    } catch (error) {
      this.renderError(error.message);
    }
  }

  async openDelimited(path, text, delimiter = ',', { history = true } = {}) {
    this.source = { kind: 'local', path, delimiter, displayName: basename(path) };
    this.viewKind = 'data';
    this.resetState();
    this.renderLoading(`Parsing ${basename(path)}…`);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    try {
      const rows = parseDelimited(text, delimiter, 50001);
      const header = rows.shift() || [];
      const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), header.length);
      this.localColumns = Array.from({ length: width }, (_, index) => ({
        name: header[index] || `V${index + 1}`,
        ...(() => {
          const type = inferColumnType(rows.slice(0, 500).map(row => row[index] ?? ''));
          return { className: type, type };
        })()
      }));
      this.localRows = rows.map((values, index) => ({
        index: index + 1,
        values: Array.from({ length: width }, (_, column) => values[column] ?? '')
      }));
      this.info = {
        name: basename(path),
        kind: 'data',
        rows: this.localRows.length,
        columns: width,
        columnInfo: this.localColumns,
        truncated: rows.length >= 50000
      };
      this.applyLocalFilters();
      if (history) this.remember({ kind: 'local', path, text, delimiter, displayName: basename(path) });
      this.render();
      this.callbacks.onTitle?.(basename(path));
    } catch (error) {
      this.renderError(error.message);
    }
  }

  async refresh() {
    if (!this.source || !this.info) return;
    if (this.viewKind !== 'data') {
      if (this.source.kind !== 'r') return;
      if (this.engine.running) {
        this.pendingRefresh = true;
        return;
      }
      this.renderLoading(`Refreshing ${this.source.displayName || this.source.name}…`);
      try {
        this.treeRecords = await this.engine.getObjectTree(this.source.name);
        const root = this.treeRecords.find(record => record.id === 'root');
        if (root) root.label = this.source.displayName || this.source.name;
        this.renderTree();
      } catch (error) {
        this.renderError(error.message);
      }
      return;
    }

    this.state.page = Math.max(1, this.state.page);
    if (this.source.kind === 'local') {
      this.applyLocalFilters();
      this.render();
      return;
    }
    if (this.engine.running) {
      this.pendingRefresh = true;
      this.setGridBusy(false);
      return;
    }
    const token = ++this.loadingToken;
    this.setGridBusy(true);
    try {
      const page = await this.engine.getDataFramePage(this.source.name, this.state);
      if (token !== this.loadingToken) return;
      this.currentPage = page;
      const pages = Math.max(1, Math.ceil(page.filteredRows / page.pageSize));
      if (this.state.page > pages) {
        this.state.page = pages;
        return this.refresh();
      }
      this.render();
    } catch (error) {
      this.renderError(error.message);
    }
  }

  applyLocalFilters() {
    const globalFilter = this.state.globalFilter.toLocaleLowerCase();
    const filters = Object.entries(this.state.columnFilters).filter(([, value]) => value !== '');
    let rows = this.localRows.filter(row => {
      if (globalFilter && !row.values.some(value => String(value).toLocaleLowerCase().includes(globalFilter))) return false;
      return filters.every(([columnName, query]) => {
        const index = this.localColumns.findIndex(column => column.name === columnName);
        return index < 0 || String(row.values[index]).toLocaleLowerCase().includes(String(query).toLocaleLowerCase());
      });
    });
    if (this.state.sortColumn) {
      const index = this.localColumns.findIndex(column => column.name === this.state.sortColumn);
      const type = this.localColumns[index]?.type;
      const direction = this.state.sortDirection === 'desc' ? -1 : 1;
      rows = [...rows].sort((left, right) => {
        const a = left.values[index];
        const b = right.values[index];
        if (type === 'numeric') return ((Number(a) || 0) - (Number(b) || 0)) * direction;
        return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }) * direction;
      });
    }
    this.localFiltered = rows;
    const pageSize = this.state.pageSize;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    this.state.page = Math.min(pages, Math.max(1, this.state.page));
    const start = (this.state.page - 1) * pageSize;
    this.currentPage = {
      totalRows: this.localRows.length,
      filteredRows: rows.length,
      page: this.state.page,
      pageSize,
      rows: rows.slice(start, start + pageSize)
    };
  }

  renderLoading(message) {
    this.container.className = 'data-viewer empty-state';
    this.container.innerHTML = `<span class="status-dot"></span><p>${escapeHtml(message)}</p>`;
  }

  renderError(message) {
    this.container.className = 'data-viewer empty-state';
    this.container.innerHTML = `<span style="font-size:24px">🧯</span><p>${escapeHtml(message)}</p>`;
  }

  setGridBusy(busy) {
    this.container.toggleAttribute('aria-busy', busy);
  }

  historyControls(title) {
    return `<span class="viewer-history-controls">
      <button class="mini-icon" data-history="back" title="Previous view" aria-label="Previous view" ${this.historyIndex <= 0 ? 'disabled' : ''}>${buttonIcon('i-chevron', 'flip-x')}</button>
      <button class="mini-icon" data-history="forward" title="Next view" aria-label="Next view" ${this.historyIndex >= this.history.length - 1 ? 'disabled' : ''}>${buttonIcon('i-chevron')}</button>
    </span><span class="viewer-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>`;
  }

  bindHistoryControls(toolbar) {
    $('[data-history="back"]', toolbar)?.addEventListener('click', () => this.navigateHistory(-1));
    $('[data-history="forward"]', toolbar)?.addEventListener('click', () => this.navigateHistory(1));
  }

  render() {
    if (!this.info || !this.currentPage) return;
    this.container.className = 'data-viewer active';
    this.container.replaceChildren(this.renderToolbar(), this.renderGrid(), this.renderFooter());
    this.setGridBusy(false);
  }

  renderToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'data-toolbar viewer-toolbar';
    toolbar.innerHTML = `
      ${this.historyControls(this.info.name || this.source?.displayName || 'Data')}
      <div class="input-with-icon small"><svg class="ui-icon"><use href="#i-filter"></use></svg><input type="search" data-role="global-filter" placeholder="Filter all columns" value="${escapeHtml(this.state.globalFilter)}"></div>
      <select data-role="page-size" aria-label="Rows per page">
        ${[25, 50, 100, 250, 500].map(value => `<option value="${value}" ${this.state.pageSize === value ? 'selected' : ''}>${value} rows</option>`).join('')}
      </select>
      <button class="button secondary compact" data-action="copy">${buttonIcon('i-copy')}<span>Copy page</span></button>
      <button class="button secondary compact" data-action="export">${buttonIcon('i-download')}<span>Export CSV</span></button>
      <span class="data-meta">${this.info.columns.toLocaleString()} columns${this.info.truncated ? ' · preview limited to 50,000 rows' : ''}</span>`;
    this.bindHistoryControls(toolbar);
    const input = $('[data-role="global-filter"]', toolbar);
    input.addEventListener('input', event => {
      this.state.globalFilter = event.target.value;
      this.state.page = 1;
      this.refreshDebounced();
    });
    $('[data-role="page-size"]', toolbar).addEventListener('change', event => {
      this.state.pageSize = Number(event.target.value);
      this.state.page = 1;
      this.refresh();
    });
    $('[data-action="copy"]', toolbar).addEventListener('click', () => this.copyCurrentPage());
    $('[data-action="export"]', toolbar).addEventListener('click', () => this.exportCsv());
    return toolbar;
  }

  renderTree() {
    this.container.className = 'data-viewer active';
    const toolbar = document.createElement('div');
    toolbar.className = 'data-toolbar viewer-toolbar';
    const rootRecord = this.treeRecords.find(record => record.id === 'root');
    const rootKind = rootRecord?.className || rootRecord?.type || 'object';
    const entryCount = rootRecord?.childCount || 0;
    const treeMeta = entryCount
      ? `${rootKind} · ${entryCount.toLocaleString()} ${entryCount === 1 ? 'entry' : 'entries'}`
      : [rootKind, rootRecord?.dimensions].filter(Boolean).join(' · ');
    toolbar.innerHTML = `
      ${this.historyControls(this.info?.name || this.source?.displayName || this.source?.name || 'Object')}
      <div class="input-with-icon small tree-toolbar-filter"><svg class="ui-icon"><use href="#i-filter"></use></svg><input type="search" data-role="tree-filter" placeholder="Filter names, types, and values" value="${escapeHtml(this.treeFilter)}"></div>
      <button class="button secondary compact" data-action="expand-tree">${buttonIcon('i-tree')}<span>Expand</span></button>
      <button class="button secondary compact" data-action="collapse-tree"><span>Collapse</span></button>
      <button class="mini-icon" data-action="refresh-tree" title="Refresh object">${buttonIcon('i-refresh')}</button>
      <span class="data-meta">${escapeHtml(treeMeta)}</span>`;
    this.bindHistoryControls(toolbar);
    $('[data-role="tree-filter"]', toolbar).addEventListener('input', event => {
      this.treeFilter = event.target.value;
      this.treeFilterDebounced();
    });

    const tree = document.createElement('div');
    tree.className = 'data-tree';
    const records = this.filteredTreeRecords();
    const byParent = new Map();
    for (const record of records) {
      if (!byParent.has(record.parent)) byParent.set(record.parent, []);
      byParent.get(record.parent).push(record);
    }
    const build = parent => {
      const fragment = document.createDocumentFragment();
      for (const record of byParent.get(parent) || []) {
        const hasVisibleChildren = (byParent.get(record.id) || []).length > 0;
        if (record.expandable && hasVisibleChildren) {
          const details = document.createElement('details');
          details.className = 'tree-node';
          details.open = record.depth < 2 || Boolean(this.treeFilter);
          const summary = document.createElement('summary');
          summary.innerHTML = this.treeRowHtml(record);
          details.append(summary);
          const children = document.createElement('div');
          children.className = 'tree-children';
          children.append(build(record.id));
          details.append(children);
          fragment.append(details);
        } else {
          const row = document.createElement('div');
          row.className = 'tree-leaf';
          row.innerHTML = this.treeRowHtml(record);
          fragment.append(row);
        }
      }
      return fragment;
    };
    const visibleRoot = records.find(record => record.id === 'root');
    const hideContainerRoot = Boolean(visibleRoot?.expandable && (byParent.get('root') || []).length);
    tree.append(build(hideContainerRoot ? 'root' : ''));
    if (!tree.childNodes.length) tree.innerHTML = '<div class="tree-empty">No list entries match this filter.</div>';

    $('[data-action="expand-tree"]', toolbar).addEventListener('click', () => tree.querySelectorAll('details').forEach(item => { item.open = true; }));
    $('[data-action="collapse-tree"]', toolbar).addEventListener('click', () => tree.querySelectorAll('details').forEach(item => { item.open = false; }));
    $('[data-action="refresh-tree"]', toolbar).addEventListener('click', () => this.refresh());
    this.container.replaceChildren(toolbar, tree);
    this.setGridBusy(false);
  }

  filteredTreeRecords() {
    const query = this.treeFilter.trim().toLocaleLowerCase();
    if (!query) return this.treeRecords;
    const byId = new Map(this.treeRecords.map(record => [record.id, record]));
    const root = byId.get('root');
    const rootText = root ? `${root.label} ${root.type} ${root.className} ${root.dimensions} ${root.preview}`.toLocaleLowerCase() : '';
    if (rootText.includes(query)) return this.treeRecords;
    const included = new Set();
    for (const record of this.treeRecords) {
      const haystack = `${record.label} ${record.type} ${record.className} ${record.dimensions} ${record.preview}`.toLocaleLowerCase();
      if (!haystack.includes(query)) continue;
      let current = record;
      while (current) {
        included.add(current.id);
        current = current.parent ? byId.get(current.parent) : null;
      }
    }
    return this.treeRecords.filter(record => included.has(record.id));
  }

  treeRowHtml(record) {
    const type = record.className || record.type || 'object';
    const meta = [type, record.dimensions, record.cyclic ? 'recursive reference' : ''].filter(Boolean).join(' · ');
    return `<span class="tree-name" title="${escapeHtml(record.label)}">${escapeHtml(record.label)}</span><span class="tree-kind" title="${escapeHtml(meta)}">${escapeHtml(meta)}</span><span class="tree-preview" title="${escapeHtml(record.preview)}">${escapeHtml(record.preview)}</span>`;
  }

  renderGrid() {
    const wrapper = document.createElement('div');
    wrapper.className = 'data-grid-wrap';
    const table = document.createElement('table');
    table.className = 'data-grid';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const rowNumberHeader = document.createElement('th');
    rowNumberHeader.className = 'row-number';
    rowNumberHeader.textContent = '#';
    headerRow.append(rowNumberHeader);
    for (const column of this.info.columnInfo) {
      const th = document.createElement('th');
      th.title = `${column.name} · ${column.className}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'column-header';
      button.style.cssText = 'width:100%;height:100%;border:0;background:transparent;text-align:left;color:inherit;padding:0;';
      const direction = this.state.sortColumn === column.name ? (this.state.sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
      button.innerHTML = `<span class="column-name">${escapeHtml(column.name)}${direction}</span><span class="type-chip">${escapeHtml(this.shortType(column.type || column.className))}</span>`;
      button.addEventListener('click', () => this.toggleSort(column.name));
      th.append(button);
      headerRow.append(th);
    }
    thead.append(headerRow);
    const filterRow = document.createElement('tr');
    filterRow.className = 'data-filter-row';
    const filterCorner = document.createElement('th');
    filterCorner.className = 'row-number';
    filterCorner.innerHTML = buttonIcon('i-filter');
    filterRow.append(filterCorner);
    for (const column of this.info.columnInfo) {
      const th = document.createElement('th');
      const input = document.createElement('input');
      input.type = 'search';
      input.placeholder = 'Filter';
      input.value = this.state.columnFilters[column.name] || '';
      input.setAttribute('aria-label', `Filter ${column.name}`);
      input.addEventListener('input', event => {
        this.state.columnFilters[column.name] = event.target.value;
        this.state.page = 1;
        this.refreshDebounced();
      });
      th.append(input);
      filterRow.append(th);
    }
    thead.append(filterRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const row of this.currentPage.rows) {
      const tr = document.createElement('tr');
      const rowNumber = document.createElement('td');
      rowNumber.className = 'row-number';
      rowNumber.textContent = row.index.toLocaleString();
      tr.append(rowNumber);
      row.values.forEach((value, index) => {
        const td = document.createElement('td');
        const type = this.info.columnInfo[index]?.type || this.info.columnInfo[index]?.className;
        td.classList.toggle('numeric', /double|integer|numeric/.test(type));
        td.classList.toggle('na', value === 'NA');
        td.textContent = value;
        td.title = value;
        td.tabIndex = 0;
        td.addEventListener('dblclick', () => {
          copyText(value);
          this.callbacks.onNotify?.('Cell copied to the clipboard.');
        });
        tr.append(td);
      });
      tbody.append(tr);
    }
    if (!this.currentPage.rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = this.info.columnInfo.length + 1;
      td.style.cssText = 'height:90px;text-align:center;color:var(--text-subtle);';
      td.textContent = 'No rows match the current filters.';
      tr.append(td);
      tbody.append(tr);
    }
    table.append(tbody);
    wrapper.append(table);
    return wrapper;
  }

  renderFooter() {
    const footer = document.createElement('div');
    footer.className = 'data-footer';
    const pages = Math.max(1, Math.ceil(this.currentPage.filteredRows / this.currentPage.pageSize));
    footer.innerHTML = `
      <button class="mini-icon" data-page="first" title="First page">${buttonIcon('i-chevron', 'flip-x')}</button>
      <button class="mini-icon" data-page="previous" title="Previous page">${buttonIcon('i-chevron', 'flip-x')}</button>
      <span class="page-info">Page ${this.state.page.toLocaleString()} of ${pages.toLocaleString()}</span>
      <button class="mini-icon" data-page="next" title="Next page">${buttonIcon('i-chevron')}</button>
      <button class="mini-icon" data-page="last" title="Last page">${buttonIcon('i-chevron')}</button>
      <span class="page-info">${this.currentPage.filteredRows.toLocaleString()} of ${this.currentPage.totalRows.toLocaleString()} rows</span>`;
    const buttons = [...footer.querySelectorAll('[data-page]')];
    buttons.forEach(button => button.addEventListener('click', () => {
      const action = button.dataset.page;
      if (action === 'first') this.state.page = 1;
      if (action === 'previous') this.state.page = Math.max(1, this.state.page - 1);
      if (action === 'next') this.state.page = Math.min(pages, this.state.page + 1);
      if (action === 'last') this.state.page = pages;
      this.refresh();
    }));
    buttons[0].disabled = buttons[1].disabled = this.state.page <= 1;
    buttons[2].disabled = buttons[3].disabled = this.state.page >= pages;
    return footer;
  }

  shortType(type) {
    if (/double|numeric/.test(type)) return 'dbl';
    if (/integer/.test(type)) return 'int';
    if (/logical/.test(type)) return 'lgl';
    if (/factor/.test(type)) return 'fct';
    if (/date|posix/i.test(type)) return 'date';
    return 'chr';
  }

  toggleSort(column) {
    if (this.state.sortColumn === column) this.state.sortDirection = this.state.sortDirection === 'asc' ? 'desc' : 'asc';
    else {
      this.state.sortColumn = column;
      this.state.sortDirection = 'asc';
    }
    this.state.page = 1;
    this.refresh();
  }

  async copyCurrentPage() {
    const delimiter = '\t';
    const text = [
      this.info.columnInfo.map(column => column.name).join(delimiter),
      ...this.currentPage.rows.map(row => row.values.join(delimiter))
    ].join('\n');
    await copyText(text);
    this.callbacks.onNotify?.('Visible rows copied as tab-separated text.');
  }

  async exportCsv() {
    try {
      if (this.viewKind !== 'data') throw new Error('The current Viewer page is not tabular.');
      if (this.source.kind === 'r') {
        if (this.engine.running) throw new Error('R is busy. Export the table after the current operation finishes.');
        const bytes = await this.engine.exportDataFrameCsv(this.source.name);
        downloadBlob(new Blob([bytes], { type: 'text/csv' }), `${this.source.displayName || this.source.name}.csv`);
      } else {
        const rows = [
          this.localColumns.map(column => column.name),
          ...this.localFiltered.map(row => row.values)
        ];
        const text = rows.map(row => row.map(value => csvEscape(value)).join(',')).join('\n');
        downloadText(text, `${basename(this.source.path).replace(/\.(csv|tsv)$/i, '')}-filtered.csv`, 'text/csv;charset=utf-8');
      }
    } catch (error) {
      this.callbacks.onError?.(error);
    }
  }
}
