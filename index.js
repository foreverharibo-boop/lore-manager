const MODULE_NAME = "simple_extension";

const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: 4,
  theme: "minimal-white",
  folders: [],
  assignments: {},
  openFolders: [],
  sort: "name-asc",
});

const LEGACY_DEFAULT_FOLDER_IDS = Object.freeze([
  "favorites",
  "utility",
  "decor",
  "story",
  "experimental",
]);

const THEME_LABELS = Object.freeze({
  "sillytavern-default": "기본 테마 색상",
  "minimal-white": "미니멀 화이트",
  "light-modern": "라이트 모던",
  "dark-modern": "다크 모던",
  "pastel-soft": "파스텔 소프트",
});

const SORT_LABELS = Object.freeze({
  "name-asc": "이름순",
  "name-desc": "이름 역순",
  original: "원래 순서",
});

const state = {
  initialized: false,
  settings: null,
  root: null,
  ui: null,
  nativeColumns: [],
  nativeUnits: new Map(),
  observer: null,
  layoutObserver: null,
  syncTimer: null,
  normalizeTimer: null,
  normalizeInterval: null,
  originalIndex: 0,
  rendering: false,
  normalizing: false,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getContext() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function loadSettings() {
  const context = getContext();
  if (!context?.extensionSettings) {
    state.settings = clone(DEFAULT_SETTINGS);
    return;
  }

  const saved = context.extensionSettings[MODULE_NAME] ?? {};
  const defaults = clone(DEFAULT_SETTINGS);
  const savedFolders = Array.isArray(saved.folders) ? saved.folders : null;
  const hasAssignments = Boolean(
    saved.assignments && Object.keys(saved.assignments).length,
  );
  const hasUntouchedLegacyFolders =
    !saved.settingsVersion &&
    !hasAssignments &&
    savedFolders?.length === LEGACY_DEFAULT_FOLDER_IDS.length &&
    LEGACY_DEFAULT_FOLDER_IDS.every(
      (id, index) => savedFolders[index]?.id === id,
    );

  state.settings = {
    ...defaults,
    ...saved,
    settingsVersion: defaults.settingsVersion,
    folders: hasUntouchedLegacyFolders ? [] : savedFolders || [],
    assignments:
      saved.assignments && typeof saved.assignments === "object"
        ? saved.assignments
        : {},
    openFolders: hasUntouchedLegacyFolders
      ? []
      : Array.isArray(saved.openFolders)
        ? saved.openFolders
        : [],
  };
  context.extensionSettings[MODULE_NAME] = state.settings;
}

function saveSettings() {
  const context = getContext();
  if (!context?.extensionSettings) return;
  context.extensionSettings[MODULE_NAME] = state.settings;
  context.saveSettingsDebounced?.();
}

function normalizeTitle(text) {
  return String(text || "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[⌄⌃▼▲]+$/g, "")
    .trim()
    .slice(0, 120);
}

function slugify(text) {
  return (
    String(text || "extension")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "extension"
  );
}

function findTitleElement(element) {
  const selectors = [
    ":scope > .inline-drawer > .inline-drawer-toggle b",
    ":scope > .inline-drawer > .inline-drawer-toggle strong",
    ":scope > .inline-drawer > .inline-drawer-toggle",
    ":scope > .inline-drawer-toggle b",
    ":scope > .inline-drawer-toggle strong",
    ":scope > .inline-drawer-toggle",
    ".inline-drawer-header b",
    ".inline-drawer-header strong",
    ".extension-title",
    ".extension_name",
    ":scope > h3",
    ":scope > h4",
    ":scope > strong",
    ":scope > b",
    ":scope > * > h3",
    ":scope > * > h4",
    ":scope > * > strong",
    ":scope > * > b",
    '[class*="title" i]',
    '[class*="name" i]',
  ];

  for (const selector of selectors) {
    try {
      const match = element.matches(selector)
        ? element
        : element.querySelector(selector);
      if (match?.closest(".se-fixed-extension-header")) continue;
      const title = normalizeTitle(match?.textContent);
      if (title) return match;
    } catch {
      // Older Android WebViews may not support every :scope selector.
    }
  }

  return null;
}

function extractTitle(element) {
  if (element.dataset.seLegacyTitle) return element.dataset.seLegacyTitle;
  const titleElement = findTitleElement(element);
  const title = normalizeTitle(titleElement?.textContent);
  if (title) return title;

  const labelled =
    element.getAttribute("aria-label") || element.getAttribute("title");
  if (normalizeTitle(labelled)) return normalizeTitle(labelled);

  return (
    normalizeTitle(
      (element.id || "")
        .replace(/_container$|_settings?$|_extension$/gi, "")
        .replace(/[_-]+/g, " "),
    ) || "이름 없는 확장"
  );
}

function isRenderableUnit(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.classList.contains("se-ignore-native")) return false;
  return Boolean(
    element.children.length || normalizeTitle(element.textContent).length,
  );
}

function stableKey(element, title) {
  const explicit =
    element.id || element.dataset.name || element.dataset.extension || "";
  return slugify(explicit || `${title}-${state.originalIndex}`);
}

function registerNativeUnits() {
  let changed = false;

  state.nativeColumns.forEach((column) => {
    [...column.children].forEach((element) => {
      if (!isRenderableUnit(element)) return;
      if (element.dataset.seNativeKey) return;

      const title = extractTitle(element);
      let key = stableKey(element, title);
      let suffix = 2;
      while (state.nativeUnits.has(key))
        key = `${stableKey(element, title)}-${suffix++}`;

      element.dataset.seNativeKey = key;
      element.classList.add("se-native-unit");
      state.nativeUnits.set(key, {
        key,
        title,
        element,
        originalIndex: state.originalIndex++,
      });
      changed = true;
    });
  });

  return changed;
}

function makeThemePicker() {
  const picker = document.createElement("div");
  picker.className = "se-theme-picker";
  picker.hidden = true;

  const heading = document.createElement("div");
  heading.className = "se-theme-title";
  heading.textContent = "테마 선택";
  picker.append(heading);

  const grid = document.createElement("div");
  grid.className = "se-theme-grid";
  Object.entries(THEME_LABELS).forEach(([id, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "se-theme-card";
    button.dataset.theme = id;
    button.classList.toggle("is-selected", state.settings.theme === id);

    const preview = document.createElement("span");
    preview.className = "se-theme-preview";
    preview.innerHTML = "<i></i><b></b><em></em>";
    const text = document.createElement("span");
    text.textContent = label;
    button.append(preview, text);
    button.addEventListener("click", () => {
      state.settings.theme = id;
      saveSettings();
      applyTheme();
      renderThemePicker();
    });
    grid.append(button);
  });
  picker.append(grid);
  return picker;
}

function renderThemePicker() {
  const oldPicker = state.root.querySelector(".se-theme-picker");
  if (!oldPicker) return;
  const wasOpen = !oldPicker.hidden;
  const picker = makeThemePicker();
  picker.hidden = !wasOpen;
  oldPicker.replaceWith(picker);
}

function describeNode(node) {
  const id = node.id ? `#${node.id}` : "";
  const cls = [...node.classList]
    .slice(0, 8)
    .map((name) => `.${name}`)
    .join("");
  return `<${node.tagName.toLowerCase()}${id}${cls}>`;
}

function outlineWithGeometry(node, pillRect, depth = 0, lines = []) {
  if (!(node instanceof HTMLElement) || depth > 12) return lines;
  const rect = node.getBoundingClientRect();
  const computed = getComputedStyle(node);
  const overLeft = pillRect ? Math.round(pillRect.left - rect.left) : 0;
  const overRight = pillRect ? Math.round(rect.right - pillRect.right) : 0;
  const flag =
    rect.width && (overLeft > 1 || overRight > 1) ? "  ⚠️OVERFLOW" : "";
  const geo = rect.width
    ? ` [x:${Math.round(rect.left)} w:${Math.round(rect.width)} pos:${computed.position} ml:${computed.marginLeft} tf:${computed.transform === "none" ? "-" : "yes"}]`
    : " [hidden]";
  lines.push(`${"  ".repeat(depth)}${describeNode(node)}${geo}${flag}`);
  if (node.shadowRoot) {
    lines.push(`${"  ".repeat(depth + 1)}#shadow-root`);
    [...node.shadowRoot.children].forEach((child) =>
      outlineWithGeometry(child, pillRect, depth + 2, lines),
    );
  }
  [...node.children].forEach((child) =>
    outlineWithGeometry(child, pillRect, depth + 1, lines),
  );
  return lines;
}

function buildDebugReport() {
  const lines = [`[simple extension] v0.7.49 debug report`];
  lines.push(`align 보정 적용 횟수: ${state.alignCount || 0}`);
  lines.push(
    `잡힌 에러 (${state.debugErrors?.length || 0}건):${state.debugErrors?.length ? "" : " 없음"}`,
  );
  (state.debugErrors || []).forEach((message) => lines.push(`  - ${message}`));
  lines.push("");
  lines.push("===== 유닛 높이/마진 요약 (이상 있는 것만) =====");
  let extras = 0;
  state.nativeUnits.forEach((unit) => {
    if (!unit.element.isConnected) return;
    const pillRect = unit.fixedHeader?.getBoundingClientRect();
    const rect = unit.element.getBoundingClientRect();
    if (!pillRect?.height) return;
    if (!rect.height) {
      extras += 1;
      lines.push(`  ${unit.title}: ⚠️ 박스 없음 (display:contents 의심)`);
      return;
    }
    const computed = getComputedStyle(unit.element);
    const marginTop = Math.round(parseFloat(computed.marginTop) || 0);
    const marginBottom = Math.round(parseFloat(computed.marginBottom) || 0);
    const extra = Math.round(rect.height - pillRect.height);
    if (extra < 3 && !marginTop && !marginBottom) return;
    extras += 1;
    const open = unit.element.classList.contains("se-native-unit--open");
    lines.push(
      `  ${unit.title}: 높이+${extra}px 마진 ${marginTop}/${marginBottom}px${open ? " (열림-정상)" : ""}`,
    );
  });
  if (!extras) lines.push("  (전부 정상 — 간격 균일)");
  lines.push("");
  lines.push("===== 서브 드로어 점검 (중첩 inline-drawer 보유 유닛) =====");
  let subFound = 0;
  state.nativeUnits.forEach((unit) => {
    if (!unit.element.isConnected) return;
    const drawers = [...unit.element.querySelectorAll(".inline-drawer")].filter(
      (d) => !d.closest(".se-fixed-extension-header, .se-native-movebar"),
    );
    if (drawers.length <= 1) return;
    subFound += 1;
    const subPills = unit.element.querySelectorAll(
      ".se-fixed-subdrawer-header",
    ).length;
    lines.push(
      `  ${unit.title} (${unit.key}): inline-drawer ${drawers.length}개 / 생성된 서브알약 ${subPills}개`,
    );
    const mainPill = unit.fixedHeader;
    const subPill = unit.element.querySelector(".se-fixed-subdrawer-header");
    if (mainPill && subPill) {
      const mainRect = mainPill.getBoundingClientRect();
      const subRect = subPill.getBoundingClientRect();
      const gap = Math.round(subRect.top - mainRect.bottom);
      const sm = getComputedStyle(subPill);
      lines.push(
        `      본알약↔서브알약 실제간격 ${gap}px (서브 margin-top ${sm.marginTop}, margin-bottom ${sm.marginBottom})`,
      );
    }
    drawers.forEach((d) => {
      const label =
        normalizeTitle(
          d.querySelector(".inline-drawer-toggle, .inline-drawer-header")
            ?.textContent,
        ).slice(0, 24) || "(제목없음)";
      const rect = d.getBoundingClientRect();
      const disp = getComputedStyle(d).display;
      lines.push(`      · ${label} [h:${Math.round(rect.height)} d:${disp}]`);
    });
  });
  if (!subFound) lines.push("  (중첩 드로어 보유 유닛 없음)");
  lines.push("");
  lines.push(
    `===== 리스트에서 숨긴 유령 요소 (${state.listStrays?.length || 0}건) =====`,
  );
  (state.listStrays || []).forEach((entry) => lines.push(`  ${entry}`));
  if (!state.listStrays?.length) lines.push("  (없음)");
  lines.push("");
  lines.push("===== 체크박스 점검 =====");
  const topbarCb = document.querySelectorAll(
    '#rm_extensions_block .se-native-topbar input[type="checkbox"]',
  );
  lines.push(`  상단바 체크박스: ${topbarCb.length}개`);
  topbarCb.forEach((cb, i) => {
    const r = cb.getBoundingClientRect();
    const cs = getComputedStyle(cb);
    lines.push(
      `    #${i + 1} checked:${cb.checked} size:${Math.round(r.width)}x${Math.round(r.height)} opacity:${cs.opacity} appearance:${cs.appearance} accent:${cs.accentColor}`,
    );
  });
  let openUnitCb = 0;
  state.nativeUnits.forEach((unit) => {
    if (!unit.element.classList.contains("se-native-unit--open")) return;
    unit.element
      .querySelectorAll('input[type="checkbox"]')
      .forEach((cb) => {
        const r = cb.getBoundingClientRect();
        if (openUnitCb < 6) {
          lines.push(
            `    [열림:${unit.title}] checked:${cb.checked} size:${Math.round(r.width)}x${Math.round(r.height)} opacity:${getComputedStyle(cb).opacity}`,
          );
        }
        openUnitCb += 1;
      });
  });
  if (!openUnitCb) lines.push("  (펼쳐진 유닛의 체크박스 없음)");
  lines.push("");
  lines.push("===== 리스트 그리드 아이템 순서 덤프 =====");
  state.ui
    ?.querySelectorAll(".se-extension-list")
    .forEach((list, listIndex) => {
      lines.push(`  [리스트 ${listIndex + 1}]`);
      [...list.querySelectorAll(".se-native-unit")].forEach((child, index) => {
        if (!(child instanceof HTMLElement)) return;
        const rect = child.getBoundingClientRect();
        const display = getComputedStyle(child).display;
        const title =
          child.dataset.seNativeKey ||
          normalizeTitle(child.textContent).slice(0, 20) ||
          describeNode(child);
        lines.push(
          `    ${index + 1}. ${title} [h:${Math.round(rect.height)} d:${display}]`,
        );
      });
    });
  const uiRect = state.ui?.getBoundingClientRect();

  state.nativeUnits.forEach((unit) => {
    if (!unit.element.isConnected) return;
    const rect = unit.element.getBoundingClientRect();
    // 펼쳐진(높이가 있는) 유닛만 상세 출력해서 리포트를 짧게 유지
    if (rect.height < 70) return;
    const pillRect = unit.fixedHeader?.getBoundingClientRect() || null;
    lines.push("");
    lines.push(`===== ${unit.title} (${unit.key}) =====`);
    lines.push(
      `pill: x:${Math.round(pillRect?.left ?? -1)} w:${Math.round(pillRect?.width ?? -1)} / unit: x:${Math.round(rect.left)} w:${Math.round(rect.width)}`,
    );
    outlineWithGeometry(unit.element, pillRect, 0, lines);
  });

  // SE UI 바깥에서 화면상 확장 목록 영역과 겹치는 보이는 요소 탐색
  if (uiRect) {
    lines.push("");
    lines.push("===== UI 바깥의 의심 요소 (body 전체 스캔) =====");
    let found = 0;
    [...document.body.querySelectorAll("*")].some((node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (state.ui.contains(node) || node.closest(".se-debug-modal"))
        return false;
      // 실리태번 페이지 뼈대(채팅창, 서랍, 상단바)는 정상 UI — 오탐 제거
      if (
        node.closest(
          "#sheld, #form_sheld, #send_form, #top-settings-holder, #top-bar",
        )
      )
        return false;
      const rect = node.getBoundingClientRect();
      if (!rect.width || rect.height < 30) return false;
      const verticalOverlap =
        rect.top < uiRect.bottom && rect.bottom > uiRect.top;
      if (!verticalOverlap) return false;
      if (rect.left >= uiRect.left - 2 && rect.right <= uiRect.right + 2)
        return false;
      if (!node.querySelector("input, select, textarea")) return false;
      const path = [];
      let current = node;
      while (current && current !== document.body && path.length < 6) {
        path.unshift(describeNode(current));
        current = current.parentElement;
      }
      lines.push(
        `${path.join(" > ")} [x:${Math.round(rect.left)} w:${Math.round(rect.width)}]`,
      );
      return ++found >= 15;
    });
    if (!found) lines.push("(없음)");
  }

  return lines.join("\n");
}

function showDebugModal() {
  document.querySelectorAll(".se-debug-modal").forEach((el) => el.remove());
  const modal = document.createElement("div");
  modal.className = "se-debug-modal se-ignore-native";

  const box = document.createElement("div");
  box.className = "se-debug-box";
  const title = document.createElement("div");
  title.className = "se-debug-title";
  title.textContent = "디버그 리포트 — 전체 복사해서 붙여넣어 줘";
  const area = document.createElement("textarea");
  area.readOnly = true;
  area.value = buildDebugReport();

  const buttons = document.createElement("div");
  buttons.className = "se-debug-buttons";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "📋 복사";
  copy.addEventListener("click", async () => {
    let done = false;
    try {
      await navigator.clipboard.writeText(area.value);
      done = true;
    } catch {
      area.focus();
      area.select();
      done = document.execCommand("copy");
    }
    copy.textContent = done ? "✅ 복사됨" : "❌ 직접 선택해서 복사해줘";
  });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "닫기";
  close.addEventListener("click", () => modal.remove());
  buttons.append(copy, close);

  box.append(title, area, buttons);
  modal.append(box);
  document.body.append(modal);
}

function createToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "se-toolbar";
  const search = document.createElement("label");
  search.className = "se-search";
  search.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "확장 검색...";
  input.autocomplete = "off";
  input.addEventListener("input", () => applySearch(input.value));
  search.append(input);
  const debug = document.createElement("button");
  debug.type = "button";
  debug.className = "se-text-button se-debug-open";
  debug.title = "디버그 리포트";
  debug.setAttribute("aria-label", "디버그 리포트");
  debug.textContent = "⚠️";
  debug.addEventListener("click", showDebugModal);
  toolbar.append(search, debug);
  return toolbar;
}

function createSectionTitle(text, actionText, action) {
  const line = document.createElement("div");
  line.className = "se-section-title";
  const title = document.createElement("h4");
  title.textContent = text;
  line.append(title);

  if (actionText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "se-text-button";
    button.textContent = actionText;
    button.addEventListener("click", action);
    line.append(button);
  }
  return line;
}

function createSortControl() {
  const label = document.createElement("label");
  label.className = "se-sort";
  const text = document.createElement("span");
  text.textContent = "정렬";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "확장 정렬 기준");
  Object.entries(SORT_LABELS).forEach(([value, name]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = name;
    select.append(option);
  });
  select.value =
    state.settings.sort && state.settings.sort in SORT_LABELS
      ? state.settings.sort
      : "name-asc";
  select.addEventListener("change", () => {
    state.settings.sort = select.value;
    saveSettings();
    render();
  });
  label.append(text, select);
  return label;
}

