const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const makeJQuery = require('jquery');
const source = readFileSync(join(__dirname, '../lore-sort.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(saved = '') {
    const dom = new JSDOM(`<div id="WorldInfo"><div id="world_popup">
      <div><select id="world_info_sort_order" hidden><option value="9" data-field="uid" data-order="asc">UID ↑</option>
      <option value="1" data-field="comment" data-order="asc">Title ↑</option><option value="13" data-rule="custom" data-field="displayIndex">Custom</option><option value="search">Search</option></select>
      <button id="world_apply_current_sorting"><i></i></button></div></div></div>`, { runScripts: 'outside-only' });
    const w = dom.window;
    w.structuredClone = structuredClone;
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    w.eval(source.replace(/^export /gm, '') + '\nwindow.api={installLoreSortControls,planInsertionOrders};');
    const state = { book: 'A', disk: { entries: {
        0: { uid: 0, comment: 'side', content: 'side content', order: 100, STMB_sidePromptRegeneration: { templateKey: 'relationship' } },
        1: { uid: 1, comment: '2029-10-23', content: 'memory', order: 24, vectorized: true, stmemorybooks: true },
        2: { uid: 2, comment: '2029-10-24', content: 'memory 2', order: 25, stmemorybooks: true },
    } }, writes: [], messages: [], originals: [], nativeClicks: 0, changes: 0, refreshes: 0 };
    const select = w.document.querySelector('select');
    const $ = makeJQuery(w);
    $(select).on('change', () => state.changes++);
    $('#world_apply_current_sorting').on('click', () => state.nativeClicks++);
    const filter = { filterFunctions: {} };
    const deps = {
        document: w.document, filter, getBook: () => state.book,
        loadBook: async () => state.disk,
        saveBook: async (book, data) => { state.writes.push({ book, data }); state.disk = data; },
        setOriginal: (_data, uid, path, order) => state.originals.push({ uid, path, order }),
        sortEntries: entries => {
            const field = select.selectedOptions[0].dataset.field;
            return entries.sort((a, b) => typeof a[field] === 'string' ? a[field].localeCompare(b[field]) : a[field] - b[field]);
        },
        getSavedSort: () => saved, setSavedSort: value => {state.saved = value;}, refresh: () => state.refreshes++, isFoldy: () => false,
        notify: (...args) => state.messages.push(args),
    };
    w.api.installLoreSortControls(deps);
    const open = async () => { w.document.querySelector('#world_apply_current_sorting i').click(); await tick(); };
    const close = () => w.close();
    return { w, state, filter, select, open, close, deps };
}

test('removed side-sort selection migrates to native Custom without saving lorebook data', () => {
    const h = setup('slb-side-bottom');
    try {
        const before = JSON.stringify(h.state.disk);
        h.w.api.installLoreSortControls(h.deps);
        assert.equal(h.w.document.querySelectorAll('#slb-sort-controls').length, 1);
        assert.equal(h.select.hidden, false);
        assert.equal(h.select.value, '13');
        assert.equal(h.state.saved, '13');
        assert.equal(h.state.changes, 1);
        assert.equal(h.select.querySelector('[value="slb-side-bottom"]'), null);
        assert.equal(Object.keys(h.filter.filterFunctions).length, 0);
        assert.equal(JSON.stringify(h.state.disk), before);
        assert.equal(h.state.writes.length, 0);
    } finally { h.close(); }
});

test('unrelated native sort and its original change listeners remain intact', () => {
    const h = setup('9');
    try {
        assert.equal(h.select.value, '9');
        assert.equal(h.state.saved, undefined);
        h.select.value = '1';
        h.select.dispatchEvent(new h.w.Event('change', {bubbles:true}));
        assert.equal(h.state.changes, 1);
        assert.equal(h.state.writes.length, 0);
    } finally { h.close(); }
});

test('arrow opens one preview and cancel/Escape never changes priorities or invokes the native handler', async () => {
    const h = setup();
    try {
        const before = JSON.stringify(h.state.disk);
        await h.open(); await h.open();
        assert.equal(h.w.document.querySelectorAll('dialog[open]').length, 1);
        assert.match(h.w.document.querySelector('pre').textContent, /24 → 99/);
        h.w.document.querySelector('button[type=button]').click();
        assert.equal(h.w.document.querySelector('dialog'), null);
        await h.open();
        h.w.document.querySelector('dialog').dispatchEvent(new h.w.Event('cancel', { cancelable: true }));
        assert.equal(h.w.document.querySelector('dialog'), null);
        assert.equal(h.state.writes.length, 0);
        assert.equal(h.state.nativeClicks, 0);
        assert.equal(JSON.stringify(h.state.disk), before);
    } finally { h.close(); }
});

test('Apply uses the preview for all entries and changes only insertion priority', async () => {
    const h = setup();
    try {
        const before = structuredClone(h.state.disk);
        await h.open();
        h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit', { cancelable: true }));
        await tick();
        assert.equal(h.state.writes.length, 1);
        assert.equal(h.state.disk.entries[1].order, 99);
        assert.equal(h.state.disk.entries[2].order, 98);
        assert.equal(h.state.disk.entries[0].order, 100);
        for (const [uid, entry] of Object.entries(h.state.disk.entries)) {
            assert.deepEqual({ ...entry, order: before.entries[uid].order }, before.entries[uid]);
        }
        assert.equal(h.state.originals.length, 3);
        assert(h.state.originals.every(x => x.path === 'insertion_order'));
        assert.equal(h.state.refreshes, 1);
    } finally { h.close(); }
});

test('invalid values, concurrent edits and book changes prevent stale writes', async () => {
    for (const change of ['input', 'edit', 'book', 'sort']) {
        const h = setup();
        try {
            await h.open();
            if (change === 'input') {
                const input = h.w.document.querySelector('input[name=start]');
                input.value = '0'; input.dispatchEvent(new h.w.Event('input', { bubbles: true }));
                assert.equal(h.w.document.querySelector('button[type=submit]').disabled, true);
            }
            if (change === 'edit') h.state.disk.entries[1].content = 'edited while open';
            if (change === 'book') h.state.book = 'B';
            if (change === 'sort') h.select.value = '1';
            h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit', { cancelable: true }));
            await tick();
            assert.equal(h.state.writes.length, 0, change);
        } finally { h.close(); }
    }
});
