/**
 * Tiny DOM implementation — just enough to boot the ChatSync userscript in
 * Node and exercise its real code paths (panel, composer injection, code-block
 * toolbars, apply modal). Not a browser; a test double.
 */
'use strict';

const SELECTOR_PART = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/;

function parseSelectorPart(part) {
  const m = SELECTOR_PART.exec(part);
  if (!m) {
    return null;
  }
  const tag = m[1] ? m[1].toLowerCase() : null;
  const rest = m[2] || '';
  const classes = [];
  const ids = [];
  const attrs = [];
  const re = /([.#][\w-]+)|\[([^\]=]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\]/g;
  let mm;
  while ((mm = re.exec(rest))) {
    if (mm[1]) {
      if (mm[1][0] === '.') {
        classes.push(mm[1].slice(1));
      } else {
        ids.push(mm[1].slice(1));
      }
    } else {
      attrs.push({ name: mm[2].toLowerCase(), op: mm[3], value: mm[4] });
    }
  }
  return { tag, classes, ids, attrs };
}

function attrMatches(el, a) {
  const actual = el.getAttribute(a.name);
  if (actual === null) {
    return false;
  }
  if (!a.op) {
    return true;
  }
  const v = a.value ?? '';
  switch (a.op) {
    case '=':
      return actual === v;
    case '^=':
      return actual.startsWith(v);
    case '$=':
      return actual.endsWith(v);
    case '*=':
      return actual.includes(v);
    case '~=':
      return actual.split(/\s+/).includes(v);
    case '|=':
      return actual === v || actual.startsWith(`${v}-`);
    default:
      return false;
  }
}

function matchesPart(el, part) {
  if (!part) {
    return false;
  }
  if (part.tag && el.tagName.toLowerCase() !== part.tag) {
    return false;
  }
  for (const c of part.classes) {
    if (!el.classList.contains(c)) {
      return false;
    }
  }
  for (const id of part.ids) {
    if (el.getAttribute('id') !== id) {
      return false;
    }
  }
  for (const a of part.attrs) {
    if (!attrMatches(el, a)) {
      return false;
    }
  }
  return true;
}

class DOMTokenList {
  constructor(el, attr) {
    this.el = el;
    this.attr = attr;
  }
  _list() {
    return (this.el.getAttribute(this.attr) || '').split(/\s+/).filter(Boolean);
  }
  _write(list) {
    this.el.setAttribute(this.attr, list.join(' '));
  }
  contains(t) {
    return this._list().includes(t);
  }
  add(...ts) {
    const l = this._list();
    ts.forEach((t) => t && !l.includes(t) && l.push(t));
    this._write(l);
  }
  remove(...ts) {
    this._write(this._list().filter((t) => !ts.includes(t)));
  }
  toggle(t, force) {
    const has = this.contains(t);
    const want = force === undefined ? !has : Boolean(force);
    if (want && !has) {
      this.add(t);
    } else if (!want && has) {
      this.remove(t);
    }
    return want;
  }
  get value() {
    return this.el.getAttribute(this.attr) || '';
  }
}

class Class {
  constructor(type, props = {}) {
    this.type = type; // 'element' | 'text' | 'fragment'
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this._attrs = new Map();
    this._listeners = new Map();
    this._text = props.text ?? '';
    this.tagName = props.tagName ? String(props.tagName).toUpperCase() : undefined;
    this.style = createStyle(this);
    this.dataset = createDataset(this);
    this.classList = new DOMTokenList(this, 'class');
    this.scrollTop = 0;
    this.scrollLeft = 0;
    if (this.tagName === 'TEXTAREA' || this.tagName === 'INPUT') {
      defineValueAccessor(this);
      formElements.set(this, this.tagName === 'TEXTAREA' ? 'textarea' : 'input');
    }
  }

  get children() {
    return this.childNodes.filter((n) => n.type === 'element');
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.type === 'element' ? this.parentNode : null;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get nextSibling() {
    const sibs = this.parentNode ? this.parentNode.childNodes : [];
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    const sibs = this.parentNode ? this.parentNode.childNodes : [];
    return sibs[sibs.indexOf(this) - 1] ?? null;
  }
  get nextElementSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  get previousElementSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    return sibs[sibs.indexOf(this) - 1] ?? null;
  }

  get className() {
    return this.getAttribute('class') || '';
  }
  set className(v) {
    this.setAttribute('class', String(v));
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', String(v));
  }

  getAttribute(n) {
    const v = this._attrs.get(String(n).toLowerCase());
    return v === undefined ? null : v;
  }
  setAttribute(n, v) {
    this._attrs.set(String(n).toLowerCase(), String(v));
  }
  removeAttribute(n) {
    this._attrs.delete(String(n).toLowerCase());
  }
  hasAttribute(n) {
    return this._attrs.has(String(n).toLowerCase());
  }

  get offsetParent() {
    // everything is "visible" unless hidden via display:none / hidden attr
    if (this.getAttribute('hidden') !== null) {
      return null;
    }
    let node = this;
    while (node) {
      if (node.style && node.style.display === 'none') {
        return null;
      }
      node = node.parentNode;
    }
    return this.parentNode || this;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0 };
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }

  appendChild(node) {
    if (node.type === 'fragment') {
      [...node.childNodes].forEach((c) => this.appendChild(c));
      return node;
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    node.ownerDocument = this.ownerDocument;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(typeof n === 'string' ? textNode(n, this.ownerDocument) : n));
  }
  prepend(node) {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    this.childNodes.unshift(node);
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      node.parentNode = null;
    }
    return node;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  replaceChild(nu, old) {
    const i = this.childNodes.indexOf(old);
    if (i >= 0) {
      this.childNodes[i] = nu;
      nu.parentNode = this;
      old.parentNode = null;
    }
    return old;
  }
  insertBefore(nu, ref) {
    if (nu.type === 'fragment') {
      [...nu.childNodes].forEach((c) => this.insertBefore(c, ref));
      return nu;
    }
    if (nu.parentNode) {
      nu.parentNode.removeChild(nu);
    }
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    nu.parentNode = this;
    if (i >= 0) {
      this.childNodes.splice(i, 0, nu);
    } else {
      this.childNodes.push(nu);
    }
    return nu;
  }
  insertAdjacentElement(where, el) {
    if (where === 'afterend' && this.parentNode) {
      this.parentNode.insertBefore(el, this.nextSibling);
    } else if (where === 'beforebegin' && this.parentNode) {
      this.parentNode.insertBefore(el, this);
    } else if (where === 'beforeend') {
      this.appendChild(el);
    } else if (where === 'afterbegin') {
      this.insertBefore(el, this.firstChild);
    }
    return el;
  }
  insertAdjacentHTML(where, html) {
    const tmp = this.ownerDocument.createElement('div');
    tmp.innerHTML = html;
    [...tmp.childNodes].forEach((c) => this.insertAdjacentElement(where === 'afterend' ? 'afterend' : 'beforeend', c));
  }

  cloneNode(deep) {
    const copy = new Class(this.tagName, { tagName: this.tagName });
    copy._attrs = new Map(this._attrs);
    if (deep) {
      this.childNodes.forEach((c) => copy.appendChild(c.cloneNode(true)));
    }
    return copy;
  }

  get textContent() {
    if (this.type === 'text') {
      return this._text;
    }
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    if (this.type === 'text') {
      this._text = String(v);
      return;
    }
    this.childNodes.forEach((c) => (c.parentNode = null));
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) {
      this.appendChild(textNode(String(v), this.ownerDocument));
    }
  }
  get innerText() {
    return this.textContent;
  }
  set innerText(v) {
    this.textContent = v;
  }
  get innerHTML() {
    return serialize(this);
  }
  set innerHTML(html) {
    this.childNodes.forEach((c) => (c.parentNode = null));
    this.childNodes = [];
    parseHtmlInto(this, String(html));
  }
  get outerHTML() {
    return serialize(this, true);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, []);
    }
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (l) {
      this._listeners.set(type, l.filter((f) => f !== fn));
    }
  }
  dispatchEvent(ev) {
    if (!ev.target) {
      ev.target = this;
    }
    let node = this;
    const chain = [];
    while (node) {
      chain.push(node);
      node = ev.bubbles ? node.parentNode : null;
    }
    for (const n of chain) {
      const l = n._listeners && n._listeners.get(ev.type);
      if (l) {
        ev.currentTarget = n;
        l.slice().forEach((fn) => fn.call(n, ev));
        if (ev._stopped) {
          break;
        }
      }
    }
    return !ev.defaultPrevented;
  }
  click() {
    this.dispatchEvent(new DomEvent('click', { bubbles: true, target: this }));
  }
  focus() {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }
  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }
  select() {}
  setSelectionRange() {}
  scrollIntoView() {}

  matches(selector) {
    return String(selector)
      .split(',')
      .some((sel) => {
        const parts = sel.trim().split(/\s+/).map(parseSelectorPart).filter(Boolean);
        if (!parts.length) {
          return false;
        }
        if (!matchesPart(this, parts[parts.length - 1])) {
          return false;
        }
        let node = this.parentNode;
        for (let i = parts.length - 2; i >= 0; i--) {
          let found = false;
          while (node) {
            if (matchesPart(node, parts[i])) {
              found = true;
              node = node.parentNode;
              break;
            }
            node = node.parentNode;
          }
          if (!found) {
            return false;
          }
        }
        return true;
      });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      node.children.forEach((c) => {
        if (c.matches(selector)) {
          out.push(c);
        }
        walk(c);
      });
    };
    walk(this);
    return out;
  }
  getElementsByTagName(tag) {
    return this.querySelectorAll(String(tag).toLowerCase());
  }
  getElementsByClassName(cls) {
    return this.querySelectorAll(`.${cls}`);
  }
}