function sortUnits(units) {
  const list = [...units];
  const byName = (a, b) => a.title.localeCompare(b.title, "ko");
  switch (state.settings.sort) {
    case "name-desc":
      return list.sort((a, b) => byName(b, a));
    case "original":
      return list.sort((a, b) => a.originalIndex - b.originalIndex);
    default:
      return list.sort(byName);
  }
}

function addFolder() {
  const name = normalizeTitle(
    window.prompt("새 폴더 이름을 입력해 주세요.", "새 폴더"),
  );
  if (!name) return;
  const id = `folder-${Date.now().toString(36)}`;
  state.settings.folders.push({ id, name, icon: "📁" });
  state.settings.openFolders.push(id);
  saveSettings();
  render();
}

function makeFolderMenu(folder, anchor) {
  document.querySelectorAll(".se-folder-menu").forEach((menu) => menu.remove());
  const menu = document.createElement("div");
  menu.className = "se-folder-menu";

  const rename = document.createElement("button");
  rename.type = "button";
  rename.textContent = "이름 변경";
  rename.addEventListener("click", () => {
    const name = normalizeTitle(
      window.prompt("새 폴더 이름을 입력해 주세요.", folder.name),
    );
    if (!name) return;
    folder.name = name;
    saveSettings();
    render();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "se-danger";
  remove.textContent = "폴더 삭제";
  remove.addEventListener("click", () => {
    if (!window.confirm(`“${folder.name}” 폴더를 삭제할까요?`)) return;
    state.settings.folders = state.settings.folders.filter(
      (item) => item.id !== folder.id,
    );
    Object.keys(state.settings.assignments).forEach((key) => {
      if (state.settings.assignments[key] === folder.id)
        delete state.settings.assignments[key];
    });
    state.settings.openFolders = state.settings.openFolders.filter(
      (id) => id !== folder.id,
    );
    saveSettings();
    render();
  });

  menu.append(rename, remove);
  anchor.closest(".se-folder")?.append(menu);
}

function makeMoreButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "se-more";
  button.textContent = "⋮";
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function findPrimaryToggle(element) {
  const selectors = [
    ":scope > .inline-drawer > .inline-drawer-toggle",
    ":scope > .inline-drawer-toggle",
    ".inline-drawer-toggle",
    ".inline-drawer-header",
  ];
  for (const selector of selectors) {
    try {
      const match = element.querySelector(selector);
      if (match) return match;
    } catch {
      // Ignore unsupported :scope selectors on older Android WebViews.
    }
  }

  // Fallback: some extensions (e.g. custom translators) build their own
  // header row without ST's inline-drawer classes. Use the chevron icon if
  // present (clicks bubble up to the row's own handler), else the title.
  const title = findTitleElement(element);
  if (
    title &&
    !title.closest(
      ".inline-drawer-content, .se-native-primary-content, .se-native-fixed-content, .se-fixed-extension-header",
    )
  ) {
    const icon = [
      ...element.querySelectorAll(
        '.inline-drawer-icon, [class*="chevron" i]',
      ),
    ].find(
      (node) =>
        !node.closest(
          ".inline-drawer-content, .se-fixed-extension-header, .se-native-movebar",
        ),
    );
    return icon || title;
  }
  return null;
}

function directChild(element, selector) {
  return [...(element?.children || [])].find((child) =>
    child.matches(selector),
  );
}

function drawerTitle(toggle, fallback = "설정") {
  const named = toggle?.querySelector("b, strong, .extension-title");
  return normalizeTitle(named?.textContent || toggle?.textContent) || fallback;
}

function findCommonAncestor(left, right, root) {
  if (!left || !right) return null;
  const leftAncestors = new Set();
  let current = left;
  while (current) {
    leftAncestors.add(current);
    if (current === root) break;
    current = current.parentElement;
  }

  current = right;
  while (current) {
    if (leftAncestors.has(current)) return current;
    if (current === root) break;
    current = current.parentElement;
  }
  return null;
}

function findPillHeader(unit, toggle) {
  const titleElement = unit.titleElement?.isConnected
    ? unit.titleElement
    : findTitleElement(unit.element);
  unit.titleElement = titleElement;
  const common = findCommonAncestor(titleElement, toggle, unit.element);
  const content = findPrimaryContent(unit);
  if (
    common &&
    common !== unit.element &&
    (content
      ? !common.contains(content)
      : // No ST drawer content found — only treat the wrapper as a header if
        // it clearly holds no settings, so we never hide a custom panel.
        !common.querySelector("input, select, textarea, .inline-drawer-content"))
  ) {
    return common;
  }
  return toggle;
}

function findPrimaryContent(unit) {
  if (unit.primaryContent?.isConnected) return unit.primaryContent;
  const header = unit.primaryToggle?.isConnected
    ? unit.primaryToggle
    : findPrimaryToggle(unit.element);
  const drawer = header?.closest(".inline-drawer");
  let content = null;
  try {
    content = drawer?.querySelector(":scope > .inline-drawer-content");
  } catch {
    // Fall through to the broad native selector.
  }
  unit.primaryContent =
    content || unit.element.querySelector(".inline-drawer-content");
  return unit.primaryContent;
}

function updateDrawerOpenState(toggle, content, fixed) {
  if (!content || !fixed) return;
  const isOpen = getComputedStyle(content).display !== "none";
  fixed.classList.toggle("is-open", isOpen);
  fixed.setAttribute("aria-expanded", String(isOpen));
  toggle?.setAttribute("aria-expanded", String(isOpen));
  // 서브 드로어가 접혀 있으면 그 콘텐츠가 여전히 박스(마진/패딩/보더)를
  // 차지해 서브알약 밑에 여분 공간이 생긴다. 접혔을 때는 콘텐츠 박스를
  // 완전히 접도록 클래스로 표시한다 (펼치면 원래대로).
  content.classList.toggle("se-subdrawer-collapsed", !isOpen);
}

function enforceContentBox(unit) {
  // 일부 확장(#tua-settings, #mma-settings-block 등)이 ID 셀렉터 CSS로
  // 패널 패딩/폭을 덮어써서 여백이 사라진다. 인라인 !important는
  // 명시도 싸움이 없으므로 어떤 CSS보다 우선한다. display는 건드리지
  // 않아 접힘/펼침 동작은 그대로 유지된다.
  const content = findPrimaryContent(unit);
  if (!content) return;
  const style = content.style;
  // display:none 대신 max-height:0 등으로 접는 확장은 접힌 상태에서도
  // 마진이 렌더링돼 알약 간격이 벌어진다. 접혀 있으면 마진을 0으로.
  const collapsed =
    getComputedStyle(content).display === "none" ||
    content.getBoundingClientRect().height < 3;
  style.setProperty("width", "calc(100% - 16px)", "important");
  style.setProperty("max-width", "calc(100% - 16px)", "important");
  style.setProperty("margin", collapsed ? "0 8px" : "4px 8px 7px", "important");
  style.setProperty("padding", collapsed ? "0" : "9px", "important");
  style.setProperty("box-sizing", "border-box", "important");
  // 방어적 초기화: 이전에 어떤 경로로든 height/overflow 잠금이 걸렸다면
  // 실제 콘텐츠와 그 조상 셸에서는 항상 풀어둔다 — 이 요소는 열림/닫힘을
  // display로 스스로 제어하므로 height를 강제로 잠글 대상이 아니다.
  let shell = content;
  let hops = 0;
  while (shell instanceof HTMLElement && hops < 8) {
    shell.style.removeProperty("height");
    shell.style.removeProperty("max-height");
    shell.style.removeProperty("overflow");
    if (shell === unit.element) break;
    shell = shell.parentElement;
    hops += 1;
  }
}

function updateNativeOpenState(unit) {
  const content = findPrimaryContent(unit);
  let isOpen;
  if (content) {
    // display:none이 끝내 안 걸리는 경우(jQuery 슬라이드 애니메이션과 강제
    // 인라인 스타일 충돌 등)를 대비해, display 값뿐 아니라 실제 렌더링
    // 높이도 함께 확인한다. 둘 다 "열림"을 가리켜야 열린 것으로 본다.
    const displayOpen = getComputedStyle(content).display !== "none";
    const hasHeight = content.getBoundingClientRect().height > 2;
    isOpen = displayOpen && hasHeight;
  } else {
    // 드로어 없는(자체 관리) 유닛도 마찬가지: 실수로 플래그가 true가
    // 되어도 실제로 펼칠 내용(.se-panel-inset)이 없거나 높이가 0이면
    // "열림" 취급하지 않는다 — 빈 전체폭 알약이 뜨는 걸 막는다.
    const flagged = unit.element.dataset.seSelfOpen === "true";
    const inset = unit.element.querySelector(".se-panel-inset");
    const insetHasHeight = inset && inset.getBoundingClientRect().height > 2;
    isOpen = flagged && insetHasHeight;
    if (flagged && !insetHasHeight) {
      // 펼칠 내용이 없는데 플래그만 true인 상태 — 다음 클릭에서 정상
      // 토글되도록 플래그를 되돌려둔다 (좀비 open 상태 방지).
      unit.element.dataset.seSelfOpen = "false";
    }
  }
  unit.element.classList.toggle("se-native-unit--open", isOpen);
  unit.fixedHeader?.classList.toggle("is-open", isOpen);
  unit.fixedHeader?.setAttribute("aria-expanded", String(isOpen));
}


function markNativeContentShell(unit) {
  const content = findPrimaryContent(unit);
  if (!content) return;
  content.classList.add("se-native-primary-content");
  let shell = content.parentElement;
  while (shell && shell !== unit.element) {
    shell.classList.add("se-native-content-shell");
    shell = shell.parentElement;
  }
}

function markCustomPanels(unit) {
  // Extensions without any .inline-drawer-content render their settings as a
  // sibling of their own header. Constrain those panels so their full-bleed
  // CSS (negative margins, absolute positioning, 100%+padding widths) cannot
  // push them outside the unit.
  if (findPrimaryContent(unit)) return;
  const headerEl =
    (unit.pillHeader?.isConnected && unit.pillHeader) ||
    (unit.primaryToggle?.isConnected && unit.primaryToggle) ||
    null;
  const scope =
    headerEl?.parentElement && unit.element.contains(headerEl.parentElement)
      ? headerEl.parentElement
      : unit.element;

  let shell = scope;
  while (shell && shell !== unit.element) {
    shell.classList.add("se-native-content-shell");
    shell = shell.parentElement;
  }

  [...scope.children].forEach((child) => {
    if (child === headerEl) return;
    if (
      child.classList.contains("se-fixed-extension-header") ||
      child.classList.contains("se-native-movebar") ||
      child.classList.contains("se-panel-inset") ||
      child.classList.contains("se-native-original-header") ||
      child.dataset.seForceHidden
    )
      return;
    child.classList.add("se-native-custom-panel");
    // 심플 확장 소유의 래퍼로 감싼다. 여백은 래퍼 패딩에서 나오므로
    // 원본 확장의 CSS/JS가 어떤 스타일을 쓰든 빼앗을 수 없다.
    if (!child.parentElement?.classList.contains("se-panel-inset")) {
      [
        "position",
        "top",
        "left",
        "right",
        "bottom",
        "transform",
        "float",
        "margin-left",
        "margin-right",
        "width",
        "max-width",
      ].forEach((prop) => child.style.removeProperty(prop));
      const inset = document.createElement("div");
      inset.className = "se-panel-inset se-ignore-native";
      child.before(inset);
      inset.append(child);
    }
  });
}

function markFixedContent(unit, content) {
  if (!content) return;
  content.classList.add("se-native-fixed-content");
  let shell = content.parentElement;
  while (shell && shell !== unit.element) {
    shell.classList.add("se-native-content-shell");
    shell = shell.parentElement;
  }
}

function setFixedHeaderContents(fixed, title) {
  let name = fixed.querySelector(":scope > .se-fixed-extension-name");
  if (!name) {
    name = document.createElement("span");
    name.className = "se-fixed-extension-name";
    fixed.append(name);
  }
  if (name.textContent !== title) name.textContent = title;

  let more = fixed.querySelector(":scope > .se-fixed-extension-more");
  if (!more) {
    more = document.createElement("span");
    more.className = "se-fixed-extension-more";
    more.textContent = "⋮";
    more.setAttribute("aria-hidden", "true");
    fixed.append(more);
  }
}

function ensureFixedHeader(unit, originalToggle, originalHeader) {
  let fixed = unit.element.querySelector(":scope > .se-fixed-extension-header");
  if (!fixed) {
    fixed = document.createElement("button");
    fixed.type = "button";
    fixed.className = "se-fixed-extension-header se-ignore-native";
    unit.element.prepend(fixed);
    fixed.addEventListener("click", () => {
      // 드로어가 아예 없는 확장(설정이 생 input들)은 접힘 개념이 없어
      // 내용물이 리스트에 그대로 눕는다. 그런 유닛은 SE가 직접
      // 접기/펼치기 상태를 관리한다 (패널 래퍼 표시 여부로 제어).
      if (!findPrimaryContent(unit)) {
        const open = unit.element.dataset.seSelfOpen === "true";
        unit.element.dataset.seSelfOpen = open ? "false" : "true";
      }
      // 여백은 normalize 주기를 기다리지 않고 클릭 즉시 건다. ST의
      // 슬라이드 애니메이션이 진행되는 동안에도 첫 프레임부터 여백이
      // 있어야, "펼쳐지며 퍼졌다가 나중에 여백 생김" 깜빡임이 없다.
      enforceContentBox(unit);
      markCustomPanels(unit);
      unit.primaryToggle?.click();
      enforceContentBox(unit);
      requestAnimationFrame(() => {
        enforceContentBox(unit);
        updateNativeOpenState(unit);
      });
      window.setTimeout(() => {
        enforceContentBox(unit);
        updateNativeOpenState(unit);
      }, 250);
      [60, 120, 180].forEach((delay) => {
        window.setTimeout(() => enforceContentBox(unit), delay);
      });
    });
  }

  setFixedHeaderContents(fixed, unit.title);
  fixed.setAttribute("aria-label", `${unit.title} 설정 열기`);
  unit.fixedHeader = fixed;

  originalHeader?.classList.add("se-native-original-header");
  originalToggle?.classList.add("se-native-original-toggle");
  if (
    unit.titleElement &&
    originalHeader &&
    !originalHeader.contains(unit.titleElement)
  ) {
    unit.titleElement.classList.add("se-native-original-title");
  }
}

function ensureSubdrawerHeader(unit, drawer, toggle, content, index) {
  if (!drawer.dataset.seDrawerId) {
    drawer.dataset.seDrawerId = `${unit.key}-drawer-${index}`;
  }
  const drawerId = drawer.dataset.seDrawerId;
  let fixed = [
    ...unit.element.querySelectorAll(".se-fixed-subdrawer-header"),
  ].find((candidate) => candidate.dataset.seDrawerFor === drawerId);
  if (!fixed) {
    fixed = document.createElement("button");
    fixed.type = "button";
    fixed.className =
      "se-fixed-extension-header se-fixed-subdrawer-header se-ignore-native";
    fixed.dataset.seDrawerFor = drawerId;
    drawer.before(fixed);
    fixed.addEventListener("click", () => {
      toggle.click();
      requestAnimationFrame(() =>
        updateDrawerOpenState(toggle, content, fixed),
      );
      window.setTimeout(
        () => updateDrawerOpenState(toggle, content, fixed),
        250,
      );
    });
  }

  const title = drawerTitle(toggle);
  setFixedHeaderContents(fixed, title);
  fixed.setAttribute("aria-label", `${title} 설정 열기`);
  toggle.classList.add("se-native-original-toggle");
  drawer.classList.add("se-native-fixed-drawer");
  markFixedContent(unit, content);
  updateDrawerOpenState(toggle, content, fixed);
  return fixed;
}

function collectNativeDrawers(unit) {
  return [...unit.element.querySelectorAll(".inline-drawer")]
    .filter(
      (drawer) =>
        !drawer.closest(".se-fixed-extension-header, .se-native-movebar"),
    )
    .map((drawer) => ({
      drawer,
      toggle: directChild(
        drawer,
        ".inline-drawer-toggle, .inline-drawer-header",
      ),
      content: directChild(drawer, ".inline-drawer-content"),
    }))
    .filter(({ toggle, content }) => toggle && content);
}

function normalizeNativeDrawers(unit) {
  const pairs = collectNativeDrawers(unit);
  const primaryContent = findPrimaryContent(unit);
  const primaryPair = pairs.find(
    ({ toggle, content }) =>
      toggle === unit.primaryToggle || content === primaryContent,
  );

  pairs.forEach(({ drawer, toggle, content }, index) => {
    markFixedContent(unit, content);
    if (primaryPair && drawer === primaryPair.drawer) {
      toggle.classList.add("se-native-original-toggle");
      return;
    }
    ensureSubdrawerHeader(unit, drawer, toggle, content, index);
  });

  // Some extensions build a title row and arrow separately, or insert it later.
  // Every original toggle is hidden after its native click target has been mapped.
  unit.element
    .querySelectorAll(".inline-drawer-toggle, .inline-drawer-header")
    .forEach((toggle) => {
      if (toggle.closest(".se-fixed-extension-header, .se-native-movebar"))
        return;
      toggle.classList.add("se-native-original-toggle");
      const splitHeader = toggle.parentElement;
      if (
        splitHeader &&
        splitHeader !== unit.element &&
        !splitHeader.querySelector(".inline-drawer-content")
      ) {
        splitHeader.classList.add("se-native-original-header");
      }
      const icon = toggle.querySelector(
        ".inline-drawer-icon, .fa-circle-chevron-down, .fa-circle-chevron-up",
      );
      icon?.classList.add("se-native-original-toggle");
    });
}

// 제목이 여기 포함되면 확장이 직접 그린 중복 헤더 줄을 강제로 숨긴다.
const FORCE_HIDE_HEADER_TITLES = ["translator"];

function forceHideCustomHeader(unit) {
  const unitTitle = normalizeTitle(unit.title).toLocaleLowerCase();
  if (!FORCE_HIDE_HEADER_TITLES.some((name) => unitTitle.includes(name)))
    return;

  const candidates = [...unit.element.querySelectorAll("*")].filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.dataset.seForceHidden) return false;
    if (node.closest(".se-fixed-extension-header, .se-native-movebar"))
      return false;
    // 설정 패널(입력 요소 포함)은 절대 건드리지 않는다.
    if (node.querySelector("input, select, textarea")) return false;
    const text = normalizeTitle(node.textContent).toLocaleLowerCase();
    if (!text || text.length > unitTitle.length + 8) return false;
    return text.includes(unitTitle) || unitTitle.includes(text);
  });
  // 후보 중 가장 바깥 요소 = 헤더 줄 전체
  const header = candidates.find(
    (node) =>
      node !== unit.element &&
      !candidates.some((other) => other !== node && other.contains(node)),
  );
  if (!header) return;

  const icon =
    header.querySelector('.inline-drawer-icon, [class*="chevron" i]') || header;
  unit.primaryToggle = icon;
  header.dataset.seForceHidden = "true";
  header.style.setProperty("display", "none", "important");
}

