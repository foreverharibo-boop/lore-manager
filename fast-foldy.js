import { saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { SORT_ORDER_KEY } from '../../../world-info.js';

export const FAST_FOLDY_SORT_VALUE = 'slb-fast-foldy';

const LIST_ID = 'world_popup_entries_list';
const SORT_ID = 'world_info_sort_order';
const FOLDY_SORT_VALUES = Object.freeze(['foldy-order', 'foldy']);
const MANAGER_FOLDER_CLASS = 'slb-fast-foldy-folder';
const MANAGER_ITEMS_CLASS = 'slb-fast-foldy-items';
const MANAGER_MOVE_CLASS = 'slb-fast-foldy-move';

function cloneJson(value) {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function ownerForBook(book) {
    return JSON.stringify(['name', String(book || '')]);
}

function legacyOwnerForBook(book) {
    return `name:${String(book || '')}`;
}

function uniqueId() {
    return globalThis.crypto?.randomUUID?.()
        || `slb-folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function rowUid(row) {
    return String(row?.getAttribute?.('uid') ?? row?.dataset?.uid ?? '');
}

function managerRowSelector() {
    return [
        `#${LIST_ID} > .world_entry`,
        `#${LIST_ID} > .${MANAGER_FOLDER_CLASS} > .${MANAGER_ITEMS_CLASS} > .world_entry`,
    ].join(', ');
}

function ensureFoldyStore() {
    if (!extension_settings.foldy || typeof extension_settings.foldy !== 'object' || Array.isArray(extension_settings.foldy)) {
        extension_settings.foldy = {};
    }
    const foldy = extension_settings.foldy;
    if (!foldy.layouts || typeof foldy.layouts !== 'object' || Array.isArray(foldy.layouts)) foldy.layouts = {};
    if (!foldy.layouts.lorebooks || typeof foldy.layouts.lorebooks !== 'object' || Array.isArray(foldy.layouts.lorebooks)) {
        foldy.layouts.lorebooks = {};
    }
    if (!foldy.collapsed || typeof foldy.collapsed !== 'object' || Array.isArray(foldy.collapsed)) foldy.collapsed = {};
    if (!foldy.collapsed.lore || typeof foldy.collapsed.lore !== 'object' || Array.isArray(foldy.collapsed.lore)) {
        foldy.collapsed.lore = {};
    }
    return foldy;
}

function normalizeLayoutWithoutDroppingUnseen(rawLayout, visibleIds) {
    const source = rawLayout && typeof rawLayout === 'object' && !Array.isArray(rawLayout)
        ? rawLayout
        : {};
    const sourceFolders = Array.isArray(source.folders) ? source.folders : [];
    const sourceRoot = Array.isArray(source.root) ? source.root : [];
    const folders = [];
    const folderIds = new Set();
    const folderNames = new Set();
    const ownedItems = new Set();

    for (const candidate of sourceFolders) {
        if (!candidate || typeof candidate !== 'object') continue;
        let id = String(candidate.id || uniqueId());
        while (folderIds.has(id)) id = uniqueId();
        folderIds.add(id);

        const requestedName = String(candidate.name || '새 폴더').trim() || '새 폴더';
        let name = requestedName;
        let suffix = 2;
        while (folderNames.has(name.toLocaleLowerCase())) name = `${requestedName} (${suffix++})`;
        folderNames.add(name.toLocaleLowerCase());

        const items = [];
        for (const value of Array.isArray(candidate.items) ? candidate.items : []) {
            const itemId = String(value ?? '');
            if (!itemId || ownedItems.has(itemId)) continue;
            ownedItems.add(itemId);
            items.push(itemId);
        }
        folders.push({
            id,
            name,
            color: typeof candidate.color === 'string' ? candidate.color : '',
            borderColor: typeof candidate.borderColor === 'string' ? candidate.borderColor : '',
            nameColor: typeof candidate.nameColor === 'string' ? candidate.nameColor : '',
            items,
        });
    }

    const folderMap = new Map(folders.map(folder => [folder.id, folder]));
    const root = [];
    const rootedFolders = new Set();
    const rootedItems = new Set();
    for (const candidate of sourceRoot) {
        if (!candidate || typeof candidate !== 'object') continue;
        const id = String(candidate.id ?? '');
        if (candidate.type === 'folder' && folderMap.has(id) && !rootedFolders.has(id)) {
            rootedFolders.add(id);
            root.push({ type: 'folder', id });
        } else if (candidate.type === 'item' && id && !ownedItems.has(id) && !rootedItems.has(id)) {
            rootedItems.add(id);
            root.push({ type: 'item', id });
        }
    }
    for (const folder of folders) {
        if (!rootedFolders.has(folder.id)) root.push({ type: 'folder', id: folder.id });
    }
    for (const visibleId of visibleIds) {
        const id = String(visibleId);
        if (!ownedItems.has(id) && !rootedItems.has(id)) {
            rootedItems.add(id);
            root.push({ type: 'item', id });
        }
    }
    return { version: 1, root, folders };
}

function sameJson(left, right) {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function iconButton(icon, title, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button fa-solid ${icon} ${extraClass}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
}

function setFolderStyle(element, folder) {
    const background = String(folder.color || '').trim();
    const border = String(folder.borderColor || '').trim();
    const name = String(folder.nameColor || '').trim();
    if (background) element.style.setProperty('--slb-fast-folder-bg', background);
    if (border) element.style.setProperty('--slb-fast-folder-border', border);
    if (name) element.style.setProperty('--slb-fast-folder-name', name);
}

function showFormDialog({ title, submitText, fields, validate = null }) {
    return new Promise(resolve => {
        document.getElementById('slb-fast-foldy-dialog')?.remove();
        const dialog = document.createElement('dialog');
        dialog.id = 'slb-fast-foldy-dialog';
        dialog.className = 'slb-fast-foldy-dialog';
        const form = document.createElement('form');
        form.method = 'dialog';
        const heading = document.createElement('strong');
        heading.textContent = title;
        const body = document.createElement('div');
        body.className = 'slb-fast-foldy-dialog-body';
        for (const field of fields) body.append(field.element);
        const actions = document.createElement('div');
        actions.className = 'slb-fast-foldy-dialog-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'menu_button';
        cancel.textContent = '취소';
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'menu_button';
        submit.textContent = submitText;
        actions.append(cancel, submit);
        form.append(heading, body, actions);
        dialog.append(form);
        document.body.append(dialog);

        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            dialog.remove();
            resolve(value);
        };
        cancel.addEventListener('click', () => finish(null));
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            finish(null);
        });
        dialog.addEventListener('close', () => finish(null));
        form.addEventListener('submit', event => {
            event.preventDefault();
            const values = Object.fromEntries(fields.map(field => [field.name, field.value()]));
            const problem = validate?.(values);
            if (problem) {
                globalThis.toastr?.warning?.(problem);
                return;
            }
            finish(values);
        });
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        fields[0]?.focus?.();
    });
}