const formElements = new WeakMap(); // element -> 'textarea' | 'input'

function defineValueAccessor(el) {
  el._value = el.getAttribute('value') || '';
}

Object.defineProperty(Class.prototype, 'value', {
  configurable: true,
  get() {
    return this._value === undefined ? '' : this._value;
  },
  set(v) {
    this._value = String(v);
  },
});

function createStyle(el) {
  const store = {};
  return new Proxy(store, {
    get(t, k) {
      if (k === 'setProperty') {
        return (name, v) => (t[name] = v);
      }
      if (k === 'getPropertyValue') {
        return (name) => t[name] ?? '';
      }
      if (k === 'cssText') {
        return Object.entries(t)
          .map(([a, b]) => `${a}:${b}`)
          .join(';');
      }
      return t[k];
    },
    set(t, k, v) {
      t[k] = v;
      void el;
      return true;
    },
  });
}

function createDataset(el) {
  return new Proxy(
    {},
    {
      get(_t, k) {
        return el.getAttribute(`data-${camelToDash(String(k))}`);
      },
      set(_t, k, v) {
        el.setAttribute(`data-${camelToDash(String(k))}`, String(v));
        return true;
      },
      has(_t, k) {
        return el.hasAttribute(`data-${camelToDash(String(k))}`);
      },
    },
  );
}

