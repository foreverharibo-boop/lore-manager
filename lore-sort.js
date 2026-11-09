// Display sorting must never rewrite insertion priority or persisted entry data.
export function planInsertionOrders(entries, start, step, ascending) {
    if (start === '' || step === '' || !Number.isSafeInteger(Number(start))
        || !Number.isSafeInteger(Number(step)) || Number(start) < 0 || Number(step) < 1) {
        throw new Error('시작값은 0 이상의 정수, 간격은 1 이상의 정수로 입력해주세요.');
    }
    return entries.map((entry, index) => {
        const order = Number(start) + (ascending ? 1 : -1) * index * Number(step);
        if (!Number.isSafeInteger(order) || order < 0 || order > 9999) {
            throw new Error('순서 값이 0~9999를 벗어납니다. 시작값이나 간격을 조절해주세요.');
        }
        return { uid: entry.uid, title: entry.comment || `UID ${entry.uid}`, previous: entry.order, order };
    });
}

export function installLoreSortControls({ document, getBook, loadBook, saveBook,
    setOriginal, sortEntries, getSavedSort, setSavedSort, refresh, isFoldy, notify }) {
    const select = document.getElementById('world_info_sort_order');
    const popup = document.getElementById('world_popup');
    if (!select || !popup || document.getElementById('slb-sort-controls')) return;
    const el = (tag, text = '', className = '') => {
        const node = document.createElement(tag);
        node.textContent = text;
        node.className = className;
        return node;
    };
    // Move the original select, retaining ST and Foldy's change listeners and options.
    const toolbar = el('div', '', 'slb-sort-controls');
    toolbar.id = 'slb-sort-controls';
    const label = el('label', '화면 정렬');
    label.htmlFor = select.id;
    select.hidden = false;
    select.classList.remove('displayNone');
    select.setAttribute('aria-label', '화면 정렬');
    toolbar.append(label, select);
    popup.prepend(toolbar);
    const saved = getSavedSort();
    if (saved === 'slb-side-bottom') {
        const custom = Array.from(select.options).find(option => option.dataset.rule === 'custom');
        if (custom) {
            setSavedSort(custom.value);
            if (!isFoldy()) {
                select.value = custom.value;
                select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
            }
        }
    }

    const button = document.getElementById('world_apply_current_sorting');
    if (button) {
        button.title = '주입 순서 일괄 변경 (화면 정렬과 별개)';
        button.setAttribute('aria-label', button.title);
    }
    let opening = false;
    async function openOrderDialog() {
        if (opening || document.getElementById('slb-order-dialog')) return;
        const book = getBook();
        if (!book) { notify('먼저 로어북을 선택해주세요.', 'warning'); return; }
        if (isFoldy() || select.value === 'search') {
            notify('주입 순서를 바꾸려면 검색을 지우고 일반 화면 정렬을 선택해주세요.', 'warning');
            return;
        }
        opening = true;
        try {
            const data = await loadBook(book);
            if (getBook() !== book) return;
            if (!data?.entries) throw new Error('로어북을 불러올 수 없습니다.');
            const snapshot = JSON.stringify(data);
            const sortValue = select.value;
            const sortName = select.selectedOptions[0]?.textContent || '';
            const entries = Object.values(data.entries).filter(entry => entry && typeof entry === 'object');
            if (!entries.length) throw new Error('변경할 항목이 없습니다.');
            // Native custom order uses displayIndex, with UID as the legacy fallback.
            const prepared = entries.map(entry => ({ ...entry, displayIndex: entry.displayIndex ?? entry.uid }));
            const sorted = sortEntries(prepared);
            const dialog = el('dialog', '', 'slb-order-dialog');
            dialog.id = 'slb-order-dialog';
            dialog.setAttribute('aria-labelledby', 'slb-order-title');
            const heading = el('h3', '주입 순서 일괄 변경');
            heading.id = 'slb-order-title';
            const description = el('p', `전체 ${sorted.length}개 항목 · ${sortName}`);
            const detail = el('p', '항목의 ‘순서’ 숫자를 바꿉니다. 화면만 정렬하려면 취소하고 ‘화면 정렬’을 사용하세요.');
            const form = el('form');
            const input = (name, labelText, value, min) => {
                const label = el('label', labelText);
                const field = el('input', '', 'text_pole');
                field.type = 'number'; field.name = name; field.min = String(min); field.max = '9999';
                field.step = '1'; field.value = String(value); field.required = true;
                label.append(field); form.append(label); return field;
            };
            const start = input('start', '시작값', Math.max(100, sorted.length - 1), 0);
            const step = input('step', '간격', 1, 1);
            const direction = el('label', '위에서 아래로 숫자 증가');
            const ascending = el('input'); ascending.type = 'checkbox'; ascending.name = 'ascending';
            direction.prepend(ascending); form.append(direction);
            const preview = el('pre', '', 'slb-order-preview');
            preview.setAttribute('aria-live', 'polite');
            const footer = el('div', '', 'slb-export-modal-footer');
            const cancel = el('button', '취소', 'menu_button'); cancel.type = 'button';
            const apply = el('button', '주입 순서 변경', 'menu_button'); apply.type = 'submit';
            footer.append(cancel, apply); form.append(preview, footer);
            dialog.append(heading, description, detail, form);
            let busy = false;
            let plan = null;
            const update = () => {
                try {
                    plan = planInsertionOrders(sorted, start.value, step.value, ascending.checked);
                    const shown = plan.length > 6 ? [...plan.slice(0, 3), null, ...plan.slice(-3)] : plan;
                    preview.textContent = shown.map(item => item ? `${item.title}: ${item.previous} → ${item.order}` : '…').join('\n');
                    apply.disabled = busy;
                } catch (error) { plan = null; preview.textContent = error.message; apply.disabled = true; }
            };
            const close = () => { if (!busy) { dialog.close(); dialog.remove(); button?.focus(); } };
            cancel.onclick = close;
            dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
            form.addEventListener('input', update);
            form.addEventListener('submit', async event => {
                event.preventDefault();
                if (busy || !plan) return;
                busy = true; apply.disabled = true; cancel.disabled = true;
                start.disabled = step.disabled = ascending.disabled = true;
                try {
                    const fresh = await loadBook(book);
                    if (getBook() !== book || select.value !== sortValue || JSON.stringify(fresh) !== snapshot) {
                        throw new Error('로어북이나 정렬이 바뀌었습니다. 취소한 뒤 다시 열어주세요.');
                    }
                    const updated = structuredClone(fresh);
                    for (const item of plan) {
                        updated.entries[item.uid].order = item.order;
                        setOriginal(updated, item.uid, 'insertion_order', item.order);
                    }
                    await saveBook(book, updated, true);
                    busy = false; close();
                    if (getBook() === book) refresh();
                    notify(`${plan.length}개 항목의 주입 순서를 변경했습니다.`, 'success');
                } catch (error) {
                    preview.textContent = error.message;
                    // Reopen to preview fresh data after a failed save or concurrent edit.
                    plan = null;
                } finally {
                    busy = false; cancel.disabled = false; apply.disabled = !plan;
                    start.disabled = step.disabled = ascending.disabled = false;
                }
            });
            document.body.append(dialog);
            update(); dialog.showModal(); start.focus();
        } catch (error) { notify(error.message || '주입 순서 창을 열 수 없습니다.', 'error'); }
        finally { opening = false; }
    }
    // Native ST replaces the button's jQuery listener after each render. A delegated
    // capture listener remains intact and opens our explicit, previewable dialog once.
    document.getElementById('WorldInfo')?.addEventListener('click', event => {
        if (!event.target.closest?.('#world_apply_current_sorting')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void openOrderDialog();
    }, true);
}
