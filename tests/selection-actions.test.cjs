const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const code = readFileSync(require('node:path').join(__dirname, '../index.js'), 'utf8');
const fn = name => code.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];
const flush = () => new Promise(resolve => setImmediate(resolve));
const key = (book, uid) => `${book}:${uid}`;
function fixture() {
    const dom = new JSDOM('<div id="rows"></div>');
    const data = { entries: Object.fromEntries([0, 1, 2, 3].map(uid => [uid, { uid, content: `source ${uid}` }])),
        originalData: { entries: [0, 1, 2, 3].map(uid => ({ uid })) } };
    let book = 'A', current = true, confirm = async () => 1;
    const settings = { hideOriginalWhenTranslated: true, translations: {}, entryLanguagePairs: {} };
    const events = [], requests = [], rows = [];
    let translate = async source => `translated ${source}`;
    let save = async () => { events.push('save'); };
    const context = vm.createContext({
        console: { warn() {} }, clearTimeout, document: dom.window.document,
        state: { sourceTimers: new Map(), translationTimers: new Map(), bulkTranslation: null },
        Popup: { show: { confirm: (...args) => { events.push(args); return confirm(); } } },
        POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: null },
        entryBulkEditor: { isCurrentSelection: () => current, prune: () => events.push('prune') },
        loadWorldInfo: async () => data, currentBookName: () => book, getSettings: () => settings,
        saveWorldInfo: (...args) => save(...args),
        deleteWIOriginalDataValue: (data, uid) => { data.originalData.entries = data.originalData.entries.filter(e => String(e.uid) !== uid); },
        saveSettingsDebounced: () => {}, saveSettings: async () => {},
        renderedEntries: () => rows, getUid: row => row.dataset.uid,
        worldInfoFilter: { onDataChanged: () => events.push('redraw') }, renderTokenSummary() {},
        notify: (...args) => events.push(args), updateBulkTranslationStatus() {},
        translationKey: key, canTranslate: () => true,
        getEntryLanguagePair: () => ({ sourceLanguage: 'en', translationLanguage: 'ko' }),
        translateText: async (source, language) => { requests.push([source, language]); return translate(source); },
        saveTranslationRecord: (book, uid, source, text) => { settings.translations[key(book, uid)] = { text, source }; },
        markTranslationSynced: (ui, source, text) => { settings.translations[key(ui.book, ui.uid)] = { source, text }; },
    });
    vm.runInContext(['deleteSelectedEntries', 'translateCurrentLorebook', 'lorebookEntries', 'hasEntryTranslation', 'syncSourceVisibility'].map(fn).join('\n'), context);
    function ui(uid) {
        const row = dom.window.document.createElement('div'); row.dataset.uid = String(uid);
        row.innerHTML = '<div class="world_entry_edit"><div class="slb-content-grid"><div class="slb-source-pane"><textarea></textarea></div><textarea class="translation"></textarea></div></div>';
        dom.window.document.getElementById('rows').append(row); rows.push(row);
        const edit = row.querySelector('.world_entry_edit');
        const result = { book: 'A', uid: String(uid), root: edit, source: row.querySelector('textarea'), translation: row.querySelector('.translation'), flags: {}, status: {}, sourceLanguage: 'en', translationLanguage: 'ko' };
        result.source.value = data.entries[uid].content; edit.slbTranslationUI = result; return result;
    }
    return { context, data, settings, events, requests, ui, selection: { book: 'A', uids: ['0', '2', '3'] },
        confirm: handler => { confirm = handler; }, translate: handler => { translate = handler; },
        save: handler => { save = handler; }, invalidate: () => { current = false; }, switchBook: () => { book = 'B'; }, close: () => dom.window.close() };
}

test('delete requires explicit confirmation and aborts if selection changes during confirmation', async () => {
    for (const result of [null, 0, 1]) {
        const f = fixture();
        try {
            f.confirm(async () => { if (result === 1) f.invalidate(); return result; });
            await f.context.deleteSelectedEntries(f.selection);
            assert.equal(Object.keys(f.data.entries).length, 4);
            assert.equal(f.events.includes('save'), false);
            assert.equal(f.events[0][2].okButton, '삭제');
            assert.equal(f.events[0][2].cancelButton, '취소');
        } finally { f.close(); }
    }
});