function textField(name, labelText, value = '') {
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'text_pole';
    input.type = 'text';
    input.value = value;
    label.append(text, input);
    return { name, element: label, value: () => input.value.trim(), focus: () => input.focus() };
}

function colorField(name, labelText, value = '') {
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'text_pole';
    input.type = 'text';
    input.placeholder = '기본 테마색';
    input.value = value;
    label.append(text, input);
    return { name, element: label, value: () => input.value.trim() };
}

function selectField(name, labelText, options, selectedValue = '') {
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = labelText;
    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const optionValue of options) {
        const option = document.createElement('option');
        option.value = optionValue.value;
        option.textContent = optionValue.label;
        select.append(option);
    }
    select.value = selectedValue;
    label.append(text, select);
    return { name, element: label, value: () => select.value, focus: () => select.focus() };
}

export function createFastFoldyRenderer({
    getBookName,
    onRendered,
    notify,
}) {
    let active = false;
    let rendering = false;
    let suppressObserver = false;
    let listObserver = null;
    let observedList = null;
    let renderTimer = 0;
    let renderRaf = 0;
    let sortableSaveTimer = 0;
    let initialized = false;
    let activeEventsBound = false;
    let renderGeneration = 0;
    let dirty = true;
    let currentLayout = null;
    let currentOwner = '';
    let lastNativeSortValue = '0';
    let nativeResetRequested = false;
    let awaitingNativeReset = false;

    function emitModeChange() {
        window.dispatchEvent(new CustomEvent('slb-fast-foldy-mode-change', {
            detail: { active },
        }));
    }

    function bindActiveEvents() {
        if (activeEventsBound) return;
        window.addEventListener('change', handleGlobalChange, true);
        activeEventsBound = true;
    }

    function unbindActiveEvents() {
        if (!activeEventsBound) return;
        window.removeEventListener('change', handleGlobalChange, true);
        activeEventsBound = false;
    }

    function isAvailable() {
        const foldy = extension_settings?.foldy;
        if (foldy?.features?.lorebooks === false) return false;
        const originalOption = FOLDY_SORT_VALUES
            .map(value => document.querySelector(`#${SORT_ID} option[value="${value}"]`))
            .find(Boolean);
        if (originalOption) return !originalOption.disabled;
        // Foldy renders its own settings panel before installing the optional
        // lorebook toolbar. This covers that short startup gap without treating
        // stale extension_settings left by an uninstall as an installed copy.
        return Boolean(document.getElementById('foldy_settings'));
    }

    function getList() {
        return document.getElementById(LIST_ID);
    }

    function getSort() {
        return document.getElementById(SORT_ID);
    }

    function allRows(list = getList()) {
        if (!list) return [];
        return [...document.querySelectorAll(managerRowSelector())].filter(row => list.contains(row));
    }

    function deduplicatedRows(list) {
        const byUid = new Map();
        for (const row of allRows(list)) {
            const uid = rowUid(row);
            if (!uid) continue;
            if (!byUid.has(uid)) {
                byUid.set(uid, row);
            } else {
                row.remove();
            }
        }
        return [...byUid.values()];
    }

    function resolveLayout(book, visibleIds, { saveRepair = true } = {}) {
        const foldy = ensureFoldyStore();
        const owner = ownerForBook(book);
        const legacyOwner = legacyOwnerForBook(book);
        const raw = foldy.layouts.lorebooks[owner]
            || foldy.layouts.lorebooks[legacyOwner]
            || foldy.layouts.lorebooks[book]
            || null;
        const normalized = normalizeLayoutWithoutDroppingUnseen(raw, visibleIds);
        const changed = !sameJson(raw, normalized) || !foldy.layouts.lorebooks[owner];
        foldy.layouts.lorebooks[owner] = normalized;
        if (legacyOwner !== owner && foldy.layouts.lorebooks[legacyOwner] === raw) delete foldy.layouts.lorebooks[legacyOwner];
        if (book !== owner && foldy.layouts.lorebooks[book] === raw) delete foldy.layouts.lorebooks[book];
        if (changed && saveRepair) saveSettingsDebounced();
        currentOwner = owner;
        currentLayout = normalized;
        return normalized;
    }

    function collapsedSet(owner) {
        const foldy = ensureFoldyStore();
        const values = foldy.collapsed.lore[owner];
        return new Set(Array.isArray(values) ? values.map(String) : []);
    }

    function saveCollapsed(owner, collapsed) {
        const foldy = ensureFoldyStore();
        const values = [...collapsed];
        if (values.length) foldy.collapsed.lore[owner] = values;
        else delete foldy.collapsed.lore[owner];
        saveSettingsDebounced();
    }

    async function persistLayout(layout, reason = '') {
        if (!currentOwner) return;
        ensureFoldyStore().layouts.lorebooks[currentOwner] = layout;
        currentLayout = layout;
        try {
            await saveSettings();
        } catch (error) {
            console.error('[로어북 매니저] 폴디 연동 폴더 구조 저장 실패', error);
            notify?.('폴디 연동 폴더 구조를 저장하지 못했습니다.', 'error');
            throw error;
        }
        if (reason) notify?.(reason, 'success');
    }

    function destroySortables(list = getList()) {
        if (!list || !globalThis.jQuery?.fn?.sortable) return;
        const candidates = [list, ...list.querySelectorAll(`.${MANAGER_ITEMS_CLASS}`)];
        for (const element of candidates) {
            const target = globalThis.jQuery(element);
            try {
                if (target.sortable('instance')) target.sortable('destroy');
            } catch {
                // jQuery UI가 아직 준비되지 않은 초기 프레임은 건너뛴다.
            }
        }
    }

    function readLayoutFromDom(list, baseLayout) {
        const visibleIds = new Set(allRows(list).map(rowUid).filter(Boolean));
        const displayedFolderIds = new Set(
            [...list.querySelectorAll(`:scope > .${MANAGER_FOLDER_CLASS}`)]
                .map(folder => String(folder.dataset.folderId || ''))
                .filter(Boolean),
        );
        const next = cloneJson(baseLayout);
        const folderMap = new Map(next.folders.map(folder => [String(folder.id), folder]));

        for (const folder of next.folders) {
            folder.items = folder.items.filter(id => !visibleIds.has(String(id)));
        }
        next.root = next.root.filter(node => !(node.type === 'item' && visibleIds.has(String(node.id))));

        const domRoot = [];
        for (const element of list.children) {
            if (element.classList.contains(MANAGER_FOLDER_CLASS)) {
                const folderId = String(element.dataset.folderId || '');
                const folder = folderMap.get(folderId);
                if (!folder) continue;
                const itemIds = [...element.querySelectorAll(`:scope > .${MANAGER_ITEMS_CLASS} > .world_entry`)]
                    .map(rowUid)
                    .filter(Boolean);
                folder.items.push(...itemIds);
                domRoot.push({ type: 'folder', id: folderId });
            } else if (element.classList.contains('world_entry')) {
                const uid = rowUid(element);
                if (uid) domRoot.push({ type: 'item', id: uid });
            }
        }

        const removableIndices = [];
        next.root.forEach((node, index) => {
            if ((node.type === 'folder' && displayedFolderIds.has(String(node.id)))
                || (node.type === 'item' && visibleIds.has(String(node.id)))) {
                removableIndices.push(index);
            }
        });
        const insertionIndex = removableIndices.length ? removableIndices[0] : next.root.length;
        next.root = next.root.filter(node => !(
            (node.type === 'folder' && displayedFolderIds.has(String(node.id)))
            || (node.type === 'item' && visibleIds.has(String(node.id)))
        ));
        next.root.splice(Math.min(insertionIndex, next.root.length), 0, ...domRoot);
        return normalizeLayoutWithoutDroppingUnseen(next, visibleIds);
    }

    function scheduleSortableSave() {
        if (sortableSaveTimer) clearTimeout(sortableSaveTimer);
        sortableSaveTimer = setTimeout(async () => {
            sortableSaveTimer = 0;
            const list = getList();
            if (!active || !list || !currentLayout) return;
            const next = readLayoutFromDom(list, currentLayout);
            currentLayout = next;
            ensureFoldyStore().layouts.lorebooks[currentOwner] = next;
            try {
                await saveSettings();
                renderNow('sort-save');
            } catch (error) {
                console.error('[로어북 매니저] 폴디 연동 폴더 정렬 저장 실패', error);
                notify?.('폴더 순서를 저장하지 못했습니다.', 'error');
            }
        }, 0);
    }

    function setupSortables(list) {
        destroySortables(list);
        if (!globalThis.jQuery?.fn?.sortable) return;
        const common = {
            delay: matchMedia('(pointer: coarse)').matches ? 220 : 60,
            handle: '.drag-handle',
            placeholder: 'slb-fast-foldy-placeholder',
            forcePlaceholderSize: true,
            tolerance: 'pointer',
            start: () => {
                dirty = true;
                suppressObserver = true;
                list.classList.add('slb-fast-foldy-sorting');
            },
            stop: () => {
                list.classList.remove('slb-fast-foldy-sorting');
                scheduleSortableSave();
                // sortable이 만든 childList 알림은 현재 작업 저장으로 이미
                // 처리한다. observer가 이를 네이티브 재렌더로 오인하지 않게
                // 알림 전달이 끝나는 다음 task까지 억제한다.
                setTimeout(() => { suppressObserver = false; }, 0);
            },
        };
        globalThis.jQuery(list).sortable({
            ...common,
            items: `> .world_entry, > .${MANAGER_FOLDER_CLASS}`,
            connectWith: `#${LIST_ID}, .${MANAGER_ITEMS_CLASS}`,
        });
        list.querySelectorAll(`.${MANAGER_ITEMS_CLASS}`).forEach(items => {
            globalThis.jQuery(items).sortable({
                ...common,
                items: '> .world_entry',
                connectWith: `#${LIST_ID}, .${MANAGER_ITEMS_CLASS}`,
                receive(event, ui) {
                    // Foldy 호환 레이아웃은 폴더 중첩을 지원하지 않는다.
                    if (ui.item?.hasClass?.(MANAGER_FOLDER_CLASS)) {
                        globalThis.jQuery(event.currentTarget).sortable('cancel');
                    }
                },
            });
        });
    }

    async function requestMove(uid) {
        if (!currentLayout) return;
        const currentFolder = currentLayout.folders.find(folder => folder.items.includes(uid));
        const field = selectField('folderId', '이동할 곳', [
            { value: '', label: '최상위 (폴더 없음)' },
            ...currentLayout.folders.map(folder => ({ value: folder.id, label: folder.name })),
        ], currentFolder?.id || '');
        const values = await showFormDialog({
            title: '폴더로 이동',
            submitText: '이동',
            fields: [field],
        });
        if (!values) return;
        const targetId = String(values.folderId || '');
        const next = cloneJson(currentLayout);
        next.root = next.root.filter(node => !(node.type === 'item' && String(node.id) === uid));
        for (const folder of next.folders) folder.items = folder.items.filter(id => String(id) !== uid);
        if (targetId) {
            const target = next.folders.find(folder => String(folder.id) === targetId);
            if (!target) return;
            target.items.push(uid);
        } else {
            next.root.push({ type: 'item', id: uid });
        }
        await persistLayout(next);
        renderNow('move');
    }

    function attachMoveButton(row) {
        row.querySelectorAll(`.${MANAGER_MOVE_CLASS}`).forEach(button => button.remove());
        const header = row.querySelector('.inline-drawer-header, .world_entry_header, .world-entry-header');
        if (!header || !currentLayout?.folders?.length) return;
        const uid = rowUid(row);
        if (!uid) return;
        const button = iconButton('fa-folder-open', '폴디 연동 폴더로 이동', `${MANAGER_MOVE_CLASS} slb-fast-foldy-control`);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            void requestMove(uid);
        });
        const actions = header.querySelector(':scope > .slb-header-actions');
        if (actions) actions.prepend(button);
        else header.append(button);
    }

    async function editFolder(folderId) {
        const folder = currentLayout?.folders?.find(value => String(value.id) === String(folderId));
        if (!folder) return;
        const fields = [
            textField('name', '폴더 이름', folder.name),
            colorField('color', '배경색', folder.color),
            colorField('borderColor', '테두리색', folder.borderColor),
            colorField('nameColor', '이름 색상', folder.nameColor),
        ];
        const values = await showFormDialog({
            title: '폴디 연동 폴더 설정',
            submitText: '적용',
            fields,
            validate: result => {
                if (!result.name) return '폴더 이름을 입력해주세요.';
                if (currentLayout.folders.some(value => value.id !== folder.id && value.name.toLocaleLowerCase() === result.name.toLocaleLowerCase())) {
                    return '같은 이름의 폴더가 이미 있습니다.';
                }
                return '';
            },
        });
        if (!values) return;
        const next = cloneJson(currentLayout);
        const target = next.folders.find(value => String(value.id) === String(folderId));
        Object.assign(target, values);
        await persistLayout(next, '폴더 설정을 저장했습니다.');
        renderNow('edit-folder');
    }

    async function deleteFolder(folderId) {
        const folder = currentLayout?.folders?.find(value => String(value.id) === String(folderId));
        if (!folder) return;
        if (!confirm(`“${folder.name}” 폴더만 삭제할까요?\n안의 로어북 항목은 최상위로 이동합니다.`)) return;
        const next = cloneJson(currentLayout);
        const rootIndex = next.root.findIndex(node => node.type === 'folder' && String(node.id) === String(folderId));
        const promoted = folder.items.map(id => ({ type: 'item', id: String(id) }));
        if (rootIndex >= 0) next.root.splice(rootIndex, 1, ...promoted);
        else next.root.push(...promoted);
        next.folders = next.folders.filter(value => String(value.id) !== String(folderId));
        const collapsed = collapsedSet(currentOwner);
        collapsed.delete(String(folderId));
        saveCollapsed(currentOwner, collapsed);
        await persistLayout(next, '폴더를 삭제했습니다. 로어북 항목은 유지됩니다.');
        renderNow('delete-folder');
    }

    function createFolderElement(folder, rows, collapsed) {
        const element = document.createElement('section');
        element.className = MANAGER_FOLDER_CLASS;
        element.dataset.folderId = String(folder.id);
        element.dataset.slbFastFoldyOwned = 'true';
        if (collapsed.has(String(folder.id))) element.classList.add('is-collapsed');
        setFolderStyle(element, folder);

        const header = document.createElement('div');
        header.className = 'slb-fast-foldy-folder-header';
        const drag = document.createElement('span');
        drag.className = 'drag-handle fa-solid fa-bars';
        drag.title = '폴더 이동';
        const collapse = iconButton(
            element.classList.contains('is-collapsed') ? 'fa-chevron-right' : 'fa-chevron-down',
            '폴더 접기/펼치기',
            'slb-fast-foldy-collapse slb-fast-foldy-control',
        );
        const name = document.createElement('span');
        name.className = 'slb-fast-foldy-folder-name';
        name.textContent = folder.name;
        name.title = folder.name;
        const count = document.createElement('span');
        count.className = 'slb-fast-foldy-folder-count';
        count.textContent = rows.length === folder.items.length
            ? String(folder.items.length)
            : `${rows.length}/${folder.items.length}`;
        count.title = rows.length === folder.items.length
            ? `${folder.items.length}개 항목`
            : `현재 페이지 ${rows.length}개 / 폴더 전체 ${folder.items.length}개`;
        const edit = iconButton('fa-pencil', '폴더 편집', 'slb-fast-foldy-control');
        const remove = iconButton('fa-trash', '폴더 삭제', 'slb-fast-foldy-control caution');
        const items = document.createElement('div');
        items.className = MANAGER_ITEMS_CLASS;

        const toggleCollapse = () => {
            const isCollapsed = element.classList.toggle('is-collapsed');
            collapse.classList.toggle('fa-chevron-right', isCollapsed);
            collapse.classList.toggle('fa-chevron-down', !isCollapsed);
            const nextCollapsed = collapsedSet(currentOwner);
            isCollapsed ? nextCollapsed.add(String(folder.id)) : nextCollapsed.delete(String(folder.id));
            saveCollapsed(currentOwner, nextCollapsed);
        };
        collapse.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            toggleCollapse();
        });
        name.addEventListener('click', toggleCollapse);
        edit.addEventListener('click', () => void editFolder(folder.id));
        remove.addEventListener('click', () => void deleteFolder(folder.id));
        rows.forEach(row => {
            attachMoveButton(row);
            items.append(row);
        });
        header.append(drag, collapse, name, count, edit, remove);
        element.append(header, items);
        return element;
    }

    function clearForeignFolderShells(list, rows, header) {
        for (const row of rows) row.remove();
        if (header) header.remove();
        list.replaceChildren();
        list.classList.remove(
            'foldy-lore-root',
            'foldy-lore-pending',
            'foldy-searching',
            'slb-foldy-ready',
            'slb-foldy-settling',
            'slb-foldy-folder-operation',
        );
        list.classList.add('slb-fast-foldy-root');
    }

    function renderNow(reason = 'manual') {
        if (!active || rendering) return false;
        const list = getList();
        const book = getBookName();
        if (!list) return false;
        if (!book) {
            dirty = false;
            currentOwner = '';
            currentLayout = null;
            list.classList.remove('slb-fast-foldy-pending', 'slb-fast-foldy-rendering');
            return true;
        }
        // When switching explicitly from original Foldy, first ask
        // SillyTavern to rebuild its ordinary rows through the public sort and
        // refresh controls. The linked renderer never extracts rows from or
        // mutates an original Foldy folder shell.
        const hasOriginalFoldyDom = !list.classList.contains('slb-fast-foldy-root') && Boolean(
            list.classList.contains('foldy-lore-root')
            || list.querySelector(':scope > .foldy-lore-folder, :scope > .foldy-folder'),
        );
        if (hasOriginalFoldyDom) awaitingNativeReset = true;
        if (awaitingNativeReset) {
            if (!nativeResetRequested) {
                nativeResetRequested = true;
                document.getElementById('world_refresh')?.click();
            }
            schedule('wait-native-reset', 80);
            return false;
        }
        nativeResetRequested = false;
        // 원본 Foldy 렌더가 이미 시작된 정확한 순간에 사용자가 연동 모드를
        // 켰다면 그 작업의 finally가 끝날 때까지 기다린다. 실행 중인 원본
        // 함수를 중단하거나 패치하지 않고, 완료된 DOM만 인계받는다.
        if (list.classList.contains('foldy-lore-pending')
            && !list.classList.contains('slb-fast-foldy-root')) {
            schedule('wait-original-foldy', 16);
            return false;
        }
        const generation = ++renderGeneration;
        rendering = true;
        suppressObserver = true;
        list.classList.add('slb-fast-foldy-rendering');
        let renderedPayload = null;
        try {
            destroySortables(list);
            const header = list.querySelector(':scope > #WIEntryHeaderTitlesPC')
                || list.querySelector('#WIEntryHeaderTitlesPC');
            const rows = deduplicatedRows(list);
            const visibleIds = rows.map(rowUid).filter(Boolean);
            const layout = resolveLayout(book, visibleIds);
            const rowMap = new Map(rows.map(row => [rowUid(row), row]));
            const folderMap = new Map(layout.folders.map(folder => [String(folder.id), folder]));
            const collapsed = collapsedSet(currentOwner);
            const fragment = document.createDocumentFragment();
            clearForeignFolderShells(list, rows, header);
            if (header) fragment.append(header);

            for (const node of layout.root) {
                if (node.type === 'item') {
                    const row = rowMap.get(String(node.id));
                    if (!row) continue;
                    rowMap.delete(String(node.id));
                    attachMoveButton(row);
                    fragment.append(row);
                    continue;
                }
                const folder = folderMap.get(String(node.id));
                if (!folder) continue;
                const folderRows = folder.items
                    .map(id => rowMap.get(String(id)))
                    .filter(Boolean);
                for (const row of folderRows) rowMap.delete(rowUid(row));
                if (!folderRows.length && folder.items.length) continue;
                fragment.append(createFolderElement(folder, folderRows, collapsed));
            }
            for (const row of rowMap.values()) {
                attachMoveButton(row);
                fragment.append(row);
            }
            list.append(fragment);
            setupSortables(list);
            document.getElementById('WorldInfo')?.classList.add('slb-fast-foldy-active');
            if (generation === renderGeneration) {
                dirty = false;
                renderedPayload = { reason, rows: allRows(list), list };
            }
            return true;
        } catch (error) {
            dirty = true;
            console.error('[로어북 매니저] 폴디 연동 폴더 렌더 실패', error);
            notify?.('폴디 연동 폴더를 표시하지 못했습니다. 기존 로어북 매니저로 전환해 주세요.', 'error');
            return false;
        } finally {
            rendering = false;
            if (renderedPayload) {
                try {
                    onRendered?.(renderedPayload);
                } catch (error) {
                    console.error('[로어북 매니저] 폴디 연동 폴더 렌더 후처리 실패', error);
                }
            }
            setTimeout(() => {
                suppressObserver = false;
                list.classList.remove('slb-fast-foldy-rendering');
            }, 0);
        }
    }

    function reveal() {
        const list = getList();
        if (!active || rendering || dirty || !list?.classList.contains('slb-fast-foldy-root')) return false;
        list.classList.remove('slb-fast-foldy-pending');
        return true;
    }

    function schedule(reason = 'mutation', delay = 0) {
        if (!active) return;
        ensureSortOption();
        ensureToolbar();
        observeList();
        dirty = true;
        if (['activate', 'book-change', 'native-list-change', 'manager-observer', 'enhance-wait'].includes(reason)) {
            getList()?.classList.add('slb-fast-foldy-pending');
        }
        if (renderTimer) clearTimeout(renderTimer);
        if (renderRaf) cancelAnimationFrame(renderRaf);
        renderTimer = setTimeout(() => {
            renderTimer = 0;
            renderRaf = requestAnimationFrame(() => {
                renderRaf = 0;
                renderNow(reason);
            });
        }, delay);
    }

    function observeList() {
        const list = getList();
        if (!list || observedList === list) return;
        listObserver?.disconnect();
        observedList = list;
        listObserver = new MutationObserver(mutations => {
            if (!active || suppressObserver || rendering) return;
            const nativeChange = mutations.some(mutation => [...mutation.addedNodes, ...mutation.removedNodes]
                .some(node => node instanceof Element && (
                    node.matches('.world_entry, #WIEntryHeaderTitlesPC')
                    || node.querySelector?.('.world_entry, #WIEntryHeaderTitlesPC')
                )));
            if (nativeChange) {
                awaitingNativeReset = false;
                nativeResetRequested = false;
                schedule('native-list-change');
            }
        });
        listObserver.observe(list, { childList: true });
    }

    function ensureToolbar() {
        const newButton = document.getElementById('world_popup_new');
        if (!newButton) return;
        let create = document.getElementById('slb_fast_foldy_create');
        if (!create) {
            create = iconButton('fa-folder-plus', '폴디 연동 폴더 만들기', 'slb-fast-foldy-toolbar-button');
            create.id = 'slb_fast_foldy_create';
            create.addEventListener('click', async () => {
                if (!currentLayout) renderNow('create-prerequisite');
                if (!currentLayout) return;
                const name = textField('name', '폴더 이름');
                const values = await showFormDialog({
                    title: '새 폴디 연동 폴더',
                    submitText: '만들기',
                    fields: [name],
                    validate: result => {
                        if (!result.name) return '폴더 이름을 입력해주세요.';
                        if (currentLayout.folders.some(folder => folder.name.toLocaleLowerCase() === result.name.toLocaleLowerCase())) {
                            return '같은 이름의 폴더가 이미 있습니다.';
                        }
                        return '';
                    },
                });
                if (!values) return;
                const next = cloneJson(currentLayout);
                const folder = { id: uniqueId(), name: values.name, color: '', borderColor: '', nameColor: '', items: [] };
                next.folders.push(folder);
                next.root.unshift({ type: 'folder', id: folder.id });
                await persistLayout(next, '새 폴더를 만들었습니다.');
                renderNow('create-folder');
            });
            newButton.after(create);
        }
        if (!document.getElementById('slb_fast_foldy_expand_all')) {
            const expand = iconButton('fa-folder-open', '폴디 연동 폴더 모두 펼치기', 'slb-fast-foldy-toolbar-button');
            expand.id = 'slb_fast_foldy_expand_all';
            expand.addEventListener('click', () => {
                saveCollapsed(currentOwner, new Set());
                renderNow('expand-all');
            });
            create.after(expand);
        }
        if (!document.getElementById('slb_fast_foldy_collapse_all')) {
            const collapse = iconButton('fa-folder', '폴디 연동 폴더 모두 접기', 'slb-fast-foldy-toolbar-button');
            collapse.id = 'slb_fast_foldy_collapse_all';
            collapse.addEventListener('click', () => {
                saveCollapsed(currentOwner, new Set(currentLayout?.folders?.map(folder => String(folder.id)) || []));
                renderNow('collapse-all');
            });
            document.getElementById('slb_fast_foldy_expand_all')?.after(collapse);
        }
    }

    function removeToolbar() {
        document.getElementById('slb_fast_foldy_create')?.remove();
        document.getElementById('slb_fast_foldy_expand_all')?.remove();
        document.getElementById('slb_fast_foldy_collapse_all')?.remove();
    }

    function ensureSortOption() {
        const sort = getSort();
        if (!sort) return;
        let option = sort.querySelector(`option[value="${FAST_FOLDY_SORT_VALUE}"]`);
        if (!option) {
            option = document.createElement('option');
            option.value = FAST_FOLDY_SORT_VALUE;
            option.textContent = '폴디 연동 로어북 매니저';
            option.dataset.rule = 'custom';
            option.dataset.field = 'displayIndex';
            option.dataset.order = 'asc';
            option.dataset.slbInternal = 'true';
            option.hidden = true;
            sort.append(option);
        }
        option.hidden = true;
        option.disabled = !isAvailable();
    }

    function removeSortOption() {
        getSort()?.querySelector(`option[value="${FAST_FOLDY_SORT_VALUE}"]`)?.remove();
    }

    function nativeSortValue() {
        const sort = getSort();
        if (!sort) return '';
        const current = sort.value;
        if (current && current !== FAST_FOLDY_SORT_VALUE && !FOLDY_SORT_VALUES.includes(current)) {
            const currentOption = [...sort.options].find(option => option.value === current);
            if (currentOption && currentOption.dataset.rule !== 'custom') {
                lastNativeSortValue = current;
                return current;
            }
        }
        const remembered = [...sort.options].find(option => (
            option.value === lastNativeSortValue
            && option.value !== FAST_FOLDY_SORT_VALUE
            && !FOLDY_SORT_VALUES.includes(option.value)
            && option.dataset.rule !== 'custom'
        ));
        if (remembered) return remembered.value;
        const zero = [...sort.options].find(option => option.value === '0' && option.dataset.rule !== 'custom');
        if (zero) return zero.value;
        return [...sort.options].find(option => (
            option.value !== FAST_FOLDY_SORT_VALUE
            && !FOLDY_SORT_VALUES.includes(option.value)
            && option.dataset.rule !== 'custom'
            && !option.disabled
        ))?.value || '';
    }

    function switchToNativeSort({ dispatch = true } = {}) {
        const sort = getSort();
        if (!sort) return false;
        const previous = sort.value;
        const next = nativeSortValue();
        if (!next) return false;
        sort.value = next;
        accountStorage.setItem(SORT_ORDER_KEY, next);
        if (dispatch && previous !== next) sort.dispatchEvent(new Event('change', { bubbles: true }));
        return previous !== next;
    }

    function flattenManagerFolders() {
        const list = getList();
        if (!list) return;
        destroySortables(list);
        const rows = deduplicatedRows(list);
        const header = list.querySelector('#WIEntryHeaderTitlesPC');
        rows.forEach(row => row.remove());
        header?.remove();
        list.replaceChildren();
        if (header) list.append(header);
        rows.forEach(row => {
            row.querySelectorAll(`.${MANAGER_MOVE_CLASS}`).forEach(button => button.remove());
            list.append(row);
        });
        list.classList.remove('slb-fast-foldy-root', 'slb-fast-foldy-rendering', 'slb-fast-foldy-sorting', 'slb-fast-foldy-pending');
        document.getElementById('WorldInfo')?.classList.remove('slb-fast-foldy-active');
    }

    function activate({ announce = false } = {}) {
        if (!isAvailable()) {
            notify?.('Foldy 로어북 폴더 데이터를 찾지 못했습니다.', 'warning');
            return false;
        }
        ensureSortOption();
        const wasActive = active;
        const list = getList();
        const hadOriginalFoldyDom = Boolean(
            list?.classList.contains('foldy-lore-root')
            || list?.querySelector(':scope > .foldy-lore-folder, :scope > .foldy-folder'),
        );
        active = true;
        dirty = true;
        const sort = getSort();
        if (sort) {
            if (sort.value && sort.value !== FAST_FOLDY_SORT_VALUE && !FOLDY_SORT_VALUES.includes(sort.value)) {
                const selected = sort.selectedOptions?.[0];
                if (selected?.dataset.rule !== 'custom') lastNativeSortValue = sort.value;
            }
            sort.value = FAST_FOLDY_SORT_VALUE;
        }
        accountStorage.setItem(SORT_ORDER_KEY, FAST_FOLDY_SORT_VALUE);
        observeList();
        // Foldy's own public sort listener sees a non-Foldy value and steps
        // aside. We neither patch that listener nor stop its events.
        if (hadOriginalFoldyDom && sort) {
            awaitingNativeReset = true;
            list?.classList.add('slb-fast-foldy-pending');
            sort.dispatchEvent(new Event('change', { bubbles: true }));
        }
        bindActiveEvents();
        ensureToolbar();
        schedule('activate', hadOriginalFoldyDom ? 80 : 0);
        if (!wasActive) emitModeChange();
        if (announce) notify?.('폴디 연동 로어북 매니저를 켰습니다. Foldy 원본은 수정하지 않고 저장된 폴더 구조만 공유합니다.', 'success');
        return true;
    }

    function deactivate({ returnToNative = false, announce = false } = {}) {
        const wasActive = active;
        const list = getList();
        const hadManagerDom = Boolean(list?.classList.contains('slb-fast-foldy-root'));
        active = false;
        dirty = true;
        if (renderTimer) clearTimeout(renderTimer);
        if (renderRaf) cancelAnimationFrame(renderRaf);
        renderTimer = 0;
        renderRaf = 0;
        unbindActiveEvents();
        listObserver?.disconnect();
        listObserver = null;
        observedList = null;
        if (wasActive || hadManagerDom) flattenManagerFolders();
        if (returnToNative) switchToNativeSort();
        removeToolbar();
        removeSortOption();
        currentLayout = null;
        currentOwner = '';
        nativeResetRequested = false;
        awaitingNativeReset = false;
        if (wasActive) emitModeChange();
        if (announce) notify?.('기존 로어북 매니저로 전환했습니다. 폴디 연동 기능은 실행되지 않습니다.');
        return true;
    }

    function setEnabled(value, options = {}) {
        return value ? activate(options) : deactivate(options);
    }

    function handleGlobalChange(event) {
        if (event.target?.id === SORT_ID) {
            if (active && event.target.value !== FAST_FOLDY_SORT_VALUE) {
                setTimeout(() => {
                    if (!active) return;
                    ensureSortOption();
                    event.target.value = FAST_FOLDY_SORT_VALUE;
                    accountStorage.setItem(SORT_ORDER_KEY, FAST_FOLDY_SORT_VALUE);
                    schedule('sort-guard');
                }, 0);
            }
            return;
        }
        if (event.target?.id === 'world_editor_select' && active) schedule('book-change', 0);
    }

    function init() {
        if (initialized) return;
        initialized = true;
    }

    function destroy() {
        deactivate({ returnToNative: false });
        listObserver?.disconnect();
        listObserver = null;
        observedList = null;
        unbindActiveEvents();
        initialized = false;
    }

    return {
        init,
        destroy,
        activate,
        deactivate,
        setEnabled,
        isActive: () => active,
        isRendering: () => rendering,
        isSuppressingObserver: () => suppressObserver,
        isReady: () => Boolean(
            active
            && !rendering
            && !dirty
            && (
                !getBookName()
                || (
                    currentOwner === ownerForBook(getBookName())
                    && getList()?.classList.contains('slb-fast-foldy-root')
                )
            )
        ),
        isAvailable,
        switchToNativeSort,
        reveal,
        schedule,
        renderNow,
    };
}