function clampOverflowingDescendants(unit) {
  const host = unit.element;
  if (!host.isConnected) return;
  const bounds = host.getBoundingClientRect();
  // 접혀서 알약만 보일 때는 검사할 필요 없음
  if (!bounds.width || bounds.height < 60) return;
  const slack = 2;

  host.querySelectorAll("*").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.seClamped) return;
    if (node.closest(".se-fixed-extension-header, .se-native-movebar")) return;
    const rect = node.getBoundingClientRect();
    if (!rect.width) return;
    if (rect.left >= bounds.left - slack && rect.right <= bounds.right + slack)
      return;

    // 유닛 밖으로 삐져나간 요소를 인라인 !important로 강제 고정.
    // 인라인 스타일이라 해당 확장의 어떤 CSS보다 우선한다.
    node.dataset.seClamped = "true";
    const style = node.style;
    style.setProperty("position", "relative", "important");
    style.setProperty("top", "auto", "important");
    style.setProperty("left", "auto", "important");
    style.setProperty("right", "auto", "important");
    style.setProperty("bottom", "auto", "important");
    style.setProperty("transform", "none", "important");
    style.setProperty("float", "none", "important");
    style.setProperty("margin-left", "0", "important");
    style.setProperty("margin-right", "0", "important");
    style.setProperty("max-width", "100%", "important");
    style.setProperty("box-sizing", "border-box", "important");
  });
}

