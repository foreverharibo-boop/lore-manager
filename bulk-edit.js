// Multi-selection is session-only and scoped to one lorebook, never to row indices.
const FIELDS = Object.freeze({
    strategy: { selector: '.slb-strategy-field select', label: '전략' },
    position: { selector: '.slb-position-field select', label: '위치' },
    depth: { selector: '.slb-depth-field input', label: '깊이' },
    order: { selector: '.slb-order-field input', label: '순서' },
    probability: { selector: '.slb-trigger-field input', label: '발동 확률' },
});

function readChange(control, field, atDepth) {
    if (control.disabled || control.value.trim() === '') return null;
    if (field === 'strategy') {
        if (!['constant', 'normal', 'vectorized'].includes(control.value)) return null;
        return { constant: control.value === 'constant', vectorized: control.value === 'vectorized' };
    }
    const value = Number(control.value);
    if (!Number.isFinite(value)) return null;
    if (field === 'position') {
        const roleValue = control.selectedOptions[0]?.dataset.role;
        const role = value === atDepth ? Number(roleValue) : null;
        if (value === atDepth && (roleValue == null || roleValue === '' || !Number.isFinite(role))) return null;
        return { position: value, role };
    }
    return { [field]: field === 'probability' ? Math.min(100, Math.max(0, value)) : value };
}

// Keep ST's originalData export fields in sync without copying any unrelated settings.
function patchEntry(data, uid, patch, setOriginal) {
    const item = data.entries?.[uid];
    if (!item) return false;
    const paths = {
        constant: 'constant', vectorized: 'extensions.vectorized',
        depth: 'extensions.depth', order: 'insertion_order',
        probability: 'extensions.probability', role: 'extensions.role',
    };
    for (const [key, value] of Object.entries(patch)) {
        item[key] = value;
        const originalUid = item.uid ?? uid;
        if (key === 'position') {
            setOriginal(data, originalUid, 'position', value === 0 ? 'before_char' : 'after_char');
            setOriginal(data, originalUid, 'extensions.position', value);
        } else {
            setOriginal(data, originalUid, paths[key], value);
        }
    }
    return true;
}