function camelToDash(s) {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function textNode(text, doc) {
  const n = new Class('text', { text });
  n.ownerDocument = doc;
  return n;
}

function serialize(node, includeSelf = false) {
  if (node.type === 'text') {
    return node._text;
  }
  const inner = node.childNodes.map((c) => serialize(c)).join('');
  if (!includeSelf || !node.tagName) {
    return inner;
  }
  const tag = node.tagName.toLowerCase();
  const attrs = [...node._attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/* ------------------------------------------------------------------ *
 * Very small HTML parser: supports the subset the userscript emits via
 * innerHTML (plain tags, attributes, text). No tables/entities needed.
 * ------------------------------------------------------------------ */
function parseHtmlInto(root, html) {
  const doc = root.ownerDocument;
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const stack = [root];
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[4] !== undefined) {
      stack[stack.length - 1].appendChild(textNode(decodeEntities(m[4]), doc));
      continue;
    }
    const raw = m[0];
    const name = m[1].toLowerCase();
    const attrStr = m[2] || '';
    const selfClose = Boolean(m[3]);
    if (raw.startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName && stack[i].tagName.toLowerCase() === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const el = doc.createElement(name);
    const attrRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrStr))) {
      el.setAttribute(am[1], decodeEntities(am[2] ?? am[3] ?? am[4] ?? ''));
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(name)) {
      stack.push(el);
    }
  }
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source']);

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ *
 * Events / document / window
 * ------------------------------------------------------------------ */

class DomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = init.target ?? null;
    this.currentTarget = null;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
  stopImmediatePropagation() {
    this._stopped = true;
  }
}

class DomSelection {
  constructor() {
    this.ranges = [];
  }
  get rangeCount() {
    return this.ranges.length;
  }
  getRangeAt(i) {
    return this.ranges[i];
  }
  removeAllRanges() {
    this.ranges = [];
  }
  addRange(r) {
    this.ranges.push(r);
  }
}

