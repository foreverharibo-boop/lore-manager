// Run with Node's test runner after installing jsdom and jquery as dev tools.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const makeJQuery = require('jquery');
const code = readFileSync(require('node:path').join(__dirname, '../bulk-edit.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(mobile = false) {
    const dom = new JSDOM('<div id="world_popup"><div id="world_popup_entries_list"></div></div>', { runScripts: 'outside-only' });
    const { window: w } = dom;
    const $ = makeJQuery(w);
    w.eval(code.replace('export function createLorebookBulkEditor', 'function createLorebookBulkEditor') + '\nwindow.makeBulk = createLorebookBulkEditor;');
    const document = w.document;
    let book = 'A';
    const books = Object.fromEntries(['A', 'B'].map(name => [name, {
        entries: Object.fromEntries([0, 1, 2, 3].map(uid => [uid, {
            uid, content: `${name}-${uid}`, comment: `entry ${uid}`, key: [`key${uid}`], disable: uid === 2,
            constant: uid === 0, vectorized: false, position: 1, role: null,
            order: 100 + uid, depth: 4 + uid, probability: 90 + uid,
        }])),
        originalData: { entries: [0, 1, 2, 3].map(uid => ({ uid, extensions: {} })) },
    }]));
    const saves = [], errors = [];
    let load = async name => books[name];
    const popup = document.getElementById('world_popup');
    let list = document.getElementById('world_popup_entries_list');
    const rows = () => [...list.querySelectorAll('.world_entry')];
    const setOriginal = (data, uid, path, value) => {
        let entry = data.originalData.entries.find(e => e.uid === uid);
        const keys = path.split('.');
        const last = keys.pop();
        keys.forEach(key => { entry = entry[key] ||= {}; });
        entry[last] = value;
    };
    // Native input handlers own individual writes. Bulk UI calls these with
    // noSave, just like ST, to update dependent controls without a save per row.
    function bindNative(row, uid) {
        const data = books[book];
        $(row).find('input[name], select[name], textarea[name]').on('input', function (_, { noSave = false } = {}) {
            const item = data.entries[uid];
            const name = this.name;
            if (name === 'entryStateSelector') {
                item.constant = this.value === 'constant';
                item.vectorized = this.value === 'vectorized';
            } else if (name === 'position') {
                item.position = Number(this.value);
                item.role = item.position === 4 ? Number(this.selectedOptions[0].dataset.role) : null;
                row.querySelector('[name=depth]').disabled = item.position !== 4;
            } else if (['order', 'depth', 'probability'].includes(name)) {
                item[name] = name === 'probability' ? Math.min(100, Math.max(0, Number(this.value))) : Number(this.value);
                this.value = item[name];
            } else {
                item[name] = this.value;
            }
            if (!noSave) saves.push('native');
        });
    }
    const editor = w.makeBulk({
        getBook: () => book, getRows: rows, getUid: row => row.dataset.uid,
        loadBook: name => load(name), saveBook: async name => { saves.push(`bulk:${name}`); },
        setOriginal, atDepth: 4, refreshControl: control => $(control).trigger('input', { noSave: true }),
        onApplied() {}, onLayout() {}, onError: error => errors.push(error.message),
    });
    function render(ids = [0, 1, 2]) {
        list.replaceChildren();
        for (const uid of ids) {
            const item = books[book].entries[uid];
            const row = document.createElement('div');
            row.className = 'world_entry'; row.dataset.uid = uid;
            const fields = `<div class="slb-strategy-field"><select name="entryStateSelector"><option value="normal">green</option><option value="constant">blue</option><option value="vectorized">vector</option></select></div>
                <div class="slb-position-field"><select name="position"><option value="0">before</option><option value="1">after</option><option value="4" data-role="0">system</option><option value="4" data-role="1">user</option><option value="4" data-role="2">assistant</option></select></div>
                <div class="slb-depth-field"><input type="number" name="depth" value="${item.depth}" disabled></div>
                <div class="slb-order-field"><input type="number" name="order" value="${item.order}"></div>
                <div class="slb-trigger-field"><input type="number" name="probability" value="${item.probability}"></div>`;
            row.innerHTML = `<div class="slb-entry-header-shell"><div class="slb-header-toggles"><span class="drag-handle">☰</span><span name="entryKillSwitch">enabled</span></div><div class="slb-header-grid"><textarea name="comment">${item.comment}</textarea>${mobile ? '' : fields}</div></div>${mobile ? `<div class="slb-panel" data-panel="activation"><div class="slb-activation-overview">${fields}</div></div>` : ''}<textarea name="content">${item.content}</textarea>`;
            row.querySelector('[name=entryStateSelector]').value = item.constant ? 'constant' : item.vectorized ? 'vectorized' : 'normal';
            row.querySelector('[name=position]').value = item.position;
            bindNative(row, uid);
            list.append(row);
            editor.syncRow(row);
        }
        editor.ensureToolbar(popup, list);
    }
    render();
    const query = selector => document.querySelector(selector);
    const control = (uid, name) => query(`.world_entry[data-uid="${uid}"] [name="${name}"]`);
    const mode = () => query('.slb-bulk-mode').click();
    const choose = uid => query(`.world_entry[data-uid="${uid}"] .slb-entry-selection-checkbox`).click();
    async function edit(uid, name, value, type = 'input', index = null) {
        const c = control(uid, name);
        if (index === null) c.value = value; else c.selectedIndex = index;
        c.dispatchEvent(new w.Event(type, { bubbles: true }));
        await flush();
    }
    return { w, document, books, saves, errors, editor, render, query, rows, control, mode, choose, edit,
        setLoad: fn => { load = fn; },
        switchBook: name => { book = name; editor.reset(name); render(); },
        replaceList() { const next = list.cloneNode(false); list.replaceWith(next); list = next; render(); },
        close: () => dom.window.close(),
    };
}

for (const mobile of [false, true]) {
    test(`${mobile ? 'mobile activation panel' : 'desktop header'}: opt-in, selected-only five-field updates`, async () => {
        const f = setup(mobile);
        try {
            assert.equal(f.query('.slb-entry-selection-checkbox'), null);
            assert.equal(f.query('.slb-bulk-selection-tools').hidden, true);
            f.mode(); f.choose(0); f.choose(1);
            const untouched = JSON.stringify(f.books.A.entries[2]);
            const content = f.books.A.entries[1].content;
            await f.edit(0, 'order', '200');
            assert.equal(f.books.A.entries[1].order, 101, 'partial typing must not propagate');
            await f.edit(0, 'order', '200', 'change');
            assert.equal(f.books.A.entries[1].order, 200);
            assert.equal(f.books.A.entries[1].depth, 5);
            assert.equal(f.books.A.originalData.entries[1].insertion_order, 200);
            assert.equal(f.saves.filter(x => x.startsWith('bulk')).length, 1);
            await f.edit(0, 'entryStateSelector', 'vectorized');
            assert.equal(f.books.A.entries[1].constant, false);
            assert.equal(f.books.A.entries[1].vectorized, true);
            await f.edit(0, 'position', '', 'input', 3);
            assert.equal(f.books.A.entries[1].position, 4);
            assert.equal(f.books.A.entries[1].role, 1, '@D role is not just select.value');
            assert.equal(f.control(1, 'position').selectedIndex, 3);
            assert.equal(f.control(1, 'depth').disabled, false);
            await f.edit(0, 'depth', '8', 'change');
            assert.equal(f.books.A.entries[1].depth, 8);
            await f.edit(0, 'probability', '120', 'change');
            assert.equal(f.books.A.entries[1].probability, 100);
            await f.edit(0, 'position', '0');
            assert.equal(f.books.A.entries[1].role, null);
            assert.equal(f.control(1, 'depth').disabled, true);
            await f.edit(0, 'content', 'new source');
            assert.equal(f.books.A.entries[1].content, content);
            assert.equal(JSON.stringify(f.books.A.entries[2]), untouched);
            await f.edit(2, 'order', '300', 'change');
            assert.equal(f.books.A.entries[0].order, 200, 'unselected source never propagates');
            f.query('.slb-bulk-clear').click();
            assert.equal(f.query('.slb-bulk-mode').checked, true);
            assert.equal(f.query('.slb-bulk-selection-count').textContent, '0개 선택 중');
            f.mode();
            assert.equal(f.query('.slb-entry-selection-checkbox'), null);
            assert.equal(f.query('.slb-bulk-selected'), null);
            assert.deepEqual(f.errors, []);
        } finally { f.close(); }
    });
}

test('all pages, rerender, deletion, and book changes preserve selection boundaries', async () => {
    const f = setup();
    try {
        f.mode(); f.query('.slb-bulk-select-all').click(); await flush();
        assert.equal(f.query('.slb-bulk-selection-count').textContent, '4개 선택 중');
        await f.edit(0, 'order', '777', 'change');
        assert.equal(f.books.A.entries[3].order, 777, 'selected off-page row updates');
        f.render([2, 3]);
        assert.equal(f.document.querySelectorAll('.slb-entry-selection-checkbox:checked').length, 2);
        delete f.books.A.entries[3]; f.editor.prune(f.books.A);
        assert.equal(f.query('.slb-bulk-selection-count').textContent, '3개 선택 중');
        f.replaceList();
        assert.equal(f.document.querySelectorAll('#slb-entry-selection-toolbar').length, 1);
        assert.equal(f.document.querySelectorAll('.slb-entry-selection-checkbox:checked').length, 3);
        f.switchBook('B');
        assert.equal(f.query('.slb-bulk-mode').checked, false);
        assert.equal(f.query('.slb-entry-selection-checkbox'), null);
        assert.equal(f.books.B.entries[0].order, 100);
    } finally { f.close(); }
});

test('pending load is cancelled by mode exit, selection changes, and book switch', async () => {
    for (const cancel of ['mode', 'selection', 'book']) {
        const f = setup();
        try {
            f.mode(); f.choose(0); f.choose(1);
            let resolve;
            f.setLoad(() => new Promise(r => { resolve = r; }));
            const c = f.control(0, 'order'); c.value = '999';
            c.dispatchEvent(new f.w.Event('change', { bubbles: true })); await flush();
            if (cancel === 'mode') f.mode();
            if (cancel === 'selection') f.choose(1);
            if (cancel === 'book') f.switchBook('B');
            resolve(f.books.A); await flush();
            assert.equal(f.books.A.entries[1].order, 101);
            assert.equal(f.saves.filter(x => x.startsWith('bulk')).length, 0);
        } finally { f.close(); }
    }
});

test('blank numbers, disabled controls, single selection, and load failure never bulk overwrite', async () => {
    const f = setup();
    try {
        f.mode(); f.choose(0);
        await f.edit(0, 'order', '500', 'change');
        assert.equal(f.books.A.entries[1].order, 101);
        f.choose(1);
        await f.edit(0, 'order', '', 'change');
        await f.edit(0, 'depth', '20', 'change');
        assert.equal(f.books.A.entries[1].order, 101);
        assert.equal(f.books.A.entries[1].depth, 5);
        f.setLoad(async () => null);
        await f.edit(0, 'order', '500', 'change');
        assert.equal(f.books.A.entries[1].order, 101);
        assert.equal(f.errors.length, 1);
    } finally { f.close(); }
});
