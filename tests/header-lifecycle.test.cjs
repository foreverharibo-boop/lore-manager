const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const makeJQuery = require('jquery');
const source = readFileSync(join(__dirname, '../index.js'), 'utf8');
function productionFunction(name) {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `production function ${name}`);
    return match[0];
}

test('jQuery close before slide animation preserves native controls through destructive cleanup and reopen', () => {
    const dom = new JSDOM('<div id="world_popup_entries_list"></div>', { runScripts: 'outside-only' });
    const w = dom.window;
    w.jQuery = makeJQuery(w);
    const deferred = [];
    w.requestAnimationFrame = fn => deferred.push(fn);
    w.setTimeout = fn => deferred.push(fn);
    const functions = ['queryCompatible', 'getResponsiveHeaderFields', 'getEntryDrawer',
        'bindEntryDrawerLifecycle', 'isEntryDrawerOpen', 'isEntryEditorRendered',
        'isEntryDrawerStablyOpen', 'placeResponsiveHeaderFields', 'enforceActivationOverviewIntegrity'];
    w.eval(`
        const VERSION = 'test';
        const state = {closingEntryDrawers: new WeakSet(), entryFilterRefreshPending:false, sorting:false};
        const renderedEntries = () => [...document.querySelectorAll('.world_entry')];
        const shouldUseCompactHeader = () => true;
        const enhanceEntry = () => {};
        const scheduleNativeHeaderRecovery = () => { throw new Error('Native controls were lost'); };
        ${functions.map(productionFunction).join('\n')}
        window.api = {bindEntryDrawerLifecycle, placeResponsiveHeaderFields, enforceActivationOverviewIntegrity};
    `);
    const row = w.document.createElement('div');
    row.className = 'world_entry slb-compact-entry';
    row.dataset.slbActiveTab = 'activation';
    row.innerHTML = `<form class="world_entry_form"><div class="inline-drawer">
        <div class="inline-drawer-header slb-entry-header"><i class="inline-drawer-icon up"></i>
            <div class="slb-entry-header-shell"><div class="slb-header-grid slb-header-title-only"></div><div class="slb-deferred-header-fields"></div></div>
        </div>
        <div class="inline-drawer-content"><div class="inline-drawer-outlet"><div class="world_entry_edit">
            <section class="slb-panel is-active" data-panel="activation"><div class="slb-activation-overview">
                <div class="slb-strategy-field"><select name="entryStateSelector"><option value="normal">green</option><option value="constant">blue</option></select></div>
                <div class="slb-position-field"><select name="position"><option value="1">after</option><option value="4">depth</option></select></div>
                <div class="slb-depth-field"><input name="depth" value="4"></div>
                <div class="slb-order-field"><input name="order" value="100"></div>
                <div class="slb-trigger-field"><input name="probability" value="100"></div>
            </div></section>
        </div></div></div>
    </div></form>`;
    w.document.getElementById('world_popup_entries_list').append(row);
    const drawer = row.querySelector('.inline-drawer');
    const content = row.querySelector('.inline-drawer-content');
    const outlet = row.querySelector('.inline-drawer-outlet');
    const stash = row.querySelector('.slb-deferred-header-fields');
    const icon = row.querySelector('.inline-drawer-icon');
    w.Element.prototype.getClientRects = function () {
        for (let e = this; e; e = e.parentElement) if (e.hidden || e.style.display === 'none') return [];
        return this.isConnected ? [{}] : [];
    };
    const fields = [...row.querySelector('.slb-activation-overview').children];
    let changes = 0;
    w.jQuery(row.querySelector('[name=order]')).on('input', () => changes++);
    try {
        w.api.bindEntryDrawerLifecycle(row);
        w.api.bindEntryDrawerLifecycle(row); // Must not double-register.
        for (let iteration = 0; iteration < 3; iteration++) {
            // Native ST changes the icon, emits jQuery's event, then animates.
            // Content is still visible when the event arrives.
            icon.className = 'inline-drawer-icon down';
            w.jQuery(drawer).trigger('inline-drawer-toggle');
            assert.equal(stash.children.length, 5, 'park synchronously before animation/cleanup');
            w.api.enforceActivationOverviewIntegrity();
            assert.equal(stash.children.length, 5, 'polling must not put them back during close');
            content.style.display = 'none';
            w.jQuery(outlet).find('option').remove();
            w.jQuery(outlet).empty();
            deferred.splice(0).forEach(fn => fn());
            assert.equal(row.querySelectorAll('option').length, 4, 'native options survive');
            fields.forEach(field => assert.equal(field.parentElement, stash));

            outlet.innerHTML = '<div class="world_entry_edit"><section class="slb-panel is-active" data-panel="activation"><div class="slb-activation-overview"></div></section></div>';
            icon.className = 'inline-drawer-icon up';
            w.jQuery(drawer).trigger('inline-drawer-toggle');
            content.style.display = 'block';
            deferred.splice(0).forEach(fn => fn());
            const overview = row.querySelector('.slb-activation-overview');
            fields.forEach(field => assert.equal(field.parentElement, overview, 'reuse same native node'));
            assert.equal(overview.hidden, false);
            w.jQuery(row.querySelector('[name=order]')).trigger('input');
            assert.equal(changes, iteration + 1, 'native handler survives exactly once');
        }
        // Nested editor drawers must not change the outer lifecycle state.
        const nested = w.document.createElement('div');
        nested.className = 'inline-drawer'; outlet.append(nested);
        w.jQuery(nested).trigger('inline-drawer-toggle');
        assert.equal(stash.children.length, 0);
    } finally { w.close(); }
});
