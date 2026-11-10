// Keep the real select and sortable callbacks: ST owns options, saving and touch support.
export function compactNativeSort(document) {
    const search = document.getElementById('world_info_search');
    const sort = document.getElementById('world_info_sort_order');
    if (!search || !sort) return;
    // Keep ST's internal drag-order value for saving, but omit it from the picker.
    for (const option of sort.options) {
        if (option.dataset.rule === 'custom' && !option.hidden) option.hidden = true;
    }
    let group = document.getElementById('slb-search-sort');
    if (!group) {
        group = document.createElement('div');
        group.id = 'slb-search-sort';
        search.before(group);
    }
    if (search.parentElement !== group) group.append(search);
    let control = group.querySelector('.slb-native-sort');
    if (!control) {
        control = document.createElement('div');
        control.className = 'slb-native-sort menu_button fa-solid fa-arrow-down-wide-short';
        group.append(control);
    }
    if (sort.parentElement !== control) control.append(sort);
    sort.setAttribute('aria-label', '항목 정렬');
    const selected = sort.selectedOptions[0];
    const title = selected?.dataset.rule === 'custom'
        ? '항목 정렬'
        : `항목 정렬: ${selected?.textContent?.trim() || ''}`;
    if (sort.title !== title) sort.title = title;
}

export function enableNativeEntryDrag({ document, jQuery, isFoldy, getBook, notify }) {
    if (isFoldy()) return false;
    const list = document.getElementById('world_popup_entries_list');
    if (!list || !jQuery.fn.sortable) return false;
    const sortable = jQuery(list).sortable('instance');
    if (!sortable || typeof sortable.options.stop !== 'function') return false;
    if (sortable.options.stop.slbNativeDrag) return true;
    const nativeStop = sortable.options.stop;
    const stop = async function (event, ui) {
        const book = getBook();
        const sort = document.getElementById('world_info_sort_order');
        const previousSort = sort?.value;
        try {
            // Await ST's displayIndex save before a sort change can reload the book.
            await nativeStop.call(this, event, ui);
            if (isFoldy() || getBook() !== book || sort?.value !== previousSort) return;
            const custom = Array.from(sort?.options || []).find(option => option.dataset.rule === 'custom' && !option.disabled);
            if (custom && sort.value !== custom.value) {
                sort.value = custom.value;
                sort.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (error) {
            console.error('[로어북 매니저] 항목 순서 저장 실패', error);
            notify('항목 순서를 저장하지 못했습니다. 서버 연결을 확인해 주세요.', 'error');
        }
    };
    stop.slbNativeDrag = true;
    jQuery(list).sortable('option', 'stop', stop);
    return true;
}