function alignOutermostOffenders(node, pillRect, depth = 0) {
  if (!(node instanceof HTMLElement) || depth > 12) return;
  if (
    node.classList.contains("se-fixed-extension-header") ||
    node.classList.contains("se-native-movebar")
  )
    return;
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const overLeft = pillRect.left - rect.left; // >0: 알약보다 왼쪽으로 삐져나감
  const overRight = rect.right - pillRect.right; // >0: 오른쪽으로 삐져나감
  if (overLeft > 1 || overRight > 1) {
    state.alignCount = (state.alignCount || 0) + 1;
    const currentMargin =
      parseFloat(getComputedStyle(node).marginLeft) || 0;
    const style = node.style;
    style.setProperty("position", "relative", "important");
    style.setProperty("top", "auto", "important");
    style.setProperty("left", "auto", "important");
    style.setProperty("right", "auto", "important");
    style.setProperty("bottom", "auto", "important");
    style.setProperty("transform", "none", "important");
    style.setProperty("float", "none", "important");
    style.setProperty("box-sizing", "border-box", "important");
    if (overLeft > 1) {
      style.setProperty(
        "margin-left",
        `${currentMargin + overLeft}px`,
        "important",
      );
    }
    if (rect.width > pillRect.width + 1) {
      style.setProperty("width", `${pillRect.width}px`, "important");
      style.setProperty("max-width", "100%", "important");
    } else if (overRight > 1 && overLeft <= 1) {
      style.setProperty(
        "margin-left",
        `${currentMargin - overRight}px`,
        "important",
      );
    }
    // 가장 바깥 요소만 맞추면 내부는 따라온다. 다음 주기에 재측정해 수렴.
    return;
  }

  const kids = [...(node.shadowRoot?.children || []), ...node.children];
  kids.forEach((child) =>
    alignOutermostOffenders(child, pillRect, depth + 1),
  );
}

