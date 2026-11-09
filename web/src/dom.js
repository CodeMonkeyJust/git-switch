/** Tiny DOM helpers: no framework, no build step. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function tag(level, text) {
  return el('span', { class: `tag ${level}`, text });
}

/** Render a unified diff with per-line colouring, without innerHTML. */
export function diffBlock(diffText) {
  const pre = el('pre', { class: 'diff' });
  for (const line of diffText.split('\n')) {
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    pre.append(el('span', { class: cls, text: line + '\n' }));
  }
  return pre;
}

export function notice(level, text) {
  return el('div', { class: `notice ${level}`, text });
}
