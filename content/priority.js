// content/priority.js
// Classic-script module. Exports: ns.priority
//
// This module answers two questions about a text node and nothing else:
//
//   1. WHEN should it be translated? The reader came for the article body, so
//      that goes first; headings give the body structure and follow; menus,
//      headers, footers and sidebars are page chrome and can wait; whatever
//      could not be placed at all is last. Inside one class the viewport band
//      (visible -> near -> rest) still decides, so the first answer always
//      lands on text that is on screen — and inside one band the position on the
//      page decides, so a page fills in from the top downwards and the reader
//      can start reading while the bottom is still on its way.
//
//   2. IS it worth translating yet? Text the user cannot see (display:none,
//      visibility:hidden, [hidden]) is held back: a closed dropdown, a modal and
//      a mobile menu repeat the page several times over, and the hidden copy is
//      not text anybody is reading. It is translated when it is displayed.
//
// Both answers come from element structure and CSS — never from the text
// itself, which is the segmenter's and the model's business. Everything here is
// duck-typed (tagName/getAttribute/parentNode only) so it also runs against the
// mini DOM in test/dom.test.cjs.
(function () {
  var ns = (globalThis.__PLAMO__ = globalThis.__PLAMO__ || {});
  var log = ns.logger.log;
  var C = ns.constants || {};
  var ROLES = C.PRIORITY_ROLES || ['content', 'heading', 'navigation', 'other'];
  var PRIORITY = C.PRIORITY_SETTINGS || {};

  // A text node below one of these is "page chrome" however deep it sits.
  var NAV_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'MENU']);
  var ARIA_NAV = new Set(['navigation', 'menu', 'menubar', 'tablist', 'toolbar', 'search',
    'banner', 'contentinfo', 'complementary']);
  // The article itself. <section>/<div> are not on this list: they are everywhere.
  var CONTENT_TAGS = new Set(['MAIN', 'ARTICLE']);
  var ARIA_CONTENT = new Set(['main', 'article', 'feed']);
  var HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  // Class/id words. '-' and '_' count as word separators here, so 'main-nav'
  // matches the nav list — which is what we want, because the nav check runs
  // first and page chrome always wins over a region marker.
  var NAV_CLASS_RE = /(^|[-_ ])(nav|navs|navbar|navigation|menu|menus|menubar|submenu|sidebar|sidemenu|sidenav|breadcrumb|breadcrumbs|footer|header|topbar|bottombar|toolbar|tabs|tabbar|toc|pagination|share|social)([-_ ]|$)/i;
  var CONTENT_CLASS_RE = /(^|[-_ ])(article|articles|post|posts|entry|hentry|story|prose|content|contents|description|summary|caption)([-_ ]|$)/i;
  // No marker anywhere and a long run of words: that is body text even on a page
  // built out of anonymous <div>s, so it is not made to wait behind the menu.
  var PROSE_MIN_CHARS = 120;
  // A scan never asks the CSS more than this many questions; past that the
  // answer is "visible" (which is what every build before this one assumed).
  var MAX_HIDDEN_CHECKS = (PRIORITY.maxHiddenChecks != null) ? PRIORITY.maxHiddenChecks : 6000;

  var HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))/i;

  function tagNameOf(el) {
    return el && el.tagName ? String(el.tagName).toUpperCase() : '';
  }
  function getAttr(el, name) {
    if (!el || !el.getAttribute) return null;
    try { return el.getAttribute(name); } catch (e) { return null; }
  }
  function roleOfAria(el) {
    return String(getAttr(el, 'role') || '').toLowerCase().split(/\s+/)[0];
  }
  function classIdOf(el) {
    return String(getAttr(el, 'class') || '') + ' ' + String(getAttr(el, 'id') || '');
  }

  // What this element says about itself; '' when it says nothing.
  function elementRole(el) {
    var tag = tagNameOf(el);
    var aria = roleOfAria(el);
    if (HEADING_TAGS.has(tag) || aria === 'heading') return 'heading';
    if (NAV_TAGS.has(tag) || ARIA_NAV.has(aria) || NAV_CLASS_RE.test(classIdOf(el))) return 'navigation';
    if (CONTENT_TAGS.has(tag) || ARIA_CONTENT.has(aria) || CONTENT_CLASS_RE.test(classIdOf(el))) return 'content';
    return '';
  }

  // contextOf(roleMemo, el): the class of the region `el` sits in. Memoised per
  // run, so a page of 5000 text nodes costs one pass over the *elements*, not
  // nodes x depth. Navigation outranks everything — being inside a menu is
  // secondary whatever tag you are — otherwise the nearest marker wins.
  function contextOf(roleMemo, el) {
    if (!el || el.nodeType !== 1) return '';
    var known = roleMemo.get(el);
    if (known !== undefined) return known;
    var up = el.parentNode;
    var above = (up && up.nodeType === 1) ? contextOf(roleMemo, up) : '';
    var own = elementRole(el);
    var out;
    if (own === 'navigation' || above === 'navigation') out = 'navigation';
    else if (own) out = own;
    else out = above;
    roleMemo.set(el, out);
    return out;
  }

  function priorityOf(role) {
    var i = ROLES.indexOf(role);
    return i === -1 ? ROLES.length : i;
  }

  // One object per buildSegments() run: it owns the role memo, which must not
  // outlive the run (a page can move a node into another region at any time).
  function createContext() {
    return { roles: new Map(), stats: { elements: 0 } };
  }

  // -> { role, priority }. `text` is the node's own text, used only for the
  // "a long run of words is body text" fallback.
  function classify(ctx, el, text) {
    ctx = ctx || createContext();
    var before = ctx.roles.size;
    var region = contextOf(ctx.roles, el);
    ctx.stats.elements += ctx.roles.size - before;
    var role = region;
    if (!role) role = (String(text || '').length >= PROSE_MIN_CHARS) ? 'content' : 'other';
    return { role: role, priority: priorityOf(role) };
  }

  // --- is the user able to see this? ----------------------------------------
  // Attributes first (free), then computed style (one call per element, and
  // never for an element whose ancestor already hid it: a closed menu subtree
  // costs one lookup, not one per item).
  function hiddenByAttributes(el) {
    var hiddenAttr = getAttr(el, 'hidden');
    if (hiddenAttr !== null && String(hiddenAttr).toLowerCase() !== 'false') return true;
    var style = getAttr(el, 'style');
    if (style && HIDDEN_STYLE_RE.test(style)) return true;
    return false;
  }

  // root: the subtree that is ours; an element above it is not our business.
  // -> { hidden(el), visible(el), attached(el), hasComputedStyle, stats() }
  function createVisibility(root, opts) {
    opts = opts || {};
    var doc = root ? (root.ownerDocument || root)
      : (typeof document !== 'undefined' ? document : null);
    var win = (typeof window !== 'undefined' && window && window.getComputedStyle) ? window
      : (doc && doc.defaultView && doc.defaultView.getComputedStyle) ? doc.defaultView : null;
    var maxChecks = (opts.maxHiddenChecks != null) ? opts.maxHiddenChecks : MAX_HIDDEN_CHECKS;
    var stats = { elements: 0, styleLookups: 0, budgetHit: false, hiddenElements: 0 };
    var memo = new Map();

    function computedHidden(el) {
      if (!win) return false;
      if (stats.styleLookups >= maxChecks) {
        if (!stats.budgetHit) {
          stats.budgetHit = true;
          log.warn('visibility: stop asking the CSS after ' + maxChecks +
            ' element(s); the rest of this scan assumes visible (raise PRIORITY_SETTINGS.maxHiddenChecks)');
        }
        return false;
      }
      stats.styleLookups++;
      try {
        var cs = win.getComputedStyle(el);
        if (!cs) return false;
        if (cs.display === 'none') return true;
        var v = cs.visibility;
        return v === 'hidden' || v === 'collapse';
      } catch (e) {
        return false;
      }
    }

    function selfHidden(el) {
      stats.elements++;
      var res = hiddenByAttributes(el) || computedHidden(el);
      if (res) stats.hiddenElements++;
      return res;
    }

    function hidden(el) {
      if (!el || el.nodeType !== 1) return false;
      var seen = memo.get(el);
      if (seen !== undefined) return seen;
      var up = el.parentNode;
      // Ancestor first: that is what keeps a whole closed subtree at one lookup.
      var res = (up && up.nodeType === 1 && up !== root) ? hidden(up) : false;
      if (!res) res = selfHidden(el);
      memo.set(el, res);
      return res;
    }

    function visible(el) { return !!el && !hidden(el); }

    // A node the page took out of the document cannot be "displayed" again; it
    // is dropped from the pending list instead of being re-checked forever.
    function attached(el) {
      if (!el) return false;
      if (el.isConnected != null) return !!el.isConnected;
      if (doc && doc.contains) return doc.contains(el);
      return !!el.parentNode;
    }

    return {
      hidden: hidden,
      visible: visible,
      attached: attached,
      hasComputedStyle: !!win,
      stats: function () { return Object.assign({}, stats); }
    };
  }
  // --- ordering --------------------------------------------------------------
  // Text the user could not see at scan time goes last (and when it is being
  // held back for a later run, that is the only reason it is in the list at
  // all); then the class; then the viewport band; then where the text sits on
  // the page: `y` ascending, so within one region of the page the reader meets
  // the translations top-down instead of in whatever order the markup happens to
  // list them (flex `order`, a `column-reverse` card, a sidebar that comes first
  // in the source all make markup order and display order disagree), and `x`
  // breaks a tie on one line, left to right. Only two segments that were never
  // measured at all fall back to the order the extractor walked the tree
  // (Array#sort is stable) — a segment with no position goes after the ones that
  // have one, because nothing could tell where on the page it is.
  //
  // `topDown: false` ignores the position keys and stops at the viewport band:
  // the ordering of builds that trusted markup order.
  function hiddenFlag(s) { return (s && (s.hidden || s.deferred)) ? 1 : 0; }

  // Measured position, or null when there is none (a node with no layout).
  function coord(s, key) {
    var v = s && s[key];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  // null sorts last, so an unmeasured segment never jumps ahead of measured text.
  function compareCoords(a, b) {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  }

  var TOP_DOWN = (PRIORITY.topDown == null) ? true : PRIORITY.topDown !== false;

  // createCompare(opts) when a run has something to say about the order;
  // `compare` is the default comparator, ready for Array#sort.
  function createCompare(opts) {
    var topDown = (opts && opts.topDown != null) ? !!opts.topDown : TOP_DOWN;
    return function (a, b) {
      var ha = hiddenFlag(a);
      var hb = hiddenFlag(b);
      if (ha !== hb) return ha - hb;
      var pa = (a && a.priority != null) ? a.priority : ROLES.length;
      var pb = (b && b.priority != null) ? b.priority : ROLES.length;
      if (pa !== pb) return pa - pb;
      var va = (a && a.viewport) || 0;
      var vb = (b && b.viewport) || 0;
      if (va !== vb) return va - vb;
      if (!topDown) return 0;
      var y = compareCoords(coord(a, 'y'), coord(b, 'y'));
      if (y) return y;
      return compareCoords(coord(a, 'x'), coord(b, 'x'));
    };
  }

  var compare = createCompare();

  function sortSegments(segments, opts) {
    var cmp = (opts && opts.topDown != null) ? createCompare(opts) : compare;
    return (segments || []).slice().sort(cmp);
  }

  // What a run would send per class — the numbers to read when the ordering
  // looks wrong on a real page (see __plamo.getBatchPlan().roles). `hidden`
  // counts the segments whose text was not visible at scan time.
  function histogram(segments) {
    var out = {};
    ROLES.forEach(function (r) { out[r] = 0; });
    out.hidden = 0;
    (segments || []).forEach(function (s) {
      var key = (out[s.role] == null) ? 'other' : s.role;
      out[key] = (out[key] || 0) + 1;
      if (s.hidden) out.hidden++;
    });
    return out;
  }

  ns.priority = {
    ROLES: ROLES.slice(),
    createContext: createContext,
    classify: classify,
    elementRole: elementRole,
    priorityOf: priorityOf,
    createVisibility: createVisibility,
    hiddenByAttributes: hiddenByAttributes,
    compare: compare,
    createCompare: createCompare,
    sortSegments: sortSegments,
    histogram: histogram,
    PROSE_MIN_CHARS: PROSE_MIN_CHARS
  };
})();