function containStrayPanels() {
  // 유닛 바깥(확장 블록 어딘가)에 패널을 직접 붙이는 확장 대응:
  // SE UI에 속하지 않으면서 알약 폭을 벗어난 보이는 요소를 강제로 맞춘다.
  if (!state.ui || !state.root) return;
  const sample = [...state.nativeUnits.values()].find(
    (unit) =>
      unit.fixedHeader?.isConnected &&
      unit.fixedHeader.getBoundingClientRect().width,
  );
  if (!sample) return;
  const pillRect = sample.fixedHeader.getBoundingClientRect();

  [...state.root.querySelectorAll("*")].forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node === state.ui || state.ui.contains(node)) return;
    if (node.closest(".se-native-topbar")) return;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const overLeft = pillRect.left - rect.left;
    const overRight = rect.right - pillRect.right;
    if (overLeft > 1 || overRight > 1 || rect.width > pillRect.width + 2) {
      alignOutermostOffenders(node, pillRect, 12); // 이 노드 자체만 보정
    }
  });
}

function forceAlignToPill(unit) {
  const pill = unit.fixedHeader;
  if (!pill?.isConnected) return;
  const pillRect = pill.getBoundingClientRect();
  if (!pillRect.width) return;
  [...unit.element.children].forEach((child) => {
    if (child === pill) return;
    alignOutermostOffenders(child, pillRect, 0);
  });
}

