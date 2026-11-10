const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const jquery = require('jquery');
const source = readFileSync(join(__dirname, '../native-controls.js'), 'utf8').replace(/^export /gm, '');

function fixture() {
    const dom = new JSDOM(`<div><input id="world_info_search"><select id="world_info_sort_order">
        <option value="9">UID ↑</option><option value="13" data-rule="custom">Custom</option>
        </select><div id="world_popup_entries_list"></div></div>`, { runScripts: 'outside-only' });
    const w = dom.window;
    w.eval(source);
    const $ = jquery(w);
    const sort = w.document.getElementById('world_info_sort_order');
    let book = 'A', foldy = false;
    let resolveSave;
    const calls = [];
    const instance = { options: { stop: async function (event, ui) {
        calls.push(['save', this, event, ui]);
        await new Promise(resolve => { resolveSave = resolve; });
    } } };
    $.fn.sortable = function (method, option, value) {
        if (method === 'instance') return instance;
        instance.options[option] = value;
    };
    $(sort).on('change', () => calls.push(['change', sort.value]));
    const args = { document: w.document, jQuery: $, isFoldy: () => foldy, getBook: () => book, notify: () => {} };
    return { dom, w, sort, calls, instance, args, resolve: () => resolveSave(), setBook: v => book = v, setFoldy: v => foldy = v };
}

test('compact control preserves the native select, options and change listeners without duplicates', () => {
    const f = fixture();
    try {
        const options = [...f.sort.options];
        f.w.compactNativeSort(f.w.document);
        f.w.compactNativeSort(f.w.document);
        assert.equal(f.w.document.querySelectorAll('#slb-search-sort').length, 1);
        assert.equal(f.w.document.querySelector('.slb-native-sort select'), f.sort);
        assert.deepEqual([...f.sort.options], options);
        assert.equal(f.sort.querySelector('[data-rule="custom"]').hidden, true);
        assert.equal(f.sort.options[0].hidden, false);
        f.sort.value = '13';
        f.sort.dispatchEvent(new f.w.Event('change'));
        assert.deepEqual(f.calls, [['change', '13']]);
        f.w.compactNativeSort(f.w.document);
        assert.equal(f.sort.title, '항목 정렬');
    } finally { f.dom.window.close(); }
});

test('native drag save completes once before switching from UID order to persisted custom order', async () => {
    const f = fixture();
    try {
        f.w.enableNativeEntryDrag(f.args);
        const stop = f.instance.options.stop;
        f.w.enableNativeEntryDrag(f.args);
        assert.equal(f.instance.options.stop, stop);
        const list = f.w.document.getElementById('world_popup_entries_list');
        const event = {}, ui = {};
        const saving = stop.call(list, event, ui);
        assert.deepEqual(f.calls, [['save', list, event, ui]]);
        assert.equal(f.sort.value, '9');
        f.resolve(); await saving;
        assert.deepEqual(f.calls[1], ['change', '13']);
    } finally { f.dom.window.close(); }
});

test('book changes and Foldy mode are not overwritten by a pending drag save', async () => {
    for (const change of [f => f.setBook('B'), f => f.setFoldy(true), f => { f.sort.value = '13'; }]) {
        const f = fixture();
        try {
            f.w.enableNativeEntryDrag(f.args);
            const saving = f.instance.options.stop();
            change(f); f.resolve(); await saving;
            assert.equal(f.calls.length, 1);
        } finally { f.dom.window.close(); }
    }
    const f = fixture();
    try {
        f.setFoldy(true);
        const original = f.instance.options.stop;
        assert.equal(f.w.enableNativeEntryDrag(f.args), false);
        assert.equal(f.instance.options.stop, original);
    } finally { f.dom.window.close(); }
});