test('confirmed delete removes only selected UIDs and export records, saves once and removes their translations', async () => {
    const f = fixture();
    try {
        for (const uid of [0, 1, 2, 3]) { f.settings.translations[key('A', uid)] = { text: 'old' }; f.settings.entryLanguagePairs[key('A', uid)] = {}; }
        const ui = f.ui(0);
        await f.context.deleteSelectedEntries(f.selection);
        assert.deepEqual(Object.keys(f.data.entries), ['1']);
        assert.deepEqual(f.data.originalData.entries.map(e => e.uid), [1]);
        assert.deepEqual(Object.keys(f.settings.translations), ['A:1']);
        assert.deepEqual(Object.keys(f.settings.entryLanguagePairs), ['A:1']);
        assert.equal(f.events.filter(e => e === 'save').length, 1);
        assert.equal(ui.flags.deleted, true);
        assert.ok(f.events.includes('redraw'));
    } finally { f.close(); }
});

test('failed delete save restores entries and original export data without erasing translations', async () => {
    const f = fixture();
    try {
        const before = JSON.stringify(f.data);
        const ui = f.ui(0);
        f.settings.translations['A:0'] = { text: 'keep' };
        f.save(async () => { throw new Error('offline'); });
        await assert.rejects(f.context.deleteSelectedEntries(f.selection), /offline/);
        assert.equal(JSON.stringify(f.data), before);
        assert.equal(ui.flags.deleted, false);
        assert.equal(f.settings.translations['A:0'].text, 'keep');
    } finally { f.close(); }
});

test('selected translation is sequential, includes off-page entries, and continues after an item fails', async () => {
    const f = fixture();
    try {
        const ui = f.ui(0); let finish;
        f.translate(source => source === 'source 0' ? new Promise(resolve => { finish = resolve; }) : source === 'source 2' ? Promise.reject(new Error('API')) : 'third');
        const pending = f.context.translateCurrentLorebook('selected', f.selection);
        await flush();
        assert.equal(f.requests.length, 1);
        finish('first'); await pending;
        assert.deepEqual(f.requests.map(r => r[0]), ['source 0', 'source 2', 'source 3']);
        assert.equal(ui.translation.value, 'first');
        assert.equal(f.settings.translations['A:3'].text, 'third');
        assert.equal(f.settings.translations['A:1'], undefined);
        assert.equal(f.context.state.bulkTranslation, null);
    } finally { f.close(); }
});

test('translation cannot overwrite intervening edits, deleted entries or a different book', async () => {
    for (const action of ['source', 'translation', 'delete', 'book', 'cancel']) {
        const f = fixture();
        try {
            const ui = f.ui(0); let finish;
            f.translate(() => new Promise(resolve => { finish = resolve; }));
            const pending = f.context.translateCurrentLorebook('selected', { book: 'A', uids: ['0'] });
            await flush();
            if (action === 'source') ui.source.value = 'edited';
            if (action === 'translation') ui.translation.value = 'edited translation';
            if (action === 'delete') delete f.data.entries[0];
            if (action === 'book') f.switchBook();
            if (action === 'cancel') await f.context.translateCurrentLorebook('selected', f.selection);
            finish('stale'); await pending;
            assert.equal(f.settings.translations['A:0'], undefined, action);
            assert.notEqual(ui.translation.value, 'stale', action);
        } finally { f.close(); }
    }
});

test('source visibility follows actual translation content and toggle without changing the source', () => {
    const f = fixture();
    try {
        const ui = f.ui(0), pane = ui.source.parentElement, grid = pane.parentElement;
        const sync = () => f.context.syncSourceVisibility(ui);
        sync(); assert.equal(pane.classList.contains('slb-source-hidden'), false);
        ui.translation.value = '번역본'; sync();
        assert.equal(pane.classList.contains('slb-source-hidden'), true);
        assert.equal(grid.classList.contains('slb-translation-only'), true);
        f.settings.hideOriginalWhenTranslated = false; sync();
        assert.equal(pane.classList.contains('slb-source-hidden'), false);
        f.settings.hideOriginalWhenTranslated = true; ui.translation.value = '  \n '; sync();
        assert.equal(pane.classList.contains('slb-source-hidden'), false);
        assert.equal(ui.source.value, 'source 0');
    } finally { f.close(); }
});