function recordDebugError(scope, error) {
  state.debugErrors = state.debugErrors || [];
  const message = `${scope}: ${error?.message || error}`;
  if (state.debugErrors.at(-1) !== message) state.debugErrors.push(message);
  if (state.debugErrors.length > 20) state.debugErrors.shift();
}

function flattenClosedElement(node, depth = 0) {
  if (!(node instanceof HTMLElement) || depth > 8) return;
  const style = node.style;
  style.setProperty("margin-top", "0", "important");
  style.setProperty("margin-bottom", "0", "important");
  style.setProperty("padding-top", "0", "important");
  style.setProperty("padding-bottom", "0", "important");
  style.setProperty("border-top-width", "0", "important");
  style.setProperty("border-bottom-width", "0", "important");
  style.setProperty("min-height", "0", "important");
  // 마진/패딩만으로는 못 잡는 경우: 확장이 명시적 height(px)로 항상
  // 보이는 요소를 만들면 접힌 상태에서도 그 높이만큼 삐져나온다. 단,
  // 실제 펼침 대상 콘텐츠(.se-native-primary-content/.se-panel-inset)를
  // 담고 있거나 그 자체인 노드는 절대 여기서 height:0으로 잠그지 않는다
  // — 인라인 !important는 나중에 펼쳐도 안 풀려서 영구 먹통이 된다.
  // 진짜 콘텐츠와 무관한(그 안에 없는) 노드만 완전히 접는다.
  const holdsRealContent =
    node.classList.contains("se-native-primary-content") ||
    node.classList.contains("se-panel-inset") ||
    node.querySelector(".se-native-primary-content, .se-panel-inset") ||
    // 중첩 서브 드로어(.inline-drawer)와 그 SE 서브알약 헤더는 정상적인
    // 펼침 대상이다. height:0으로 눌러버리면 서브알약이 화면에서 사라져
    // (예: "이미지 생성 ?" 안의 "이미지 프롬프트 템플릿") 클릭해도 아무것도
    // 안 뜬다. 이런 노드는 flatten에서 제외한다.
    node.classList.contains("inline-drawer") ||
    node.classList.contains("se-fixed-subdrawer-header") ||
    node.querySelector(".inline-drawer, .se-fixed-subdrawer-header");
  if (!holdsRealContent) {
    style.setProperty("height", "0", "important");
    style.setProperty("max-height", "0", "important");
    style.setProperty("overflow", "hidden", "important");
  }
  [...node.children].forEach((child) => {
    if (!(child instanceof HTMLElement)) return;
    // 패널 본체의 세로 박스는 enforceContentBox가 열림/접힘에 따라 관리
    if (child.classList.contains("se-native-primary-content")) return;
    // 서브 드로어와 그 서브알약 헤더는 정상 펼침 대상 — 건드리지 않는다.
    if (
      child.classList.contains("inline-drawer") ||
      child.classList.contains("se-fixed-subdrawer-header") ||
      child.querySelector(".inline-drawer, .se-fixed-subdrawer-header")
    )
      return;
    const rect = child.getBoundingClientRect();
    const computed = getComputedStyle(child);
    if (
      rect.height > 1 ||
      parseFloat(computed.marginTop) > 0 ||
      parseFloat(computed.marginBottom) > 0
    ) {
      flattenClosedElement(child, depth + 1);
    }
  });
}

function equalizeClosedUnits(unit) {
  const pill = unit.fixedHeader;
  if (!pill?.isConnected) return;
  const pillRect = pill.getBoundingClientRect();
  const unitRect = unit.element.getBoundingClientRect();
  if (!pillRect.height || !unitRect.height) return;
  if (unitRect.height - pillRect.height <= 2) return;

  // 패널이 열려 있으면 유닛이 큰 게 정상
  const content = findPrimaryContent(unit);
  const contentOpen =
    content &&
    getComputedStyle(content).display !== "none" &&
    content.getBoundingClientRect().height > 2;
  const customOpen = [
    ...unit.element.querySelectorAll(".se-native-custom-panel"),
  ].some(
    (panel) =>
      getComputedStyle(panel).display !== "none" &&
      panel.getBoundingClientRect().height > 2,
  );
  if (contentOpen || customOpen) return;

  // 접혀 있는데 알약보다 크다 → 여분 높이를 만드는 요소를 납작하게.
  // 원인(마진/패딩/보더/min-height)이 뭐든 측정으로 잡는다.
  [...unit.element.children].forEach((child) => {
    if (child === pill) return;
    if (!(child instanceof HTMLElement)) return;
    const rect = child.getBoundingClientRect();
    const computed = getComputedStyle(child);
    if (
      rect.height > 1 ||
      parseFloat(computed.marginTop) > 0 ||
      parseFloat(computed.marginBottom) > 0
    ) {
      flattenClosedElement(child);
    }
  });
}