class DomRange {
  constructor() {
    this.startContainer = null;
    this.endContainer = null;
  }
  selectNodeContents() {}
  collapse() {}
  deleteContents() {}
  insertNode() {}
}

function createDocument() {
  const doc = new Class('#document');
  doc.type = 'document';
  doc.ownerDocument = doc;
  doc.readyState = 'complete';
  doc.activeElement = null;
  doc._selection = new DomSelection();

  doc.createElement = (tag) => {
    const el = new Class('element', { tagName: tag });
    el.ownerDocument = doc;
    if (/^(textarea|input)$/i.test(String(tag))) {
      // let the prototype-level accessor (see createWindow) own `value`
      delete el.value;
    }
    return el;
  };
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);

  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.append(doc.head, doc.body);
  doc.appendChild(doc.documentElement);
  doc.createTextNode = (t) => textNode(t, doc);
  doc.createDocumentFragment = () => {
    const f = new Class('fragment');
    f.ownerDocument = doc;
    return f;
  };
  doc.createRange = () => new DomRange();
  doc.getSelection = () => doc._selection;
  doc.execCommand = (cmd, _ui, value) => {
    if (cmd === 'insertText') {
      const el = doc.activeElement;
      if (el && el.type === 'element') {
        el.appendChild(textNode(String(value ?? ''), doc));
        el.dispatchEvent(new DomEvent('input', { bubbles: true }));
        return true;
      }
    }
    return false;
  };
  doc.addEventListener = doc.addEventListener.bind(doc);
  doc.hasFocus = () => true;
  return doc;
}

function createWindow(DOC) {
  const win = {
    document: DOC,
    location: { href: 'https://chat.deepseek.com/', hostname: 'chat.deepseek.com', protocol: 'https:', origin: 'https://chat.deepseek.com' },
    navigator: { userAgent: 'node-smoke', clipboard: { writeText: async () => {} } },
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLInputElement: class HTMLInputElement {},
    Element: Class,
    Node: Class,
    Event: DomEvent,
    InputEvent: DomEvent,
    CustomEvent: DomEvent,
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    prompt: () => null,
    confirm: () => true,
    alert: () => {},
  };
  // window-level event target (focus / keydown / resize listeners)
  const winListeners = new Map();
  win.addEventListener = (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  };
  win.removeEventListener = (type, fn) => {
    const l = winListeners.get(type);
    if (l) winListeners.set(type, l.filter((f) => f !== fn));
  };
  win.dispatchEvent = (ev) => {
    const l = winListeners.get(ev.type) || [];
    ev.target = ev.target || win;
    l.slice().forEach((fn) => fn.call(win, ev));
    return true;
  };
  win.__dispatchWindowEvent = win.dispatchEvent;

  // document events also reach the window (capture/bubble phases in real browsers)
  const docDispatch = DOC.dispatchEvent.bind(DOC);
  DOC.dispatchEvent = (ev) => {
    const r = docDispatch(ev);
    if (ev.bubbles) win.dispatchEvent(ev);
    return r;
  };

  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;
  win.globalThis = win;
  // value accessors must live on the prototypes the userscript looks up
  // the fake element classes must still inherit the stub node API
  Object.setPrototypeOf(win.HTMLTextAreaElement.prototype, Class.prototype);
  Object.setPrototypeOf(win.HTMLInputElement.prototype, Class.prototype);
  const protoFor = { textarea: win.HTMLTextAreaElement.prototype, input: win.HTMLInputElement.prototype };
  for (const kind of ['textarea', 'input']) {
    Object.defineProperty(protoFor[kind], 'value', {
      configurable: true,
      get() {
        const own = Object.getOwnPropertyDescriptor(Class.prototype, 'value');
        return own && own.get ? own.get.call(this) : '';
      },
      set(v) {
        const own = Object.getOwnPropertyDescriptor(Class.prototype, 'value');
        if (own && own.set) {
          own.set.call(this, v);
        }
      },
    });
    // make the instances actual members of those prototype chains
    Object.defineProperty(protoFor[kind], '__kind', { value: kind });
  }
  const origCreate = DOC.createElement;
  DOC.createElement = (tag) => {
    const el = origCreate(tag);
    const kind = formElements.get(el);
    if (kind && protoFor[kind]) {
      Object.setPrototypeOf(el, protoFor[kind]);
    }
    return el;
  };
  return win;
}

module.exports = { Class, DomEvent, createDocument, createWindow, textNode, parseHtmlInto };
