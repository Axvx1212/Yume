// Tiny DOM helpers. No framework — just enough to keep the views declarative
// and to make text interpolation safe by construction.

/**
 * Build an element. Children that are strings become text nodes, so anything
 * coming from the server (titles, descriptions) can never be parsed as HTML.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') node.innerHTML = v; // only ever used with literals
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Inline SVG from a path spec — the design uses stroked 24×24 icons throughout. */
export function icon(paths, { size = 20, width = 1.8, fill = false } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', fill ? 'currentColor' : 'none');
  if (!fill) {
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', width);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  svg.innerHTML = paths;
  return svg;
}

export const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  forward: '<path d="M9 5l7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  filter: '<path d="M4 7h16M7 12h10M10 17h4"/>',
  sort: '<path d="M7 4v16M7 20l-3-3M7 4l3 3M14 7h6M14 12h6M14 17h4"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',
  bookmark: '<path d="M6 4h12v16l-6-4.5L6 20z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"/>',
  play: '<path d="M8 5l12 7-12 7z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 4v7h-7"/>',
  book: '<path d="M4 5h6v14H4zM14 5h6v14h-6z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
};

export const clear = (node) => { node.replaceChildren(); return node; };

/** Cover/page image that fades in and degrades to the weave placeholder. */
export function img(src, alt = '') {
  const image = el('img', { alt, loading: 'lazy', decoding: 'async' });
  image.addEventListener('load', () => image.classList.add('is-loaded'));
  image.addEventListener('error', () => { image.style.display = 'none'; });
  image.src = src;
  return image;
}

let toastTimer = null;
export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-on'), 2600);
}

/** Standard error panel with a retry affordance. */
export function errorBox(err, onRetry) {
  return el('div', { class: 'error-box' },
    el('div', { class: 'msg' }, err?.message || 'Something went wrong.'),
    err?.detail ? el('code', {}, String(err.detail).slice(0, 240)) : null,
    onRetry ? el('button', { class: 'btn btn-sm', onClick: onRetry }, 'Try again') : null,
  );
}

export function spinnerRow(label = 'Loading…') {
  return el('div', { class: 'loading-row' }, el('div', { class: 'spinner' }), label);
}

export function skeletonGrid(count = 9) {
  return el('div', { class: 'grid' },
    Array.from({ length: count }, () => el('div', { class: 'tile' },
      el('div', { class: 'skel skel-tile' }),
      el('div', { class: 'skel skel-line' }),
      el('div', { class: 'skel skel-line short' }),
    )),
  );
}

export function emptyState({ title, body, action, onAction, iconPath }) {
  return el('div', { class: 'empty' },
    iconPath ? el('div', { class: 'empty-icon' }, icon(iconPath, { size: 34, width: 1.4 })) : null,
    el('h4', {}, title),
    body ? el('p', {}, body) : null,
    action ? el('button', { class: 'btn', onClick: onAction }, action) : null,
  );
}

/**
 * Average the top band of a cover to get a hero tint, the way the prototype
 * tinted each detail screen with its own title's art. Same-origin through the
 * proxy, so the canvas never taints. Resolves null if sampling isn't possible.
 */
export function sampleCoverColor(src) {
  return new Promise((resolve) => {
    const image = new Image();
    // Deliberately NOT crossOrigin: the proxy already makes covers same-origin,
    // so the canvas won't taint — while setting it would change the request's
    // CORS mode, miss the cache entry the visible <img> just filled, and
    // re-download the full-size cover.
    image.onerror = () => resolve(null);
    image.onload = () => {
      try {
        const w = 24;
        const h = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * w));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, w, h);

        const { data } = ctx.getImageData(0, 0, w, Math.max(1, Math.round(h * 0.5)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
        }
        if (!n) return resolve(null);

        // Pull toward the Nocturne ground so the wash stays a tint, never a flood.
        const mix = (c, ground) => Math.round((c / n) * 0.55 + ground * 0.45);
        resolve(`rgb(${mix(r, 0x16)}, ${mix(g, 0x18)}, ${mix(b, 0x26)})`);
      } catch {
        resolve(null);
      }
    };
    image.src = src;
  });
}

/**
 * Bottom action sheet. Used by the chapter long-press menu and the detail
 * screen's overflow menu, so both look and behave identically.
 *
 * `actions` are `{label, hint, icon, danger, onPick}`. Returns the node; append
 * it to a positioned container (`.view` is `position: relative`).
 */
export function actionSheet({ title, subtitle, actions }) {
  let wrap;
  const close = () => wrap.remove();

  wrap = el('div', { class: 'sheet-wrap' },
    el('button', { class: 'sheet-backdrop', 'aria-label': 'Close menu', onClick: close }),
    el('div', { class: 'sheet', role: 'dialog', 'aria-label': title || 'Actions' },
      el('div', { class: 'sheet-grip' }),
      title
        ? el('div', { class: 'sheet-head' },
            el('div', { class: 'sheet-title' }, title),
            subtitle ? el('div', { class: 'sheet-sub' }, subtitle) : null,
          )
        : null,
      el('div', { class: 'sheet-actions' },
        actions.filter(Boolean).map((a) => el('button', {
          class: `sheet-action${a.danger ? ' is-danger' : ''}`,
          onClick: () => { close(); a.onPick(); },
        },
          a.icon ? icon(a.icon, { size: 17 }) : null,
          el('span', { class: 'sheet-action-text' },
            el('span', { class: 'l' }, a.label),
            a.hint ? el('span', { class: 'h' }, a.hint) : null,
          ),
        )),
      ),
      el('button', { class: 'btn btn-block', onClick: close }, 'Cancel'),
    ),
  );

  // Escape closes it, matching the reader's settings sheet.
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); window.removeEventListener('keydown', onKey); }
  };
  window.addEventListener('keydown', onKey);

  return wrap;
}

/**
 * Long-press without breaking tap or scroll. Fires `onLongPress` after 550ms
 * of a stationary finger, and suppresses the click that would otherwise follow.
 * Returns a disposer.
 */
export function onLongPress(node, handler) {
  let timer = null;
  let fired = false;
  let start = null;

  const cancel = () => { clearTimeout(timer); timer = null; };

  const down = (e) => {
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; handler(e); }, 550);
  };
  // Any real movement means the user is scrolling, not pressing.
  const move = (e) => {
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  };
  const up = () => cancel();
  const click = (e) => {
    if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
  };

  node.addEventListener('pointerdown', down, { passive: true });
  node.addEventListener('pointermove', move, { passive: true });
  node.addEventListener('pointerup', up, { passive: true });
  node.addEventListener('pointercancel', up, { passive: true });
  node.addEventListener('pointerleave', up, { passive: true });
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', (e) => e.preventDefault());

  return () => {
    cancel();
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', up);
    node.removeEventListener('pointerleave', up);
    node.removeEventListener('click', click, true);
  };
}