function sweepListStrays() {
  // ST 기본 확장들은 자기 설정 블록 옆에 요소를 동적으로 끼워넣는데
  // ($.after 등), 블록이 SE 리스트로 옮겨진 뒤에는 그 요소가 알약
  // 사이에 그리드 한 줄을 차지해 간격을 벌린다. 유닛이 아닌 리스트
  // 자식은 전부 숨긴다 (display:none은 그리드 줄을 만들지 않는다).
  state.ui
    ?.querySelectorAll(".se-extension-list, .se-ext-col, .se-folder-content")
    .forEach((container) => {
      [...container.children].forEach((child) => {
        if (!(child instanceof HTMLElement)) return;
        if (
          child.classList.contains("se-native-unit") ||
          child.classList.contains("se-ext-col") ||
          child.classList.contains("se-empty") ||
          child.dataset.seListStray
        )
          return;
        child.dataset.seListStray = "true";
        state.listStrays = state.listStrays || [];
        state.listStrays.push(describeNode(child));
        if (state.listStrays.length > 30) state.listStrays.shift();
        child.style.setProperty("display", "none", "important");
      });
    });
}

function normalizeAllNativeUnits() {
  if (state.normalizing || state.rendering) return;
  state.normalizing = true;
  try {
    state.nativeUnits.forEach((unit) => {
      if (!state.ui?.contains(unit.element)) return;
      // 유닛 하나에서 에러가 나도 나머지 유닛 처리는 계속되도록 단계별 격리
      try {
        const header = findPrimaryToggle(unit.element);
        unit.primaryToggle = header;
        unit.primaryContent = null;
        header?.classList.add("se-native-primary-toggle");
        const pillHeader = header ? findPillHeader(unit, header) : null;
        ensureFixedHeader(unit, header, pillHeader);
        // 유닛 바깥 마진은 rect 높이에 안 잡혀 측정을 전부 통과하는데,
        // ST 코어가 기본 확장 컨테이너를 ID 셀렉터(+!important)로
        // 스타일링해 클래스 기반 margin:0을 이긴다. 인라인으로 제압.
        unit.element.style.setProperty("margin", "0", "important");
        markNativeContentShell(unit);
        markCustomPanels(unit);
        normalizeNativeDrawers(unit);
      } catch (error) {
        recordDebugError(`normalize(${unit.title})`, error);
      }
      try {
        enforceContentBox(unit);
      } catch (error) {
        recordDebugError(`contentBox(${unit.title})`, error);
      }
      try {
        forceHideCustomHeader(unit);
      } catch (error) {
        recordDebugError(`hideHeader(${unit.title})`, error);
      }
      try {
        clampOverflowingDescendants(unit);
      } catch (error) {
        recordDebugError(`clamp(${unit.title})`, error);
      }
      try {
        forceAlignToPill(unit);
      } catch (error) {
        recordDebugError(`align(${unit.title})`, error);
      }
      try {
        equalizeClosedUnits(unit);
      } catch (error) {
        recordDebugError(`equalize(${unit.title})`, error);
      }
      try {
        updateNativeOpenState(unit);
      } catch (error) {
        recordDebugError(`openState(${unit.title})`, error);
      }
    });
    try {
      sweepListStrays();
    } catch (error) {
      recordDebugError("listStrays", error);
    }
    try {
      containStrayPanels();
    } catch (error) {
      recordDebugError("strayPanels", error);
    }
  } finally {
    state.normalizing = false;
  }
}

function normalizeSoon() {
  window.clearTimeout(state.normalizeTimer);
  state.normalizeTimer = window.setTimeout(normalizeAllNativeUnits, 40);
}

function ensureNativeMoveBar(unit) {
  const content = findPrimaryContent(unit);
  if (!content) return;

  let bar = content.querySelector(":scope > .se-native-movebar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "se-native-movebar se-ignore-native";
    content.prepend(bar);
  }
  bar.hidden = state.settings.folders.length === 0;
  bar.replaceChildren();
  if (bar.hidden) return;

  const label = document.createElement("label");
  label.textContent = "폴더 이동";
  const select = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "미분류";
  select.append(none);
  state.settings.folders.forEach((folder) => {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = `${folder.icon || "📁"} ${folder.name}`;
    select.append(option);
  });
  select.value = state.settings.assignments[unit.key] || "";
  select.addEventListener("change", () => {
    if (select.value) state.settings.assignments[unit.key] = select.value;
    else delete state.settings.assignments[unit.key];
    saveSettings();
    render();
  });
  label.append(select);
  bar.append(label);
}

function prepareNativeUnit(unit) {
  const element = unit.element;
  element.dataset.key = unit.key;
  element.dataset.search = unit.title.toLocaleLowerCase();
  element.classList.add("se-native-unit");

  const header = findPrimaryToggle(element);
  unit.primaryToggle = header;
  unit.primaryContent = null;
  header?.classList.add("se-native-primary-toggle");
  const pillHeader = header ? findPillHeader(unit, header) : null;
  unit.pillHeader = pillHeader;
  ensureFixedHeader(unit, header, pillHeader);
  markNativeContentShell(unit);
  markCustomPanels(unit);
  normalizeNativeDrawers(unit);
  if (header && !header.dataset.seNativeListener) {
    header.dataset.seNativeListener = "true";
    header.addEventListener("click", () => {
      requestAnimationFrame(() => updateNativeOpenState(unit));
      window.setTimeout(() => updateNativeOpenState(unit), 250);
    });
  }

  ensureNativeMoveBar(unit);
  requestAnimationFrame(() => updateNativeOpenState(unit));
  return element;
}

function makeFolder(folder) {
  const assigned = sortUnits(
    [...state.nativeUnits.values()].filter(
      (unit) => state.settings.assignments[unit.key] === folder.id,
    ),
  );
  const wrapper = document.createElement("section");
  wrapper.className = "se-folder";
  wrapper.dataset.folderId = folder.id;
  const isOpen = state.settings.openFolders.includes(folder.id);
  wrapper.classList.toggle("is-open", isOpen);

  const row = document.createElement("div");
  row.className = "se-folder-row";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-expanded", String(isOpen));
  const icon = document.createElement("span");
  icon.className = "se-folder-icon";
  icon.textContent = folder.icon || "📁";
  const name = document.createElement("span");
  name.className = "se-folder-name";
  name.textContent = folder.name;
  const count = document.createElement("span");
  count.className = "se-count";
  count.textContent = String(assigned.length);
  const more = makeMoreButton(`${folder.name} 폴더 메뉴`);
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    makeFolderMenu(folder, more);
  });
  row.append(icon, name, count, more);

  const toggle = () => {
    const open = state.settings.openFolders.includes(folder.id);
    state.settings.openFolders = open
      ? state.settings.openFolders.filter((id) => id !== folder.id)
      : [...state.settings.openFolders, folder.id];
    saveSettings();
    render();
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });

  const content = document.createElement("div");
  content.className = "se-folder-content";
  if (!assigned.length) {
    const empty = document.createElement("div");
    empty.className = "se-empty";
    empty.textContent = "아직 이 폴더에 담긴 확장이 없어요.";
    content.append(empty);
  } else {
    assigned.forEach((unit) => content.append(prepareNativeUnit(unit)));
  }
  wrapper.append(row, content);
  return wrapper;
}