export function createLorebookBulkEditor({ getBook, getRows, getUid, loadBook, saveBook,
    setOriginal, atDepth, refreshControl, onApplied, onLayout, onError }) {
    let book = '';
    let enabled = false;
    let revision = 0;
    let toolbar = null;
    let entriesRoot = null;
    let applying = false;
    let selectingAll = false;
    const selected = new Set();
    let queue = Promise.resolve();

    function updateToolbar(message = '') {
        if (!toolbar) return;
        toolbar.querySelector('.slb-bulk-mode').checked = enabled;
        toolbar.querySelector('.slb-bulk-mode').disabled = !getBook();
        toolbar.querySelector('.slb-bulk-selection-tools').hidden = !enabled;
        toolbar.querySelector('.slb-bulk-selection-count').textContent = `${selected.size}개 선택 중`;
        toolbar.querySelector('.slb-bulk-select-all').disabled = selectingAll;
        toolbar.querySelector('.slb-bulk-selection-status').textContent = message
            || '전략·위치·깊이·순서·발동 확률: 바꾼 설정만 선택 항목에 적용';
    }

    function syncRow(row) {
        const uid = getUid(row);
        const active = enabled && book === getBook() && uid !== '';
        row.classList.toggle('slb-bulk-selected', active && selected.has(uid));
        let label = row.querySelector('.slb-entry-selection');
        if (!active) {
            label?.remove();
            return;
        }
        const toggles = row.querySelector('.slb-header-toggles');
        if (!toggles) return;
        if (!label) {
            label = document.createElement('label');
            label.className = 'slb-entry-selection';
            label.title = '일괄 변경할 항목 선택';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'slb-entry-selection-checkbox';
            checkbox.setAttribute('aria-label', '일괄 변경할 항목 선택');
            label.append(checkbox);
            // Selecting must not open the drawer, toggle activation, or start sorting.
            for (const type of ['click', 'pointerdown', 'mousedown', 'touchstart']) {
                label.addEventListener(type, event => event.stopPropagation());
            }
            checkbox.addEventListener('change', event => {
                event.stopPropagation();
                if (!enabled || book !== getBook()) return;
                revision++;
                checkbox.checked ? selected.add(getUid(row)) : selected.delete(getUid(row));
                row.classList.toggle('slb-bulk-selected', checkbox.checked);
                updateToolbar();
            });
        }
        if (toggles.firstElementChild !== label) toggles.prepend(label);
        label.querySelector('input').checked = selected.has(uid);
    }

    function syncRows() {
        getRows().forEach(syncRow);
        updateToolbar();
    }

    function reset(nextBook = getBook()) {
        revision++;
        book = nextBook;
        enabled = false;
        selectingAll = false;
        selected.clear();
        syncRows();
        onLayout();
    }

    async function selectAll() {
        const expectedBook = book;
        const expectedRevision = ++revision;
        selectingAll = true;
        updateToolbar();
        try {
            const data = await loadBook(expectedBook);
            if (!enabled || book !== expectedBook || getBook() !== expectedBook || revision !== expectedRevision) return;
            if (!data?.entries) throw new Error('현재 로어북의 항목을 불러오지 못했습니다.');
            Object.keys(data.entries).forEach(uid => { if (data.entries[uid]) selected.add(String(uid)); });
            syncRows();
        } catch (error) {
            onError(error);
        } finally {
            selectingAll = false;
            updateToolbar();
        }
    }

    function ensureToolbar(popup, entries) {
        if (book !== getBook()) reset(getBook());
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.id = 'slb-entry-selection-toolbar';
            toolbar.innerHTML = `
                <label class="checkbox_label slb-bulk-mode-label"><input type="checkbox" class="slb-bulk-mode"><span>선택</span></label>
                <div class="slb-bulk-selection-tools" hidden>
                    <strong class="slb-bulk-selection-count" aria-live="polite"></strong>
                    <button type="button" class="menu_button slb-bulk-select-all" title="현재 로어북의 모든 항목 선택 (다른 페이지와 필터로 숨긴 항목 포함)">전체 선택</button>
                    <button type="button" class="menu_button slb-bulk-clear">선택 해제</button>
                    <small class="slb-bulk-selection-status" role="status"></small>
                </div>`;
            toolbar.querySelector('.slb-bulk-mode').addEventListener('change', event => {
                revision++;
                book = getBook();
                enabled = event.target.checked && Boolean(book);
                selected.clear();
                syncRows();
                onLayout();
            });
            toolbar.querySelector('.slb-bulk-clear').addEventListener('click', () => {
                revision++;
                selected.clear();
                syncRows();
            });
            toolbar.querySelector('.slb-bulk-select-all').addEventListener('click', selectAll);
        }
        if (toolbar.parentElement !== popup || toolbar.nextElementSibling !== entries) popup.insertBefore(toolbar, entries);
        if (entriesRoot !== entries) {
            entriesRoot?.removeEventListener('input', handleInput, true);
            entriesRoot?.removeEventListener('change', handleInput, true);
            entriesRoot = entries;
            entries.addEventListener('input', handleInput, true);
            entries.addEventListener('change', handleInput, true);
        }
        updateToolbar();
        return toolbar;
    }

    function handleInput(event) {
        if (applying || !enabled || book !== getBook() || selected.size < 2) return;
        const control = event.target;
        if (!(control instanceof Element)) return;
        const row = control.closest('.world_entry');
        if (!row || !selected.has(getUid(row)) || !getRows().includes(row)) return;
        const field = Object.keys(FIELDS).find(key => control.matches(FIELDS[key].selector));
        if (!field) return;
        // Numbers commit on change (blur/Enter), not each partially typed digit.
        // Selects use ST's input event, including the mobile strategy picker.
        if (event.type !== (control.tagName === 'SELECT' ? 'input' : 'change')) return;
        const patch = readChange(control, field, atDepth);
        if (!patch) return;
        const job = { book, revision, uids: [...selected], field, patch };
        // Run after the original target handler, which updates ST's shared cache.
        queue = queue.then(() => applyChange(job)).catch(onError);
    }

    async function applyChange(job) {
        const isCurrent = () => enabled && book === job.book && getBook() === job.book && revision === job.revision;
        if (!isCurrent()) return;
        // Use the live native data object, never an old cloned book snapshot.
        const data = await loadBook(job.book);
        if (!isCurrent()) return;
        if (!data?.entries) throw new Error('현재 로어북의 항목을 불러오지 못했습니다.');
        const affected = new Set(job.uids.filter(uid => data.entries[uid]));
        if (affected.size < 2) return;
        applying = true;
        try {
            for (const uid of affected) patchEntry(data, uid, job.patch, setOriginal);
            for (const row of getRows()) {
                if (!affected.has(getUid(row))) continue;
                const control = row.querySelector(FIELDS[job.field].selector);
                if (!control) continue;
                if (job.field === 'position') {
                    // @D system/user/assistant share value=4; preserve the option's role too.
                    const optionIndex = Array.from(control.options).findIndex(option =>
                        Number(option.value) === job.patch.position
                        && (job.patch.position !== atDepth || Number(option.dataset.role) === job.patch.role));
                    if (optionIndex < 0) continue;
                    control.selectedIndex = optionIndex;
                } else if (job.field === 'strategy') {
                    control.value = job.patch.constant ? 'constant' : job.patch.vectorized ? 'vectorized' : 'normal';
                } else {
                    control.value = String(job.patch[job.field]);
                }
                // Let native handlers update depth visibility and compact labels,
                // but make only one bulk save rather than one request per row.
                refreshControl(control, row);
            }
            await saveBook(job.book, data);
            if (getBook() === job.book) onApplied(job.book, data);
            if (isCurrent()) updateToolbar(`선택한 ${affected.size}개 항목에 ${FIELDS[job.field].label} 변경 적용`);
        } finally {
            applying = false;
        }
    }

    function prune(data) {
        if (!enabled || book !== getBook() || !data?.entries) return;
        for (const uid of selected) if (!data.entries[uid]) selected.delete(uid);
        syncRows();
    }

    function isBulkSource(row) {
        return enabled && book === getBook() && selected.size > 1 && selected.has(getUid(row));
    }

    return { ensureToolbar, syncRow, reset, prune, isBulkSource };
}
