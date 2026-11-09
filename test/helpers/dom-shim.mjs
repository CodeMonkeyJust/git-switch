/**
 * Minimal DOM shim so the GUI's ES modules can be executed in Node and their
 * behaviour asserted. Deliberately small: just enough surface for
 * web/src/dom.js, the views and main.js.
 *
 * This catches runtime errors a static check cannot: a missing function, a wrong
 * call signature, an undefined property during render — the causes of a blank
 * page in the browser.
 */

class DomNode {
  constructor(tag = '#text') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.className = '';
    this._text = '';
    this.parentNode = null;
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      const child = typeof n === 'string' ? createText(n) : n;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(n) {
    this.append(n);
    return n;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    return n;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (!list) return;
    this.listeners[type] = list.filter((f) => f !== fn);
  }

  dispatchEvent(event) {
    for (const fn of this.listeners[event.type] ?? []) fn.call(this, event);
    return true;
  }

  querySelector(selector) {
    return this._find((n) => matchesSelector(n, selector), true);
  }

  querySelectorAll(selector) {
    return this._find((n) => matchesSelector(n, selector), false);
  }

  /** Walk up through parents until one matches. Requires `parentNode`. */
  closest(selector) {
    let node = this;
    while (node) {
      if (node.nodeType === 1 && matchesSelector(node, selector)) return node;
      node = node.parentNode ?? null;
    }
    return null;
  }

  _find(predicate, firstOnly) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName === '#TEXT') continue;
        if (predicate(child)) {
          out.push(child);
          if (firstOnly) return true;
        }
        if (walk(child)) return true;
      }
      return false;
    };
    walk(this);
    return firstOnly ? (out[0] ?? null) : out;
  }

  get textContent() {
    if (this.tagName === '#TEXT') return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    if (this.tagName === '#TEXT') {
      this._text = String(value);
      return;
    }
    this.children = [createText(String(value))];
  }

  get isConnected() {
    return true;
  }

  get nodeType() {
    return this.tagName === '#TEXT' ? 3 : 1;
  }
}

function createText(text) {
  const n = new DomNode('#text');
  n._text = String(text);
  return n;
}

function matchesSelector(node, selector) {
  const simple = selector.trim();
  if (simple.startsWith('.')) return node.className.split(/\s+/).includes(simple.slice(1));
  if (simple.startsWith('#')) return node.attributes.id === simple.slice(1);
  if (simple.startsWith('[')) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(simple);
    if (!m) return false;
    const [, name, value] = m;
    if (!(name in node.attributes)) return false;
    return value === undefined || node.attributes[name] === value;
  }
  const [tag, cls] = simple.split('.');
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (cls) return node.className.split(/\s+/).includes(cls);
  return true;
}

/**
 * Install the shim as globals and expose the `#main` + `#status` skeleton the
 * application code expects. Returns handles for assertions.
 */
export function installDom(html = {}) {
  const main = new DomNode('main');
  main.setAttribute('id', 'main');

  const status = new DomNode('div');
  status.setAttribute('id', 'status');

  const tabs = (html.tabs ?? ['overview', 'rules', 'preview', 'doctor']).map((view) => {
    const tab = new DomNode('button');
    tab.className = 'tab';
    tab.setAttribute('data-view', view);
    tab.dataset.view = view;
    return tab;
  });

  const body = new DomNode('body');
  body.append(main, status, ...tabs);

  const document = {
    body,
    createElement: (tag) => new DomNode(tag),
    createTextNode: (text) => createText(text),
    getElementById: (id) => body._find((n) => n.attributes.id === id, true),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };

  globalThis.document = document;
  globalThis.Node = DomNode;
  globalThis.window = globalThis;
  if (!globalThis.location) {
    globalThis.location = { hash: '', href: 'http://127.0.0.1/' };
  }

  return { document, Node: DomNode, main, status, tabs, body };
}

export { DomNode, createText, matchesSelector };