function render() {
  if (!state.ui || state.rendering) return;
  state.rendering = true;

  const retained = document.createDocumentFragment();
  state.nativeUnits.forEach((unit) => retained.append(unit.element));
  state.ui.replaceChildren();
  state.ui.append(makeThemePicker(), createToolbar());

  const folders = document.createElement("div");
  folders.className = "se-folders";
  folders.append(createSectionTitle("내 폴더", "+ 폴더 추가", addFolder));
  state.settings.folders.forEach((folder) =>
    folders.append(makeFolder(folder)),
  );
  state.ui.append(folders);

  const validFolderIds = new Set(
    state.settings.folders.map((folder) => folder.id),
  );
  const unassigned = sortUnits(
    [...state.nativeUnits.values()].filter(
      (unit) => !validFolderIds.has(state.settings.assignments[unit.key]),
    ),
  );
  const all = document.createElement("div");
  all.className = "se-all-extensions";
  const allTitle = createSectionTitle("전체 확장");
  allTitle.append(createSortControl());
  all.append(allTitle);
  const list = document.createElement("div");
  list.className = "se-extension-list";
  const prepared = unassigned
    .map((unit) => {
      try {
        return prepareNativeUnit(unit);
      } catch (error) {
        recordDebugError(`prepareNativeUnit(${unit?.title})`, error);
        return null;
      }
    })
    .filter(Boolean);

  const colLeft = document.createElement("div");
  colLeft.className = "se-ext-col";
  const colRight = document.createElement("div");
  colRight.className = "se-ext-col";
  const half = Math.ceil(prepared.length / 2);
  prepared.forEach((el, i) => {
    (i < half ? colLeft : colRight).append(el);
  });
  list.append(colLeft, colRight);
  if (!state.nativeUnits.size) {
    const empty = document.createElement("div");
    empty.className = "se-empty";
    empty.textContent = "실리태번 원본 확장 설정을 찾지 못했어요.";
    list.append(empty);
  }
  all.append(list);
  state.ui.append(all);

  applyTheme();
  state.rendering = false;
  normalizeSoon();
}

function applyTheme() {
  state.root?.setAttribute("data-se-theme", state.settings.theme);
  state.root
    ?.closest("#rm_extensions_block")
    ?.setAttribute("data-se-theme", state.settings.theme);
}

function applySearch(value) {
  const query = normalizeTitle(value).toLocaleLowerCase();
  state.ui.querySelectorAll(".se-native-unit").forEach((element) => {
    element.hidden = Boolean(query) && !element.dataset.search.includes(query);
  });
  state.ui.querySelectorAll(".se-folder").forEach((folder) => {
    if (!query) {
      folder.hidden = false;
      return;
    }
    const folderMatch = folder
      .querySelector(".se-folder-name")
      ?.textContent.toLocaleLowerCase()
      .includes(query);
    const unitMatch = [...folder.querySelectorAll(".se-native-unit")].some(
      (unit) => !unit.hidden,
    );
    folder.hidden = !(folderMatch || unitMatch);
  });
}

function styleNativeTopBar() {
  const notify = state.root.querySelector("#extensions_notify_updates");
  const details = state.root.querySelector("#extensions_details");
  const install = state.root.querySelector("#third_party_extension_button");
  const bar =
    notify?.closest(".alignitemscenter.flex-container.wide100p") ||
    details?.parentElement ||
    install?.parentElement;
  if (!bar) return;
  bar.classList.add("se-native-topbar");
  const heading = bar.querySelector("h3");
  if (heading) heading.textContent = "확장";

  if (!bar.querySelector(".se-native-palette")) {
    const palette = document.createElement("button");
    palette.type = "button";
    palette.className = "se-palette-button se-native-palette";
    palette.title = "테마 선택";
    palette.setAttribute("aria-label", "테마 선택");
    palette.innerHTML = '<i class="fa-solid fa-palette"></i>';
    palette.addEventListener("click", (event) => {
      event.stopPropagation();
      const picker = state.root.querySelector(".se-theme-picker");
      if (picker) picker.hidden = !picker.hidden;
    });
    bar.append(palette);
  }
}

function syncSoon() {
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => {
    consolidateLegacyExtrasApi();
    if (registerNativeUnits()) render();
  }, 80);
}

function consolidateLegacyExtrasApi() {
  // ST 코어의 "(DEPRECATED) Extras API" 블록은 실제 확장이 아니라 헐거운
  // <div> 여러 개 + <hr>가 컬럼에 형제로 그냥 놓여 있는 구조라, 유닛
  // 스캐너가 이걸 이름 없는 확장 조각 여러 개로 잘못 인식했다. 연결 필드가
  // 들어있는 input을 기준으로 관련 조각들을 하나의 컨테이너로 합친다.
  if (document.getElementById("se-legacy-extras-api")) return;
  const urlInput = document.getElementById("extensions_url");
  if (!urlInput) return;
  const inputRow = urlInput.closest(".flex-container");
  const headerRow = inputRow?.previousElementSibling;
  const hr = headerRow?.previousElementSibling;
  if (!inputRow || !headerRow?.contains(document.getElementById("extensions_status")))
    return;

  const wrapper = document.createElement("div");
  wrapper.id = "se-legacy-extras-api";
  wrapper.dataset.seLegacyTitle = "외부 API (Deprecated)";
  headerRow.before(wrapper);
  wrapper.append(headerRow, inputRow);
  if (hr?.tagName === "HR") hr.remove();
}

function initialize() {
  if (state.initialized) return true;
  const root = document.querySelector("#rm_extensions_block .extensions_block");
  const first = document.getElementById("extensions_settings");
  const second = document.getElementById("extensions_settings2");
  if (!root || !first || !second) return false;

  state.initialized = true;
  state.root = root;
  state.nativeColumns = [first, second];
  consolidateLegacyExtrasApi();
  loadSettings();
  styleNativeTopBar();

  const ui = document.createElement("div");
  ui.id = "simple-extension-ui";
  ui.className = "se-ui se-ignore-native";
  root.insertBefore(ui, first);
  state.ui = ui;
  state.nativeColumns.forEach((column) =>
    column.classList.add("se-native-source"),
  );

  registerNativeUnits();
  render();

  state.observer = new MutationObserver(syncSoon);
  state.nativeColumns.forEach((column) =>
    state.observer.observe(column, { childList: true, subtree: true }),
  );

  state.layoutObserver = new MutationObserver((mutations) => {
    const hasNativeChange = mutations.some((mutation) => {
      if (
        mutation.target.closest?.(
          ".se-fixed-extension-header, .se-native-movebar, .se-theme-picker",
        )
      )
        return false;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) =>
          node.nodeType === 1 && !node.classList?.contains("se-ignore-native"),
      );
    });
    if (hasNativeChange) normalizeSoon();
  });
  state.layoutObserver.observe(state.ui, { childList: true, subtree: true });
  state.normalizeInterval = globalThis.setInterval(
    normalizeAllNativeUnits,
    500,
  );

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".se-theme-picker, .se-palette-button")) {
      const picker = state.root?.querySelector(".se-theme-picker");
      if (picker) picker.hidden = true;
    }
    if (!event.target.closest(".se-folder-menu, .se-more")) {
      document
        .querySelectorAll(".se-folder-menu")
        .forEach((menu) => menu.remove());
    }
  });

  console.info("[simple extension] v0.7.49 loaded — native SillyTavern layout themed");
  return true;
}

function outlineElement(element, depth = 0, maxDepth = 5) {
  if (!(element instanceof HTMLElement) || depth > maxDepth) return [];
  const id = element.id ? `#${element.id}` : "";
  const cls = [...element.classList]
    .slice(0, 8)
    .map((name) => `.${name}`)
    .join("");
  const line = `${"  ".repeat(depth)}<${element.tagName.toLowerCase()}${id}${cls}>`;
  return [
    line,
    ...[...element.children].flatMap((child) =>
      outlineElement(child, depth + 1, maxDepth),
    ),
  ];
}

globalThis.simpleExtensionDebug = (filter = "") => {
  const query = String(filter).toLocaleLowerCase();
  const lines = [`[simple extension] v0.7.49 debug dump`];
  state.nativeUnits.forEach((unit) => {
    if (query && !unit.title.toLocaleLowerCase().includes(query)) return;
    lines.push(`===== ${unit.title} (${unit.key}) =====`);
    lines.push(...outlineElement(unit.element));
  });
  const dump = lines.join("\n");
  console.log(dump);
  return dump;
};

if (!initialize()) {
  const timer = window.setInterval(() => {
    if (initialize()) window.clearInterval(timer);
  }, 250);
  window.setTimeout(() => window.clearInterval(timer), 15_000);
}
