/**
 * Injected into px0's own document (the iframe body) by the Host proxy.
 *
 * px0 exposes no extension API, so this script observes its two context menus
 * and appends an "insert into the composer" item to each:
 *   - `#tree-menu`  (file tree right-click)  -> `@file:<path>`
 *   - `#diff-menu`  (code selection)         -> `@file:<path> lines:<range>`
 *
 * The reference is posted to the parent DSH page, which owns the composer and
 * inserts it; this document never touches DSH state directly.
 */
export const PX0_EXTRAS_SCRIPT = String.raw`
(function () {
  if (window.__dshPx0Extras) return;
  window.__dshPx0Extras = true;

  var TREE_MENU = '#tree-menu';
  var SEL_MENU = '#sel-menu';
  var ITEM_CLASS = 'sel-menu-item';
  var MARK = 'data-dsh-insert';

  /** Post one reference request to the DSH page. */
  function requestInsert(text) {
    if (!text) return;
    try {
      window.parent.postMessage({ type: 'dsh-px0:insert', text: text }, window.location.origin);
    } catch (e) { /* parent gone */ }
  }

  /**
   * The open file's path. px0 drops the path query from the URL once it loads a
   * file (it navigates to a clean base path), so the selected tree row is the
   * durable source. The URL query only covers the first paint.
   */
  function currentPath() {
    try {
      var url = new URL(window.location.href);
      var fromQuery = url.searchParams.get('path');
      if (fromQuery) return fromQuery;
    } catch (e) { /* ignore */ }
    var selected = document.querySelector('#side .tr.file.sel[data-file]');
    if (selected) return selected.getAttribute('data-file') || '';
    var tab = document.querySelector('.tab.active[data-path], .tab[data-path]');
    return tab ? tab.getAttribute('data-path') || '' : '';
  }

  /**
   * Resolve one DOM range into line/column numbers within px0's virtualised
   * code view. Columns are measured in characters from the row's first glyph.
   * @param range a live selection range
   */
  function selectionRange(range) {
    if (!range) return null;

    /** The data-l row containing a node. */
    function rowOf(node) {
      var el = node.nodeType === 1 ? node : node.parentElement;
      return el && el.closest ? el.closest('.row[data-l]') : null;
    }
    /** Character offset of (node, offset) within its row's code cell, 1-based. */
    function colOf(node, offset) {
      var row = rowOf(node);
      if (!row) return 1;
      var cell = row.querySelector('.c') || row;
      try {
        var r = document.createRange();
        r.selectNodeContents(cell);
        r.setEnd(node, offset);
        return r.toString().length + 1;
      } catch (e) {
        return 1;
      }
    }

    var startRow = rowOf(range.startContainer);
    var endRow = rowOf(range.endContainer);
    if (!startRow || !endRow) return null;
    return {
      fromLine: Number(startRow.getAttribute('data-l')),
      fromCol: colOf(range.startContainer, range.startOffset),
      toLine: Number(endRow.getAttribute('data-l')),
      toCol: colOf(range.endContainer, range.endOffset),
    };
  }

  /** The reference text for a code selection captured before the menu opened. */
  function selectionRef() {
    var path = currentPath();
    var r = lastSelection;
    if (!path) return '';
    if (!r) return '@file:' + path;
    if (r.fromLine === r.toLine && r.fromCol === r.toCol) {
      return '@file:' + path + ' lines:' + r.fromLine + ':' + r.fromCol;
    }
    return '@file:' + path + ' lines:' + r.fromLine + ':' + r.fromCol + '-' + r.toLine + ':' + r.toCol;
  }

  /** Build one menu row matching px0's own item markup. */
  function makeItem(label, hint, onClick) {
    var btn = document.createElement('button');
    btn.className = ITEM_CLASS;
    btn.setAttribute(MARK, '');
    btn.setAttribute('role', 'menuitem');
    var text = document.createElement('span');
    text.textContent = label;
    if (hint) {
      text.appendChild(document.createElement('br'));
      var small = document.createElement('span');
      small.style.opacity = '0.6';
      small.style.fontSize = '11px';
      small.textContent = hint;
      text.appendChild(small);
    }
    btn.appendChild(text);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onClick();
      var menu = btn.parentElement;
      if (menu) menu.hidden = true;
    });
    return btn;
  }

  /** Append the tree-menu item once, whenever that menu is populated. */
  function augmentTreeMenu(menu) {
    if (menu.querySelector('[' + MARK + ']')) return;
    if (!treeTarget.path || treeTarget.isDir) return;
    var ref = '@file:' + treeTarget.path;
    menu.appendChild(makeItem('Insert reference into composer', ref, function () { requestInsert(ref); }));
  }

  /**
   * The selection captured before a right-click, already resolved to line and
   * column numbers. px0 clears the DOM selection while opening its menu and may
   * re-render rows, which invalidates a cloned Range, so the numbers are taken
   * while the live selection still points at real nodes.
   */
  var lastSelection = null;

  /** Resolve the live selection into line/column numbers, or null when empty. */
  function captureSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { lastSelection = null; return; }
    lastSelection = selectionRange(sel.getRangeAt(0));
  }

  /**
   * Add our item to px0's own selection menu.
   *
   * px0 rebuilds that menu with replaceChildren() and then reveals it, so
   * anything appended before that rebuild is lost. This runs from a
   * MutationObserver after the rebuild settles and only appends, never
   * clearing: px0's own entries stay untouched.
   * @param menu the #diff-menu element
   */
  function augmentDiffMenu(menu) {
    if (menu.querySelector('[' + MARK + ']')) return;
    var ref = selectionRef();
    if (!ref) return;
    menu.appendChild(makeItem('Insert reference into composer', ref, function () { requestInsert(ref); }));
  }

  /**
   * px0 only opens its selection menu when its own selection state is set.
   * When ours is the only entry the menu is shown on demand, positioned the
   * way px0 positions its own, using px0's markup so it looks native.
   */
  function openNativeMenu(x, y) {
    var menu = document.querySelector(SEL_MENU);
    if (!menu) return;
    if (menu.querySelector('[' + MARK + ']')) return;
    var ref = selectionRef();
    if (!ref) return;
    menu.appendChild(makeItem('Insert reference into composer', ref, function () { requestInsert(ref); }));
    menu.hidden = false;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, x + w > window.innerWidth - 4 ? x - w : x) + 'px';
    menu.style.top = Math.max(4, y + h > window.innerHeight - 4 ? y - h : y) + 'px';
  }

  /**
   * Observe a px0 menu and re-append our entry every time px0 rebuilds it.
   * px0 clears the menu with replaceChildren() and then reveals it, so the
   * append waits one frame after the reveal: by then its own entries are in
   * place and nothing else will clear them for this open.
   */
  function watch(selector, augment) {
    var menu = document.querySelector(selector);
    if (!menu) return;
    var scheduled = false;
    var run = function () {
      if (menu.hidden || menu.children.length === 0) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        if (!menu.hidden && menu.children.length > 0) augment(menu);
      });
    };
    new MutationObserver(run).observe(menu, { childList: true, attributes: true, attributeFilter: ['hidden'] });
    run();
  }

  /**
   * Capture the selection and the tree row before px0 rebuilds its menus, then
   * offer the item in px0's own selection menu for a code-area right-click.
   */
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 2) return;
    captureSelection();
    var row = e.target && e.target.closest ? e.target.closest('[data-file], [data-dir]') : null;
    if (!row) { treeTarget = { path: '', isDir: false }; return; }
    var file = row.getAttribute('data-file');
    var dir = row.getAttribute('data-dir');
    treeTarget = file
      ? { path: file, isDir: false }
      : { path: dir || '', isDir: true };
  }, true);

  document.addEventListener('contextmenu', function (e) {
    // A right-click inside the file tree belongs to px0's own tree menu, which
    // the tree augmenter extends; anywhere else in the code view gets ours.
    var inTree = !!(e.target && e.target.closest && e.target.closest('[data-file], [data-dir]'));
    if (inTree) return;
    var x = e.clientX, y = e.clientY;
    // Let px0's own handler run first: when it opens the menu, its items are
    // there and the augmenter appends to them; otherwise ours opens alone.
    setTimeout(function () { openNativeMenu(x, y); }, 0);
  }, true);

  function boot() {
    watch(TREE_MENU, augmentTreeMenu);
    watch(SEL_MENU, augmentDiffMenu);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
