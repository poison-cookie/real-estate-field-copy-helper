// ==UserScript==
// @name         Real Estate Field Copy Helper
// @namespace    https://local.user/real-estate-field-copy-helper
// @version      0.1.0
// @description  不動産物件情報を汎用ルールで抽出し、まとめてコピーする補助ツール
// @match        https://*/*
// @match        http://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  const APP_ID = "re-copy-helper";
  const SETTINGS_KEY = "realEstateCopyHelper.settings";
  const SETTINGS_VERSION = 1;
  const DEFAULT_OUTPUT_TEMPLATE = [
    "賃料：{rent}",
    "管理費：{managementFee}",
    "敷金：{deposit}",
    "礼金：{keyMoney}",
    "入居日：{moveInDate}",
  ].join("\n");
  const DEFAULT_HTML_CELL_OUTPUT_TEMPLATE = [
    "<td class=\"plan_td02\">{layout}</td>",
    "<td class=\"plan_td02\">{area}</td>",
    "<td class=\"plan_td02\">\\{rent}</td>",
    "<td class=\"plan_td02\">\\{managementFee}</td>",
    "<td class=\"plan_td02\">{deposit}/{keyMoney}</td>",
    "<td class=\"plan_td02\">{availableDate}</td>",
  ].join("\n");
  const DEFAULT_COPY_TEMPLATES = [
    { name: "コピー文面①", template: DEFAULT_OUTPUT_TEMPLATE },
    { name: "コピー文面②", template: DEFAULT_HTML_CELL_OUTPUT_TEMPLATE },
  ];
  const DEFAULT_VALUE_ALIASES = [
    { output: "即可", aliases: ["即入居可", "即入居", "即時入居可", "すぐ入居可"] },
    { output: "0ヶ月", aliases: ["", "なし", "無し", "無", "無料", "不要", "-"] },
  ];
  const DEFAULT_PANEL_WIDTH = 760;
  const DEFAULT_PANEL_HEIGHT = 620;
  const PANEL_VIEW_GAP = 8;
  const AI_PREVIEW_ROW_LIMIT = 500;
  const DUPLICATE_WARNING_DISMISS_MS = 24 * 60 * 60 * 1000;

  const DEFAULT_FIELD_DEFS = [
    {
      id: "rent",
      label: "賃料",
      outputLabel: "賃料",
      order: 1,
      labels: ["賃料", "家賃", "月額賃料"],
      normalizers: ["trim", "collapseWhitespace", "removeLabelPrefix"],
    },
    {
      id: "managementFee",
      label: "管理費",
      outputLabel: "管理費",
      order: 2,
      labels: ["管理費", "共益費", "管理費等", "管理費・共益費"],
      normalizers: ["trim", "collapseWhitespace", "removeLabelPrefix"],
    },
    {
      id: "deposit",
      label: "敷金",
      outputLabel: "敷金",
      order: 3,
      labels: ["敷金", "保証金"],
      normalizers: ["trim", "collapseWhitespace", "removeLabelPrefix", "normalizeMonth"],
    },
    {
      id: "keyMoney",
      label: "礼金",
      outputLabel: "礼金",
      order: 4,
      labels: ["礼金"],
      normalizers: ["trim", "collapseWhitespace", "removeLabelPrefix", "normalizeMonth"],
    },
    {
      id: "moveInDate",
      label: "入居日",
      outputLabel: "入居日",
      order: 5,
      labels: ["入居日", "入居時期", "入居可能日", "引渡", "引渡時期"],
      normalizers: ["trim", "collapseWhitespace", "removeLabelPrefix"],
    },
  ];

  let settings = migrateSettingsIfNeeded(loadSettings());
  let activeProfile = findMatchingProfile(getCurrentUrlContext());

  let lastValues = {};
  let lastDebug = {};
  let panelRoot = null;
  let settingsOverlay = null;
  let helpPopoverDocument = null;
  let toastTimer = 0;
  let selectorPicker = null;
  let listingObserver = null;
  let listingRefreshTimer = 0;
  let lastListingSignature = "";
  let settingsSaveStatusNode = null;
  let settingsDirty = false;
  let settingsSnapshotBeforeModal = null;
  let keywordFilterSaveTimer = 0;
  let viewportResizeTimer = 0;
  let suppressNextCollapsedClick = false;
  let nodeUidCounter = 1;
  const nodeUids = new WeakMap();

  init();

  function init() {
    registerDisplayMenuCommand();
    if (!isHelperEnabledForCurrentSite()) {
      removeHelperDisplay();
      return;
    }
    activeProfile = ensureProfileForCurrentSite(getCurrentUrlContext());
    enableHelperDisplay();
  }

  function registerDisplayMenuCommand() {
    if (typeof GM_registerMenuCommand !== "function") return;
    const enabled = isHelperEnabledForCurrentSite();
    const label = enabled ? "このサイトで物件確認を無効化する" : "このサイトで物件確認を有効化する";
    GM_registerMenuCommand(label, () => {
      setHelperEnabledForCurrentSite(!enabled);
      saveSettings(settings);
      window.location.reload();
    });
  }

  function isHelperEnabledForCurrentSite() {
    const siteKey = getCurrentSiteKey(getCurrentUrlContext());
    const enabledSiteKeys = Array.isArray(settings.uiSettings.enabledSiteKeys) ? settings.uiSettings.enabledSiteKeys : [];
    return Boolean(siteKey && enabledSiteKeys.includes(siteKey));
  }

  function setHelperEnabledForCurrentSite(enabled) {
    const context = getCurrentUrlContext();
    const siteKey = getCurrentSiteKey(context);
    if (!siteKey) return;
    if (!Array.isArray(settings.uiSettings.enabledSiteKeys)) settings.uiSettings.enabledSiteKeys = [];
    const enabledSiteKeys = new Set(settings.uiSettings.enabledSiteKeys);
    if (enabled) {
      enabledSiteKeys.add(siteKey);
      activeProfile = ensureProfileForCurrentSite(context);
      if (activeProfile) activeProfile.enabled = true;
    } else {
      enabledSiteKeys.delete(siteKey);
    }
    settings.uiSettings.enabledSiteKeys = Array.from(enabledSiteKeys);
    settings.uiSettings.displayEnabled = settings.uiSettings.enabledSiteKeys.length > 0;
  }

  function getCurrentSiteKey(context) {
    return context && context.hostname ? context.hostname : "";
  }

  function enableHelperDisplay() {
    injectStyles();
    createPanel();
    renderPanel();
    startListingMutationObserver();
    window.addEventListener("resize", scheduleViewportClamp, { passive: true });
  }

  function removeHelperDisplay() {
    document.getElementById(APP_ID)?.remove();
    document.getElementById(`${APP_ID}-modal`)?.remove();
    window.removeEventListener("resize", scheduleViewportClamp);
  }

  function getCurrentUrlContext() {
    return {
      href: window.location.href,
      hostname: window.location.hostname,
      pathname: window.location.pathname,
      title: document.title,
    };
  }

  function createDefaultProfileForCurrentSite(context) {
    const now = new Date().toISOString();
    return {
      id: `profile-${context.hostname || "local"}-${Date.now()}`,
      name: `${context.hostname || "現在のサイト"} 物件詳細`,
      enabled: true,
      match: {
        hostname: context.hostname,
        pathPattern: "",
        titlePattern: "",
        urlPattern: "",
      },
      fields: DEFAULT_FIELD_DEFS.map((field) => ({
        id: field.id,
        label: field.label,
        outputLabel: field.outputLabel,
        enabled: true,
        order: field.order,
        required: false,
        rules: [],
        normalizers: field.normalizers.slice(),
        fallbackValue: "",
      })),
      derivedFields: [],
      listingExtractor: createDefaultListingExtractor(),
      outputTemplate: DEFAULT_OUTPUT_TEMPLATE,
      outputTemplates: DEFAULT_COPY_TEMPLATES.map((template) => ({ ...template })),
      createdAt: now,
      updatedAt: now,
    };
  }

  function createDefaultListingExtractor() {
    return {
      enabled: true,
      uiManagedRules: true,
      itemSelector: "",
      rowSelector: "",
      scopeMode: "mixed",
      cellText: {
        includeBeforeContent: false,
        includeAfterContent: false,
      },
      tableExtraction: createDefaultTableExtraction(),
      outputColumns: [
        { key: "buildingName", label: "物件名" },
        { key: "room", label: "号室" },
        { key: "rent", label: "賃料" },
        { key: "managementFee", label: "管理費" },
        { key: "deposit", label: "敷金" },
        { key: "keyMoney", label: "礼金" },
        { key: "availableDate", label: "入居可能日" },
        { key: "ad", label: "AD" },
        { key: "layout", label: "間取り" },
        { key: "area", label: "面積" },
      ],
      fields: createDefaultListingFields(),
    };
  }

  function createDefaultTableExtraction() {
    return {
      enabled: false,
      mode: "standard",
      tableSelector: "",
      rowSelector: "tr",
      cellSelector: "td,th",
      headerRowIndex: 0,
      dataStartRowIndex: 1,
      roomSelector: "",
      buildingNameSelector: "",
      columns: {},
      excludeColumns: [],
    };
  }

  function createDefaultListingFields() {
    return {
      buildingName: createListingField("物件名", true, [
      ]),
      rent: createListingField("賃料", true, [
      ]),
      managementFee: createListingField("管理費", true, [
      ]),
      deposit: createListingField("敷金", true, [
      ]),
      keyMoney: createListingField("礼金", true, [
      ]),
      availableDate: createListingField("入居可能日", false, [
      ]),
      ad: createListingField("AD", false, [
      ]),
      layout: createListingField("間取り", true, [
      ]),
      area: createListingField("面積", true, [
      ]),
    };
  }

  function createListingField(label, required, rules) {
    return {
      enabled: true,
      required,
      label,
      rules,
    };
  }

  function loadSettings() {
    const fallback = {
      version: SETTINGS_VERSION,
      profiles: [],
      globalOutputTemplates: [],
      uiSettings: {
        displayEnabled: false,
        enabledSiteKeys: [],
        panelCollapsed: false,
        panelPosition: "topRight",
      },
    };

    try {
      const raw = getStoredValue(SETTINGS_KEY, "");
      if (!raw) return fallback;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (error) {
      console.warn("[RealEstateCopyHelper] 設定データの読み込みに失敗しました", error);
      return fallback;
    }
  }

  function saveSettings(nextSettings) {
    nextSettings.version = SETTINGS_VERSION;
    addSettingsBackupBeforeSave(nextSettings);
    setStoredValue(SETTINGS_KEY, JSON.stringify(nextSettings));
  }

  function saveUiSettingsOnly() {
    try {
      const raw = getStoredValue(SETTINGS_KEY, "");
      const persisted = raw ? migrateSettingsIfNeeded(typeof raw === "string" ? JSON.parse(raw) : raw) : clonePlain(settings);
      persisted.uiSettings = clonePlain(settings.uiSettings || {});
      persisted.version = SETTINGS_VERSION;
      setStoredValue(SETTINGS_KEY, JSON.stringify(persisted));
    } catch (error) {
      console.warn("[RealEstateCopyHelper] UI設定だけの保存に失敗しました", error);
    }
  }

  function appendAiAssistantLog(action, rawJson, report, extra) {
    try {
      const raw = getStoredValue(SETTINGS_KEY, "");
      const persisted = raw ? migrateSettingsIfNeeded(typeof raw === "string" ? JSON.parse(raw) : raw) : clonePlain(settings);
      const logs = Array.isArray(persisted.aiAssistantLogs) ? persisted.aiAssistantLogs.slice() : [];
      logs.unshift(createAiAssistantLogEntry(action, rawJson, report, extra));
      persisted.aiAssistantLogs = logs.slice(0, 40);
      persisted.version = SETTINGS_VERSION;
      setStoredValue(SETTINGS_KEY, JSON.stringify(persisted));
      settings.aiAssistantLogs = persisted.aiAssistantLogs;
    } catch (error) {
      console.warn("[RealEstateCopyHelper] AI補助ログの保存に失敗しました", error);
    }
  }

  function createAiAssistantLogEntry(action, rawJson, report, extra) {
    const context = getCurrentUrlContext();
    return {
      id: `ai-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      action,
      page: {
        hostname: context.hostname,
        pathname: context.pathname,
        title: context.title,
      },
      rawJson: truncateText(String(rawJson || ""), 80000),
      jsonObjectText: safeExtractJsonObjectText(rawJson),
      report: summarizeAiReportForLog(report),
      ...(extra && typeof extra === "object" ? extra : {}),
    };
  }

  function summarizeAiReportForLog(report) {
    if (!report) return null;
    return {
      applied: report.applied || 0,
      aiRound: report.aiRound || 0,
      rowCount: report.rowCount || 0,
      previewRowCount: report.previewRowCount || 0,
      previewRowTotal: report.previewRowTotal || report.rowCount || 0,
      itemCount: report.itemCount || 0,
      roomCount: report.roomCount || 0,
      errors: (report.errors || []).slice(0, 30),
      warnings: (report.warnings || []).slice(0, 30),
      retryFieldKeys: Array.isArray(report.retryFieldKeys) ? report.retryFieldKeys.slice() : [],
      fieldScores: (report.fieldScores || []).map((score) => ({
        key: score.key,
        label: score.label,
        score: score.score,
        retrieved: `${score.valueCount}/${score.contextCount}`,
        formatOk: score.requiresFormat ? `${score.formatOkCount}/${score.valueCount || 0}` : "-",
        samples: score.samples || [],
        rawSamples: score.rawSamples || [],
        issueReasons: score.issueReasons || [],
        currentRule: score.currentRule || null,
      })),
    };
  }

  function addSettingsBackupBeforeSave(nextSettings) {
    try {
      const raw = getStoredValue(SETTINGS_KEY, "");
      if (!raw) return;
      const previous = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!previous || typeof previous !== "object" || !Array.isArray(previous.profiles) || !previous.profiles.length) return;
      const previousPayload = getSettingsBackupPayload(previous);
      const nextPayload = getSettingsBackupPayload(nextSettings);
      const previousFingerprint = JSON.stringify(previousPayload);
      if (!previousFingerprint || previousFingerprint === JSON.stringify(nextPayload)) return;
      const backups = Array.isArray(nextSettings.settingsBackups) ? nextSettings.settingsBackups.slice() : [];
      if (backups[0] && backups[0].fingerprint === previousFingerprint) return;
      backups.unshift({
        id: `backup-${Date.now()}`,
        createdAt: new Date().toISOString(),
        label: "自動バックアップ",
        fingerprint: previousFingerprint,
        settings: previousPayload,
      });
      nextSettings.settingsBackups = backups.slice(0, 8);
    } catch (error) {
      console.warn("[RealEstateCopyHelper] 設定バックアップの作成に失敗しました", error);
    }
  }

  function getSettingsBackupPayload(value) {
    return {
      version: SETTINGS_VERSION,
      profiles: clonePlain((value && value.profiles) || []),
      globalOutputTemplates: clonePlain((value && value.globalOutputTemplates) || []),
      globalValueAliases: clonePlain((value && value.globalValueAliases) || DEFAULT_VALUE_ALIASES),
    };
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value == null ? null : value));
  }

  function migrateSettingsIfNeeded(value) {
    const migrated = value && typeof value === "object" ? value : {};
    migrated.version = SETTINGS_VERSION;
    if (!Array.isArray(migrated.profiles)) migrated.profiles = [];
    migrated.profiles.forEach((profile) => {
      if (profile && !profile.listingExtractor) profile.listingExtractor = createDefaultListingExtractor();
      if (profile) ensureProfileOutputTemplates(profile);
      if (profile) clearDefaultSingleFieldRules(profile);
      if (profile && profile.listingExtractor && profile.listingExtractor.uiManagedRules !== true) {
        clearListingFieldRules(profile.listingExtractor);
        profile.listingExtractor.uiManagedRules = true;
      }
      if (profile && profile.listingExtractor) ensureListingOutputColumns(profile.listingExtractor);
      if (profile && profile.listingExtractor) profile.listingExtractor = sanitizeListingExtractorConfig(profile.listingExtractor);
    });
    if (!Array.isArray(migrated.globalOutputTemplates)) migrated.globalOutputTemplates = [];
    if (!Array.isArray(migrated.settingsBackups)) migrated.settingsBackups = [];
    if (!Array.isArray(migrated.aiAssistantLogs)) migrated.aiAssistantLogs = [];
    if (!Array.isArray(migrated.globalValueAliases)) {
      migrated.globalValueAliases = DEFAULT_VALUE_ALIASES.map((rule) => ({ output: rule.output, aliases: rule.aliases.slice() }));
    }
    if (!migrated.uiSettings || typeof migrated.uiSettings !== "object") {
      migrated.uiSettings = {};
    }
    if (typeof migrated.uiSettings.displayEnabled !== "boolean") {
      migrated.uiSettings.displayEnabled = false;
    }
    if (!Array.isArray(migrated.uiSettings.enabledSiteKeys)) {
      migrated.uiSettings.enabledSiteKeys = [];
    }
    if (typeof migrated.uiSettings.panelCollapsed !== "boolean") {
      migrated.uiSettings.panelCollapsed = false;
    }
    if (!migrated.uiSettings.panelPosition) {
      migrated.uiSettings.panelPosition = "topRight";
    }
    if (!migrated.uiSettings.panelSize || typeof migrated.uiSettings.panelSize !== "object") {
      migrated.uiSettings.panelSize = {};
    }
    if (!migrated.uiSettings.panelOffset || typeof migrated.uiSettings.panelOffset !== "object") {
      migrated.uiSettings.panelOffset = {};
    }
    if (!migrated.uiSettings.panelCollapsedOffset || typeof migrated.uiSettings.panelCollapsedOffset !== "object") {
      migrated.uiSettings.panelCollapsedOffset = {};
    }
    if (typeof migrated.uiSettings.panelKeywordFilter !== "string") {
      migrated.uiSettings.panelKeywordFilter = "";
    }
    if (typeof migrated.uiSettings.panelActiveTab !== "string") {
      migrated.uiSettings.panelActiveTab = "check";
    }
    if (!migrated.uiSettings.panelTableSort || typeof migrated.uiSettings.panelTableSort !== "object") {
      migrated.uiSettings.panelTableSort = {};
    }
    if (migrated.uiSettings.panelTableValueMode !== "raw") {
      migrated.uiSettings.panelTableValueMode = "normalized";
    }
    if (!Number.isFinite(migrated.uiSettings.duplicateWarningDismissedUntil)) {
      migrated.uiSettings.duplicateWarningDismissedUntil = 0;
    }
    return migrated;
  }

  function ensureProfileOutputTemplates(profile) {
    if (!profile || typeof profile !== "object") return;
    const existing = Array.isArray(profile.outputTemplates) ? profile.outputTemplates : [];
    const normalized = existing
      .filter((entry) => entry && typeof entry === "object")
      .map((entry, index) => ({
        name: String(entry.name || `コピー文面${index + 1}`).trim() || `コピー文面${index + 1}`,
        template: String(entry.template || ""),
      }))
      .filter((entry) => entry.template);
    if (!normalized.length) {
      normalized.push({
        name: "コピー文面①",
        template: String(profile.outputTemplate || DEFAULT_OUTPUT_TEMPLATE),
      });
    }
    if (!normalized.some((entry) => entry.name === "コピー文面②" || entry.template === DEFAULT_HTML_CELL_OUTPUT_TEMPLATE)) {
      normalized.push({ name: "コピー文面②", template: DEFAULT_HTML_CELL_OUTPUT_TEMPLATE });
    }
    profile.outputTemplates = normalized;
    profile.outputTemplate = normalized[0] ? normalized[0].template : DEFAULT_OUTPUT_TEMPLATE;
  }

  function getProfileOutputTemplates(profile) {
    ensureProfileOutputTemplates(profile);
    return Array.isArray(profile && profile.outputTemplates) ? profile.outputTemplates : DEFAULT_COPY_TEMPLATES;
  }

  function getStoredValue(key, fallbackValue) {
    if (typeof GM_getValue === "function") {
      return GM_getValue(key, fallbackValue);
    }
    return localStorage.getItem(key) || fallbackValue;
  }

  function setStoredValue(key, value) {
    if (typeof GM_setValue === "function") {
      GM_setValue(key, value);
      return;
    }
    localStorage.setItem(key, value);
  }

  function findMatchingProfile(context) {
    return settings.profiles.find((profile) => {
      if (!profile || profile.enabled === false) return false;
      const match = profile.match || {};
      if (match.hostname && match.hostname !== context.hostname) return false;
      if (match.pathPattern && !matchesPattern(context.pathname, match.pathPattern)) return false;
      if (match.urlPattern && !matchesPattern(context.href, match.urlPattern)) return false;
      if (match.titlePattern && !matchesPattern(context.title, match.titlePattern)) return false;
      return true;
    });
  }

  function findProfileForCurrentSite(context) {
    return settings.profiles.find((profile) => profileMatchesContext(profile, context, { ignoreEnabled: true }));
  }

  function ensureProfileForCurrentSite(context) {
    let profile = findMatchingProfile(context) || findProfileForCurrentSite(context);
    if (!profile) {
      profile = createDefaultProfileForCurrentSite(context);
      settings.profiles.push(profile);
    }
    profile.enabled = true;
    return profile;
  }

  function matchesPattern(value, pattern) {
    if (!pattern) return true;
    try {
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${escaped}`).test(value || "");
    } catch (error) {
      console.warn("[RealEstateCopyHelper] パターン照合に失敗しました", error);
      return false;
    }
  }

  function createPanel() {
    panelRoot = document.createElement("div");
    panelRoot.id = APP_ID;
    panelRoot.setAttribute("data-position", settings.uiSettings.panelPosition || "topRight");
    applyPanelSize();
    document.documentElement.appendChild(panelRoot);
    applyPanelOffset();
  }

  function renderPanel() {
    if (!panelRoot) return;
    const collapsed = settings.uiSettings.panelCollapsed;
    panelRoot.classList.toggle("is-collapsed", collapsed);
    if (collapsed) {
      panelRoot.style.width = "";
      panelRoot.style.height = "";
      panelRoot.style.maxHeight = "";
    } else {
      applyPanelSize();
      applyPanelOffset();
    }
    panelRoot.innerHTML = "";

    if (collapsed) {
      const collapsedButton = button("Field Copy", "rech-collapsed-button", () => {
        if (suppressNextCollapsedClick) {
          suppressNextCollapsedClick = false;
          return;
        }
        settings.uiSettings.panelCollapsed = false;
        saveSettings(settings);
        renderPanel();
      });
      collapsedButton.addEventListener("pointerdown", startCollapsedPanelDrag);
      panelRoot.appendChild(collapsedButton);
      applyCollapsedPanelOffset();
      return;
    }

    const header = el("div", "rech-header");
    header.addEventListener("pointerdown", startPanelDrag);
    header.appendChild(el("strong", "rech-title", "物件確認"));
    header.appendChild(el("span", "rech-host", activeProfile.name || location.hostname));

    const headerActions = el("div", "rech-header-actions");
    headerActions.appendChild(renderPanelPlacementMenu());
    const toggleButton = button("たたむ", "rech-secondary", () => {
      saveExpandedPanelPlacement();
      settings.uiSettings.panelCollapsed = true;
      if (!hasFiniteOffset(settings.uiSettings.panelCollapsedOffset)) {
        settings.uiSettings.panelCollapsedOffset = getCurrentPanelOffset();
      }
      saveSettings(settings);
      renderPanel();
    });
    headerActions.appendChild(toggleButton);
    header.appendChild(headerActions);
    panelRoot.appendChild(header);

    lastValues = extractAllFields(activeProfile);
    const listingRows = extractListingRows();
    const output = buildOutputText(lastValues, activeProfile.outputTemplate || DEFAULT_OUTPUT_TEMPLATE);
    let filteredListingRows = getPanelVisibleListingRows(listingRows);
    const activeTab = getPanelActiveTab();
    const tabBar = renderPanelTabs(activeTab);
    panelRoot.appendChild(tabBar);
    panelRoot.appendChild(renderPanelSummary(listingRows, filteredListingRows));
    const tableSlot = el("div", "rech-table-slot");
    const anomalySlot = el("div", "rech-anomaly-slot");
    const status = el("div", "rech-status");
    if (activeTab === "check" && listingRows.length) {
      panelRoot.appendChild(renderPanelKeywordFilter(listingRows, (nextRows) => {
        filteredListingRows = applyPanelListingSort(nextRows);
        tableSlot.innerHTML = "";
        tableSlot.appendChild(renderListingTable(filteredListingRows, "検索条件に一致する物件がありません", getPanelListingTableOptions()));
        anomalySlot.innerHTML = "";
        anomalySlot.appendChild(renderListingAnomalyWarnings(filteredListingRows));
        updatePanelListingStatus(status, listingRows, filteredListingRows);
      }));
      panelRoot.appendChild(renderPanelValueModeToggle(() => {
        renderPanel();
      }));
    }

    if (activeTab === "settings") {
      panelRoot.appendChild(renderPanelSettingsShortcut());
      status.textContent = "設定画面で取得ルール、正規表現、プロファイルを編集します";
    } else if (activeTab === "assist") {
      panelRoot.appendChild(renderPanelAssistantShortcut());
      status.textContent = "全体、部分、整形、確認、完成の順でAIと表を作ります";
    } else if (listingRows.length) {
      tableSlot.appendChild(renderListingTable(filteredListingRows, getPanelKeywordFilter() ? "検索条件に一致する物件がありません" : undefined, getPanelListingTableOptions()));
      panelRoot.appendChild(tableSlot);
      anomalySlot.appendChild(renderListingAnomalyWarnings(filteredListingRows));
      panelRoot.appendChild(anomalySlot);
      updatePanelListingStatus(status, listingRows, filteredListingRows);
    } else {
      const missing = getEnabledFields(activeProfile).filter((field) => !lastValues[field.id]);
      status.textContent = missing.length ? `検索結果では見つからず、物件詳細画面から一部だけ取得：${missing.map((field) => field.label).join("、")}` : "検索結果では見つからず、物件詳細画面の項目を取得しました";
      const preview = el("textarea", "rech-preview");
      preview.readOnly = true;
      preview.value = output;
      panelRoot.appendChild(preview);
    }
    panelRoot.appendChild(status);

    const actions = el("div", "rech-actions");
    actions.appendChild(button("表をコピー", "rech-primary", async () => {
      const allRows = extractListingRows();
      const rows = getPanelVisibleListingRows(allRows);
      if (allRows.length && !rows.length) {
        showToast("検索条件に一致する物件がありません", "error");
        return;
      }
      const text = allRows.length ? buildListingTsv(rows) : buildOutputText(extractAllFields(activeProfile), activeProfile.outputTemplate || DEFAULT_OUTPUT_TEMPLATE);
      try {
        await copyToClipboard(text);
        showToast(rows.length ? `${rows.length}件をコピーしました` : "コピーしました", "success");
        renderPanel();
      } catch (error) {
        console.warn("[RealEstateCopyHelper] コピーに失敗しました", error);
        showToast("コピーに失敗しました", "error");
      }
    }));
    actions.appendChild(button("表を別タブで開く", "rech-secondary", () => {
      const allRows = extractListingRows();
      const rows = getPanelVisibleListingRows(allRows);
      if (allRows.length && !rows.length) {
        showToast("検索条件に一致する物件がありません", "error");
        return;
      }
      openListingTableInNewTab(rows);
    }));
    actions.appendChild(button("再取得", "rech-secondary", renderPanel));
    actions.appendChild(button("設定", "rech-secondary", () => openSettingsModal({ focusTab: "listing" })));
    panelRoot.appendChild(actions);

    const toast = el("div", "rech-toast");
    toast.id = `${APP_ID}-toast`;
    panelRoot.appendChild(toast);
    appendResizeHandles(panelRoot, startPanelResize);
  }

  function applyPanelSize() {
    if (!panelRoot) return;
    const size = settings.uiSettings && settings.uiSettings.panelSize ? settings.uiSettings.panelSize : {};
    const width = Number.isFinite(size.width) ? size.width : DEFAULT_PANEL_WIDTH;
    const height = Number.isFinite(size.height) ? size.height : DEFAULT_PANEL_HEIGHT;
    panelRoot.style.width = `${clamp(width, 360, getMaxPanelWidth())}px`;
    panelRoot.style.height = `${clamp(height, 220, getMaxPanelHeight())}px`;
    panelRoot.style.maxHeight = panelRoot.style.height;
  }

  function renderPanelPlacementMenu() {
    const details = el("details", "rech-placement-menu");
    const summary = el("summary", "", "配置");
    summary.title = "パネルの位置と大きさ";
    details.appendChild(summary);
    const menu = el("div", "rech-placement-popover");
    [
      ["全画面", () => placePanelFullscreen()],
      ["左1/2", () => placePanelHalf("left")],
      ["右1/2", () => placePanelHalf("right")],
      ["横全", () => placePanelWidth("full")],
      ["縦1/2", () => placePanelHeight("half")],
      ["縦全", () => placePanelHeight("full")],
    ].forEach(([label, action]) => {
      menu.appendChild(button(label, "rech-secondary rech-compact-button", () => {
        details.open = false;
        action();
      }));
    });
    details.appendChild(menu);
    return details;
  }

  function getPanelActiveTab() {
    const value = settings.uiSettings && settings.uiSettings.panelActiveTab;
    return ["check", "settings", "assist"].includes(value) ? value : "check";
  }

  function setPanelActiveTab(tab) {
    if (!settings.uiSettings) settings.uiSettings = {};
    settings.uiSettings.panelActiveTab = tab;
    saveUiSettingsOnly();
    renderPanel();
  }

  function renderPanelTabs(activeTab) {
    const tabs = el("div", "rech-panel-tabs");
    [
      ["check", "確認"],
      ["settings", "設定"],
      ["assist", "補助"],
    ].forEach(([id, label]) => {
      const tab = button(label, id === activeTab ? "rech-panel-tab is-active" : "rech-panel-tab", () => setPanelActiveTab(id));
      tab.setAttribute("aria-pressed", id === activeTab ? "true" : "false");
      tabs.appendChild(tab);
    });
    return tabs;
  }

  function renderPanelSummary(allRows, visibleRows) {
    const summary = el("div", "rech-panel-summary");
    const duplicateCount = (allRows || []).reduce((count, row) => count + ((row && row._duplicates && row._duplicates.length) || 0), 0);
    const warningCount = countListingWarnings(allRows || []);
    const floorOnlyCount = (allRows || []).filter((row) => isFloorOnlyRoomValue(row && row.room)).length;
    const sortText = getPanelSortStatusText();
    const activeName = activeProfile && activeProfile.name ? activeProfile.name : location.hostname;
    [
      [`取得 ${visibleRows.length}/${allRows.length}件`, "neutral"],
      duplicateCount ? [`重複 ${duplicateCount}件`, "warn"] : ["重複 0件", "muted"],
      floorOnlyCount ? [`号室なし ${floorOnlyCount}件`, "warn"] : ["号室あり", "muted"],
      warningCount ? [`警告 ${warningCount}件`, "warn"] : ["警告 0件", "muted"],
      sortText ? [sortText, "neutral"] : [activeName, "muted"],
    ].forEach(([text, tone]) => {
      const pill = el("span", "rech-summary-pill", text);
      pill.dataset.tone = tone;
      summary.appendChild(pill);
    });
    return summary;
  }

  function countListingWarnings(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;
    const keys = ["rent", "layout", "area"];
    return list.filter((row) => {
      return keys.some((key) => !normalizeText(row && row[key] || ""));
    }).length;
  }

  function renderPanelSettingsShortcut() {
    const section = el("div", "rech-panel-mode");
    section.appendChild(el("strong", "", "取得ルールを編集"));
    section.appendChild(el("p", "", "物件のまとまり、部屋のまとまり、各項目の取得場所を設定します。JSON編集は詳細設定にあります。"));
    const actions = el("div", "rech-panel-mode-actions");
    actions.appendChild(button("設定画面を開く", "rech-primary", () => openSettingsModal({ focusTab: "listing" })));
    actions.appendChild(button("確認に戻る", "rech-secondary", () => setPanelActiveTab("check")));
    section.appendChild(actions);
    return section;
  }

  function renderPanelAssistantShortcut() {
    const section = el("div", "rech-panel-mode");
    section.appendChild(el("strong", "", "AIと表を完成させる"));
    section.appendChild(el("p", "", "ページ全体から候補を探し、1物件・1部屋のまとまりを決め、必要な形へ整形してから仮プレビューします。"));
    const actions = el("div", "rech-panel-mode-actions");
    actions.appendChild(button("補助を開く", "rech-primary", () => openSettingsModal({ focusTab: "listing", openAssistant: true })));
    actions.appendChild(button("確認に戻る", "rech-secondary", () => setPanelActiveTab("check")));
    section.appendChild(actions);
    return section;
  }

  function applyPanelOffset() {
    if (!panelRoot) return;
    const offset = settings.uiSettings && settings.uiSettings.panelOffset ? settings.uiSettings.panelOffset : {};
    if (!Number.isFinite(offset.left) || !Number.isFinite(offset.top)) return;
    const size = settings.uiSettings && settings.uiSettings.panelSize ? settings.uiSettings.panelSize : {};
    const width = panelRoot.offsetWidth || (Number.isFinite(size.width) ? size.width : DEFAULT_PANEL_WIDTH);
    const height = panelRoot.offsetHeight || (Number.isFinite(size.height) ? size.height : DEFAULT_PANEL_HEIGHT);
    const left = clamp(offset.left, 0, Math.max(0, window.innerWidth - width));
    const top = clamp(offset.top, 0, Math.max(0, window.innerHeight - height));
    panelRoot.style.left = `${left}px`;
    panelRoot.style.top = `${top}px`;
    panelRoot.style.right = "auto";
    panelRoot.style.bottom = "auto";
  }

  function getMaxPanelWidth() {
    return Math.max(360, window.innerWidth - PANEL_VIEW_GAP * 2);
  }

  function getMaxPanelHeight() {
    return Math.max(220, window.innerHeight - PANEL_VIEW_GAP * 2);
  }

  function applyPanelPlacement(width, height, left, top) {
    const nextWidth = clamp(Math.round(width), 360, getMaxPanelWidth());
    const nextHeight = clamp(Math.round(height), 220, getMaxPanelHeight());
    const nextLeft = clamp(Math.round(left), 0, Math.max(0, window.innerWidth - nextWidth));
    const nextTop = clamp(Math.round(top), 0, Math.max(0, window.innerHeight - nextHeight));
    settings.uiSettings.panelCollapsed = false;
    settings.uiSettings.panelSize = { width: nextWidth, height: nextHeight };
    settings.uiSettings.panelOffset = { left: nextLeft, top: nextTop };
    saveSettings(settings);
    applyPanelSize();
    applyPanelOffset();
    renderPanel();
  }

  function applyCollapsedPanelOffset() {
    if (!panelRoot) return;
    const offset = settings.uiSettings && settings.uiSettings.panelCollapsedOffset ? settings.uiSettings.panelCollapsedOffset : {};
    if (!Number.isFinite(offset.left) || !Number.isFinite(offset.top)) {
      applyPanelOffset();
      return;
    }
    const width = panelRoot.offsetWidth || 180;
    const height = panelRoot.offsetHeight || 44;
    const left = clamp(offset.left, 0, Math.max(0, window.innerWidth - width));
    const top = clamp(offset.top, 0, Math.max(0, window.innerHeight - height));
    panelRoot.style.left = `${left}px`;
    panelRoot.style.top = `${top}px`;
    panelRoot.style.right = "auto";
    panelRoot.style.bottom = "auto";
  }

  function saveExpandedPanelPlacement() {
    if (!panelRoot || settings.uiSettings.panelCollapsed) return;
    const rect = panelRoot.getBoundingClientRect();
    settings.uiSettings.panelSize = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    settings.uiSettings.panelOffset = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
    };
  }

  function hasFiniteOffset(offset) {
    return Boolean(offset && Number.isFinite(offset.left) && Number.isFinite(offset.top));
  }

  function getCurrentPanelOffset() {
    if (!panelRoot) return {};
    const rect = panelRoot.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
    };
  }

  function placePanelHalf(side) {
    if (!panelRoot) return;
    const width = Math.max(360, Math.floor((window.innerWidth - PANEL_VIEW_GAP * 3) / 2));
    const height = getMaxPanelHeight();
    const left = side === "right" ? window.innerWidth - width - PANEL_VIEW_GAP : PANEL_VIEW_GAP;
    applyPanelPlacement(width, height, left, PANEL_VIEW_GAP);
  }

  function placePanelFullscreen() {
    if (!panelRoot) return;
    applyPanelPlacement(getMaxPanelWidth(), getMaxPanelHeight(), PANEL_VIEW_GAP, PANEL_VIEW_GAP);
  }

  function placePanelHeight(mode) {
    if (!panelRoot) return;
    const rect = panelRoot.getBoundingClientRect();
    const width = Math.round(rect.width || DEFAULT_PANEL_WIDTH);
    const height = mode === "full"
      ? getMaxPanelHeight()
      : Math.max(220, Math.floor((window.innerHeight - PANEL_VIEW_GAP * 3) / 2));
    const left = clamp(Math.round(rect.left), 0, Math.max(0, window.innerWidth - width));
    const top = mode === "full" ? PANEL_VIEW_GAP : clamp(Math.round(rect.top), PANEL_VIEW_GAP, Math.max(PANEL_VIEW_GAP, window.innerHeight - height - PANEL_VIEW_GAP));
    applyPanelPlacement(width, height, left, top);
  }

  function placePanelWidth(mode) {
    if (!panelRoot) return;
    const rect = panelRoot.getBoundingClientRect();
    const width = mode === "full" ? getMaxPanelWidth() : Math.round(rect.width || DEFAULT_PANEL_WIDTH);
    const height = Math.round(rect.height || DEFAULT_PANEL_HEIGHT);
    const left = mode === "full" ? PANEL_VIEW_GAP : clamp(Math.round(rect.left), 0, Math.max(0, window.innerWidth - width));
    const top = clamp(Math.round(rect.top), 0, Math.max(0, window.innerHeight - height));
    applyPanelPlacement(width, height, left, top);
  }

  function renderPanelKeywordFilter(allRows, onFilterChange) {
    const wrapper = el("div", "rech-keyword-filter");
    const label = el("label", "");
    label.appendChild(el("span", "", "表内検索"));
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "マンション名・部屋番号など";
    input.value = getPanelKeywordFilter();
    const count = el("small", "rech-keyword-count");
    const applyFilter = () => {
      settings.uiSettings.panelKeywordFilter = input.value;
      scheduleKeywordFilterSave();
      const filteredRows = filterListingRowsByKeyword(allRows, input.value);
      count.textContent = getKeywordFilterCountText(allRows, filteredRows, input.value);
      onFilterChange(filteredRows);
    };
    input.addEventListener("input", applyFilter);
    input.addEventListener("blur", flushKeywordFilterSave);
    label.appendChild(input);
    wrapper.appendChild(label);
    wrapper.appendChild(button("クリア", "rech-secondary rech-mini-button", () => {
      input.value = "";
      input.focus();
      applyFilter();
    }));
    count.textContent = getKeywordFilterCountText(allRows, filterListingRowsByKeyword(allRows, input.value), input.value);
    wrapper.appendChild(count);
    return wrapper;
  }

  function getPanelKeywordFilter() {
    return String(settings.uiSettings && settings.uiSettings.panelKeywordFilter || "").trim();
  }

  function scheduleKeywordFilterSave() {
    window.clearTimeout(keywordFilterSaveTimer);
    keywordFilterSaveTimer = window.setTimeout(flushKeywordFilterSave, 350);
  }

  function flushKeywordFilterSave() {
    window.clearTimeout(keywordFilterSaveTimer);
    keywordFilterSaveTimer = 0;
    saveSettings(settings);
  }

  function getPanelListingTableOptions() {
    return {
      sortable: true,
      sortState: getPanelTableSort(),
      valueMode: getPanelTableValueMode(),
      onSort: (key) => {
        togglePanelTableSort(key);
        renderPanel();
      },
      directFieldPick: true,
      onPickField: startListingFieldPickerFromTable,
      rowCopyTemplates: getProfileOutputTemplates(activeProfile),
      onCopyRowTemplate: copyListingRowWithTemplate,
    };
  }

  function renderPanelValueModeToggle(onChange) {
    const wrapper = el("div", "rech-value-mode-toggle");
    wrapper.appendChild(el("span", "", "表示"));
    [
      ["normalized", "整形後"],
      ["raw", "取得元"],
    ].forEach(([mode, label]) => {
      const modeButton = button(label, `rech-secondary rech-mini-button${getPanelTableValueMode() === mode ? " is-active" : ""}`, () => {
        settings.uiSettings.panelTableValueMode = mode;
        saveUiSettingsOnly();
        if (typeof onChange === "function") onChange();
      });
      modeButton.type = "button";
      modeButton.setAttribute("aria-pressed", getPanelTableValueMode() === mode ? "true" : "false");
      modeButton.title = mode === "raw" ? "正規化前に取得した表示へ切り替えます" : "表記ゆれを吸収した表示へ戻します";
      wrapper.appendChild(modeButton);
    });
    wrapper.appendChild(el("small", "", getPanelTableValueMode() === "raw" ? "取得元表示です。正規化や切り出し前の値を確認できます。" : "整形後表示です。コピーに使う値を確認できます。"));
    return wrapper;
  }

  function getPanelTableValueMode() {
    return settings.uiSettings && settings.uiSettings.panelTableValueMode === "raw" ? "raw" : "normalized";
  }

  async function copyListingRowWithTemplate(row, templateEntry) {
    try {
      const template = templateEntry && templateEntry.template || DEFAULT_OUTPUT_TEMPLATE;
      const text = buildOutputText(createOutputValuesForRow(row, { htmlCell: isHtmlCellOutputTemplate(template) }), template);
      await copyToClipboard(text);
      showToast(`${templateEntry && templateEntry.name || "コピー文面"}をコピーしました`, "success");
    } catch (error) {
      console.warn("[RealEstateCopyHelper] 部屋単位コピーに失敗しました", error);
      showToast("コピーに失敗しました", "error");
    }
  }

  function isHtmlCellOutputTemplate(template) {
    const text = String(template || "");
    return text.includes("<td") || text.includes("plan_td02");
  }

  function startListingFieldPickerFromTable(fieldKey) {
    refreshActiveProfileForCurrentPage();
    const config = activeProfile && activeProfile.listingExtractor ? activeProfile.listingExtractor : null;
    if (!config || !fieldKey) return;
    const field = ensureListingField(config, fieldKey, getListingFieldLabel(fieldKey));
    const selectorRule = ensurePrimaryListingRule(field, "selector");
    const regexRule = ensurePrimaryListingRule(field, "regex");
    startListingSelectorPicker({
      kind: "field",
      label: getListingFieldLabel(fieldKey),
      fieldKey,
      selectorRule,
      regexRule,
      config,
      onChange: () => {
        activeProfile.updatedAt = new Date().toISOString();
      },
      onPicked: () => {
        renderPanel();
      },
    });
  }

  function getPanelVisibleListingRows(rows) {
    return applyPanelListingSort(filterListingRowsByKeyword(rows, getPanelKeywordFilter()));
  }

  function getPanelTableSort() {
    const sort = settings.uiSettings && settings.uiSettings.panelTableSort || {};
    const key = typeof sort.key === "string" ? sort.key : "";
    const direction = sort.direction === "desc" ? "desc" : "asc";
    return key ? { key, direction } : { key: "", direction: "asc" };
  }

  function togglePanelTableSort(key) {
    if (!settings.uiSettings) settings.uiSettings = {};
    const current = getPanelTableSort();
    const direction = current.key === key && current.direction === "asc" ? "desc" : "asc";
    settings.uiSettings.panelTableSort = { key, direction };
    saveSettings(settings);
  }

  function applyPanelListingSort(rows) {
    return sortListingRows(rows, getPanelTableSort());
  }

  function sortListingRows(rows, sortState) {
    const key = sortState && sortState.key;
    if (!key) return rows.slice();
    const direction = sortState.direction === "desc" ? -1 : 1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const compared = compareListingValues(a.row, b.row, key);
        return compared ? compared * direction : a.index - b.index;
      })
      .map(({ row }) => row);
  }

  function compareListingValues(a, b, key) {
    if (key === "index") return Number(a.index || 0) - Number(b.index || 0);
    const left = getSortableListingValue(a, key);
    const right = getSortableListingValue(b, key);
    if (left.empty && right.empty) return 0;
    if (left.empty) return 1;
    if (right.empty) return -1;
    if (left.type === "number" && right.type === "number") return left.value - right.value;
    return String(left.value).localeCompare(String(right.value), "ja", { numeric: true, sensitivity: "base" });
  }

  function getSortableListingValue(row, key) {
    const raw = key === "propertyName" ? row.propertyName || row.buildingName || "" : row[key] || "";
    const text = normalizeText(raw);
    if (!text) return { empty: true, type: "text", value: "" };
    if (key === "rent" || key === "managementFee") {
      const yen = parseJapaneseYenAmount(text, { allowManYen: true, assumeYenForPlainNumber: true, assumeManYenForPlainDecimal: true, assumeManYenForSmallPlainNumber: true });
      if (yen != null) return { empty: false, type: "number", value: yen };
    }
    if (key === "deposit" || key === "keyMoney") {
      const month = parseMonthAmount(text);
      if (month != null) return { empty: false, type: "number", value: month };
      const yen = parseJapaneseYenAmount(text, { allowManYen: true, assumeYenForPlainNumber: true });
      if (yen != null) return { empty: false, type: "number", value: yen / 1000000 };
    }
    if (key === "area") {
      const area = parseAreaAmount(text);
      if (area != null) return { empty: false, type: "number", value: area };
    }
    if (key === "room") {
      const room = parseRoomOrFloorAmount(text);
      if (room != null) return { empty: false, type: "number", value: room };
    }
    if (key === "layout") {
      const layout = parseLayoutSortValue(text);
      if (layout != null) return { empty: false, type: "number", value: layout };
    }
    return { empty: false, type: "text", value: text };
  }

  function parseMonthAmount(value) {
    const text = normalizeNumberText(value);
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:ヶ月|か月|ヵ月|カ月|ケ月)/);
    if (match) return Number(match[1]);
    if (/^(?:なし|無し|無|無料|不要|0ヶ月)$/.test(text)) return 0;
    return null;
  }

  function parseAreaAmount(value) {
    const text = normalizeNumberText(value);
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m²|m2|平米)/i);
    return match ? Number(match[1]) : null;
  }

  function parseRoomOrFloorAmount(value) {
    const text = normalizeNumberText(value);
    const match = text.match(/([0-9]+)/);
    return match ? Number(match[1]) : null;
  }

  function isFloorOnlyRoomValue(value) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    return /^(?:地下|B)?[0-9]+階(?:建)?$/.test(text) || /^[0-9]+-[0-9]+階$/.test(text);
  }

  function parseLayoutSortValue(value) {
    const text = normalizeNumberText(value).toUpperCase();
    if (/ワンルーム/.test(text)) return getLayoutRank(1, "R");
    const match = text.match(/([0-9]+)\s*(SLDK|LDK|SDK|DK|SK|R|K)(?![A-Z])/);
    if (!match) return null;
    return getLayoutRank(Number(match[1]), match[2]);
  }

  function getLayoutRank(roomCount, layoutType) {
    if (!Number.isFinite(roomCount)) return null;
    const typeRanks = {
      R: 0,
      K: 1,
      SK: 1.5,
      DK: 2,
      SDK: 2.5,
      LDK: 3,
      SLDK: 3.5,
    };
    const typeRank = typeRanks[layoutType] != null ? typeRanks[layoutType] : 9;
    return roomCount * 10 + typeRank;
  }

  function filterListingRowsByKeyword(rows, keyword) {
    const terms = normalizeSearchText(keyword).split(/\s+/).filter(Boolean);
    if (!terms.length) return rows;
    return rows.filter((row) => {
      const haystack = normalizeSearchText(getListingRowSearchText(row));
      return terms.every((term) => haystack.includes(term));
    });
  }

  function getListingRowSearchText(row) {
    if (!row) return "";
    const columns = getListingOutputColumns().map(([key]) => key);
    const values = new Set(["propertyName", "buildingName", "room", "url", ...columns]);
    return Array.from(values).map((key) => row[key] || "").join(" ");
  }

  function normalizeSearchText(value) {
    return normalizeText(value).toLowerCase();
  }

  function getKeywordFilterCountText(allRows, filteredRows, keyword) {
    const query = String(keyword || "").trim();
    return query ? `${filteredRows.length}/${allRows.length}件表示` : `${allRows.length}件表示`;
  }

  function updatePanelListingStatus(status, allRows, filteredRows) {
    const keyword = getPanelKeywordFilter();
    const sortText = getPanelSortStatusText();
    const baseText = keyword
      ? `${filteredRows.length}/${allRows.length}件を表示中: ${keyword}`
      : `${allRows.length}件をテーブル化しました`;
    status.textContent = sortText ? `${baseText} / ${sortText}` : baseText;
  }

  function getPanelSortStatusText() {
    const sort = getPanelTableSort();
    if (!sort.key) return "";
    const columns = new Map([["index", "#"], ...getListingOutputColumns()]);
    const label = columns.get(sort.key) || sort.key;
    return `${label} ${sort.direction === "desc" ? "降順" : "昇順"}`;
  }

  function renderListingAnomalyWarnings(rows) {
    const warnings = getListingAnomalyWarnings(rows);
    const box = el("div", "rech-anomaly-warnings");
    if (!warnings.length) {
      box.hidden = true;
      return box;
    }
    warnings.forEach((warning) => {
      const row = el("div", "rech-anomaly-warning-row");
      row.appendChild(el("span", "", warning.message));
      if (warning.key === "duplicates") {
        row.appendChild(button("閉じる", "rech-secondary rech-mini-button rech-anomaly-close", () => {
          settings.uiSettings.duplicateWarningDismissedUntil = Date.now() + DUPLICATE_WARNING_DISMISS_MS;
          saveUiSettingsOnly();
          box.remove();
        }));
      }
      box.appendChild(row);
    });
    return box;
  }

  function getListingAnomalyWarnings(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length < 2) return [];
    const warnings = [];
    const duplicateCount = list.reduce((count, row) => count + ((row && row._duplicates && row._duplicates.length) || 0), 0);
    if (duplicateCount && !isDuplicateWarningDismissed()) warnings.push({ key: "duplicates", message: `重複候補が${duplicateCount}件あります。#列の「重複候補」を開いて確認してください。` });
    [
      ["rent", "賃料"],
      ["layout", "間取り"],
      ["area", "面積"],
      ["room", "号室"],
    ].forEach(([key, label]) => {
      const values = list.map((row) => normalizeText(row && row[key] || "")).filter(Boolean);
      if (values.length >= Math.min(3, list.length) && new Set(values).size === 1) {
        warnings.push({ key: `same-${key}`, message: `${label}が全行で同じです。1件目の値を繰り返し取得していないか確認してください。` });
      }
    });
    [
      ["rent", "賃料"],
      ["layout", "間取り"],
      ["area", "面積"],
    ].forEach(([key, label]) => {
      const emptyCount = list.filter((row) => !normalizeText(row && row[key] || "")).length;
      if (emptyCount && emptyCount / list.length >= 0.5) warnings.push({ key: `empty-${key}`, message: `${label}が${emptyCount}/${list.length}件で空欄です。` });
    });
    return warnings.slice(0, 5);
  }

  function isDuplicateWarningDismissed() {
    const until = settings.uiSettings && Number(settings.uiSettings.duplicateWarningDismissedUntil);
    return Number.isFinite(until) && until > Date.now();
  }

  function openListingTableInNewTab(rows) {
    const popup = window.open("", "_blank");
    if (!popup) {
      showToast("別タブを開けませんでした。ポップアップブロックを確認してください", "error");
      return;
    }
    const title = `${activeProfile && activeProfile.name || "物件確認"} テーブル`;
    popup.document.open();
    popup.document.write(buildListingTableStandaloneHtml(rows, title, getPanelTableSort()));
    popup.document.close();
  }

  function buildListingTableStandaloneHtml(rows, title, initialSortState) {
    const columns = [["index", "#"], ...getListingOutputColumns().filter(([key]) => key !== "url")];
    const warnings = getListingAnomalyWarnings(rows);
    const tableData = buildStandaloneListingTableData(rows, columns);
    const sortState = initialSortState && initialSortState.key ? initialSortState : { key: "", direction: "asc" };
    return [
      "<!doctype html>",
      "<html lang=\"ja\">",
      "<head>",
      "<meta charset=\"utf-8\">",
      `<title>${escapeHtml(title)}</title>`,
      "<style>",
      "body{margin:0;padding:18px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#17202a;background:#f8fafc;}",
      "h1{margin:0 0 12px;font-size:18px;}",
      ".meta{margin:0 0 12px;color:#64748b;font-size:12px;}",
      ".warnings{margin:0 0 12px;padding:10px 12px;border:1px solid #fed7aa;border-radius:6px;background:#fff7ed;color:#9a3412;font-size:12px;}",
      ".table-wrap{overflow:auto;border:1px solid #cbd5df;border-radius:7px;background:#fff;}",
      "table{width:100%;border-collapse:collapse;font-size:13px;}",
      "th,td{padding:7px 8px;border-bottom:1px solid #e5edf4;border-right:1px solid #eef2f7;text-align:left;white-space:nowrap;}",
      "th{position:sticky;top:0;background:#dbe4ee;z-index:1;font-weight:700;}",
      "th.is-sorted{background:#dbeafe;}",
      ".sort-button{appearance:none;width:100%;margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:700;text-align:left;cursor:pointer;white-space:nowrap;}",
      ".sort-button:hover{text-decoration:underline;}",
      "tr:nth-child(even) td{background:#f6f7f9;}",
      "a{color:#1f6feb;text-decoration:underline;}",
      "</style>",
      "</head>",
      "<body>",
      `<h1>${escapeHtml(title)}</h1>`,
      `<p class=\"meta\">${rows.length}件 / ${escapeHtml(new Date().toLocaleString("ja-JP"))}</p>`,
      warnings.length ? `<div class=\"warnings\">${warnings.map((warning) => escapeHtml(warning.message || warning)).join("<br>")}</div>` : "",
      "<div class=\"table-wrap\"><table><thead><tr>",
      columns.map(([key, label]) => `<th data-key="${escapeHtml(key)}"><button class="sort-button" type="button" data-key="${escapeHtml(key)}">${escapeHtml(label)} ⇅</button></th>`).join(""),
      "</tr></thead><tbody id=\"listing-table-body\">",
      tableData.rows.map((row, rowIndex) => renderStandaloneListingTableRow(row, columns, rowIndex)).join(""),
      "</tbody></table></div>",
      "<script>",
      `window.__RECH_TABLE__=${safeInlineJson({ columns: tableData.columns, rows: tableData.rows, sortState })};`,
      standaloneListingTableScript(),
      "</script>",
      "</body></html>",
    ].join("");
  }

  function buildStandaloneListingTableData(rows, columns) {
    return {
      columns,
      rows: rows.map((row, rowIndex) => {
        const cells = {};
        const sortValues = {};
        columns.forEach(([key]) => {
          const value = key === "index" ? String(rowIndex + 1) : key === "propertyName" ? row.propertyName || row.buildingName || "" : row[key] || "";
          cells[key] = value;
          if (key === "index") {
            sortValues[key] = { empty: false, type: "number", value: Number(row.index || rowIndex + 1) };
          } else {
            sortValues[key] = getSortableListingValue(row, key);
          }
        });
        return {
          cells,
          sortValues,
          url: row.url || "",
          originalIndex: rowIndex,
        };
      }),
    };
  }

  function renderStandaloneListingTableRow(row, columns, rowIndex) {
    return `<tr>${columns.map(([key]) => {
      const value = key === "index" ? String(rowIndex + 1) : row.cells[key] || "";
      if (key === "propertyName" && row.url) {
        return `<td><a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a></td>`;
      }
      return `<td>${escapeHtml(value)}</td>`;
    }).join("")}</tr>`;
  }

  function safeInlineJson(value) {
    return JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  function standaloneListingTableScript() {
    return `
(function(){
  var state = window.__RECH_TABLE__ || { columns: [], rows: [], sortState: { key: "", direction: "asc" } };
  var columns = state.columns || [];
  var rows = (state.rows || []).slice();
  var sortState = state.sortState || { key: "", direction: "asc" };
  var tbody = document.getElementById("listing-table-body");
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function compareRows(a, b, key) {
    var left = a.sortValues && a.sortValues[key] || { empty: true, type: "text", value: "" };
    var right = b.sortValues && b.sortValues[key] || { empty: true, type: "text", value: "" };
    if (left.empty && right.empty) return 0;
    if (left.empty) return 1;
    if (right.empty) return -1;
    if (left.type === "number" && right.type === "number") return Number(left.value || 0) - Number(right.value || 0);
    return String(left.value || "").localeCompare(String(right.value || ""), "ja", { numeric: true, sensitivity: "base" });
  }
  function getSortedRows() {
    if (!sortState.key) return rows.slice();
    var direction = sortState.direction === "desc" ? -1 : 1;
    return rows.map(function(row, index){ return { row: row, index: index }; })
      .sort(function(a, b){
        var compared = compareRows(a.row, b.row, sortState.key);
        return compared ? compared * direction : a.row.originalIndex - b.row.originalIndex || a.index - b.index;
      })
      .map(function(entry){ return entry.row; });
  }
  function renderRows() {
    if (!tbody) return;
    tbody.innerHTML = getSortedRows().map(function(row, rowIndex){
      return "<tr>" + columns.map(function(column){
        var key = column[0];
        var value = key === "index" ? String(rowIndex + 1) : row.cells && row.cells[key] || "";
        if (key === "propertyName" && row.url) {
          return '<td><a href="' + escapeHtml(row.url) + '" target="_blank" rel="noreferrer">' + escapeHtml(value) + "</a></td>";
        }
        return "<td>" + escapeHtml(value) + "</td>";
      }).join("") + "</tr>";
    }).join("");
  }
  function renderHeaders() {
    document.querySelectorAll(".sort-button").forEach(function(button){
      var key = button.getAttribute("data-key") || "";
      var column = columns.find(function(candidate){ return candidate[0] === key; });
      var label = column ? column[1] : key;
      button.textContent = sortState.key === key ? label + " " + (sortState.direction === "desc" ? "↓" : "↑") : label + " ⇅";
      button.setAttribute("aria-sort", sortState.key === key ? (sortState.direction === "desc" ? "descending" : "ascending") : "none");
      var th = button.closest("th");
      if (th) th.classList.toggle("is-sorted", sortState.key === key);
    });
  }
  document.querySelectorAll(".sort-button").forEach(function(button){
    button.addEventListener("click", function(){
      var key = button.getAttribute("data-key") || "";
      sortState = {
        key: key,
        direction: sortState.key === key && sortState.direction === "asc" ? "desc" : "asc"
      };
      renderHeaders();
      renderRows();
    });
  });
  renderHeaders();
  renderRows();
})();`;
  }

  function startPanelDrag(event, options) {
    if (!panelRoot || (!(options && options.allowButton) && event.target.closest("button, input, select, textarea, summary, details, .rech-placement-menu"))) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panelRoot.getBoundingClientRect();
    const startLeft = rect.left;
    const startTop = rect.top;
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    const previousCursor = document.body.style.cursor;
    document.body.classList.add("rech-dragging-panel");
    document.body.style.cursor = "move";

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const nextLeft = clamp(startLeft + (moveEvent.clientX - startX), 0, maxLeft);
      const nextTop = clamp(startTop + (moveEvent.clientY - startY), 0, maxTop);
      panelRoot.style.left = `${Math.round(nextLeft)}px`;
      panelRoot.style.top = `${Math.round(nextTop)}px`;
      panelRoot.style.right = "auto";
      panelRoot.style.bottom = "auto";
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.body.classList.remove("rech-dragging-panel");
      document.body.style.cursor = previousCursor;
      const nextRect = panelRoot.getBoundingClientRect();
      const offsetKey = settings.uiSettings.panelCollapsed ? "panelCollapsedOffset" : "panelOffset";
      settings.uiSettings[offsetKey] = {
        left: Math.round(nextRect.left),
        top: Math.round(nextRect.top),
      };
      saveSettings(settings);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  function startCollapsedPanelDrag(event) {
    if (!panelRoot || event.button !== 0) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panelRoot.getBoundingClientRect();
    const startLeft = rect.left;
    const startTop = rect.top;
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    let dragging = false;

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragging && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      dragging = true;
      suppressNextCollapsedClick = true;
      moveEvent.preventDefault();
      const nextLeft = clamp(startLeft + dx, 0, maxLeft);
      const nextTop = clamp(startTop + dy, 0, maxTop);
      panelRoot.style.left = `${Math.round(nextLeft)}px`;
      panelRoot.style.top = `${Math.round(nextTop)}px`;
      panelRoot.style.right = "auto";
      panelRoot.style.bottom = "auto";
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      if (!dragging) return;
      const nextRect = panelRoot.getBoundingClientRect();
      settings.uiSettings.panelCollapsedOffset = {
        left: Math.round(nextRect.left),
        top: Math.round(nextRect.top),
      };
      saveSettings(settings);
      window.setTimeout(() => {
        suppressNextCollapsedClick = false;
      }, 250);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  function startPanelResize(event, direction) {
    if (!panelRoot) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panelRoot.getBoundingClientRect();
    const startWidth = rect.width;
    const startHeight = rect.height;
    const minWidth = 360;
    const minHeight = 220;
    const maxWidth = Math.max(minWidth, direction.includes("w") ? rect.right : window.innerWidth - rect.left);
    const maxHeight = Math.max(minHeight, direction.includes("n") ? rect.bottom : window.innerHeight - rect.top);
    const previousCursor = document.body.style.cursor;
    document.body.classList.add("rech-resizing-panel");
    document.body.style.cursor = getResizeCursor(direction);

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const nextWidth = direction.includes("w")
        ? clamp(startWidth + (startX - moveEvent.clientX), minWidth, maxWidth)
        : direction.includes("e")
          ? clamp(startWidth + (moveEvent.clientX - startX), minWidth, maxWidth)
          : startWidth;
      const nextHeight = direction.includes("n")
        ? clamp(startHeight + (startY - moveEvent.clientY), minHeight, maxHeight)
        : direction.includes("s")
          ? clamp(startHeight + (moveEvent.clientY - startY), minHeight, maxHeight)
          : startHeight;
      const nextLeft = direction.includes("w") ? clamp(rect.right - nextWidth, 0, Math.max(0, window.innerWidth - nextWidth)) : rect.left;
      const nextTop = direction.includes("n") ? clamp(rect.bottom - nextHeight, 0, Math.max(0, window.innerHeight - nextHeight)) : rect.top;
      panelRoot.style.left = `${Math.round(nextLeft)}px`;
      panelRoot.style.top = `${Math.round(nextTop)}px`;
      panelRoot.style.right = "auto";
      panelRoot.style.bottom = "auto";
      panelRoot.style.width = `${Math.round(nextWidth)}px`;
      panelRoot.style.height = `${Math.round(nextHeight)}px`;
      panelRoot.style.maxHeight = `${Math.round(nextHeight)}px`;
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.body.classList.remove("rech-resizing-panel");
      document.body.style.cursor = previousCursor;
      const nextRect = panelRoot.getBoundingClientRect();
      settings.uiSettings.panelSize = {
        width: Math.round(nextRect.width),
        height: Math.round(nextRect.height),
      };
      settings.uiSettings.panelOffset = {
        left: Math.round(nextRect.left),
        top: Math.round(nextRect.top),
      };
      saveUiSettingsOnly();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  function startListingMutationObserver() {
    if (listingObserver || !document.body) return;
    lastListingSignature = getListingMutationSignature();
    listingObserver = new MutationObserver((mutations) => {
      if (!mutations.some(isPageContentMutation)) return;
      scheduleListingRefresh();
    });
    listingObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function isPageContentMutation(mutation) {
    const target = mutation.target;
    if (target && target.closest && target.closest(`#${APP_ID}, #${APP_ID}-modal`)) return false;
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.some((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      if (node.closest && node.closest(`#${APP_ID}, #${APP_ID}-modal`)) return false;
      return true;
    });
  }

  function scheduleListingRefresh() {
    window.clearTimeout(listingRefreshTimer);
    listingRefreshTimer = window.setTimeout(() => {
      const signature = getListingMutationSignature();
      if (signature === lastListingSignature) return;
      lastListingSignature = signature;
      refreshActiveProfileForCurrentPage();
      renderPanel();
    }, 500);
  }

  function scheduleViewportClamp() {
    window.clearTimeout(viewportResizeTimer);
    viewportResizeTimer = window.setTimeout(clampFloatingPanelsToViewport, 100);
  }

  function clampFloatingPanelsToViewport() {
    if (panelRoot && panelRoot.style.display !== "none") {
      if (settings.uiSettings.panelCollapsed) {
        applyCollapsedPanelOffset();
      } else {
        applyPanelSize();
        applyPanelOffset();
        saveExpandedPanelPlacement();
        saveUiSettingsOnly();
      }
    }
    const modal = settingsOverlay && settingsOverlay.querySelector ? settingsOverlay.querySelector(".rech-modal") : null;
    if (modal) {
      applySettingsPanelSize(modal, modal.getBoundingClientRect());
      positionSettingsModal(modal, modal.getBoundingClientRect());
      const rect = modal.getBoundingClientRect();
      settings.uiSettings.panelSize = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      settings.uiSettings.panelOffset = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      };
      saveUiSettingsOnly();
    }
  }

  function getListingMutationSignature() {
    const config = activeProfile && activeProfile.listingExtractor ? activeProfile.listingExtractor : {};
    const itemCount = config.itemSelector ? safeQuerySelectorAll(document, config.itemSelector).length : 0;
    const rowCount = config.rowSelector ? safeQuerySelectorAll(document, config.rowSelector).length : 0;
    return [
      location.href,
      itemCount,
      rowCount,
    ].join("|");
  }

  function refreshActiveProfileForCurrentPage() {
    const current = getCurrentUrlContext();
    if (activeProfile && profileMatchesContext(activeProfile, current)) return;
    activeProfile = findMatchingProfile(current);
    if (!activeProfile && isHelperEnabledForCurrentSite()) activeProfile = ensureProfileForCurrentSite(current);
  }

  function profileMatchesContext(profile, context, options) {
    if (!profile) return false;
    if (!(options && options.ignoreEnabled) && profile.enabled === false) return false;
    const match = profile.match || {};
    if (match.hostname && match.hostname !== context.hostname) return false;
    if (match.pathPattern && !matchesPattern(context.pathname, match.pathPattern)) return false;
    if (match.urlPattern && !matchesPattern(context.href, match.urlPattern)) return false;
    if (match.titlePattern && !matchesPattern(context.title, match.titlePattern)) return false;
    return true;
  }

  function openSettingsModal(options) {
    closeSettingsModal({ silent: true, discard: true });
    settingsSnapshotBeforeModal = clonePlain(settings);
    settingsDirty = false;
    const panelRect = panelRoot ? panelRoot.getBoundingClientRect() : null;
    hidePanelWhileSettingsOpen();
    const overlay = el("div", "rech-modal-overlay");
    overlay.id = `${APP_ID}-modal`;
    settingsOverlay = overlay;
    const modal = el("div", "rech-modal");
    applySettingsPanelSize(modal, panelRect);
    const header = el("div", "rech-modal-header");
    header.title = "ドラッグして設定画面を移動";
    header.addEventListener("pointerdown", (event) => startSettingsDrag(event, modal));
    header.appendChild(el("h2", "", "コピー設定"));
    header.appendChild(button("保存せず戻る", "rech-secondary", () => closeSettingsModal({ discard: true })));
    modal.appendChild(header);

    const tabBar = el("div", "rech-settings-tabs");
    const body = el("div", "rech-settings-body");
    modal.appendChild(tabBar);
    modal.appendChild(body);
    const sections = [];
    const addSettingsSection = (id, label, section, selected) => {
      section.dataset.settingsTab = id;
      if (!selected) section.classList.add("is-hidden");
      sections.push(section);
      const tabButton = button(label, selected ? "rech-tab is-active" : "rech-tab", () => {
        sections.forEach((candidate) => {
          candidate.classList.toggle("is-hidden", candidate.dataset.settingsTab !== id);
        });
        tabBar.querySelectorAll(".rech-tab").forEach((node) => node.classList.remove("is-active"));
        tabButton.classList.add("is-active");
      });
      tabBar.appendChild(tabButton);
      body.appendChild(section);
    };

    const profileSection = el("section", "rech-section");
    profileSection.appendChild(sectionTitle("サイト設定", "このサイトで使う抽出設定とコピー形式のまとまりです。URL条件に合うページで自動的に使われます。"));
    profileSection.appendChild(helpText("このサイトで使う設定です。対象ドメインと対象URLパスに一致したページで自動適用されます。"));
    profileSection.appendChild(labeledInput("この設定の名前", activeProfile.name, (value) => {
      activeProfile.name = value;
    }, "自分が見分けるための名前です。例: SUUMO一覧、CHINTAI大阪一覧", "この設定を後で見分けるための名前です。物件名や取得結果には影響しません。分からなければサイト名のままで構いません。"));
    profileSection.appendChild(labeledInput("この設定を使うサイト", activeProfile.match.hostname || "", (value) => {
      activeProfile.match.hostname = value.trim();
    }, `例: ${location.hostname}。通常は現在のサイトのままで変更しません。`, "この設定を使うサイト名です。suumo.jp、chintai.net などのドメインを入れます。分からなければ現在入っている値のままで構いません。"));
    profileSection.appendChild(labeledInput("この設定を使うページ", activeProfile.match.pathPattern || "", (value) => {
      activeProfile.match.pathPattern = value.trim();
    }, "空欄ならこのサイトの全ページで使います。例: /jj/chintai/*", "同じサイト内で、この設定を使うページを絞るための条件です。普通は空欄で構いません。複数の一覧ページで設定を分けたい時だけ、URLの / 以降を入れます。* は任意の文字として扱います。"));
    profileSection.appendChild(renderProfileMatchExplanation(activeProfile));
    profileSection.appendChild(renderOutputTemplatesEditor(activeProfile));
    const profileActions = el("div", "rech-inline-actions");
    profileActions.appendChild(button("この設定を複製", "rech-secondary", () => {
      activeProfile = duplicateProfile(activeProfile);
      saveSettings(settings);
      showToast("設定を複製しました", "success");
      closeSettingsModal({ saved: true });
      renderPanel();
      openSettingsModal();
    }));
    profileSection.appendChild(profileActions);
    addSettingsSection("profile", "基本", profileSection, false);

    const fieldSection = el("section", "rech-section");
    fieldSection.appendChild(sectionTitle("物件詳細画面からコピー", "物件名・賃料・住所などが1物件分だけ表示されている画面で、どの場所から値を取るかを決める設定です。"));
    fieldSection.appendChild(helpText("物件詳細画面を開いて、表示中の1物件だけをコピーしたいときに使います。検索結果から複数の物件や部屋をまとめてコピーする場合は「検索結果を表にする」を使います。"));
    getEnabledFields(activeProfile).forEach((field) => {
      fieldSection.appendChild(renderFieldEditor(field));
    });
    addSettingsSection("fields", "物件詳細", fieldSection, false);

    const derivedSection = el("section", "rech-section");
    derivedSection.appendChild(sectionTitle("敷金礼金の共通セル分割", "敷金/礼金のように1つの表示欄に複数の値がまとまっているとき、区切り文字で分ける補助設定です。"));
    const splitRule = (activeProfile.derivedFields || []).find((rule) => rule.id === "depositKeyMoneySplit");
    if (splitRule) {
      derivedSection.appendChild(labeledInput("見出し名候補", (splitRule.sourceRule.labels || []).join(", "), (value) => {
        splitRule.sourceRule.labels = splitCommaList(value);
      }, "", "敷金/礼金が一緒に書かれている場所を探すための見出し名です。複数ある場合はカンマで区切ります。"));
      derivedSection.appendChild(labeledInput("区切り文字", splitRule.separator || "/", (value) => {
        splitRule.separator = value || "/";
      }, "", "取得した文字列を左右に分ける記号です。例: 敷金/礼金 のような表示なら / を使います。"));
    }
    addSettingsSection("derived", "分割", derivedSection, false);

    const listingSection = el("section", "rech-section");
    listingSection.appendChild(sectionTitle("検索結果を表にする", "検索結果ページなど、複数の物件や部屋を表形式でまとめてコピーするための設定です。"));
    const listingConfig = activeProfile.listingExtractor || createDefaultListingExtractor();
    activeProfile.listingExtractor = listingConfig;
    const listingText = labeledTextarea("上級設定（JSON）", JSON.stringify(listingConfig, null, 2), () => { }, "フォームで表現しきれない設定だけ直接編集します。通常は閉じたままで構いません。", "検索結果を表にするための内部設定です。通常は画面上のボタンで設定し、ここは触らなくて構いません。");
    const listingArea = listingText.querySelector("textarea");
    listingArea.classList.add("rech-json-editor");
    const syncListingJson = () => {
      listingArea.value = JSON.stringify(activeProfile.listingExtractor || createDefaultListingExtractor(), null, 2);
    };
    listingSection.appendChild(renderListingQuickEditor(listingConfig, syncListingJson));
    const listingActions = el("div", "rech-actions");
    const advanced = el("details", "rech-advanced-json");
    advanced.appendChild(el("summary", "", "上級設定を編集"));
    advanced.appendChild(listingText);
    listingActions.appendChild(button("上級設定を反映", "rech-secondary", () => {
      try {
        const parsed = JSON.parse(listingArea.value);
        const nextConfig = parsed && typeof parsed === "object" ? mergeNestedObjects(createDefaultListingExtractor(), parsed) : createDefaultListingExtractor();
        Object.keys(listingConfig).forEach((key) => delete listingConfig[key]);
        Object.assign(listingConfig, sanitizeListingExtractorConfig(nextConfig));
        ensureListingOutputColumns(listingConfig);
        activeProfile.listingExtractor = listingConfig;
        syncListingJson();
        const quickEditor = listingSection.querySelector(".rech-listing-editor");
        syncListingEditorControls(quickEditor, listingConfig);
        if (quickEditor && typeof quickEditor.refreshListingEditor === "function") quickEditor.refreshListingEditor();
        markSettingsDirty("未保存");
        showToast("検索結果の表設定を反映しました", "success");
        renderPanel();
      } catch (error) {
        console.warn("[RealEstateCopyHelper] 検索結果の表設定反映に失敗しました", error);
        showToast("検索結果の表設定JSONが不正です", "error");
      }
    }));
    listingSection.appendChild(advanced);
    listingSection.appendChild(listingActions);
    addSettingsSection("listing", "検索結果", listingSection, true);

    const aliasSection = el("section", "rech-section");
    aliasSection.appendChild(sectionTitle("表記ゆれ", "サイトごとに違う表記を、コピー時に同じ表記へそろえるための全体設定です。"));
    aliasSection.appendChild(helpText("抽出値が aliases のいずれかに完全一致した場合、output の表記に変換します。全サイト共通です。"));
    const aliasText = labeledTextarea("表記ゆれ設定（JSON）", JSON.stringify(settings.globalValueAliases || DEFAULT_VALUE_ALIASES, null, 2), (value) => {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) settings.globalValueAliases = parsed;
      } catch (_error) {
        // 保存時ではなく入力中の不完全JSONは無視します。
      }
    }, "例: output に 即可、aliases に 即入居可 など。", "aliases に書いた値が取れた場合、output の値に置き換えます。例: 即入居可 を 即可 に統一します。");
    aliasText.querySelector("textarea").classList.add("rech-json-editor");
    aliasSection.appendChild(aliasText);
    addSettingsSection("aliases", "表記ゆれ", aliasSection, false);

    const ioSection = el("section", "rech-section");
    ioSection.appendChild(sectionTitle("設定の保管・復元", "今の設定を控えておく、または控えておいた設定に戻す画面です。"));
    ioSection.appendChild(helpText("設定を別PCへ移したい時や、念のため控えておきたい時に使います。普通の編集では使いません。"));
    ioSection.appendChild(helpList([
      "保管する: 「今の設定を表示」を押し、下の文字をコピーしてメモ帳などに保存します。",
      "復元する: 保存しておいた文字を下に貼り付け、「貼り付けた設定に戻す」を押します。",
      "注意: 復元すると、今入っている設定は貼り付けた内容に置き換わります。",
    ]));
    const ioText = labeledTextarea("設定の控え", "", () => { }, "ここに設定の控えが表示されます。復元する時は、保存しておいた控えをここに貼り付けます。", "設定をまとめた文字です。中身を手で直す必要はありません。コピーして保管するか、保管済みのものを貼り付けて使います。");
    const ioArea = ioText.querySelector("textarea");
    const ioActions = el("div", "rech-actions");
    ioActions.appendChild(button("今の設定を表示", "rech-secondary", () => {
      ioArea.value = exportSettings();
      ioArea.select();
    }));
    ioActions.appendChild(button("貼り付けた設定に戻す", "rech-secondary", () => {
      try {
        importSettings(ioArea.value);
        showToast("貼り付けた設定に戻しました", "success");
        closeSettingsModal({ saved: true });
        activeProfile = findMatchingProfile(getCurrentUrlContext()) || settings.profiles[0];
        renderPanel();
      } catch (error) {
        console.warn("[RealEstateCopyHelper] インポートに失敗しました", error);
        showToast("貼り付けた設定を読み込めませんでした", "error");
      }
    }));
    ioSection.appendChild(ioText);
    ioSection.appendChild(ioActions);
    ioSection.appendChild(renderSettingsBackupPanel());
    addSettingsSection("io", "保管", ioSection, false);

    const footer = el("div", "rech-modal-footer");
    settingsSaveStatusNode = el("span", "rech-save-status", "保存済み");
    footer.appendChild(settingsSaveStatusNode);
    footer.appendChild(button("保存して戻る", "rech-primary", () => {
      activeProfile.updatedAt = new Date().toISOString();
      saveSettings(settings);
      markSettingsSaved("保存済み");
      closeSettingsModal({ saved: true });
      showToast("設定を保存しました", "success");
    }));
    modal.appendChild(footer);
    appendResizeHandles(modal, startSettingsResize);

    overlay.appendChild(modal);
    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) return;
      event.preventDefault();
      event.stopPropagation();
      nudgeSettingsModal(modal);
      showToast("外側クリックでは閉じません。保存して戻るか、保存せず戻るを押してください", "error");
    });
    document.documentElement.appendChild(overlay);
    positionSettingsModal(modal, panelRect);
    if (options && options.focusFieldKey) focusListingFieldEditor(modal, options.focusFieldKey);
    if (options && options.openAssistant) openSettingsAssistant(modal);
  }

  function openSettingsAssistant(modal) {
    const assistant = modal && modal.querySelector ? modal.querySelector(".rech-ai-assistant") : null;
    if (!assistant) return;
    assistant.open = true;
    assistant.scrollIntoView({ block: "start", inline: "nearest" });
  }

  function nudgeSettingsModal(modal) {
    if (!modal) return;
    modal.classList.remove("is-attention");
    void modal.offsetWidth;
    modal.classList.add("is-attention");
    window.setTimeout(() => {
      if (modal && modal.classList) modal.classList.remove("is-attention");
    }, 320);
  }

  function focusListingFieldEditor(modal, fieldKey) {
    const row = modal && modal.querySelector ? modal.querySelector(`[data-listing-field="${cssEscape(fieldKey)}"]`) : null;
    if (!row) return;
    row.classList.add("is-focus-row");
    row.scrollIntoView({ block: "center", inline: "nearest" });
    const input = row.querySelector("input, select, button");
    if (input && typeof input.focus === "function") input.focus();
    window.setTimeout(() => row.classList.remove("is-focus-row"), 2400);
  }

  function renderProfileMatchExplanation(profile) {
    const context = getCurrentUrlContext();
    const match = profile && profile.match ? profile.match : {};
    const box = el("div", "rech-match-explain");
    box.appendChild(el("strong", "", "この設定が使われる場所"));
    const siteText = match.hostname
      ? `${match.hostname} のページ`
      : "サイト名では絞り込まない";
    const pathText = match.pathPattern
      ? `URLの / 以降が ${match.pathPattern} に合うページ`
      : "このサイトの全ページ";
    box.appendChild(el("span", "", `${siteText} / ${pathText}`));
    box.appendChild(el("small", "", `今のページ: ${context.hostname}${context.pathname}`));
    box.appendChild(el("small", "", "通常は「この設定を使うサイト」はそのまま、「この設定を使うページ」は空欄で問題ありません。"));
    return box;
  }

  function renderOutputTemplatesEditor(profile) {
    ensureProfileOutputTemplates(profile);
    const wrapper = el("div", "rech-output-templates");
    wrapper.appendChild(termWithHelp("コピー文面", "物件詳細画面や部屋行からコピーするときの文面です。複数登録できます。{rent} のような項目名が取得値に置き換わります。"));
    wrapper.appendChild(el("small", "rech-output-template-note", "コピー文面②には、空室表HTMLへ貼り戻すための td 形式を初期登録しています。"));
    const list = el("div", "rech-output-template-list");
    const renderList = () => {
      list.innerHTML = "";
      getProfileOutputTemplates(profile).forEach((entry, index) => {
        const item = el("div", "rech-output-template-item");
        const header = el("div", "rech-output-template-header");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = entry.name || `コピー文面${index + 1}`;
        nameInput.addEventListener("input", () => {
          entry.name = nameInput.value.trim() || `コピー文面${index + 1}`;
          markSettingsDirty("未保存");
        });
        header.appendChild(nameInput);
        if (index > 0) {
          header.appendChild(button("削除", "rech-secondary rech-mini-button", () => {
            profile.outputTemplates.splice(index, 1);
            ensureProfileOutputTemplates(profile);
            markSettingsDirty("未保存");
            renderList();
          }));
        }
        item.appendChild(header);
        const textarea = document.createElement("textarea");
        textarea.value = entry.template || "";
        textarea.placeholder = "例: 賃料：{rent}";
        textarea.addEventListener("input", () => {
          entry.template = textarea.value;
          if (index === 0) profile.outputTemplate = entry.template;
          markSettingsDirty("未保存");
        });
        item.appendChild(textarea);
        list.appendChild(item);
      });
    };
    renderList();
    wrapper.appendChild(list);
    const actions = el("div", "rech-inline-actions");
    actions.appendChild(button("コピー文面を追加", "rech-secondary", () => {
      profile.outputTemplates.push({
        name: `コピー文面${profile.outputTemplates.length + 1}`,
        template: DEFAULT_OUTPUT_TEMPLATE,
      });
      markSettingsDirty("未保存");
      renderList();
    }));
    wrapper.appendChild(actions);
    return wrapper;
  }

  function closeSettingsModal(options) {
    const mode = options || {};
    if (settingsDirty && !mode.saved && !mode.discard && !mode.silent) {
      showToast("未保存です。保存して戻るか、保存せず戻るを押してください", "error");
      return false;
    }
    closeHelpPopover();
    closePickerNotice();
    stopSelectorPicker();
    settingsSaveStatusNode = null;
    let closed = false;
    if (settingsOverlay) {
      settingsOverlay.remove();
      settingsOverlay = null;
      closed = true;
    } else {
      const modal = document.getElementById(`${APP_ID}-modal`);
      if (modal) {
        modal.remove();
        closed = true;
      }
    }
    restorePanelAfterSettingsClose();
    if (closed && mode.discard && settingsSnapshotBeforeModal) restoreSettingsSnapshotBeforeModal();
    if (mode.saved) settingsSnapshotBeforeModal = null;
    settingsDirty = false;
    settingsSnapshotBeforeModal = null;
    if (closed) renderPanel();
    return closed;
  }

  function restoreSettingsSnapshotBeforeModal() {
    if (!settingsSnapshotBeforeModal) return;
    const currentUi = clonePlain(settings.uiSettings || {});
    settings = migrateSettingsIfNeeded(settingsSnapshotBeforeModal);
    settings.uiSettings = {
      ...(settings.uiSettings || {}),
      panelSize: currentUi.panelSize || (settings.uiSettings && settings.uiSettings.panelSize) || {},
      panelOffset: currentUi.panelOffset || (settings.uiSettings && settings.uiSettings.panelOffset) || {},
      panelCollapsedOffset: currentUi.panelCollapsedOffset || (settings.uiSettings && settings.uiSettings.panelCollapsedOffset) || {},
      panelCollapsed: Boolean(currentUi.panelCollapsed),
      panelKeywordFilter: typeof currentUi.panelKeywordFilter === "string" ? currentUi.panelKeywordFilter : "",
      panelTableSort: currentUi.panelTableSort || {},
    };
    activeProfile = findMatchingProfile(getCurrentUrlContext()) || findProfileForCurrentSite(getCurrentUrlContext()) || settings.profiles[0] || ensureProfileForCurrentSite(getCurrentUrlContext());
  }

  function markSettingsDirty(message) {
    settingsDirty = true;
    if (settingsSaveStatusNode) {
      settingsSaveStatusNode.textContent = message || "未保存";
      settingsSaveStatusNode.setAttribute("data-state", "dirty");
    }
  }

  function markSettingsSaved(message) {
    settingsDirty = false;
    if (settingsSaveStatusNode) {
      settingsSaveStatusNode.textContent = message || "保存済み";
      settingsSaveStatusNode.setAttribute("data-state", "saved");
    }
  }

  function hidePanelWhileSettingsOpen() {
    if (!panelRoot) return;
    panelRoot.dataset.displayBeforeSettings = panelRoot.style.display || "";
    panelRoot.style.display = "none";
  }

  function restorePanelAfterSettingsClose() {
    if (!panelRoot || !("displayBeforeSettings" in panelRoot.dataset)) return;
    panelRoot.style.display = panelRoot.dataset.displayBeforeSettings || "";
    delete panelRoot.dataset.displayBeforeSettings;
  }

  function applySettingsPanelSize(modal, anchorRect) {
    const size = settings.uiSettings && settings.uiSettings.panelSize ? settings.uiSettings.panelSize : {};
    const view = modal.ownerDocument.defaultView || window;
    const width = Number.isFinite(size.width) ? size.width : ((anchorRect && anchorRect.width) || DEFAULT_PANEL_WIDTH);
    const height = Number.isFinite(size.height) ? size.height : ((anchorRect && anchorRect.height) || DEFAULT_PANEL_HEIGHT);
    modal.style.width = `${clamp(width, 360, Math.max(360, view.innerWidth - 24))}px`;
    modal.style.height = `${clamp(height, 220, Math.max(220, view.innerHeight - 20))}px`;
  }

  function positionSettingsModal(modal, anchorRect) {
    const view = modal.ownerDocument.defaultView || window;
    const width = modal.offsetWidth || clamp((anchorRect && anchorRect.width) || 760, 360, Math.max(360, view.innerWidth - 24));
    const height = modal.offsetHeight || clamp((anchorRect && anchorRect.height) || 620, 220, Math.max(220, view.innerHeight - 20));
    const offset = settings.uiSettings && settings.uiSettings.panelOffset ? settings.uiSettings.panelOffset : {};
    const preferredLeft = Number.isFinite(offset.left) ? offset.left : (anchorRect ? anchorRect.left : 10);
    const preferredTop = Number.isFinite(offset.top) ? offset.top : (anchorRect ? anchorRect.top : 10);
    const left = clamp(preferredLeft, 0, Math.max(0, view.innerWidth - width));
    const top = clamp(preferredTop, 0, Math.max(0, view.innerHeight - height));
    modal.style.left = `${Math.round(left)}px`;
    modal.style.top = `${Math.round(top)}px`;
  }

  function startSettingsDrag(event, modal) {
    if (!modal || event.button !== 0) return;
    if (event.target && event.target.closest && event.target.closest("button, input, textarea, select, a, summary")) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = modal.getBoundingClientRect();
    const startLeft = rect.left;
    const startTop = rect.top;
    const doc = modal.ownerDocument;
    const view = doc.defaultView || window;
    const maxLeft = Math.max(0, view.innerWidth - rect.width);
    const maxTop = Math.max(0, view.innerHeight - rect.height);
    doc.body.classList.add("rech-dragging-settings");

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const nextLeft = clamp(startLeft + (moveEvent.clientX - startX), 0, maxLeft);
      const nextTop = clamp(startTop + (moveEvent.clientY - startY), 0, maxTop);
      modal.style.left = `${Math.round(nextLeft)}px`;
      modal.style.top = `${Math.round(nextTop)}px`;
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      doc.removeEventListener("pointermove", onMove, true);
      doc.removeEventListener("pointerup", onUp, true);
      doc.removeEventListener("pointercancel", onUp, true);
      doc.body.classList.remove("rech-dragging-settings");
      const nextRect = modal.getBoundingClientRect();
      settings.uiSettings.panelOffset = {
        left: Math.round(nextRect.left),
        top: Math.round(nextRect.top),
      };
      saveUiSettingsOnly();
    };
    doc.addEventListener("pointermove", onMove, true);
    doc.addEventListener("pointerup", onUp, true);
    doc.addEventListener("pointercancel", onUp, true);
  }

  function startSettingsResize(event, direction, modal) {
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = modal.getBoundingClientRect();
    const startWidth = rect.width;
    const startHeight = rect.height;
    const minWidth = 360;
    const minHeight = 220;
    const doc = modal.ownerDocument;
    const view = doc.defaultView || window;
    const maxWidth = Math.max(minWidth, direction.includes("w") ? rect.right : view.innerWidth - rect.left);
    const maxHeight = Math.max(minHeight, direction.includes("n") ? rect.bottom : view.innerHeight - rect.top);
    const previousCursor = doc.body.style.cursor;
    doc.body.classList.add("rech-resizing-settings");
    doc.body.style.cursor = getResizeCursor(direction);

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const nextWidth = direction.includes("w")
        ? clamp(startWidth + (startX - moveEvent.clientX), minWidth, maxWidth)
        : direction.includes("e")
          ? clamp(startWidth + (moveEvent.clientX - startX), minWidth, maxWidth)
          : startWidth;
      const nextHeight = direction.includes("n")
        ? clamp(startHeight + (startY - moveEvent.clientY), minHeight, maxHeight)
        : direction.includes("s")
          ? clamp(startHeight + (moveEvent.clientY - startY), minHeight, maxHeight)
          : startHeight;
      const nextLeft = direction.includes("w") ? clamp(rect.right - nextWidth, 0, Math.max(0, view.innerWidth - nextWidth)) : rect.left;
      const nextTop = direction.includes("n") ? clamp(rect.bottom - nextHeight, 0, Math.max(0, view.innerHeight - nextHeight)) : rect.top;
      modal.style.left = `${Math.round(nextLeft)}px`;
      modal.style.top = `${Math.round(nextTop)}px`;
      modal.style.width = `${Math.round(nextWidth)}px`;
      modal.style.height = `${Math.round(nextHeight)}px`;
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      doc.removeEventListener("pointermove", onMove, true);
      doc.removeEventListener("pointerup", onUp, true);
      doc.removeEventListener("pointercancel", onUp, true);
      doc.body.classList.remove("rech-resizing-settings");
      doc.body.style.cursor = previousCursor;
      const nextRect = modal.getBoundingClientRect();
      settings.uiSettings.panelSize = {
        width: Math.round(nextRect.width),
        height: Math.round(nextRect.height),
      };
      settings.uiSettings.panelOffset = {
        left: Math.round(nextRect.left),
        top: Math.round(nextRect.top),
      };
      saveUiSettingsOnly();
    };
    doc.addEventListener("pointermove", onMove, true);
    doc.addEventListener("pointerup", onUp, true);
    doc.addEventListener("pointercancel", onUp, true);
  }

  function appendResizeHandles(target, onResize) {
    ["n", "e", "s", "w", "ne", "se", "sw", "nw"].forEach((direction) => {
      const handle = el("div", `rech-resize-edge rech-resize-${direction}`);
      handle.dataset.resizeDirection = direction;
      handle.title = "ドラッグしてサイズ変更";
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        onResize(event, direction, target);
      });
      target.appendChild(handle);
    });
  }

  function getResizeCursor(direction) {
    if (direction === "n" || direction === "s") return "ns-resize";
    if (direction === "e" || direction === "w") return "ew-resize";
    if (direction === "ne" || direction === "sw") return "nesw-resize";
    return "nwse-resize";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function renderFieldEditor(field) {
    const wrapper = el("details", "rech-field-editor");
    wrapper.open = false;
    const heading = el("div", "rech-field-heading");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = field.enabled !== false;
    checkbox.addEventListener("change", () => {
      field.enabled = checkbox.checked;
      markSettingsDirty();
    });
    const summary = document.createElement("summary");
    heading.appendChild(checkbox);
    heading.appendChild(el("strong", "", field.label));
    heading.appendChild(el("span", "rech-field-summary", "物件詳細"));
    summary.appendChild(heading);
    wrapper.appendChild(summary);

    wrapper.appendChild(labeledInput("出力ラベル", field.outputLabel || field.label, (value) => {
      field.outputLabel = value;
    }, "コピー文面に表示する項目名です。", "コピー結果に出す項目名です。取得する場所には影響しません。"));

    const firstCssRule = findOrCreateRule(field, "css");
    const cssControl = labeledInput("値の場所（CSS）", firstCssRule.selector || "", (value) => {
      firstCssRule.selector = value.trim();
      firstCssRule.target = firstCssRule.target || "textContent";
      refreshCssProbe(cssControl, firstCssRule.selector);
    }, "物件詳細画面で、この項目の値が表示されている場所です。検索結果の表は「検索結果」タブで設定します。", "物件詳細画面上の値そのものをCSSで指定します。分からない場合は「画面から選択」を押して、画面上の値をクリックしてください。");
    const selectorActions = el("div", "rech-inline-actions");
    selectorActions.appendChild(button("画面から選択", "rech-secondary", () => startSelectorPicker(field.id, {
      onPicked: (selector) => {
        const input = cssControl.querySelector("input");
        if (input) input.value = selector;
        refreshCssProbe(cssControl, selector);
      },
    })));
    selectorActions.appendChild(button("確認", "rech-secondary", () => refreshCssProbe(cssControl, firstCssRule.selector)));
    cssControl.appendChild(selectorActions);
    const probe = el("small", "rech-css-probe");
    cssControl.appendChild(probe);
    refreshCssProbe(cssControl, firstCssRule.selector);
    wrapper.appendChild(cssControl);

    const labelRule = findOrCreateRule(field, "labelAdjacent");
    wrapper.appendChild(labeledInput("見出し名候補", (labelRule.labels || []).join(", "), (value) => {
      labelRule.labels = splitCommaList(value);
      labelRule.matchMode = labelRule.matchMode || "contains";
      labelRule.valuePosition = labelRule.valuePosition || "sameRowNextCell";
    }, "例: 賃料, 家賃。見出しの隣や同じ並びから値を探します。", "ページ内の見出し名から値を探す設定です。例: 見出し「賃料」の隣にある金額を取得します。複数ある場合はカンマで区切ります。"));

    const regexRule = findOrCreateRule(field, "regex");
    const regexControl = labeledInput("正規表現", regexRule.pattern || "", (value) => {
      regexRule.pattern = value;
      regexRule.captureGroup = regexRule.captureGroup || 1;
    }, "ページ本文から値を抜く正規表現です。通常は1番目の () を値として使います。", "値の場所や見出し名候補で取れないときだけ使う上級設定です。() で囲んだ部分がコピーする値になります。");
    regexControl.appendChild(renderRegexPresetSelect(field.id, (preset) => {
      const input = regexControl.querySelector("input");
      regexRule.pattern = preset.pattern;
      regexRule.regex = preset.pattern;
      regexRule.captureGroup = preset.group || 1;
      regexRule.group = preset.group || 1;
      regexRule.flags = preset.flags || "";
      if (input) input.value = preset.pattern;
      markSettingsDirty();
    }));
    wrapper.appendChild(regexControl);

    const staticRule = findOrCreateRule(field, "static");
    wrapper.appendChild(labeledInput("固定値", staticRule.value || "", (value) => {
      staticRule.value = value;
    }, "常に同じ値を入れたい場合だけ使います。", "サイトから取得せず、毎回同じ文字を入れる設定です。通常は空欄で構いません。"));

    wrapper.appendChild(labeledInput("未取得時の値", field.fallbackValue || "", (value) => {
      field.fallbackValue = value;
    }, "どの方法でも取れなかったときに入れる値です。空欄可。", "値の場所、見出し名候補、正規表現のどれでも値が取れなかった場合に入れる代替値です。不要なら空欄にします。"));

    return wrapper;
  }

  function renderAutoSplitNotice() {
    const box = el("div", "rech-auto-split-note");
    box.appendChild(termWithHelp("複数部屋の分割は自動", "同じ1物件のまとまりの中に賃料や間取りが複数ある場合、値選択で指定した場所をもとに1部屋ごとへ分けて取得します。通常は手で設定しません。", "strong"));
    box.appendChild(el("span", "", "同じ1物件のまとまり内に賃料や間取りが複数ある場合は、入力した値の場所から1部屋ごとに分けて取得します。通常は1物件のまとまりとコピー項目だけ設定します。"));
    return box;
  }

  function renderSelectorCandidatePanel(config, onApply) {
    const details = el("details", "rech-candidate-panel");
    details.appendChild(el("summary", "", "候補セレクタ自動提案"));
    details.appendChild(helpText("ページ内のHTMLを見て、使えそうなCSS候補を出します。候補は完全ではないので、適用後に「現在の取得結果」で確認してください。"));
    const actions = el("div", "rech-candidate-actions");
    const status = el("span", "rech-candidate-status", "未生成");
    const body = el("div", "rech-candidate-body");
    const refresh = () => {
      body.innerHTML = "";
      const groups = buildSelectorCandidateGroups(config);
      let total = 0;
      groups.forEach((group) => {
        total += group.candidates.length;
        body.appendChild(renderSelectorCandidateGroup(group, config, onApply, refresh));
      });
      status.textContent = total ? `${total}件の候補` : "候補なし";
    };
    actions.appendChild(button("候補を探す", "rech-secondary", refresh));
    actions.appendChild(status);
    details.addEventListener("toggle", () => {
      if (details.open && !body.childElementCount) refresh();
    });
    details.appendChild(actions);
    details.appendChild(body);
    return details;
  }

  function renderSelectorCandidateGroup(group, config, onApply, refresh) {
    const wrapper = el("div", "rech-candidate-group");
    wrapper.appendChild(el("strong", "", group.title));
    if (!group.candidates.length) {
      wrapper.appendChild(el("small", "", "候補なし"));
      return wrapper;
    }
    group.candidates.slice(0, group.limit || 6).forEach((candidate) => {
      const row = el("div", "rech-candidate-row");
      const main = button(candidate.selector, "rech-candidate-selector", () => {
        applySelectorCandidate(config, candidate);
        onApply();
        markSettingsDirty();
        refresh();
      });
      main.title = candidate.example || candidate.selector;
      row.appendChild(main);
      row.appendChild(el("small", "", getSelectorCandidateMeta(candidate)));
      wrapper.appendChild(row);
    });
    return wrapper;
  }

  function getSelectorCandidateMeta(candidate) {
    const parts = [];
    if (candidate.fieldKey) parts.push(getListingFieldLabel(candidate.fieldKey));
    if (candidate.scope) parts.push(getListingScopeLabel(candidate.scope));
    if (Number.isFinite(candidate.count)) parts.push(`${candidate.count}件`);
    if (candidate.lineMode) parts.push(getLineModeLabel(candidate.lineMode));
    if (candidate.regex) parts.push("正規表現あり");
    if (candidate.example) parts.push(`例: ${truncateText(candidate.example, 50).replace(/\n/g, " ")}`);
    return parts.join(" / ");
  }

  function getLineModeLabel(value) {
    const option = getLineExtractionOptions().find(([key]) => key === value);
    return option ? option[1] : value;
  }

  function applySelectorCandidate(config, candidate) {
    if (!candidate || !candidate.selector) return;
    if (candidate.kind === "item") {
      config.itemSelector = candidate.selector;
      return;
    }
    if (candidate.kind === "row") {
      config.rowSelector = candidate.selector;
      return;
    }
    if (candidate.kind !== "field" || !candidate.fieldKey) return;
    const field = ensureListingField(config, candidate.fieldKey, getListingFieldLabel(candidate.fieldKey));
    const selectorRule = ensurePrimaryListingRule(field, "selector");
    const regexRule = ensurePrimaryListingRule(field, "regex");
    selectorRule.scope = candidate.scope || getDefaultListingScope(candidate.fieldKey, config);
    selectorRule.selector = candidate.selector;
    selectorRule.attribute = "text";
    selectorRule.lineMode = candidate.lineMode || "";
    selectorRule.normalizer = candidate.normalizer || getDefaultListingNormalizer(candidate.fieldKey);
    regexRule.scope = toListingTextScope(selectorRule.scope);
    regexRule.normalizer = selectorRule.normalizer;
    regexRule.group = 1;
    regexRule.pattern = candidate.regex || "";
    regexRule.regex = candidate.regex || "";
    syncListingRegexToSelectorRule(selectorRule, regexRule);
  }

  function buildSelectorCandidateGroups(config) {
    const fieldCandidates = getListingFieldIds().flatMap(({ key }) => {
      return suggestListingFieldSelectors(key, config).slice(0, 3);
    });
    return [
      { title: "1物件のまとまり", candidates: suggestListingScopeSelectors("item", config), limit: 6 },
      { title: "1部屋のまとまり", candidates: suggestListingScopeSelectors("row", config), limit: 6 },
      { title: "コピー項目", candidates: fieldCandidates, limit: 24 },
    ];
  }

  function suggestListingScopeSelectors(kind, config) {
    const nodes = kind === "item" ? getAiItemSnippetNodes(config) : getAiRoomSnippetNodes(config);
    const map = new Map();
    nodes.slice(0, 12).forEach((node) => {
      buildCssSelectorSuggestions(node, document, { preferReusable: true }).forEach((item) => {
        const current = map.get(item.selector) || { selector: item.selector, score: 0, count: 0, example: "" };
        current.score += item.score;
        current.count = Math.max(current.count, item.count || 0);
        if (!current.example) current.example = normalizeText(node.innerText || node.textContent || "");
        map.set(item.selector, current);
      });
    });
    return Array.from(map.values())
      .map((candidate) => scoreListingScopeSelectorCandidate(candidate, kind))
      .filter(Boolean)
      .sort((a, b) => b.quality - a.quality || a.score - b.score)
      .slice(0, 8);
  }

  function scoreListingScopeSelectorCandidate(candidate, kind) {
    if (!candidate || !candidate.selector || !isSelectorValidForPreview(candidate.selector)) return null;
    const matches = safeQuerySelectorAll(document, candidate.selector)
      .filter((node) => node && !(node.closest && node.closest(`#${APP_ID}, #${APP_ID}-modal`)));
    if (!matches.length || matches.length > 500) return null;
    const useful = matches.filter((node) => kind === "item" ? isLikelyItemCandidate(node) : isUsefulAiRoomCandidate(node));
    if (!useful.length) return null;
    const quality = useful.length * 2 - Math.abs(matches.length - useful.length) - (candidate.selector.includes(":nth-of-type") ? 4 : 0);
    return {
      kind,
      selector: candidate.selector,
      count: matches.length,
      example: normalizeText((useful[0] || matches[0]).innerText || (useful[0] || matches[0]).textContent || ""),
      score: candidate.score,
      quality,
    };
  }

  function isLikelyItemCandidate(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const text = normalizeText(node.innerText || node.textContent || "");
    if (text.length < 20 || text.length > 7000) return false;
    if (!hasRoomLikeText(text)) return false;
    return Boolean(node.querySelector && node.querySelector("a, h1, h2, h3, table, dl, ul, ol"));
  }

  function suggestListingFieldSelectors(fieldKey, config) {
    const scope = getDefaultListingScope(fieldKey, config);
    const contexts = getListingPreviewContexts(config).slice(0, 20);
    const selectors = new Map();
    contexts.slice(0, 6).forEach((context) => {
      const root = getConfiguredScope(scope, context);
      findFieldCandidateNodes(fieldKey, root).slice(0, 10).forEach((node) => {
        buildCssSelectorSuggestions(node, root, { preferReusable: true }).forEach((item) => {
          const current = selectors.get(item.selector) || { selector: item.selector, score: 0 };
          current.score += item.score;
          selectors.set(item.selector, current);
        });
      });
    });
    return Array.from(selectors.values())
      .map((candidate) => evaluateFieldSelectorCandidate(fieldKey, candidate.selector, scope, contexts, config, candidate.score))
      .filter(Boolean)
      .sort((a, b) => b.quality - a.quality || a.score - b.score)
      .slice(0, 6);
  }

  function findFieldCandidateNodes(fieldKey, scope) {
    if (!scope || !scope.querySelectorAll) return [];
    const selector = fieldKey === "buildingName"
      ? "h1, h2, h3, a, strong, span, div"
      : "td, th, dd, dt, li, span, div, p, strong, em, a";
    return dedupeNodes([scope, ...Array.from(scope.querySelectorAll(selector))])
      .filter((node) => getFieldCandidateNodeScore(fieldKey, node) > 0)
      .sort((a, b) => getFieldCandidateNodeScore(fieldKey, b) - getFieldCandidateNodeScore(fieldKey, a));
  }

  function getFieldCandidateNodeScore(fieldKey, node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return 0;
    if (node.closest && node.closest(`#${APP_ID}, #${APP_ID}-modal`)) return 0;
    const text = normalizeText(node.innerText || node.textContent || "");
    const normalized = normalizeNumberText(text);
    if (!text || text.length > (fieldKey === "buildingName" ? 160 : 500)) return 0;
    if (fieldKey === "buildingName") return /[0-9,.]+\s*万|m²|m2|㎡|敷|礼|管理費|共益費/.test(normalized) ? 0 : (node.matches("h1,h2,h3,a") ? 8 : 2);
    if (fieldKey === "rent") return extractRentFromText(normalized) ? 10 : 0;
    if (fieldKey === "managementFee") return extractManagementFeeFromText(normalized, "") || /管理費|共益費|[0-9,]+\s*円/.test(normalized) ? 8 : 0;
    if (fieldKey === "deposit") return /敷(?:金)?\s*[:：]?\s*(?:[0-9]|なし|無し|無料|不要|-|－)/.test(normalized) ? 9 : 0;
    if (fieldKey === "keyMoney") return /礼(?:金)?\s*[:：]?\s*(?:[0-9]|なし|無し|無料|不要|-|－)/.test(normalized) ? 9 : 0;
    if (fieldKey === "availableDate") return /即入居|入居|空予定|退去|相談|[0-9]{1,2}\s*月/.test(normalized) ? 6 : 0;
    if (fieldKey === "ad") return /\bAD\b|広告料|広告費|広告\s*[:：]?\s*[0-9あり有なし無し無無料相談]/i.test(normalized) ? 8 : 0;
    if (fieldKey === "layout") return extractLayoutFromText(normalized) ? 10 : 0;
    if (fieldKey === "area") return extractAreaFromText(normalized) ? 10 : 0;
    if (fieldKey === "room") return /[0-9]+\s*(?:号室|階)|[A-Z0-9_-]+\s*号室/i.test(normalized) ? 7 : 0;
    return 0;
  }

  function evaluateFieldSelectorCandidate(fieldKey, selector, scope, contexts, config, score) {
    if (!selector || !isSelectorValidForPreview(selector)) return null;
    const values = [];
    let matchCount = 0;
    let rawExample = "";
    let lineMode = "";
    const normalizer = getDefaultListingNormalizer(fieldKey);
    contexts.forEach((context) => {
      const root = getConfiguredScope(scope, context);
      const nodes = safeQuerySelectorAllIncludingSelf(root, selector);
      matchCount += nodes.length;
      const node = nodes[0];
      if (!node) return;
      const raw = getConfiguredNodeTextWithBreaks(node, config);
      if (!rawExample) rawExample = raw;
      const mode = lineMode || suggestLineModeForFieldCandidate(fieldKey, raw);
      const normalized = normalizeConfiguredValue(applyConfiguredLineMode(raw, mode), normalizer, fieldKey);
      if (normalized) {
        values.push(normalized);
        if (!lineMode) lineMode = mode;
      }
    });
    const uniqueValues = Array.from(new Set(values));
    if (!matchCount || !uniqueValues.length) return null;
    const regex = suggestRegexForFieldCandidate(fieldKey, rawExample);
    return {
      kind: "field",
      fieldKey,
      selector,
      scope,
      lineMode,
      normalizer,
      regex,
      count: matchCount,
      example: uniqueValues.slice(0, 3).join(" / "),
      score: score || selector.length,
      quality: uniqueValues.length * 3 + Math.min(matchCount, 30) - (selector.includes(":nth-of-type") ? 4 : 0),
    };
  }

  function suggestLineModeForFieldCandidate(fieldKey, raw) {
    const text = normalizeNumberText(raw);
    if (!/\n/.test(String(raw || ""))) {
      if (fieldKey === "rent" && /[0-9.]+\s*万/.test(text)) return "lineWithManYen";
      if (fieldKey === "managementFee" && /[0-9.]+\s*万/.test(text) && /[0-9,]+\s*円/.test(text)) return "lineWithoutManYen";
      return "";
    }
    if (fieldKey === "rent") return "lineWithManYen";
    if (fieldKey === "managementFee") return "lineWithoutManYen";
    if (fieldKey === "layout" && extractLayoutFromText(text) && extractAreaFromText(text)) return "firstLine";
    if (fieldKey === "area" && extractLayoutFromText(text) && extractAreaFromText(text)) return "secondLine";
    return "";
  }

  function suggestRegexForFieldCandidate(fieldKey, raw) {
    const text = normalizeNumberText(raw);
    if (fieldKey === "rent" && /[0-9.]+\s*万/.test(text)) return "([0-9０-９]+(?:\\.[0-9０-９]+)?\\s*万(?:円)?)";
    if (fieldKey === "managementFee" && /管理費|共益費/.test(text)) return "(?:管理費等|管理費|共益費)\\s*[:：]?\\s*([0-9０-９,]+\\s*円|なし|無料|不要|0円|--|－)";
    if (fieldKey === "deposit" && /敷/.test(text)) return "敷(?:金)?\\s*[:：]?\\s*(なし|無料|不要|0円|--|－|[0-9０-９]+(?:\\.[0-9０-９]+)?\\s*(?:ヶ月|ヵ月|か月|万円|万|円))";
    if (fieldKey === "keyMoney" && /礼/.test(text)) return "礼(?:金)?\\s*[:：]?\\s*(なし|無料|不要|0円|--|－|[0-9０-９]+(?:\\.[0-9０-９]+)?\\s*(?:ヶ月|ヵ月|か月|万円|万|円))";
    return "";
  }

  function renderListingSetupGuide(config) {
    const box = el("div", "rech-setup-guide");
    box.appendChild(termWithHelp("設定の順番", "上から順に、1物件のまとまり、必要なら1部屋のまとまり、各項目の値、最後に現在の取得結果を確認します。全部を一度に設定する必要はありません。分かる項目から埋めていけば表に出ます。", "strong"));
    const list = el("ol", "");
    box.appendChild(list);
    updateListingSetupGuide(box, config);
    return box;
  }

  function updateListingSetupGuide(container, config) {
    const list = container && container.querySelector ? container.querySelector("ol") : null;
    if (!list) return;
    const itemCount = config.itemSelector ? querySelectorAllForPreview(document, config.itemSelector).length : 0;
    const itemScopes = getConfiguredItemScopes(config);
    const roomCount = itemScopes.reduce((count, item) => count + getConfiguredRowScopes(item, config).length, 0);
    const configuredFields = getConfiguredInputFieldKeys(config);
    const rows = extractConfiguredListingRows();
    list.innerHTML = "";
    [
      [`1物件のまとまり`, config.itemSelector ? `${itemCount}件一致` : "未指定。1部屋だけならページ全体で試します", itemCount > 0 || !config.itemSelector],
      [`1部屋のまとまり`, config.rowSelector ? `${roomCount}件一致` : "未指定。値選択から自動分割します", true],
      [`コピー項目`, configuredFields.length ? `${configuredFields.length}項目設定済み` : "未設定。値選択で分かる項目から入れてください", configuredFields.length > 0],
      [`テーブル確認`, rows.length ? `${rows.length}件を表示できます` : "まだ表にできる値がありません", rows.length > 0],
    ].forEach(([label, status, ok]) => {
      const item = el("li", ok ? "is-ok" : "is-warn");
      item.appendChild(el("span", "", label));
      item.appendChild(el("small", "", status));
      list.appendChild(item);
    });
  }

  function getLineExtractionOptions() {
    return [
      ["", "自動"],
      ["firstLine", "上の値"],
      ["secondLine", "下の値"],
      ["lineWithManYen", "万円を含む値"],
      ["lineWithoutManYen", "万円を含まない値"],
      ["lineWithYen", "円を含む値"],
    ];
  }

  function getRegexPresetOptions(fieldId) {
    const presets = {
      rent: [
        { label: "万円を含む金額", pattern: "([0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*万円)", group: 1 },
        { label: "円を含む金額", pattern: "([0-9０-９,，]+\\s*円)", group: 1 },
        { label: "賃料・家賃の後ろ", pattern: "(?:賃料|家賃)\\s*[:：]?\\s*([0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*万(?:円)?|[0-9０-９,，]+\\s*円)", group: 1 },
      ],
      managementFee: [
        { label: "円を含む金額", pattern: "([0-9０-９,，]+\\s*円)", group: 1 },
        { label: "万円を含む金額", pattern: "([0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*万円)", group: 1 },
        { label: "管理費・共益費の後ろ", pattern: "(?:管理費|共益費|管理費等|管理費・共益費)\\s*[:：]?\\s*([^\\s／/]+(?:\\s*円)?)", group: 1 },
        { label: "管理費等 10,000円", pattern: "管理費等\\s+([^\\s]+(?:\\s*円)?)", group: 1 },
        { label: "なし・無料・不要", pattern: "(なし|無し|無|無料|不要|-|0円)", group: 1 },
      ],
      deposit: [
        { label: "ヶ月を含む値", pattern: "([0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*(?:ヶ月|か月|ヵ月|カ月))", group: 1 },
        { label: "円を含む金額", pattern: "([0-9０-９,，]+\\s*円)", group: 1 },
        { label: "敷の後ろ", pattern: "敷(?:金)?\\s*[:：]?\\s*([^\\s]+(?:\\s*(?:ヶ月|か月|ヵ月|カ月|万円|円))?)", group: 1 },
        { label: "なし・無料・不要", pattern: "(なし|無し|無|無料|不要|0円|0ヶ月)", group: 1 },
      ],
      keyMoney: [
        { label: "ヶ月を含む値", pattern: "([0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*(?:ヶ月|か月|ヵ月|カ月))", group: 1 },
        { label: "円を含む金額", pattern: "([0-9０-９,，]+\\s*円)", group: 1 },
        { label: "礼の後ろ", pattern: "礼(?:金)?\\s*[:：]?\\s*([^\\s]+(?:\\s*(?:ヶ月|か月|ヵ月|カ月|万円|円))?)", group: 1 },
        { label: "なし・無料・不要", pattern: "(なし|無し|無|無料|不要|0円|0ヶ月)", group: 1 },
      ],
      room: [
        { label: "階だけ", pattern: "([0-9０-９]+\\s*階)", group: 1 },
        { label: "号室だけ", pattern: "([0-9０-９]+\\s*号室?)", group: 1 },
        { label: "先頭の階/号室", pattern: "^\\s*([^\\s]+(?:階|号室?)?)", group: 1 },
        { label: "画像枚数の後ろの階", pattern: "画像：\\d+枚\\s+([^\\s]+階)", group: 1 },
      ],
      moveInDate: [
        { label: "即入居系", pattern: "(即入居可|即入居|即時入居可|すぐ入居可)", group: 1 },
        { label: "年月日", pattern: "([0-9０-９]{4}\\s*年\\s*[0-9０-９]{1,2}\\s*月\\s*[0-9０-９]{1,2}\\s*日?)", group: 1 },
        { label: "月上旬・中旬・下旬", pattern: "([0-9０-９]{1,2}\\s*月\\s*(?:上旬|中旬|下旬|末|予定)?)", group: 1 },
        { label: "相談", pattern: "(相談)", group: 1 },
      ],
      availableDate: [
        { label: "即入居系", pattern: "(即入居可|即入居|即時入居可|すぐ入居可)", group: 1 },
        { label: "年月日", pattern: "([0-9０-９]{4}\\s*年\\s*[0-9０-９]{1,2}\\s*月\\s*[0-9０-９]{1,2}\\s*日?)", group: 1 },
        { label: "月上旬・中旬・下旬", pattern: "([0-9０-９]{1,2}\\s*月\\s*(?:上旬|中旬|下旬|末|予定)?)", group: 1 },
        { label: "相談", pattern: "(相談)", group: 1 },
      ],
      ad: [
        { label: "AD表記", pattern: "(AD\\s*[:：]?\\s*[0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*(?:ヶ月|か月|ヵ月|カ月|％|%|万円)?)", group: 1, flags: "i" },
        { label: "広告料表記", pattern: "((?:広告料|広告費)\\s*[:：]?\\s*[0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*(?:ヶ月|か月|ヵ月|カ月|％|%|万円)?)", group: 1 },
        { label: "あり・なし", pattern: "(あり|有|なし|無し|無|相談)", group: 1 },
      ],
      layout: [
        { label: "間取りだけ", pattern: "([0-9０-９]+\\s*(?:SLDK|LDK|SDK|DK|SK|K|R)|ワンルーム)", group: 1, flags: "i" },
      ],
      area: [
        { label: "㎡がある面積", pattern: "([0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*(?:㎡|m2|m²|平米))", group: 1, flags: "i" },
        { label: "専有面積の後ろ", pattern: "(?:専有面積|面積)\\s*[:：]?\\s*([0-9０-９]+(?:[.,．][0-9０-９]+)?\\s*(?:㎡|m2|m²|平米))", group: 1, flags: "i" },
      ],
    };
    const common = [
      { label: "数字だけ", pattern: "([0-9０-９]+(?:[.,．][0-9０-９]+)?)", group: 1 },
      { label: "空欄に戻す", pattern: "", group: 1 },
    ];
    return [...(presets[fieldId] || []), ...common];
  }

  function renderRegexPresetSelect(fieldId, onSelect, compact) {
    const options = getRegexPresetOptions(fieldId);
    const select = document.createElement("select");
    select.className = compact ? "rech-regex-preset is-compact" : "rech-regex-preset";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "正規表現候補を選ぶ";
    select.appendChild(placeholder);
    options.forEach((preset, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = preset.label;
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      const preset = options[Number(select.value)];
      if (!preset) return;
      onSelect(preset);
      select.value = "";
    });
    return select;
  }

  function renderListingQuickEditor(config, onChange) {
    const wrapper = el("div", "rech-listing-editor");
    let itemSelectorProbe;
    let roomSelectorProbe;
    let setupGuide;
    let resultStatus;
    let resultTableWrap;
    let formatPreviewBody;
    const refreshAllPreviews = () => {
      syncListingEditorControls(wrapper, config);
      if (setupGuide) updateListingSetupGuide(setupGuide, config);
      if (itemSelectorProbe) refreshListingItemSelectorPreview(itemSelectorProbe, config.itemSelector);
      if (roomSelectorProbe) refreshListingRoomSelectorPreview(roomSelectorProbe, config);
      wrapper.querySelectorAll("[data-preview-cell='true']").forEach((cell) => {
        if (typeof cell.refreshPreview === "function") cell.refreshPreview();
      });
      refreshListingResultPreview(resultStatus, resultTableWrap);
      refreshListingFormatPreview(formatPreviewBody, config);
    };
    wrapper.refreshListingEditor = refreshAllPreviews;

    setupGuide = renderListingSetupGuide(config);
    wrapper.appendChild(setupGuide);

    const resultPanel = el("div", "rech-live-preview");
    const resultHeader = el("div", "rech-live-preview-header");
    resultHeader.appendChild(el("strong", "", "現在の取得結果"));
    resultStatus = el("span", "rech-live-preview-status");
    resultHeader.appendChild(resultStatus);
    resultTableWrap = el("div", "rech-live-preview-table");
    resultPanel.appendChild(resultHeader);
    resultPanel.appendChild(resultTableWrap);
    wrapper.appendChild(resultPanel);
    const formatPreviewPanel = renderListingFormatPreviewPanel(config);
    formatPreviewBody = formatPreviewPanel.querySelector(".rech-format-preview-body");
    wrapper.appendChild(formatPreviewPanel);

    const scopeGrid = el("div", "rech-selector-grid");
    const itemSelectorControl = compactInputWithAction("1物件のまとまり", config.itemSelector || "", (value) => {
      config.itemSelector = value.trim();
      onChange();
      refreshAllPreviews();
    }, "例 .property-card / li.result-item", "まとまり選択", (control) => {
      startListingSelectorPicker({
        kind: "item",
        label: "1物件のまとまり",
        config,
        onChange,
        onPicked: (selector, suggestions) => {
          control.setValue(selector);
          control.setSuggestions(suggestions);
          refreshAllPreviews();
        },
      });
    }, "検索結果に並んでいる1物件分の外枠です。物件名、画像、賃料、部屋情報などを含むまとまりをクリックします。1部屋しかないページなら空欄でも試します。");
    itemSelectorControl.dataset.listingScopeControl = "item";
    itemSelectorProbe = el("small", "rech-selector-preview");
    itemSelectorControl.appendChild(itemSelectorProbe);
    refreshListingItemSelectorPreview(itemSelectorProbe, config.itemSelector);
    scopeGrid.appendChild(itemSelectorControl);

    const roomSelectorControl = compactInputWithAction("1部屋のまとまり", config.rowSelector || "", (value) => {
      config.rowSelector = value.trim();
      onChange();
      refreshAllPreviews();
    }, "複数部屋が分かれる枠。1部屋だけなら空欄可", "部屋選択", (control) => {
      startListingSelectorPicker({
        kind: "row",
        label: "1部屋のまとまり",
        config,
        onChange,
        onPicked: (selector, suggestions) => {
          control.setValue(selector);
          control.setSuggestions(suggestions);
          refreshAllPreviews();
        },
      });
    }, "同じ物件の中に複数の部屋や部屋条件が並ぶときだけ指定します。1部屋だけ、または値選択で自動分割できる場合は空欄で構いません。");
    roomSelectorControl.dataset.listingScopeControl = "row";
    roomSelectorProbe = el("small", "rech-selector-preview");
    roomSelectorControl.appendChild(roomSelectorProbe);
    refreshListingRoomSelectorPreview(roomSelectorProbe, config);
    scopeGrid.appendChild(roomSelectorControl);

    scopeGrid.appendChild(renderAutoSplitNotice());
    scopeGrid.appendChild(compactSegmentedControl("既定の探す場所", config.scopeMode || "mixed", [
      ["mixed", "自動"],
      ["item", "1物件内"],
      ["row", "1部屋内"],
      ["document", "ページ全体"],
    ], (value) => {
      config.scopeMode = value || "mixed";
      onChange();
      refreshAllPreviews();
    }, "迷ったら自動のままで構いません。物件名は1物件内、賃料や間取りは1部屋内、どうしても外にある値だけページ全体を使います。"));
    wrapper.appendChild(scopeGrid);

    const sourcePanel = renderBodySourcePanel();
    sourcePanel.hidden = true;
    const denseActions = el("div", "rech-mini-actions");
    const sourceToggle = button("HTMLを表示", "rech-secondary", () => {
      const nextVisible = sourcePanel.hidden;
      sourcePanel.hidden = !nextVisible;
      sourceToggle.textContent = nextVisible ? "HTMLを隠す" : "HTMLを表示";
      if (nextVisible) updateBodySourcePanel(sourcePanel);
    });
    denseActions.appendChild(sourceToggle);
    denseActions.appendChild(button("取得場所を強調", "rech-secondary", () => highlightConfiguredListingMatches(config)));
    const regexToggle = button("正規表現を表示", "rech-secondary", () => {
      const visible = wrapper.classList.toggle("show-regex");
      regexToggle.textContent = visible ? "正規表現を隠す" : "正規表現を表示";
    });
    denseActions.appendChild(regexToggle);
    wrapper.appendChild(denseActions);
    wrapper.appendChild(renderSelectorCandidatePanel(config, () => {
      onChange();
      refreshAllPreviews();
    }));
    wrapper.appendChild(renderAiSelectorAssistant(config, () => {
      onChange();
      markSettingsDirty("未保存");
      refreshAllPreviews();
    }));
    wrapper.appendChild(sourcePanel);

    const table = el("table", "rech-field-map");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    [
      ["項目", "", "コピーする列です。不要な列は値を設定しなければ空欄のまま出ます。"],
      ["探す場所", "", "その値をどこから探すかです。迷ったら自動。物件名は1物件内、賃料や間取りは1部屋内が基本です。"],
      ["値のCSS", "", "値選択で自動入力される場所情報です。普段は手入力しません。"],
      ["値の取り方", "", "同じセルに複数の値があるときの取り方です。例: 賃料と管理費が同じセルなら、管理費は「万円を含まない値」や「下の値」を使います。"],
      ["整形", "", "取得した値をコピー用にそろえる方法です。例: 10万円、100,000、100000円 を 100,000円 にそろえます。"],
      ["正規表現", "regex-col", "値から一部だけ切り出す上級設定です。通常は使いません。"],
    ].forEach(([label, className, help]) => {
      const th = el("th", className);
      th.appendChild(termWithHelp(label, help));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    getListingFieldIds().forEach(({ key, label }) => {
      const field = ensureListingField(config, key, label);
      const selectorRule = ensurePrimaryListingRule(field, "selector");
      const regexRule = ensurePrimaryListingRule(field, "regex");
      if (isRoomScopedListingField(key) && config.rowSelector && selectorRule.scope === "item") {
        selectorRule.scope = "row";
        regexRule.scope = "rowText";
      }
      syncListingRegexToSelectorRule(selectorRule, regexRule);
      const row = document.createElement("tr");
      row.dataset.listingField = key;
      let selectorCell;
      const refreshPreview = () => {
        if (selectorCell && typeof selectorCell.refreshPreview === "function") selectorCell.refreshPreview();
      };
      row.appendChild(el("th", "", label));
      const scopeCell = compactCellSelect(selectorRule.scope || "", [
        ["", "自動"],
        ["item", "1物件内"],
        ["row", "1部屋内"],
        ["document", "ページ全体"],
      ], (value) => {
        const scope = value.trim();
        selectorRule.scope = scope;
        regexRule.scope = scope ? toListingTextScope(scope) : "";
        onChange();
        refreshAllPreviews();
      });
      scopeCell.dataset.listingControl = "scope";
      row.appendChild(scopeCell);
      selectorCell = compactSelectorCellInput(selectorRule.selector || "", (value) => {
        selectorRule.selector = value.trim();
        selectorRule.attribute = selectorRule.attribute || "text";
        selectorRule.normalizer = selectorRule.normalizer || getDefaultListingNormalizer(key);
        onChange();
        refreshAllPreviews();
      }, "空欄可", (control) => {
        startListingSelectorPicker({
          kind: "field",
          label,
          fieldKey: key,
          selectorRule,
          regexRule,
          config,
          onChange,
          onPicked: (selector, suggestions) => {
            control.setValue(selector);
            control.setSuggestions(suggestions);
            refreshAllPreviews();
          },
        });
      }, { fieldKey: key, field, config });
      selectorCell.dataset.listingControl = "selector";
      row.appendChild(selectorCell);
      const lineModeCell = compactCellSelect(selectorRule.lineMode || "", getLineExtractionOptions(), (value) => {
        selectorRule.lineMode = value.trim();
        onChange();
        refreshAllPreviews();
      });
      lineModeCell.dataset.listingControl = "lineMode";
      row.appendChild(lineModeCell);
      const normalizerCell = compactCellSelect(selectorRule.normalizer || getDefaultListingNormalizer(key), getNormalizerOptions(key), (value) => {
        const normalizer = value.trim() || "text";
        selectorRule.normalizer = normalizer;
        regexRule.normalizer = normalizer;
        onChange();
        refreshAllPreviews();
      });
      normalizerCell.dataset.listingControl = "normalizer";
      row.appendChild(normalizerCell);
      const applyRegexValue = (value) => {
        regexRule.type = "regex";
        regexRule.pattern = value;
        regexRule.group = regexRule.group || 1;
        regexRule.normalizer = regexRule.normalizer || getDefaultListingNormalizer(key);
        syncListingRegexToSelectorRule(selectorRule, regexRule);
        onChange();
        refreshAllPreviews();
      };
      const regexCell = compactCellInput(regexRule.pattern || regexRule.regex || "", applyRegexValue, "必要な時だけ");
      regexCell.appendChild(renderRegexPresetSelect(key, (preset) => {
        const input = regexCell.querySelector("input");
        regexRule.type = "regex";
        regexRule.pattern = preset.pattern;
        regexRule.regex = preset.pattern;
        regexRule.group = preset.group || 1;
        regexRule.flags = preset.flags || "";
        regexRule.normalizer = regexRule.normalizer || getDefaultListingNormalizer(key);
        syncListingRegexToSelectorRule(selectorRule, regexRule);
        if (input) input.value = preset.pattern;
        onChange();
        refreshAllPreviews();
        markSettingsDirty();
      }, true));
      regexCell.classList.add("regex-col");
      regexCell.dataset.listingControl = "regex";
      row.appendChild(regexCell);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    const tableHeader = el("div", "rech-field-map-title");
    tableHeader.appendChild(el("strong", "", "取る項目"));
    tableHeader.appendChild(el("span", "", "値選択で画面上の値をクリック。分かるものから表に入ります"));
    const tableWrap = el("div", "rech-field-map-wrap");
    wrapper.appendChild(tableHeader);
    tableWrap.appendChild(table);
    wrapper.appendChild(tableWrap);

    refreshAllPreviews();
    return wrapper;
  }

  function syncListingEditorControls(root, config) {
    if (!root || !root.querySelector || !config) return;
    const itemInput = root.querySelector("[data-listing-scope-control='item'] input");
    if (itemInput && itemInput.value !== (config.itemSelector || "")) itemInput.value = config.itemSelector || "";
    const rowInput = root.querySelector("[data-listing-scope-control='row'] input");
    if (rowInput && rowInput.value !== (config.rowSelector || "")) rowInput.value = config.rowSelector || "";
    root.querySelectorAll("[data-listing-field]").forEach((row) => {
      const key = row.dataset.listingField;
      const field = config.fields && config.fields[key];
      if (!field) return;
      const selectorRule = getListingFieldRule(field, "selector") || {};
      const regexRule = getListingFieldRule(field, "regex") || {};
      setListingControlValue(row, "scope", selectorRule.scope || "");
      setListingControlValue(row, "selector", selectorRule.selector || "");
      setListingControlValue(row, "lineMode", selectorRule.lineMode || "");
      setListingControlValue(row, "normalizer", selectorRule.normalizer || getDefaultListingNormalizer(key));
      setListingControlValue(row, "regex", regexRule.pattern || regexRule.regex || "");
    });
  }

  function setListingControlValue(row, controlName, value) {
    const control = row.querySelector(`[data-listing-control='${controlName}']`);
    const input = control && control.querySelector ? control.querySelector("input, select") : null;
    if (input && input.value !== (value || "")) input.value = value || "";
  }

  function renderListingFormatPreviewPanel(config) {
    const details = el("details", "rech-format-preview");
    details.appendChild(el("summary", "", "整形プレビュー"));
    details.appendChild(helpText("取得した元値がコピー用にどう整形されるかを確認します。賃料、管理費、敷金、礼金、間取り、面積の確認に使います。"));
    const body = el("div", "rech-format-preview-body");
    details.appendChild(body);
    refreshListingFormatPreview(body, config);
    return details;
  }

  function refreshListingFormatPreview(container, config) {
    if (!container) return;
    const rows = buildListingFormatPreviewRows(config).slice(0, 20);
    container.innerHTML = "";
    if (!rows.length) {
      container.appendChild(el("div", "rech-empty", "整形プレビューできる設定済み項目がありません"));
      return;
    }
    const table = el("table", "rech-format-preview-table");
    const thead = document.createElement("thead");
    const head = document.createElement("tr");
    ["項目", "取得値", "整形後"].forEach((label) => head.appendChild(el("th", "", label)));
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.appendChild(el("td", "", row.label));
      tr.appendChild(el("td", "", row.raw));
      tr.appendChild(el("td", "", row.normalized));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function buildListingFormatPreviewRows(config) {
    const contexts = getListingPreviewContexts(config).slice(0, 8);
    const rows = [];
    getListingFieldIds().forEach(({ key, label }) => {
      const field = config.fields && config.fields[key];
      if (!hasConfiguredFieldInput(field)) return;
      contexts.forEach((context) => {
        const preview = getConfiguredFieldFormatPreview(key, field, context, config);
        if (preview && preview.raw) {
          rows.push({
            label,
            raw: preview.raw,
            normalized: preview.normalized || "空",
          });
        }
      });
    });
    return rows;
  }

  function getConfiguredFieldFormatPreview(fieldId, field, context, config) {
    const selectorRule = getListingFieldRule(field, "selector");
    const regexRule = getListingFieldRule(field, "regex");
    const rule = selectorRule && selectorRule.selector ? selectorRule : regexRule;
    if (!rule) return null;
    const normalizer = rule.normalizer || field.normalizer || getDefaultListingNormalizer(fieldId);
    let raw = "";
    if (rule.type === "selector" || rule.selector) {
      if (!isSelectorValidForPreview(rule.selector)) return null;
      const scope = getConfiguredScope(getConfiguredRuleScope(fieldId, rule, config), context);
      const node = safeQuerySelectorIncludingSelf(scope, rule.selector) || findIndexedRoomFieldNode(fieldId, rule, context);
      if (!node) return null;
      raw = readConfiguredAttribute(node, rule.attribute || "text", config, { ...rule, lineMode: "" });
    } else {
      raw = getConfiguredScopeText(toListingTextScope(getConfiguredRuleScope(fieldId, rule, config)), context);
    }
    const cut = applyRuleRegex(applyConfiguredLineMode(raw, rule.lineMode), rule);
    let normalized = normalizeConfiguredValue(cut, normalizer, fieldId);
    if ((fieldId === "deposit" || fieldId === "keyMoney") && normalizer === "rentMonth") {
      const rentField = config.fields && config.fields.rent;
      const rentValue = rentField ? extractConfiguredField("rent", rentField, context, {}) : "";
      normalized = normalizeLeaseCostByRent(cut, rentValue, normalizer);
    }
    return {
      raw: truncateText(normalizeText(raw), 80).replace(/\n/g, " "),
      normalized,
    };
  }

  function renderAiSelectorAssistant(config, onApplied) {
    const details = el("details", "rech-ai-assistant");
    details.appendChild(el("summary", "", "AIと表を完成させる"));
    details.appendChild(helpText("全体を見る、部分を決める、必要な形に整形する、という順番でAI回答JSONを検証しながら表を完成させます。"));
    details.appendChild(renderAiSelectorUsageGuide());
    let selectedSourceNode = null;
    let pendingAiConfig = null;
    let pendingAiReport = null;
    let aiRound = 0;
    const sessionPanel = renderAiSessionPanel();
    const sourceControl = renderAiHtmlSourceControl(config, (node) => {
      selectedSourceNode = node;
    });
    const promptArea = document.createElement("textarea");
    promptArea.className = "rech-ai-textarea";
    promptArea.readOnly = true;
    promptArea.placeholder = "1. 「AI用情報をコピー」を押すと、AIへ貼る内容がここに表示されます";
    const responseArea = document.createElement("textarea");
    responseArea.className = "rech-ai-textarea";
    responseArea.placeholder = "AIが返したJSON全体をここに貼り付けます";
    const userReviewNote = document.createElement("textarea");
    userReviewNote.className = "rech-ai-textarea rech-ai-note-textarea";
    userReviewNote.placeholder = "AIへ返すメモ。例: 賃料と管理費は正しい。号室だけ階数を拾っている。ADは未記載でよい。";
    const retryPromptArea = document.createElement("textarea");
    retryPromptArea.className = "rech-ai-textarea rech-ai-retry-textarea";
    retryPromptArea.readOnly = true;
    retryPromptArea.placeholder = "修正依頼を作成すると、次にAIへ貼る内容がここに表示されます";
    const reviewPanel = el("div", "rech-ai-review");
    const promptActions = el("div", "rech-ai-actions");
    promptActions.appendChild(button("AI用情報をコピー", "rech-secondary", async () => {
      try {
        if (sourceControl && typeof sourceControl.refreshAiSourceStatus === "function") {
          sourceControl.refreshAiSourceStatus();
        }
        const prompt = buildAiSelectorPrompt(config, {
          htmlScopeMode: getAiHtmlScopeMode(sourceControl),
          selectedNode: selectedSourceNode,
        });
        promptArea.value = prompt;
        await copyToClipboard(prompt);
        updateAiSessionPanel(sessionPanel, {
          round: aiRound,
          state: "AIへ初回依頼を送る準備ができました",
          next: getAiSourceSessionNextText(sourceControl) || "コピーした内容をAIに貼り、返ってきたJSONを下に貼ってください。",
        });
        appendAiAssistantLog("initial_prompt_copy", prompt, null, {
          htmlScopeMode: getAiHtmlScopeMode(sourceControl),
        });
        showToast("AI用情報をコピーしました", "success");
      } catch (error) {
        console.warn("[RealEstateCopyHelper] AI用情報のコピーに失敗しました", error);
        showToast("AI用情報のコピーに失敗しました", "error");
      }
    }));
    const applyButton = button("仮設定を採用", "rech-primary", () => {
      if (!pendingAiConfig) {
        showToast("先に検証して仮プレビューしてください", "error");
        return;
      }
      replaceListingExtractorConfig(config, pendingAiConfig);
      appendAiAssistantLog("adopt", responseArea.value, pendingAiReport, {
        note: "ユーザーが仮設定を採用",
        userReviewNote: userReviewNote.value,
      });
      pendingAiConfig = null;
      pendingAiReport = null;
      renderAiReviewPanel(reviewPanel, null);
      setAiActionSoftDisabled(applyButton, true);
      setAiActionSoftDisabled(retryButton, true);
      updateAiSessionPanel(sessionPanel, {
        round: aiRound,
        state: "仮設定を採用しました",
        next: "保存後、実際のテーブルで欠けやズレがないか確認してください。",
      });
      onApplied();
      showToast("仮設定を採用しました", "success");
    });
    setAiActionSoftDisabled(applyButton, true);
    const retryButton = button("修正依頼をコピー", "rech-secondary", async () => {
      if (!pendingAiReport) {
        showToast("先に検証して仮プレビューしてください", "error");
        return;
      }
      try {
        const retryPrompt = buildAiSelectorRetryPrompt(pendingAiReport, responseArea.value, {
          round: aiRound,
          userReviewNote: userReviewNote.value,
        });
        retryPromptArea.value = retryPrompt;
        await copyToClipboard(retryPrompt);
        appendAiAssistantLog("retry_copy", responseArea.value, pendingAiReport, {
          retryPrompt: truncateText(retryPrompt, 60000),
          userReviewNote: userReviewNote.value,
          round: aiRound,
        });
        updateAiSessionPanel(sessionPanel, {
          round: aiRound,
          state: "次の修正依頼をコピーしました",
          next: "AIの返答JSONをもう一度貼り、仮プレビューで差分を確認してください。",
        });
        showToast("修正依頼をコピーしました", "success");
      } catch (error) {
        console.warn("[RealEstateCopyHelper] AI修正依頼のコピーに失敗しました", error);
        showToast("修正依頼のコピーに失敗しました", "error");
      }
    });
    setAiActionSoftDisabled(retryButton, true);
    const previewActions = el("div", "rech-ai-actions");
    previewActions.appendChild(button("検証して仮プレビュー", "rech-primary", () => {
      try {
        aiRound += 1;
        const parsed = parseAiSelectorResponse(responseArea.value);
        const draft = clonePlain(config);
        const result = applyAiListingResponse(draft, parsed, { collectReport: true });
        if (!result.applied) {
          pendingAiConfig = null;
          pendingAiReport = result.report;
          pendingAiReport.aiRound = aiRound;
          renderAiReviewPanel(reviewPanel, result.report);
          setAiActionSoftDisabled(applyButton, true);
          setAiActionSoftDisabled(retryButton, false);
          appendAiAssistantLog("preview_no_rules", responseArea.value, result.report, { round: aiRound });
          updateAiSessionPanel(sessionPanel, {
            round: aiRound,
            state: "AI回答を検証しましたが、反映できる設定がありません",
            next: "JSONの形かキー名が違います。修正依頼をコピーしてAIへ戻してください。",
          });
          showToast("反映できる設定が見つかりませんでした", "error");
          return;
        }
        pendingAiConfig = draft;
        pendingAiReport = validateAiListingDraft(draft, result.report);
        pendingAiReport.aiRound = aiRound;
        pendingAiReport.configDiffs = buildListingConfigDiffSummary(config, draft);
        addAdoptionRiskWarnings(config, draft, pendingAiReport);
        renderAiReviewPanel(reviewPanel, pendingAiReport);
        setAiActionSoftDisabled(applyButton, false);
        setAiActionSoftDisabled(retryButton, false);
        appendAiAssistantLog("preview", responseArea.value, pendingAiReport, { round: aiRound });
        updateAiSessionPanel(sessionPanel, {
          round: aiRound,
          state: pendingAiReport.errors.length ? "仮プレビューにエラーがあります" : pendingAiReport.warnings.length ? "仮プレビューに確認点があります" : "仮プレビューは採用候補です",
          next: pendingAiReport.errors.length || pendingAiReport.warnings.length
            ? "正しい項目は修正チェックを外し、違う項目だけチェックして修正依頼をコピーしてください。"
            : "表が目視で正しければ採用してください。気になる列だけメモして修正依頼もできます。",
        });
        showToast(pendingAiReport.errors.length ? "エラーがあります。正しい場合はそのまま採用できます" : "仮プレビューを作成しました。問題なければ採用してください", pendingAiReport.errors.length ? "error" : "success");
      } catch (error) {
        console.warn("[RealEstateCopyHelper] AI回答JSONの反映に失敗しました", error);
        pendingAiConfig = null;
        pendingAiReport = createAiParseErrorReport(error);
        pendingAiReport.aiRound = aiRound;
        renderAiReviewPanel(reviewPanel, pendingAiReport);
        setAiActionSoftDisabled(applyButton, true);
        setAiActionSoftDisabled(retryButton, false);
        appendAiAssistantLog("preview_parse_error", responseArea.value, pendingAiReport, {
          error: error && error.message ? error.message : String(error || ""),
          round: aiRound,
        });
        updateAiSessionPanel(sessionPanel, {
          round: aiRound,
          state: "JSONを読み取れませんでした",
          next: "AIの返答からJSON部分だけを貼るか、修正依頼をコピーしてJSONだけで返すよう依頼してください。",
        });
        showToast("AI回答JSONが不正です", "error");
      }
    }));
    const retryActions = el("div", "rech-ai-actions");
    retryActions.appendChild(retryButton);
    const finishActions = el("div", "rech-ai-actions");
    finishActions.appendChild(applyButton);
    finishActions.appendChild(button("JSONログをコピー", "rech-secondary", async () => {
      try {
        await copyToClipboard(JSON.stringify(settings.aiAssistantLogs || [], null, 2));
        showToast("JSONログをコピーしました", "success");
      } catch (error) {
        console.warn("[RealEstateCopyHelper] AI補助ログのコピーに失敗しました", error);
        showToast("JSONログのコピーに失敗しました", "error");
      }
    }));
    details.appendChild(sessionPanel.wrapper);
    details.appendChild(renderAiWorkflowStep("1", "全体を見る", "まずページ全体をAIに渡します。必要なら1物件だけ、1部屋だけ、選択部分だけに絞れます。", [
      sourceControl,
      promptActions,
      el("label", "rech-ai-label", "AIに渡す情報"),
      promptArea,
    ]));
    details.appendChild(renderAiWorkflowStep("2", "部分を決める", "AIが返すJSONで、1物件のまとまり、1部屋のまとまり、各項目のCSS候補を決めます。", [
      el("label", "rech-ai-label", "AI回答JSON"),
      responseArea,
    ]));
    details.appendChild(renderAiWorkflowStep("3", "必要な形に整形する", "賃料は円表記、敷金礼金は月表記、面積は㎡表記など、normalizer、lineMode、regexで表に使う形へ整えます。", [
      renderAiShapeChecklist(),
    ]));
    details.appendChild(renderAiWorkflowStep("4", "仮プレビューで確認する", "保存前にテーブル化します。取得0件、CSS不正、広すぎるセレクタ、形式不一致をここで確認します。", [
      previewActions,
      reviewPanel,
    ]));
    details.appendChild(renderAiWorkflowStep("5", "AIへ戻して直す", "正しい項目は修正対象から外し、違う項目だけをメモ付きでAIへ戻します。", [
      el("label", "rech-ai-label", "AIへ返すメモ"),
      userReviewNote,
      retryActions,
      el("label", "rech-ai-label", "次の修正依頼"),
      retryPromptArea,
    ]));
    details.appendChild(renderAiWorkflowStep("6", "採用して表を完成させる", "自動判定で警告やエラーが出ても、表が正しければ採用できます。違う項目だけ修正依頼に戻します。", [
      finishActions,
    ]));
    return details;
  }

  function renderAiSessionPanel() {
    const wrapper = el("div", "rech-ai-session");
    const round = el("strong", "", "ラウンド 0");
    const state = el("span", "", "AI用情報をコピーして開始します");
    const next = el("small", "", "まずはページ全体または選択範囲をAIへ渡してください。");
    wrapper.appendChild(round);
    wrapper.appendChild(state);
    wrapper.appendChild(next);
    return { wrapper, round, state, next };
  }

  function updateAiSessionPanel(panel, info) {
    if (!panel) return;
    panel.round.textContent = `ラウンド ${info && info.round ? info.round : 0}`;
    panel.state.textContent = info && info.state ? info.state : "";
    panel.next.textContent = info && info.next ? info.next : "";
  }

  function renderAiWorkflowStep(number, title, description, children) {
    const step = el("section", "rech-ai-step");
    const header = el("div", "rech-ai-step-header");
    header.appendChild(el("span", "rech-ai-step-number", number));
    const text = el("div", "rech-ai-step-title");
    text.appendChild(el("strong", "", title));
    text.appendChild(el("small", "", description));
    header.appendChild(text);
    step.appendChild(header);
    (children || []).forEach((child) => {
      if (child) step.appendChild(child);
    });
    return step;
  }

  function renderAiShapeChecklist() {
    const list = el("div", "rech-ai-shape-list");
    [
      "賃料・管理費: 円表記にそろえる",
      "敷金・礼金: 0ヶ月、1ヶ月、円表記を判定する",
      "面積: ㎡ / m2 / m² を㎡表記にそろえる",
      "入居日・AD: 表記ゆれを補正し、未記載は未記載として扱う",
      "同じセルの値: lineModeやregexで必要な値だけ切り出す",
    ].forEach((text) => list.appendChild(el("span", "", text)));
    return list;
  }

  function setAiActionSoftDisabled(buttonNode, disabled) {
    if (!buttonNode) return;
    buttonNode.classList.toggle("is-soft-disabled", Boolean(disabled));
    buttonNode.setAttribute("aria-disabled", disabled ? "true" : "false");
  }

  function renderAiHtmlSourceControl(config, onSelected) {
    const wrapper = el("div", "rech-ai-source-control");
    wrapper.appendChild(termWithHelp("AIに見せるHTMLを選ぶ", "AI用情報をコピーするとき、ページHTMLのどの部分をAIに見せるかを選びます。迷ったら「ページ全体」のままで構いません。"));
    wrapper.appendChild(el("small", "rech-ai-source-note", "ここはAI用情報を作る前の絞り込みです。選んだ後は、下の「AI用情報をコピー」を押します。"));
    const row = el("div", "rech-ai-source-row");
    row.appendChild(el("span", "rech-ai-source-step", "範囲"));
    const select = document.createElement("select");
    [
      ["body", "ページ全体（迷ったらこれ）"],
      ["item", "1物件だけ（物件名も含める）"],
      ["room", "1部屋だけ（賃料・間取り向け）"],
      ["selected", "画面で選んだ部分だけ"],
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = settings.uiSettings.aiHtmlScopeMode || "body";
    let selectedNode = null;
    const status = el("span", "rech-ai-source-status", getAiHtmlSourceStatus(config, select.value, selectedNode));
    const diagnostics = el("div", "rech-ai-source-diagnostics");
    const refreshDiagnostics = () => {
      const summary = getAiCopyReadinessSummary(config, {
        htmlScopeMode: select.value,
        selectedNode,
      });
      status.textContent = getAiHtmlSourceStatus(config, select.value, selectedNode, summary);
      renderAiSourceDiagnostics(diagnostics, summary);
      wrapper.aiSourceSummary = summary;
      return summary;
    };
    select.addEventListener("change", () => {
      settings.uiSettings.aiHtmlScopeMode = select.value;
      saveUiSettingsOnly();
      refreshDiagnostics();
    });
    row.appendChild(select);
    row.appendChild(el("span", "rech-ai-source-step", "選択"));
    row.appendChild(button("画面から選ぶ（設定を一時的に隠す）", "rech-secondary rech-mini-button", () => {
      select.value = "selected";
      settings.uiSettings.aiHtmlScopeMode = "selected";
      saveUiSettingsOnly();
      startElementPicker("AIに見せたい部分をクリックしてください。Escでキャンセル", {
        hideSettingsModal: true,
        onPicked: (node) => {
          selectedNode = node;
          if (typeof onSelected === "function") onSelected(node);
          refreshDiagnostics();
        },
      });
    }));
    row.appendChild(button("再スキャン", "rech-secondary rech-mini-button", () => {
      const summary = refreshDiagnostics();
      const message = summary.roomCandidateCount
        ? `部屋候補 ${summary.roomCandidateCount}件を確認しました`
        : "再スキャンしました。部屋候補が少ない場合は一覧を展開してください";
      showToast(message, summary.roomCandidateCount ? "success" : "error");
    }));
    row.appendChild(status);
    const guide = el("div", "rech-ai-source-help");
    [
      "1: 左のプルダウンでAIに見せる範囲を選ぶ。",
      "2: 「画面で選んだ部分だけ」を使う時だけ「画面から選ぶ」を押す。設定画面はいったん消えるので、ページ上の物件部分をクリックする。",
      "3: 選び終わったら下の「AI用情報をコピー」を押す。",
      "ページ全体: まずはこれ。余計なHTMLも入るが失敗しにくい。",
      "1物件だけ: 物件名、部屋一覧、賃料などをまとめてAIに見せたい時。",
      "1部屋だけ: 賃料、管理費、間取り、面積など部屋行の取り方だけ聞きたい時。",
      "画面で選んだ部分だけ: HTMLが大きすぎる時や、AIが関係ない場所を拾う時。",
    ].forEach((text) => guide.appendChild(el("span", "", text)));
    wrapper.appendChild(guide);
    wrapper.appendChild(row);
    wrapper.appendChild(diagnostics);
    wrapper.refreshAiSourceStatus = refreshDiagnostics;
    refreshDiagnostics();
    return wrapper;
  }

  function getAiHtmlScopeMode(control) {
    const select = control && control.querySelector ? control.querySelector("select") : null;
    return select ? select.value : "body";
  }

  function getAiHtmlSourceStatus(config, mode, selectedNode, summary) {
    const source = summary && summary.source ? summary.source : getAiHtmlSource(config, { htmlScopeMode: mode, selectedNode });
    if (mode === "selected" && !selectedNode) return "未選択: 「画面から選ぶ」を押して、ページ上の見せたい部分をクリックしてください";
    const roomText = summary ? ` / 部屋候補 ${summary.roomCandidateCount}件` : "";
    return `現在: ${source.label}${roomText}。展開後は再スキャンしてからコピーします`;
  }

  function getAiSourceSessionNextText(control) {
    const summary = control && control.aiSourceSummary;
    if (!summary) return "";
    const parts = [
      `コピー内容には部屋候補 ${summary.roomCandidateCount}件、表候補 ${summary.tableCandidateCount}件を含めています。`,
    ];
    if (!summary.roomCandidateCount && !summary.tableCandidateCount) {
      parts.push("候補が少ないため、一覧を展開するか、画面から一覧部分を選んで再スキャンしてください。");
    } else if (summary.hasLikelyTruncatedList) {
      parts.push("部屋候補が少ない可能性があります。イタンジ側の一覧表示/もっと見るを押した後、再スキャンしてください。");
    } else {
      parts.push("AIに貼り、返ってきたJSONを下に貼ってください。");
    }
    return parts.join(" ");
  }

  function getAiCopyReadinessSummary(config, options) {
    const source = getAiHtmlSource(config, options || {});
    const snippets = getAiHtmlSnippets(config);
    const htmlLimit = source.mode === "body" ? 60000 : 30000;
    const sanitizedHtml = sanitizeHtmlForAiWithLimit(source.node || document.body, htmlLimit);
    const roomCandidateCount = snippets.roomCandidates ? snippets.roomCandidates.length : 0;
    const totalRoomCandidateCount = snippets.copyDiagnostics ? snippets.copyDiagnostics.totalRoomCandidateCount || roomCandidateCount : roomCandidateCount;
    const omittedRoomCandidateCount = Math.max(0, totalRoomCandidateCount - roomCandidateCount);
    const tableCandidateCount = snippets.tableCandidates ? snippets.tableCandidates.length : 0;
    const repeatingGroupCount = snippets.repeatingGroups ? snippets.repeatingGroups.length : 0;
    const fieldEvidenceCount = snippets.fieldEvidence ? snippets.fieldEvidence.length : 0;
    const warnings = snippets.copyDiagnostics && Array.isArray(snippets.copyDiagnostics.warnings)
      ? snippets.copyDiagnostics.warnings.slice()
      : [];
    const hasLikelyTruncatedList = roomCandidateCount > 0 && roomCandidateCount < 5 && hasMoreListingExpansionButtonText();
    if (hasLikelyTruncatedList) warnings.push("一覧表示/もっと見るボタンが残っている可能性があります。展開後に再スキャンしてください。");
    if (omittedRoomCandidateCount > 0) warnings.push(`候補が多いためAIには上位${roomCandidateCount}件を渡します。必要なら一覧部分を選択して範囲を絞ってください。`);
    return {
      source,
      roomCandidateCount,
      totalRoomCandidateCount,
      omittedRoomCandidateCount,
      tableCandidateCount,
      itemCandidateCount: snippets.itemCandidates ? snippets.itemCandidates.length : 0,
      repeatingGroupCount,
      fieldEvidenceCount,
      sanitizedHtmlLength: sanitizedHtml.length,
      htmlLimit,
      warnings,
      hasLikelyTruncatedList,
    };
  }

  function renderAiSourceDiagnostics(container, summary) {
    if (!container || !summary) return;
    container.innerHTML = "";
    [
      ["部屋候補", summary.omittedRoomCandidateCount ? `${summary.roomCandidateCount}/${summary.totalRoomCandidateCount}件` : `${summary.roomCandidateCount}件`],
      ["表候補", `${summary.tableCandidateCount}件`],
      ["繰り返し候補", `${summary.repeatingGroupCount}件`],
      ["項目根拠", `${summary.fieldEvidenceCount}項目`],
      ["HTML量", `${summary.sanitizedHtmlLength.toLocaleString("ja-JP")}文字`],
    ].forEach(([label, value]) => {
      const item = el("span", "rech-ai-source-metric");
      item.appendChild(el("strong", "", label));
      item.appendChild(document.createTextNode(value));
      container.appendChild(item);
    });
    const note = el("small", "rech-ai-source-diagnostics-note", "");
    if (summary.warnings && summary.warnings.length) {
      note.textContent = summary.warnings.slice(0, 2).join(" / ");
      note.classList.add("is-warning");
    } else {
      note.textContent = "イタンジなどで残り部屋を展開した後は、再スキャンして候補数が増えたことを確認してください。";
    }
    container.appendChild(note);
  }

  function hasMoreListingExpansionButtonText() {
    const text = normalizeText(document.body && (document.body.innerText || document.body.textContent || "") || "");
    return /もっと見る|一覧表示|全て表示|すべて表示|部屋番号順|残り[0-9]+件|さらに表示|表示件数を増やす/.test(text);
  }

  function renderAiSelectorUsageGuide() {
    const guide = el("div", "rech-ai-guide");
    guide.appendChild(el("strong", "", "進め方"));
    const steps = el("div", "rech-ai-flow");
    [
      ["全体", "body全体をAIに見せて候補を探す"],
      ["部分", "1物件、1部屋、項目CSSを決める"],
      ["整形", "表に必要な形へそろえる"],
      ["確認", "仮プレビューと採点を見る"],
      ["完成", "採用または修正依頼を出す"],
    ].forEach(([label, text]) => {
      const item = el("div", "rech-ai-flow-item");
      item.appendChild(el("span", "", label));
      item.appendChild(el("small", "", text));
      steps.appendChild(item);
    });
    guide.appendChild(steps);
    guide.appendChild(el("small", "", "一発で完成しない前提です。仮プレビューの警告を見ながら、修正依頼をAIに戻して表を仕上げます。"));
    return guide;
  }

  function buildAiSelectorPrompt(config, options) {
    const snippets = getAiHtmlSnippets(config);
    const htmlSource = getAiHtmlSource(config, options || {});
    const sanitizedBodyHtml = sanitizeHtmlForAiWithLimit(htmlSource.node || document.body, htmlSource.mode === "body" ? 60000 : 30000);
    const payload = {
      task: "不動産一覧ページから部屋ごとの表を作るためのCSSセレクタ、正規表現、整形方法を提案してください。",
      privacy: "ログインが必要な画面を想定しているため、ページURLは含めていません。HTML内のhref/src/action/data-detailurl、フォーム値、token/key/session系の属性値は伏せています。",
      fields: getListingFieldIds().map(({ key, label }) => ({ key, label })),
      outputJsonOnly: true,
      expectedResponseShape: {
        extractionStrategy: "css / tableExtraction / roomCells のいずれか。混ぜすぎない",
        itemSelector: "1物件のまとまりのCSS。不要なら空文字",
        rowSelector: "1部屋のまとまりのCSS。不要なら空文字",
        tableExtraction: {
          enabled: "htmlSnippets.tableCandidatesに適切な表がある場合だけtrue。表でないサイトではfalseまたは省略",
          mode: "standard または roomCells",
          tableSelector: "対象tableのCSS",
          rowSelector: "standardならtr。データ行だけを選べるならそのCSS",
          cellSelector: "standardならtd,th",
          headerRowIndex: 0,
          dataStartRowIndex: 1,
          roomSelector: "roomCellsの場合の1部屋セルCSS",
          buildingNameSelector: "表外に物件名がある場合だけCSS",
          columns: {
            room: 0,
            layout: 1,
            area: 2,
            rent: 3,
            managementFee: 4,
            depositKeyMoney: 5,
            availableDate: 6,
          },
          excludeColumns: ["備考など表に出さない列"],
        },
        fields: {
          buildingName: { scope: "item", selector: "", selectorCandidates: [], regex: "", lineMode: "", normalizer: "text" },
          rent: { scope: "row", selector: "", selectorCandidates: [], regex: "", lineMode: "", normalizer: "rent" },
          managementFee: { scope: "row", selector: "", selectorCandidates: [], regex: "", lineMode: "", normalizer: "yen" },
          deposit: { scope: "row", selector: "", selectorCandidates: [], regex: "", lineMode: "", normalizer: "rentMonth" },
          keyMoney: { scope: "row", selector: "", selectorCandidates: [], regex: "", lineMode: "", normalizer: "rentMonth" },
          layout: { scope: "row", selector: "", selectorCandidates: [], regex: "", lineMode: "", normalizer: "layout" },
          area: { scope: "row", selector: "", selectorCandidates: [], regex: "", lineMode: "", normalizer: "area" },
        },
        selfCheck: {
          expectedRowCount: "この設定で取れると想定する部屋行数",
          sampleRows: "想定される先頭数行の値",
          uncertainFields: ["自信が低い項目名"],
          reason: "この方式を選んだ理由",
        },
      },
      rules: [
        "回答はJSONだけにしてください。説明文やMarkdownコードフェンスは不要です。",
        "JSONにコメントや末尾カンマを入れないでください。キー名は必ずダブルクォートで囲んでください。",
        "正規表現のバックスラッシュはJSON文字列として必ずエスケープしてください。例: バックスラッシュ+s は、JSONではバックスラッシュ2本+s で書きます。",
        "CSS属性セレクタ内の引用符は、[data-testid='value'] のようにシングルクォートを使ってください。JSON文字列を壊すため [data-testid=\"value\"] は避けてください。",
        "特定の1件だけに依存する長すぎるnth-childは避け、同じ一覧内で繰り返し使えるCSSを優先してください。",
        "賃料と管理費、間取りと面積が同じセルにある場合は、selectorでセルを指定し、regexまたはlineModeで切り分けてください。",
        "ADは、AD、広告料、広告費などと明記されている場合だけ設定してください。仲介手数料、家賃の55%、手数料割引、タグ表示はADではありません。AD/広告表記がなければ未記載にしてください。",
        "scopeは item, row, document のいずれかにしてください。基本は物件名がitem、部屋項目がrowです。",
        "selectorに自信がない項目はselectorCandidatesに複数候補を入れてください。ツール側で先頭を主候補、残りを予備候補として検証します。",
        "広すぎるセレクタ、取得0件になりそうなセレクタ、nth-childだらけのセレクタは避けてください。",
        "extractionStrategyは css / tableExtraction / roomCells のどれか1つを主方式として選んでください。表が十分ならtableExtractionまたはroomCells、表でなければcssを選んでください。",
        "htmlSnippets.fieldValueCandidatesの候補値と、実際に返すselector/regexで取れる値が矛盾しないようにしてください。",
        "selfCheckに想定行数、サンプル値、不安な項目を入れてください。ツール側で検証します。",
        "号室には階数だけを入れないでください。部屋番号がない一般サイトでは空欄または取得不能として扱ってください。",
        "htmlSnippets.tableCandidatesに部屋一覧として使える表がある場合は、CSS fieldsよりtableExtractionを優先してください。ただし表ではないサイトではtableExtractionを使わないでください。",
        "通常のHTMLテーブルで1行が1部屋なら mode は standard、td.roomなど1セルが1部屋なら mode は roomCells にしてください。",
        "敷金/礼金が1セルの場合は columns.depositKeyMoney に列番号またはセル指定を入れてください。備考列は excludeColumns に入れ、コピー対象にはしないでください。",
        "sanitizedBodyHtmlでは検索フォーム、ナビゲーション、入力部品、操作ボタンをできるだけ除外しています。部屋情報がある場合は削りすぎないように残していることがあります。",
        "htmlSnippets.roomCandidates / repeatingGroups / fieldEvidence を優先して見てください。itemCandidates や sanitizedBodyHtml に検索フォームが残る場合があります。",
      ],
      currentConfig: serializeAiRelevantListingConfig(config),
      htmlSnippets: snippets,
      copySummary: {
        includedRoomCandidateCount: snippets.roomCandidates ? snippets.roomCandidates.length : 0,
        estimatedRoomCandidateCount: snippets.copyDiagnostics ? snippets.copyDiagnostics.totalRoomCandidateCount || 0 : 0,
        omittedRoomCandidateCount: snippets.copyDiagnostics ? snippets.copyDiagnostics.omittedRoomCandidateCount || 0 : 0,
        includedTableCandidateCount: snippets.tableCandidates ? snippets.tableCandidates.length : 0,
        includedRepeatingGroupCount: snippets.repeatingGroups ? snippets.repeatingGroups.length : 0,
        includedFieldEvidenceCount: snippets.fieldEvidence ? snippets.fieldEvidence.length : 0,
        sanitizedBodyHtmlLength: sanitizedBodyHtml.length,
        note: "イタンジ等で一覧表示/もっと見るを押した後は、再スキャンして候補数が増えた状態でコピーしてください。",
      },
      htmlScope: {
        mode: htmlSource.mode,
        label: htmlSource.label,
        note: "sanitizedBodyHtmlには、選択された範囲から検索フォームや操作UIをできるだけ除外したHTMLを入れています。modeがbodyの場合はbody全体です。body全文で渡す機能は残しています。",
      },
      sanitizedBodyHtml,
    };
    return [
      "以下の情報から、抽出設定JSONを作成してください。",
      "URLは含めていません。body内のHTMLと候補断片を見て、汎用的に繰り返し使える設定を返してください。",
      "",
      JSON.stringify(payload, null, 2),
    ].join("\n");
  }

  function serializeAiRelevantListingConfig(config) {
    const fields = {};
    getListingFieldIds().forEach(({ key }) => {
      const field = config.fields && config.fields[key] ? config.fields[key] : null;
      const selectorRule = field ? getListingFieldRule(field, "selector") : null;
      const regexRule = field ? getListingFieldRule(field, "regex") : null;
      fields[key] = {
        scope: selectorRule && selectorRule.scope || "",
        selector: selectorRule && selectorRule.selector || "",
        lineMode: selectorRule && selectorRule.lineMode || "",
        normalizer: selectorRule && selectorRule.normalizer || getDefaultListingNormalizer(key),
        regex: regexRule && (regexRule.pattern || regexRule.regex) || "",
      };
    });
    return {
      itemSelector: config.itemSelector || "",
      rowSelector: config.rowSelector || "",
      scopeMode: config.scopeMode || "mixed",
      tableExtraction: serializeAiTableExtractionConfig(config.tableExtraction),
      fields,
    };
  }

  function serializeAiTableExtractionConfig(tableExtraction) {
    const tableConfig = sanitizeTableExtractionConfig(tableExtraction || createDefaultTableExtraction());
    return {
      enabled: tableConfig.enabled,
      mode: tableConfig.mode,
      tableSelector: tableConfig.tableSelector,
      rowSelector: tableConfig.rowSelector,
      cellSelector: tableConfig.cellSelector,
      dataStartRowIndex: tableConfig.dataStartRowIndex,
      roomSelector: tableConfig.roomSelector,
      buildingNameSelector: tableConfig.buildingNameSelector,
      columns: tableConfig.columns,
      excludeColumns: tableConfig.excludeColumns,
    };
  }

  function getAiHtmlSnippets(config) {
    const configuredRoomNodes = getAiRoomSnippetNodes(config);
    const inferredRoomNodes = inferAiRoomSnippetCandidates();
    const allRoomNodes = dedupeNodes([...configuredRoomNodes, ...inferredRoomNodes]);
    const roomNodes = allRoomNodes.slice(0, 12);
    const itemNodes = getAiItemSnippetNodes(config).slice(0, 3);
    const tableCandidates = getAiTableCandidateSnippets();
    return {
      copyDiagnostics: buildAiCopyDiagnostics(config, itemNodes, roomNodes, inferredRoomNodes, allRoomNodes, tableCandidates),
      tableCandidates,
      itemCandidates: itemNodes.map((node, index) => getAiSnippetEntry(node, index + 1, { htmlLimit: 9000, textLimit: 900 })),
      roomCandidates: roomNodes.map((node, index) => ({
        ...getAiSnippetEntry(node, index + 1, { htmlLimit: 12000, textLimit: 1400 }),
        score: scoreAiRoomCandidate(node),
        diagnostics: summarizeAiRoomCandidate(node),
      })),
      repeatingGroups: getAiRepeatingGroupSnippets(roomNodes),
      fieldEvidence: getAiFieldEvidenceSnippets(config, roomNodes),
      fieldValueCandidates: getAiFieldValueCandidateLists(allRoomNodes),
    };
  }

  function getAiTableCandidateSnippets() {
    return Array.from(document.querySelectorAll("table"))
      .filter((table) => table && !(table.closest && table.closest(`#${APP_ID}, #${APP_ID}-modal`)))
      .map((table) => ({ table, score: scoreAiTableCandidate(table) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry, index) => buildAiTableCandidateSnippet(entry.table, index + 1));
  }

  function scoreAiTableCandidate(table) {
    const matrix = getAiTableMatrix(table, 8, 10);
    const rowCount = matrix.length;
    const columnCount = Math.max(0, ...matrix.map((row) => row.length));
    const text = normalizeNumberText(matrix.flat().join(" "));
    let score = 0;
    if (rowCount >= 2 && columnCount >= 3) score += 8;
    if (/賃料|家賃|[0-9]+(?:\.[0-9]+)?\s*万(?:円)?|[0-9][0-9,]*\s*円/.test(text)) score += 8;
    if (/間取り|[0-9]\s*(?:SLDK|LDK|SDK|DK|SK|R|K)\b|ワンルーム/i.test(text)) score += 6;
    if (/専有|面積|[0-9]+(?:\.[0-9]+)?\s*(?:㎡|m2|m²|平米)/i.test(text)) score += 6;
    if (/部屋|号室|入居|敷金|礼金|管理費|共益費/.test(text)) score += 5;
    if (detectAiTableMode(table) === "roomCells") score += 5;
    if (/条件|検索|ログイン|パスワード|メールアドレス/.test(text) && rowCount < 4) score -= 8;
    return score;
  }

  function buildAiTableCandidateSnippet(table, index) {
    const matrix = getAiTableMatrix(table, 8, 10);
    const mode = detectAiTableMode(table);
    const selectors = buildAiCandidateSelectors(table);
    return {
      index,
      tag: "table",
      id: table.id || "",
      className: typeof table.className === "string" ? table.className : "",
      stableCssPath: buildStableCssPath(table),
      candidateSelectors: selectors,
      likelyMode: mode,
      rowCount: Array.from(table.rows || safeQuerySelectorAll(table, "tr")).length,
      columnCount: Math.max(0, ...matrix.map((row) => row.length)),
      headers: getAiTableHeaders(table),
      matrix,
      roomCellSamples: mode === "roomCells" ? getAiRoomCellSamples(table) : [],
      suggestedTableExtraction: inferAiTableExtraction(table, mode),
    };
  }

  function getAiTableMatrix(table, rowLimit, cellLimit) {
    const rows = Array.from(table.rows || safeQuerySelectorAll(table, "tr")).slice(0, rowLimit);
    return rows.map((row) => getTableRowCells(row, "td,th")
      .slice(0, cellLimit)
      .map((cell) => truncateText(normalizeText(cell.innerText || cell.textContent || ""), 160)));
  }

  function getAiTableHeaders(table) {
    const rows = Array.from(table.rows || safeQuerySelectorAll(table, "tr"));
    const headerRow = rows.find((row) => getTableRowCells(row, "td,th").some((cell) => cell.tagName === "TH"))
      || rows.find((row) => getTableRowCells(row, "td,th").some((cell) => inferListingFieldKeyFromHeader(cell.innerText || cell.textContent || "")))
      || rows[0];
    if (!headerRow) return [];
    return getTableRowCells(headerRow, "td,th").map((cell) => truncateText(normalizeText(cell.innerText || cell.textContent || ""), 80));
  }

  function detectAiTableMode(table) {
    const roomCells = safeQuerySelectorAll(table, "td.room, [class~='room']")
      .filter((node) => hasRoomLikeText(node.innerText || node.textContent || ""));
    return roomCells.length >= 2 ? "roomCells" : "standard";
  }

  function getAiRoomCellSamples(table) {
    return safeQuerySelectorAll(table, "td.room, [class~='room']")
      .filter((node) => hasRoomLikeText(node.innerText || node.textContent || ""))
      .slice(0, 5)
      .map((node, index) => ({
        index: index + 1,
        candidateSelectors: buildAiCandidateSelectors(node),
        text: truncateText(normalizeText(node.innerText || node.textContent || ""), 300),
      }));
  }

  function inferAiTableExtraction(table, mode) {
    const tableSelector = buildAiCandidateSelectors(table)[0] || buildStableCssPath(table) || "table";
    if (mode === "roomCells") {
      return {
        enabled: true,
        mode: "roomCells",
        tableSelector,
        roomSelector: "td.room, [class~='room']",
        columns: inferAiRoomCellColumns(table),
      };
    }
    const headers = getAiTableHeaders(table);
    const columns = {};
    headers.forEach((header, columnIndex) => {
      const key = inferListingFieldKeyFromHeader(header);
      if (key && !columns[key]) columns[key] = columnIndex;
    });
    return {
      enabled: true,
      mode: "standard",
      tableSelector,
      rowSelector: "tr",
      cellSelector: "td,th",
      headerRowIndex: 0,
      dataStartRowIndex: headers.some(inferListingFieldKeyFromHeader) ? 1 : 0,
      columns,
    };
  }

  function inferAiRoomCellColumns(table) {
    const first = safeQuerySelectorAll(table, "td.room, [class~='room']")
      .find((node) => hasRoomLikeText(node.innerText || node.textContent || ""));
    const columns = {};
    if (!first) return columns;
    const selectorMap = {
      room: [".number", "[class*='number']", "[class*='room']"],
      rent: [".rent", "[class*='rent']", "[class*='price']"],
      managementFee: [".fee", "[class*='fee']", "[class*='kanri']"],
      layout: [".plan", ".layout", "[class*='plan']", "[class*='layout']"],
      area: [".area", "[class*='area']", "[class*='menseki']"],
      availableDate: [".available", ".move", "[class*='available']", "[class*='move']"],
    };
    Object.entries(selectorMap).forEach(([key, selectors]) => {
      const selector = selectors.find((candidate) => isSelectorValidForPreview(candidate) && safeQuerySelector(first, candidate));
      if (selector) columns[key] = { selector };
    });
    return columns;
  }

  function inferListingFieldKeyFromHeader(value) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    if (!text) return "";
    if (/物件名|建物名|マンション名|アパート名/.test(text)) return "buildingName";
    if (/部屋番号|号室|^部屋$|^号$/.test(text)) return "room";
    if (/間取り|タイプ/.test(text)) return "layout";
    if (/専有面積|面積|㎡|m2|m²|平米/i.test(text)) return "area";
    if (/賃料|家賃|月額賃料/.test(text)) return "rent";
    if (/管理費|共益費|管理・共益費|管理費・共益費/.test(text)) return "managementFee";
    if (/敷金.*礼金|礼金.*敷金|敷\/礼|敷礼|敷金\/礼金|敷金・礼金/.test(text)) return "depositKeyMoney";
    if (/敷金|保証金/.test(text)) return "deposit";
    if (/礼金/.test(text)) return "keyMoney";
    if (/入居|入居日|入居時期|引渡|空室|予定/.test(text)) return "availableDate";
    if (/\bAD\b|広告料|広告費/i.test(text)) return "ad";
    return "";
  }

  function buildAiCopyDiagnostics(config, itemNodes, roomNodes, inferredRoomNodes, allRoomNodes, tableCandidates) {
    const configuredRowCount = config.rowSelector && isSelectorValidForPreview(config.rowSelector)
      ? safeQuerySelectorAll(document, config.rowSelector).length
      : 0;
    const configuredItemCount = config.itemSelector && isSelectorValidForPreview(config.itemSelector)
      ? safeQuerySelectorAll(document, config.itemSelector).length
      : 0;
    const bodyText = normalizeText(document.body && (document.body.innerText || document.body.textContent || "") || "");
    const warnings = [];
    if (!roomNodes.length) warnings.push("部屋候補HTMLが見つかっていません。body全文または画面選択が必要です。");
    if (itemNodes.some(isAiSearchOrFilterContainer)) warnings.push("1物件候補に検索フォーム/絞り込みUIが混ざっている可能性があります。roomCandidatesを優先してください。");
    if (configuredRowCount > 80) warnings.push("現在のrowSelectorは一致件数が多く、広すぎる可能性があります。");
    const totalRoomCandidateCount = (allRoomNodes || roomNodes || []).length;
    const omittedRoomCandidateCount = Math.max(0, totalRoomCandidateCount - (roomNodes || []).length);
    if (configuredRowCount > 0 && roomNodes.length < Math.min(5, configuredRowCount)) warnings.push("rowSelectorの一致件数に対してAIへ渡す行候補が少ない可能性があります。");
    if (omittedRoomCandidateCount > 0) warnings.push(`部屋候補は推定${totalRoomCandidateCount}件ありますが、AIへは上位${roomNodes.length}件だけ渡しています。`);
    return {
      bodyTextLength: bodyText.length,
      configuredItemSelector: config.itemSelector || "",
      configuredItemCount,
      configuredRowSelector: config.rowSelector || "",
      configuredRowCount,
      roomCandidateCount: roomNodes.length,
      totalRoomCandidateCount,
      omittedRoomCandidateCount,
      inferredRoomCandidateCount: inferredRoomNodes.length,
      tableCandidateCount: (tableCandidates || []).length,
      warnings,
    };
  }

  function getAiItemSnippetNodes(config) {
    if (config.itemSelector && isSelectorValidForPreview(config.itemSelector)) {
      const nodes = getConfiguredItemScopes(config).filter((node) => node && node !== document.body);
      if (nodes.length) return dedupeNodes(nodes);
    }
    const rooms = getAiRoomSnippetNodes(config);
    const items = rooms.map((room) => findAiItemSnippetNode(room)).filter(Boolean);
    return dedupeNodes(items);
  }

  function getAiRoomSnippetNodes(config) {
    if (config.rowSelector && isSelectorValidForPreview(config.rowSelector)) {
      const nodes = getConfiguredItemScopes(config)
        .flatMap((item) => getConfiguredRowScopes(item, config))
        .filter((node) => node && node !== document.body);
      if (nodes.length) return dedupeNodes(nodes);
    }
    return inferAiRoomSnippetCandidates();
  }

  function inferAiRoomSnippetCandidates() {
    const candidates = Array.from(document.querySelectorAll("tr, li, article, section, div"))
      .filter(isUsefulAiRoomCandidate)
      .map((node) => ({ node, score: scoreAiRoomCandidate(node) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.node);
    return filterAiRoomSnippetNodes(candidates);
  }

  function filterAiRoomSnippetNodes(nodes) {
    const uniqueNodes = dedupeNodes(nodes || []);
    return uniqueNodes.filter((node) => {
      const text = normalizeText(node.innerText || node.textContent || "");
      return !uniqueNodes.some((candidate) => {
        if (candidate === node || !node.contains || !node.contains(candidate)) return false;
        const candidateText = normalizeText(candidate.innerText || candidate.textContent || "");
        if (candidateText.length < 20 || candidateText.length >= text.length) return false;
        return hasRoomLikeText(candidateText) && countRoomValueMarkers(text) > countRoomValueMarkers(candidateText) + 2;
      });
    });
  }

  function isUsefulAiRoomCandidate(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.closest && node.closest(`#${APP_ID}, #${APP_ID}-modal`)) return false;
    const text = normalizeText(node.innerText || node.textContent || "");
    if (text.length < 10 || text.length > 1800) return false;
    return hasRoomLikeText(text);
  }

  function scoreAiRoomCandidate(node) {
    const text = normalizeNumberText(node.innerText || node.textContent || "");
    let score = 0;
    if (extractRentFromText(text)) score += 8;
    if (extractManagementFeeFromText(text, "")) score += 3;
    if (extractLayoutFromText(text)) score += 8;
    if (extractAreaFromText(text)) score += 8;
    if (/敷金|礼金|敷|礼/.test(text)) score += 2;
    if (getSpecificRoomIdentifier(text)) score += 4;
    if (hasAiRoomValueCluster(text)) score += 10;
    if (hasComparableSiblingRoomCandidates(node)) score += 6;
    if (node.tagName === "TR") score += 4;
    if (node.tagName === "LI" || node.tagName === "ARTICLE" || node.tagName === "SECTION") score += 2;
    if (node.querySelector && node.querySelector("h1, h2, h3") && !extractRentFromText(text)) score -= 8;
    if (isAiSearchOrFilterContainer(node)) score -= 16;
    score -= countAiSearchFilterMarkers(`${node.id || ""} ${typeof node.className === "string" ? node.className : ""} ${text}`) * 5;
    if (countInteractiveElements(node) > 8 && countRoomValueMarkers(text) < 4) score -= 10;
    if (text.length > 1200 && countRoomValueMarkers(text) < 5) score -= 8;
    score -= Math.min(4, Math.floor(text.length / 500));
    return score;
  }

  function summarizeAiRoomCandidate(node) {
    const text = normalizeNumberText(node && (node.innerText || node.textContent) || "");
    return {
      markerCount: countRoomValueMarkers(text),
      hasRoomNumber: Boolean(getSpecificRoomIdentifier(text)),
      hasRent: Boolean(extractRentFromText(text)),
      hasManagementFee: Boolean(extractManagementFeeFromText(text, "")),
      hasLayout: Boolean(extractLayoutFromText(text)),
      hasArea: Boolean(extractAreaFromText(text)),
      hasLeaseCosts: /敷金|礼金|敷|礼/.test(text),
      searchFilterMarkerCount: countAiSearchFilterMarkers(`${node && node.id || ""} ${node && typeof node.className === "string" ? node.className : ""} ${text}`),
      interactiveElementCount: countInteractiveElements(node),
    };
  }

  function hasAiRoomValueCluster(text) {
    const normalized = normalizeNumberText(text);
    const hits = [
      extractRentFromText(normalized),
      extractLayoutFromText(normalized),
      extractAreaFromText(normalized),
      /敷金|礼金|敷|礼/.test(normalized) ? "lease" : "",
      getSpecificRoomIdentifier(normalized),
    ].filter(Boolean).length;
    return hits >= 3;
  }

  function hasComparableSiblingRoomCandidates(node) {
    const parent = node && node.parentElement;
    if (!parent) return false;
    const ownTag = node.tagName;
    const ownClasses = getStableClassTokens(node).join(".");
    const siblings = Array.from(parent.children || []).filter((sibling) => {
      if (sibling === node || !hasRoomLikeText(sibling.innerText || sibling.textContent || "")) return false;
      if (ownTag && sibling.tagName === ownTag) return true;
      return ownClasses && getStableClassTokens(sibling).join(".") === ownClasses;
    });
    return siblings.length >= 1;
  }

  function countInteractiveElements(node) {
    if (!node || !node.querySelectorAll) return 0;
    return node.querySelectorAll("input, textarea, select, button, [role='button'], [role='checkbox'], [role='combobox']").length;
  }

  function findAiItemSnippetNode(roomNode) {
    if (!roomNode) return null;
    let current = roomNode.parentElement;
    let best = roomNode;
    let depth = 0;
    const roomTextLength = normalizeText(roomNode.innerText || roomNode.textContent || "").length;
    while (current && current !== document.body && current !== document.documentElement && depth < 8) {
      if (current.closest && current.closest(`#${APP_ID}, #${APP_ID}-modal`)) break;
      const text = normalizeText(current.innerText || current.textContent || "");
      if (text.length > roomTextLength + 20 && text.length < 7000) {
        const hasHeading = current.querySelector && current.querySelector("h1, h2, h3, a");
        const roomLikeCount = Array.from(current.querySelectorAll("tr, li, article, section, div"))
          .filter((node) => node !== current && isUsefulAiRoomCandidate(node))
          .length;
        if (hasHeading || roomLikeCount > 1) best = current;
      }
      current = current.parentElement;
      depth += 1;
    }
    return best;
  }

  function getAiRepeatingGroupSnippets(roomNodes) {
    const groups = [];
    const parents = dedupeNodes((roomNodes || []).map((node) => node && node.parentElement).filter(Boolean));
    parents.forEach((parent) => {
      const children = Array.from(parent.children || []).filter(isUsefulAiRoomCandidate);
      if (children.length < 2) return;
      groups.push({
        parentSelector: buildStableCssPath(parent),
        parentClassName: typeof parent.className === "string" ? parent.className : "",
        repeatedChildCount: children.length,
        repeatedChildSelectors: buildAiCandidateSelectors(children[0]),
        samples: children.slice(0, 5).map((node, index) => getAiSnippetEntry(node, index + 1, { htmlLimit: 6000, textLimit: 900 })),
      });
    });
    return groups.slice(0, 3);
  }

  function getAiFieldEvidenceSnippets(config, roomNodes) {
    const rows = (roomNodes || []).slice(0, 10);
    return getListingFieldIds().map(({ key, label }) => {
      const field = config.fields && config.fields[key] ? config.fields[key] : null;
      const selectorRule = field ? getListingFieldRule(field, "selector") : null;
      const regexRule = field ? getListingFieldRule(field, "regex") : null;
      const selector = selectorRule && selectorRule.selector || "";
      const regex = regexRule && (regexRule.pattern || regexRule.regex) || selectorRule && (selectorRule.pattern || selectorRule.regex) || "";
      const samples = rows.map((row, rowIndex) => {
        const text = normalizeText(row.innerText || row.textContent || "");
        const selectorMatches = selector && isSelectorValidForPreview(selector)
          ? safeQuerySelectorAllIncludingSelf(row, selector).slice(0, 4).map((node) => truncateText(normalizeText(node.innerText || node.textContent || ""), 240))
          : [];
        return {
          rowIndex: rowIndex + 1,
          selectorMatches,
          guessedValue: guessAiFieldEvidenceValue(key, text),
          rowText: truncateText(text, 500),
        };
      }).filter((sample) => sample.selectorMatches.length || sample.guessedValue);
      return {
        key,
        label,
        currentSelector: selector,
        currentRegex: regex,
        expectedFormat: getAiFieldExpectedFormat(key),
        samples: samples.slice(0, 6),
      };
    }).filter((entry) => entry.samples.length || entry.currentSelector || entry.currentRegex);
  }

  function getAiFieldValueCandidateLists(roomNodes) {
    const nodes = (roomNodes || []).slice(0, 30);
    const collectors = {
      room: new Map(),
      rent: new Map(),
      managementFee: new Map(),
      deposit: new Map(),
      keyMoney: new Map(),
      availableDate: new Map(),
      ad: new Map(),
      layout: new Map(),
      area: new Map(),
    };
    nodes.forEach((node, nodeIndex) => {
      const rawText = normalizeNumberText(node && (node.innerText || node.textContent) || "");
      const guesses = {
        room: guessAiFieldEvidenceValue("room", rawText) || getSpecificRoomIdentifier(rawText),
        rent: normalizeConfiguredValue(extractRentFromText(rawText), "rent", "rent"),
        managementFee: normalizeConfiguredValue(extractManagementFeeFromText(rawText, extractRentFromText(rawText)), "yen", "managementFee"),
        deposit: normalizeLeaseCostByRent(extractDepositFromText(rawText), extractRentFromText(rawText), "rentMonth"),
        keyMoney: normalizeLeaseCostByRent(extractKeyMoneyFromText(rawText), extractRentFromText(rawText), "rentMonth"),
        availableDate: guessAiFieldEvidenceValue("availableDate", rawText),
        ad: guessAiFieldEvidenceValue("ad", rawText),
        layout: normalizeConfiguredValue(extractLayoutFromText(rawText), "layout", "layout"),
        area: normalizeConfiguredValue(extractAreaFromText(rawText), "area", "area"),
      };
      Object.entries(guesses).forEach(([key, value]) => {
        const normalized = normalizeText(value || "");
        if (!normalized || normalized === "未記載" || normalized === "相談" && key !== "availableDate") return;
        const bucket = collectors[key];
        const current = bucket.get(normalized) || { value: normalized, count: 0, rowIndexes: [] };
        current.count += 1;
        if (current.rowIndexes.length < 5) current.rowIndexes.push(nodeIndex + 1);
        bucket.set(normalized, current);
      });
    });
    return Object.entries(collectors).map(([key, bucket]) => ({
      key,
      label: getListingFieldLabel(key),
      expectedFormat: getAiFieldExpectedFormat(key),
      candidates: Array.from(bucket.values())
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value), "ja"))
        .slice(0, 12),
    })).filter((entry) => entry.candidates.length);
  }

  function guessAiFieldEvidenceValue(key, text) {
    const normalized = normalizeNumberText(text || "");
    if (key === "rent") return extractRentFromText(normalized);
    if (key === "managementFee") return extractManagementFeeFromText(normalized, "");
    if (key === "deposit") return extractDepositFromText(normalized);
    if (key === "keyMoney") return extractKeyMoneyFromText(normalized);
    if (key === "layout") return extractLayoutFromText(normalized);
    if (key === "area") return extractAreaFromText(normalized);
    if (key === "availableDate") {
      const match = normalized.match(/即入居可?|相談|(?:[0-9]{4}年)?[0-9]{1,2}月[0-9]{1,2}日|[0-9]{1,2}月(?:上旬|中旬|下旬)/);
      return match ? match[0] : "";
    }
    if (key === "ad") {
      const match = normalized.match(/(?:AD|広告費|広告料)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?ヶ月|[0-9]+(?:\.[0-9]+)?%|[0-9][0-9,]*円|あり|有|なし)/i);
      return match ? match[0] : "";
    }
    if (key === "room") {
      const match = normalized.match(/([0-9A-Za-z-]+)\s*号室|部屋番号\s*([0-9A-Za-z-]+)/);
      return match ? match[1] || match[2] || "" : "";
    }
    return "";
  }

  function isAiSearchOrFilterContainer(node) {
    const text = normalizeText(node && (node.innerText || node.textContent || "") || "");
    if (!text) return false;
    const filterMarkers = ["条件保存", "条件呼び出し", "絞り込み", "所在地で絞り込み", "路線・駅", "物件名（カナ検索可）", "募集条件"];
    const markerCount = filterMarkers.filter((marker) => text.includes(marker)).length;
    return markerCount >= 2;
  }

  function getAiSnippetEntry(node, index, options) {
    const htmlLimit = options && options.htmlLimit || 8000;
    const textLimit = options && options.textLimit || 500;
    return {
      index,
      tag: node.tagName.toLowerCase(),
      id: node.id || "",
      className: typeof node.className === "string" ? node.className : "",
      stableCssPath: buildStableCssPath(node),
      candidateSelectors: buildAiCandidateSelectors(node),
      textPreview: truncateText(normalizeText(node.innerText || node.textContent || ""), textLimit),
      html: sanitizeHtmlForAiWithLimit(node, htmlLimit),
    };
  }

  function buildAiCandidateSelectors(node) {
    if (!node || !node.tagName) return [];
    const selectors = [];
    const tag = node.tagName.toLowerCase();
    if (node.id) selectors.push(`#${cssIdentifier(node.id)}`);
    const dataSelector = getNodeDataSelector(node);
    if (dataSelector) selectors.push(dataSelector);
    const classTokens = getStableClassTokens(node).slice(0, 3);
    if (classTokens.length) selectors.push(`${tag}.${classTokens.map(cssIdentifier).join(".")}`);
    if (classTokens.length) selectors.push(`.${cssIdentifier(classTokens[0])}`);
    const path = buildStableCssPath(node);
    if (path) selectors.push(path);
    return selectors.filter((selector, index, list) => selector && list.indexOf(selector) === index).slice(0, 6);
  }

  function buildStableCssPath(node) {
    if (!node || !node.tagName) return "";
    const parts = [];
    let current = node;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < 5) {
      const tag = current.tagName.toLowerCase();
      const dataSelector = getNodeDataSelector(current);
      if (current.id) {
        parts.unshift(`#${cssIdentifier(current.id)}`);
        break;
      }
      if (dataSelector) {
        parts.unshift(dataSelector);
      } else {
        const classTokens = getStableClassTokens(current).slice(0, 2);
        if (classTokens.length) {
          parts.unshift(`${tag}.${classTokens.map(cssIdentifier).join(".")}`);
        } else {
          parts.unshift(tag);
        }
      }
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(" > ");
  }

  function getNodeDataSelector(node) {
    const attrs = Array.from(node.attributes || []);
    const attr = attrs.find((candidate) => /^data-(testid|test|cy|qa|field|name|label|role)$/i.test(candidate.name) && candidate.value);
    return attr ? `${node.tagName.toLowerCase()}[${attr.name}='${cssAttributeValue(attr.value)}']` : "";
  }

  function getStableClassTokens(node) {
    return String(node.className || "")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !/^(is|has|js|active|selected|open|closed|hover|focus|ng-|css-|sc-|_)/i.test(token))
      .filter((token) => !/[0-9a-f]{8,}|^\d+$/.test(token));
  }

  function cssIdentifier(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value || ""));
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssAttributeValue(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function sanitizeHtmlForAi(node) {
    return sanitizeHtmlForAiWithLimit(node, 8000);
  }

  function getSanitizedBodyHtmlForAi() {
    return sanitizeHtmlForAiWithLimit(document.body, 60000);
  }

  function getAiHtmlSource(config, options) {
    const mode = options && options.htmlScopeMode ? options.htmlScopeMode : "body";
    if (mode === "selected") {
      return {
        mode,
        label: options && options.selectedNode ? "選択した要素" : "選択した要素（未選択のためbody）",
        node: options && options.selectedNode || document.body,
      };
    }
    if (mode === "item") {
      const node = getAiItemSnippetNodes(config)[0] || document.body;
      return { mode, label: node === document.body ? "1物件候補なし（body）" : "1物件候補", node };
    }
    if (mode === "room") {
      const node = getAiRoomSnippetNodes(config)[0] || document.body;
      return { mode, label: node === document.body ? "1部屋候補なし（body）" : "1部屋候補", node };
    }
    return { mode: "body", label: "body全体", node: document.body };
  }

  function sanitizeHtmlForAiWithLimit(node, limit) {
    if (!node || !node.cloneNode) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("script, style, svg, canvas, iframe, noscript").forEach((child) => child.remove());
    removeAiNonContentElements(clone);
    clone.querySelectorAll("*").forEach((child) => {
      sanitizeAiHtmlElement(child);
    });
    if (clone.hasAttribute) {
      sanitizeAiHtmlElement(clone);
    }
    return truncateText((clone.outerHTML || "").replace(/\s+/g, " "), limit);
  }

  function removeAiNonContentElements(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("form, nav, header, footer, aside, [role='search'], [role='navigation'], [aria-label], [class], [id]").forEach((node) => {
      if (!node || !node.parentElement) return;
      if (shouldRemoveAiNonContentBlock(node)) node.remove();
    });
    root.querySelectorAll("input, textarea, select, option, button, datalist, fieldset, legend").forEach((node) => {
      if (node && node.parentElement) node.remove();
    });
  }

  function shouldRemoveAiNonContentBlock(node) {
    if (!node || node.closest && node.closest(`#${APP_ID}, #${APP_ID}-modal`)) return true;
    const tag = node.tagName || "";
    const text = normalizeText(node.innerText || node.textContent || "");
    const attrText = normalizeText([
      node.id || "",
      typeof node.className === "string" ? node.className : "",
      node.getAttribute && node.getAttribute("role") || "",
      node.getAttribute && node.getAttribute("aria-label") || "",
      node.getAttribute && node.getAttribute("data-testid") || "",
      node.getAttribute && node.getAttribute("data-test") || "",
      node.getAttribute && node.getAttribute("data-cy") || "",
    ].join(" "));
    if (hasRoomLikeText(text)) return false;
    if (/^(NAV|HEADER|FOOTER|ASIDE)$/.test(tag)) return true;
    const searchMarkers = countAiSearchFilterMarkers(`${attrText} ${text}`);
    if (tag === "FORM" && searchMarkers >= 1) return true;
    if (searchMarkers >= 2) return true;
    return false;
  }

  function countAiSearchFilterMarkers(value) {
    const text = normalizeNumberText(value).toLowerCase();
    const markers = [
      /検索|絞り込み|条件|条件保存|条件呼び出し|募集条件|所在地で絞り込み|路線・駅|駅徒歩|賃料.*万円|専有面積.*㎡/,
      /\bsearch\b|\bfilter\b|\bfilters\b|\bcondition\b|\bconditions\b|\bsidebar\b|\bdrawer\b|\bnav\b|\bnavigation\b/,
      /checkbox|radio|combobox|select|pulldown|フォーム|form/,
    ];
    return markers.reduce((count, regex) => count + (regex.test(text) ? 1 : 0), 0);
  }

  function sanitizeAiHtmlElement(node) {
    Array.from(node.attributes || []).forEach((attr) => {
      const name = attr.name;
      const lowerName = name.toLowerCase();
      if (/^on/i.test(name) || lowerName === "style") {
        node.removeAttribute(name);
        return;
      }
      if (isSensitiveAiHtmlAttribute(lowerName)) {
        node.setAttribute(name, "[omitted]");
      }
    });
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT") {
      if (node.hasAttribute("value")) node.setAttribute("value", "[omitted]");
      if (node.tagName === "TEXTAREA") node.textContent = "[omitted]";
      if (node.tagName === "SELECT") Array.from(node.options || []).forEach((option) => option.removeAttribute("selected"));
    }
  }

  function isSensitiveAiHtmlAttribute(name) {
    return name === "href"
      || name === "src"
      || name === "srcset"
      || name === "action"
      || name === "value"
      || name === "data-detailurl"
      || /token|session|csrf|auth|password|secret|credential|key|url|uri/i.test(name);
  }

  function truncateText(value, limit) {
    const text = String(value || "");
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.floor(limit * 0.7))}\n...[truncated ${text.length - limit} chars]...\n${text.slice(-Math.floor(limit * 0.3))}`;
  }

  function parseAiSelectorResponse(value) {
    const text = String(value || "").trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    if (!text) throw new Error("empty AI response");
    const envelopeText = normalizeJsonPunctuationOutsideStrings(text);
    const jsonText = extractJsonObjectText(envelopeText);
    const relaxedText = repairRelaxedJsonText(jsonText);
    const quoteRepairedText = repairCssAttributeQuotesInJsonText(jsonText);
    const relaxedQuoteRepairedText = repairCssAttributeQuotesInJsonText(relaxedText);
    const candidates = [
      jsonText,
      escapeInvalidJsonBackslashes(jsonText),
      quoteRepairedText,
      escapeInvalidJsonBackslashes(quoteRepairedText),
      relaxedText,
      escapeInvalidJsonBackslashes(relaxedText),
      relaxedQuoteRepairedText,
      escapeInvalidJsonBackslashes(relaxedQuoteRepairedText),
    ].filter((candidate, index, list) => list.indexOf(candidate) === index);
    let lastError = null;
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("invalid JSON");
  }

  function extractJsonObjectText(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("JSON object not found");
    return text.slice(start, end + 1);
  }

  function escapeInvalidJsonBackslashes(text) {
    let result = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (!inString) {
        result += char;
        if (char === "\"") inString = true;
        continue;
      }
      if (escaped) {
        result += /["\\\/bfnrtu]/.test(char) ? `\\${char}` : `\\\\${char}`;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      result += char;
      if (char === "\"") inString = false;
    }
    if (escaped) result += "\\\\";
    return result;
  }

  function repairRelaxedJsonText(text) {
    let result = stripJsonCommentsOutsideStrings(text);
    result = normalizeJsonPunctuationOutsideStrings(result);
    result = quoteUnquotedJsonKeys(result);
    result = removeTrailingJsonCommasOutsideStrings(result);
    return result;
  }

  function stripJsonCommentsOutsideStrings(text) {
    let result = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < String(text || "").length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (inString) {
        result += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        result += char;
        continue;
      }
      if (char === "/" && next === "/") {
        while (index < text.length && text[index] !== "\n") index += 1;
        result += "\n";
        continue;
      }
      if (char === "/" && next === "*") {
        index += 2;
        while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
        index += 1;
        continue;
      }
      result += char;
    }
    return result;
  }

  function normalizeJsonPunctuationOutsideStrings(text) {
    let result = "";
    let inString = false;
    let escaped = false;
    const map = {
      "｛": "{",
      "｝": "}",
      "［": "[",
      "］": "]",
      "，": ",",
      "：": ":",
      "“": "\"",
      "”": "\"",
      "„": "\"",
      "＂": "\"",
    };
    for (let index = 0; index < String(text || "").length; index += 1) {
      const char = text[index];
      if (inString) {
        const next = /[“”„＂]/.test(char) ? "\"" : char;
        result += next;
        if (escaped) {
          escaped = false;
        } else if (next === "\\") {
          escaped = true;
        } else if (next === "\"") {
          inString = false;
        }
        continue;
      }
      const next = map[char] || char;
      result += next;
      if (next === "\"") inString = true;
    }
    return result;
  }

  function quoteUnquotedJsonKeys(text) {
    return String(text || "").replace(
      /([{,]\s*)([A-Za-z_$][\w$-]*|[ぁ-んァ-ヶ一-龠々ー]+)(\s*:)/g,
      (_match, prefix, key, suffix) => `${prefix}"${key}"${suffix}`
    );
  }

  function removeTrailingJsonCommasOutsideStrings(text) {
    let result = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < String(text || "").length; index += 1) {
      const char = text[index];
      if (inString) {
        result += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        result += char;
        continue;
      }
      if (char === ",") {
        let nextIndex = index + 1;
        while (/\s/.test(text[nextIndex] || "")) nextIndex += 1;
        if (text[nextIndex] === "}" || text[nextIndex] === "]") continue;
      }
      result += char;
    }
    return result;
  }

  function repairCssAttributeQuotesInJsonText(text) {
    return String(text || "").replace(
      /(\[[^\[\]\r\n="'`]+(?:[*^$|~]?=)\s*)"([^"\]\r\n]*)"(\s*[is]?\])/gi,
      (_match, before, value, after) => `${before}\\"${value}\\"${after}`
    );
  }

  function applyAiListingResponse(config, response, options) {
    const source = response && (response.listingExtractor || response.config || response.rules || response);
    const report = createAiReviewReport();
    if (!source || typeof source !== "object") {
      report.errors.push("JSONの中に設定として読めるオブジェクトがありません。");
      return options && options.collectReport ? { applied: 0, report } : 0;
    }
    let applied = 0;
    const itemSelector = getFirstAiString(source.itemSelector || source.item || source.itemCss || source.itemSelectorCandidates, report, "1物件のまとまり");
    if (typeof itemSelector === "string") {
      config.itemSelector = itemSelector.trim();
      applied += 1;
    }
    const rowSelector = getFirstAiString(source.rowSelector || source.roomSelector || source.row || source.room || source.rowSelectorCandidates, report, "1部屋のまとまり");
    if (typeof rowSelector === "string") {
      config.rowSelector = rowSelector.trim();
      applied += 1;
    }
    if (typeof source.scopeMode === "string") {
      config.scopeMode = normalizeListingScopeMode(source.scopeMode);
      applied += 1;
    }
    applyAiStrategyMetadata(config, source, report);
    const tableApplied = applyAiTableExtractionResponse(config, getAiTableExtractionSpec(source), report);
    if (tableApplied) applied += tableApplied;
    const fields = collectAiFieldSpecs(source, report, { allowEmpty: tableApplied > 0 });
    Object.entries(fields).forEach(([rawKey, rawSpec]) => {
      const key = normalizeAiFieldKey(rawKey);
      if (!key) {
        report.warnings.push(`未対応の項目名を無視しました: ${rawKey}`);
        return;
      }
      if (key !== rawKey) report.corrections.push(`${rawKey} を ${key} として読み替えました。`);
      const spec = normalizeAiFieldSpec(rawSpec, report, getListingFieldLabel(key));
      if (!spec || typeof spec !== "object") return;
      const field = ensureListingField(config, key, getListingFieldLabel(key));
      removeAiManagedFallbackRules(field);
      const selectorRule = ensurePrimaryListingRule(field, "selector");
      const regexRule = ensurePrimaryListingRule(field, "regex");
      if (typeof spec.scope === "string") {
        selectorRule.scope = normalizeListingScope(spec.scope, getDefaultListingScope(key, config));
        regexRule.scope = toListingTextScope(selectorRule.scope);
      }
      const selector = getFirstAiString(spec.selector || spec.css || spec.cssSelector || spec.valueSelector || spec.selectorCandidates, report, getListingFieldLabel(key));
      if (typeof selector === "string") {
        selectorRule.selector = selector.trim();
        selectorRule.attribute = spec.attribute || selectorRule.attribute || "text";
        selectorRule.aiManaged = true;
      }
      getAiSelectorCandidates(spec).slice(1, 4).forEach((candidate) => {
        field.rules.push({
          type: "selector",
          enabled: true,
          aiManagedFallback: true,
          selector: candidate,
          attribute: spec.attribute || "text",
          scope: selectorRule.scope || getDefaultListingScope(key, config),
          lineMode: normalizeAiLineMode(spec.lineMode || ""),
          normalizer: selectorRule.normalizer || normalizeAiNormalizer(key, spec.normalizer || spec.format || spec.formatter),
        });
        report.corrections.push(`${getListingFieldLabel(key)} の予備セレクタを追加しました: ${truncateText(candidate, 80)}`);
      });
      if (Array.isArray(spec.selector) || Array.isArray(spec.selectors) || Array.isArray(spec.selectorCandidates)) {
        report.corrections.push(`${getListingFieldLabel(key)} の候補配列から先頭を主セレクタ、残りを予備として読み込みました。`);
      }
      if (typeof spec.lineMode === "string") selectorRule.lineMode = normalizeAiLineMode(spec.lineMode);
      const normalizer = spec.normalizer || spec.format || spec.formatter;
      if (typeof normalizer === "string") {
        selectorRule.normalizer = normalizeAiNormalizer(key, normalizer);
        regexRule.normalizer = selectorRule.normalizer;
      } else {
        selectorRule.normalizer = selectorRule.normalizer || getDefaultListingNormalizer(key);
        regexRule.normalizer = regexRule.normalizer || selectorRule.normalizer;
      }
      const regex = spec.regex || spec.pattern;
      if (typeof regex === "string") {
        regexRule.type = "regex";
        regexRule.pattern = regex.trim();
        regexRule.group = Number.isInteger(spec.group) ? spec.group : Number.isInteger(spec.captureGroup) ? spec.captureGroup : 1;
        regexRule.flags = typeof spec.flags === "string" ? spec.flags : "";
        syncListingRegexToSelectorRule(selectorRule, regexRule);
      }
      applied += 1;
    });
    ensureListingOutputColumns(config);
    report.applied = applied;
    return options && options.collectReport ? { applied, report } : applied;
  }

  function applyAiStrategyMetadata(config, source, report) {
    const strategy = normalizeAiExtractionStrategy(source.extractionStrategy || source.strategy || source.mode || "");
    if (strategy) {
      config.aiMetadata = {
        ...(config.aiMetadata || {}),
        extractionStrategy: strategy,
        selfCheck: source.selfCheck && typeof source.selfCheck === "object" ? clonePlain(source.selfCheck) : null,
      };
      report.corrections.push(`AIの抽出方式を記録しました: ${strategy}`);
    } else if (source.selfCheck && typeof source.selfCheck === "object") {
      config.aiMetadata = {
        ...(config.aiMetadata || {}),
        selfCheck: clonePlain(source.selfCheck),
      };
    }
  }

  function normalizeAiExtractionStrategy(value) {
    const text = String(value || "").trim();
    if (/roomCells|room_cells|cell/i.test(text)) return "roomCells";
    if (/table/i.test(text)) return "tableExtraction";
    if (/css|selector|card|div/i.test(text)) return "css";
    return "";
  }

  function createAiReviewReport() {
    return {
      applied: 0,
      corrections: [],
      warnings: [],
      errors: [],
      fieldScores: [],
      rows: [],
      rowCount: 0,
      previewRowCount: 0,
      previewRowTotal: 0,
      itemCount: 0,
      roomCount: 0,
      retryPrompt: "",
    };
  }

  function createAiParseErrorReport(error) {
    const report = createAiReviewReport();
    report.errors.push(`JSONを読み取れませんでした: ${error && error.message ? error.message : "不明なエラー"}`);
    return report;
  }

  function getAiTableExtractionSpec(source) {
    if (!source || typeof source !== "object") return null;
    if (source.tableExtraction && typeof source.tableExtraction === "object") return source.tableExtraction;
    if (source.tableConfig && typeof source.tableConfig === "object") return source.tableConfig;
    if (source.table && typeof source.table === "object") return source.table;
    if ((source.tableSelector || source.tableCss || source.table_css) && (source.columns || source.columnMap || source.fieldColumns || source.fields)) return source;
    return null;
  }

  function applyAiTableExtractionResponse(config, rawSpec, report) {
    if (!rawSpec || typeof rawSpec !== "object") return 0;
    if (rawSpec.enabled === false) {
      config.tableExtraction = createDefaultTableExtraction();
      report.corrections.push("テーブル抽出を無効として読み込みました。");
      return 1;
    }
    const normalized = normalizeAiTableExtractionSpec(rawSpec, report);
    const sanitized = sanitizeTableExtractionConfig({
      ...createDefaultTableExtraction(),
      ...normalized,
      enabled: true,
      columns: normalized.columns,
    });
    if (!sanitized.tableSelector) {
      report.warnings.push("tableExtraction はありますが tableSelector がないため無視しました。");
      return 0;
    }
    if (!Object.keys(sanitized.columns || {}).length) {
      report.warnings.push("tableExtraction はありますが columns が空のため無視しました。");
      return 0;
    }
    config.tableExtraction = sanitized;
    report.corrections.push("テーブル抽出設定を読み込みました。");
    return 1;
  }

  function normalizeAiTableExtractionSpec(spec, report) {
    const modeValue = spec.mode || spec.type || spec.tableMode || "";
    const tableSelector = getFirstAiString(spec.tableSelector || spec.tableCss || spec.table_css || spec.selector || spec.css, report, "テーブル");
    const rowSelector = getFirstAiString(spec.rowSelector || spec.trSelector || spec.row || spec.rows, report, "テーブル行");
    const roomSelector = getFirstAiString(spec.roomSelector || spec.roomCellSelector || spec.roomCells, report, "部屋セル");
    const cellSelector = getFirstAiString(spec.cellSelector || spec.tdSelector || spec.cells, report, "セル");
    return {
      mode: /roomCells|roomCell|cell|rooms/i.test(String(modeValue || "")) ? "roomCells" : "standard",
      tableSelector: typeof tableSelector === "string" ? tableSelector : "",
      rowSelector: typeof rowSelector === "string" ? rowSelector : "tr",
      cellSelector: typeof cellSelector === "string" ? cellSelector : "td,th",
      headerRowIndex: normalizeTableRowIndex(spec.headerRowIndex != null ? spec.headerRowIndex : spec.headerIndex, 0),
      dataStartRowIndex: normalizeTableRowIndex(spec.dataStartRowIndex != null ? spec.dataStartRowIndex : spec.dataStartIndex != null ? spec.dataStartIndex : spec.firstDataRowIndex, 1),
      roomSelector: typeof roomSelector === "string" ? roomSelector : "",
      buildingNameSelector: typeof spec.buildingNameSelector === "string" ? spec.buildingNameSelector : typeof spec.propertyNameSelector === "string" ? spec.propertyNameSelector : "",
      excludeColumns: Array.isArray(spec.excludeColumns) ? spec.excludeColumns : [],
      columns: normalizeAiTableColumns(spec.columns || spec.columnMap || spec.fieldColumns || spec.fields || spec, report),
    };
  }

  function normalizeAiTableColumns(rawColumns, report) {
    const columns = {};
    if (Array.isArray(rawColumns)) {
      rawColumns.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        const key = normalizeTableColumnKey(entry.key || entry.field || entry.name || entry.label);
        if (!key) {
          report.warnings.push(`未対応のテーブル列を無視しました: ${entry.key || entry.field || entry.name || entry.label || "名称なし"}`);
          return;
        }
        columns[key] = normalizeTableColumnSpec(entry, key);
      });
      return columns;
    }
    if (!rawColumns || typeof rawColumns !== "object") return columns;
    Object.entries(rawColumns).forEach(([rawKey, value]) => {
      if (["enabled", "mode", "type", "tableSelector", "tableCss", "table_css", "selector", "css", "rowSelector", "trSelector", "row", "rows", "cellSelector", "tdSelector", "cells", "headerRowIndex", "headerIndex", "dataStartRowIndex", "dataStartIndex", "firstDataRowIndex", "roomSelector", "roomCellSelector", "roomCells", "buildingNameSelector", "propertyNameSelector", "excludeColumns"].includes(rawKey)) return;
      const key = normalizeTableColumnKey(rawKey);
      if (!key) return;
      const spec = normalizeTableColumnSpec(value, key);
      if (spec) columns[key] = spec;
    });
    return columns;
  }

  function collectAiFieldSpecs(source, report, options) {
    const fields = { ...(source.fields || source.fieldRules || source.fieldSelectors || {}) };
    if (source.selectors && typeof source.selectors === "object" && !Array.isArray(source.selectors)) {
      Object.entries(source.selectors).forEach(([key, value]) => {
        if (key === "itemSelector" || key === "rowSelector") return;
        if (fields[key] == null) fields[key] = value;
      });
    }
    getListingFieldIds().forEach(({ key }) => {
      if (source[key] != null && fields[key] == null) fields[key] = source[key];
    });
    if (!Object.keys(fields).length && !(options && options.allowEmpty)) report.warnings.push("fields / selectors に項目別設定が見つかりません。");
    return fields;
  }

  function normalizeAiFieldSpec(rawSpec, report, label) {
    if (typeof rawSpec === "string" || Array.isArray(rawSpec)) return { selector: rawSpec };
    if (!rawSpec || typeof rawSpec !== "object") {
      report.warnings.push(`${label} はオブジェクトではないため無視しました。`);
      return null;
    }
    const spec = { ...rawSpec };
    if (spec.value && !spec.selector) spec.selector = spec.value;
    if (spec.css_path && !spec.selector) spec.selector = spec.css_path;
    if (spec.cssPath && !spec.selector) spec.selector = spec.cssPath;
    if (spec.capture_group != null && spec.group == null) spec.group = spec.capture_group;
    if (spec.captureGroup != null && spec.group == null) spec.group = spec.captureGroup;
    if (spec.line_mode && !spec.lineMode) spec.lineMode = spec.line_mode;
    return spec;
  }

  function getFirstAiString(value, report, label) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const strings = value.filter((candidate) => typeof candidate === "string" && candidate.trim());
      if (strings.length) {
        report.corrections.push(`${label} の候補配列から先頭を使いました。`);
        return strings[0];
      }
    }
    return undefined;
  }

  function getAiSelectorCandidates(spec) {
    const candidates = [];
    [spec.selector, spec.css, spec.cssSelector, spec.valueSelector, spec.selectors, spec.selectorCandidates, spec.candidates, spec.fallbackSelectors].forEach((value) => {
      if (typeof value === "string" && value.trim()) candidates.push(value.trim());
      if (Array.isArray(value)) {
        value.forEach((candidate) => {
          if (typeof candidate === "string" && candidate.trim()) candidates.push(candidate.trim());
          if (candidate && typeof candidate === "object") {
            const selector = candidate.selector || candidate.css || candidate.cssSelector;
            if (typeof selector === "string" && selector.trim()) candidates.push(selector.trim());
          }
        });
      }
    });
    return candidates.filter((candidate, index, list) => list.indexOf(candidate) === index);
  }

  function removeAiManagedFallbackRules(field) {
    if (!field || !Array.isArray(field.rules)) return;
    field.rules = field.rules.filter((rule) => !rule.aiManagedFallback);
  }

  function replaceListingExtractorConfig(target, source) {
    Object.keys(target).forEach((key) => delete target[key]);
    Object.assign(target, clonePlain(source));
  }

  function validateAiListingDraft(config, baseReport) {
    const report = baseReport || createAiReviewReport();
    report.itemCount = countSelectorForAiReview(config.itemSelector, document);
    report.roomCount = countConfiguredRoomsForAiReview(config);
    if (config.itemSelector) {
      validateSelectorForAiReview(config.itemSelector, "1物件のまとまり", report);
      if (report.itemCount === 0) report.warnings.push(`1物件のまとまりが0件です: ${config.itemSelector}`);
      addSelectorQualityWarnings(config.itemSelector, "1物件のまとまり", report);
    }
    if (config.rowSelector) {
      validateSelectorForAiReview(config.rowSelector, "1部屋のまとまり", report);
      if (report.roomCount === 0) report.warnings.push(`1部屋のまとまりが0件です: ${config.rowSelector}`);
      addSelectorQualityWarnings(config.rowSelector, "1部屋のまとまり", report);
    }
    validateTableExtractionForAiReview(config, report);
    const tableRowsAvailable = extractTableBasedListingRows(config).length > 0;
    getListingFieldIds().forEach(({ key, label }) => {
      const field = config.fields && config.fields[key];
      const hasTableField = isTableExtractionConfiguredForField(config, key);
      if ((!field || !hasConfiguredFieldInput(field)) && !hasTableField) {
        if (key !== "availableDate" && key !== "ad") report.warnings.push(`${label} の取得設定がありません。`);
        return;
      }
      report.fieldScores.push(scoreAiConfiguredField(config, key, label));
      if (hasTableField && tableRowsAvailable) return;
      ((field && field.rules) || []).forEach((rule) => {
        if (rule && rule.type === "selector" && rule.selector) {
          validateSelectorForAiReview(rule.selector, label, report);
          addSelectorQualityWarnings(rule.selector, label, report);
        }
      });
    });
    const previewRows = extractRowsForListingConfig(config);
    previewRows.forEach((row) => {
      row._fieldIssues = buildAiRowFieldIssues(row);
    });
    report.rowCount = previewRows.length;
    report.previewRowTotal = previewRows.length;
    report.rows = previewRows.slice(0, AI_PREVIEW_ROW_LIMIT);
    report.previewRowCount = report.rows.length;
    if (!report.rowCount) report.errors.push("この設定ではテーブル行を作れませんでした。1物件/1部屋のまとまり、または各項目のCSSを見直してください。");
    applyAiSelfCheckWarnings(config, report);
    addAiRowIssueWarnings(report);
    report.fieldScores.forEach((score) => {
      const requiredField = !["availableDate", "ad"].includes(score.key);
      if (score.configured && score.valueCount === 0) report.warnings.push(`${score.label} は設定済みですが取得値が0件です。`);
      if (score.configured && score.valueCount > 0 && score.formatOkCount === 0 && score.requiresFormat) {
        const message = `${score.label} は取得値の形式が項目に合っていません。`;
        if (requiredField) report.errors.push(message);
        else report.warnings.push(message);
      }
      if (score.configured && requiredField && score.issueReasons && score.issueReasons.some((reason) => reason.includes("別項目の値"))) {
        report.errors.push(`${score.label} は別項目の値を拾っている可能性があります。`);
      }
      if (score.configured && score.sameValueCount >= 3 && score.valueCount >= 4 && score.uniqueCount <= 1) report.warnings.push(`${score.label} が全行ほぼ同じ値です。広すぎるセレクタの可能性があります。`);
    });
    return report;
  }

  function applyAiSelfCheckWarnings(config, report) {
    const selfCheck = config && config.aiMetadata && config.aiMetadata.selfCheck;
    if (!selfCheck || typeof selfCheck !== "object") return;
    const expected = Number(selfCheck.expectedRowCount || selfCheck.rowCount || selfCheck.expectedRows);
    if (Number.isFinite(expected) && expected >= 0) {
      const diff = Math.abs((report.rowCount || 0) - expected);
      if (diff >= Math.max(2, Math.ceil(expected * 0.3))) {
        report.warnings.push(`AIの想定行数 ${expected}件 に対して、仮プレビューは ${report.rowCount || 0}件です。行のまとまりがズレている可能性があります。`);
      }
    }
    const uncertainFields = Array.isArray(selfCheck.uncertainFields) ? selfCheck.uncertainFields.filter(Boolean) : [];
    if (uncertainFields.length) report.warnings.push(`AIが自信低めとした項目: ${uncertainFields.slice(0, 8).join(" / ")}`);
  }

  function addAiRowIssueWarnings(report) {
    const rows = Array.isArray(report && report.rows) ? report.rows : [];
    const issueRows = rows.filter((row) => row && row._fieldIssues && Object.keys(row._fieldIssues).length);
    if (!issueRows.length) return;
    report.warnings.push(`行単位の確認点が ${issueRows.length}/${rows.length}件あります。仮プレビューの強調セルを確認してください。`);
    issueRows.slice(0, 5).forEach((row) => {
      const labels = Object.keys(row._fieldIssues).map(getListingFieldLabel).join(" / ");
      report.warnings.push(`${row.index || "?"}行目: ${labels} を確認してください。`);
    });
  }

  function buildAiRowFieldIssues(row) {
    const issues = {};
    getListingFieldIds().forEach(({ key, label }) => {
      const value = normalizeText(row && row[key] || "");
      if (!value || key === "buildingName") return;
      const raw = row && row._rawValues && (row._rawValues[key] || row._rawValues.rowText) || value;
      if (!isAiFieldValueFormatOk(key, value, raw)) {
        issues[key] = `${label}の値が想定形式と違う可能性があります: ${truncateText(value, 40)}`;
      }
    });
    if (row && isFloorOnlyRoomValue(row.room || "")) {
      issues.room = "号室ではなく階数だけを拾っている可能性があります。";
    }
    if (row && row.rent && row.managementFee) {
      const rent = parseJapaneseYenAmount(row.rent, { allowManYen: true, assumeYenForPlainNumber: true });
      const fee = parseJapaneseYenAmount(row.managementFee, { allowManYen: true, assumeYenForPlainNumber: true });
      if (rent && fee && fee >= rent) issues.managementFee = "管理費が賃料以上です。賃料と管理費を取り違えている可能性があります。";
    }
    return issues;
  }

  function buildListingConfigDiffSummary(beforeConfig, afterConfig) {
    const diffs = [];
    if ((beforeConfig.itemSelector || "") !== (afterConfig.itemSelector || "")) {
      diffs.push(`1物件CSS: ${truncateText(beforeConfig.itemSelector || "未設定", 60)} → ${truncateText(afterConfig.itemSelector || "未設定", 60)}`);
    }
    if ((beforeConfig.rowSelector || "") !== (afterConfig.rowSelector || "")) {
      diffs.push(`1部屋CSS: ${truncateText(beforeConfig.rowSelector || "未設定", 60)} → ${truncateText(afterConfig.rowSelector || "未設定", 60)}`);
    }
    const beforeTable = serializeAiTableExtractionConfig(beforeConfig.tableExtraction);
    const afterTable = serializeAiTableExtractionConfig(afterConfig.tableExtraction);
    if (JSON.stringify(beforeTable) !== JSON.stringify(afterTable)) {
      diffs.push(`テーブル抽出: ${beforeTable.enabled ? "有効" : "無効"} → ${afterTable.enabled ? "有効" : "無効"}`);
      if ((beforeTable.tableSelector || "") !== (afterTable.tableSelector || "")) {
        diffs.push(`テーブルCSS: ${truncateText(beforeTable.tableSelector || "未設定", 60)} → ${truncateText(afterTable.tableSelector || "未設定", 60)}`);
      }
    }
    getListingFieldIds().forEach(({ key, label }) => {
      const beforeRule = serializeFieldPrimaryRuleForDiff(beforeConfig, key);
      const afterRule = serializeFieldPrimaryRuleForDiff(afterConfig, key);
      if (beforeRule !== afterRule) diffs.push(`${label}: ${truncateText(beforeRule || "未設定", 80)} → ${truncateText(afterRule || "未設定", 80)}`);
    });
    return diffs.slice(0, 16);
  }

  function serializeFieldPrimaryRuleForDiff(config, key) {
    const field = config && config.fields && config.fields[key];
    if (!field) return "";
    const selectorRule = getListingFieldRule(field, "selector");
    const regexRule = getListingFieldRule(field, "regex");
    return JSON.stringify({
      scope: selectorRule && selectorRule.scope || "",
      selector: selectorRule && selectorRule.selector || "",
      regex: regexRule && (regexRule.pattern || regexRule.regex) || selectorRule && (selectorRule.pattern || selectorRule.regex) || "",
      lineMode: selectorRule && selectorRule.lineMode || "",
      normalizer: selectorRule && selectorRule.normalizer || "",
    });
  }

  function addAdoptionRiskWarnings(beforeConfig, afterConfig, report) {
    if (!report) return;
    const beforeRows = extractRowsForListingConfig(beforeConfig);
    const afterRows = Array.isArray(report.rows) ? report.rows : extractRowsForListingConfig(afterConfig);
    if (beforeRows.length >= 3 && afterRows.length < Math.max(1, Math.floor(beforeRows.length * 0.6))) {
      report.warnings.push(`採用前確認: 現在設定では ${beforeRows.length}件、仮設定では ${afterRows.length}件です。行数が大きく減っています。`);
    }
    const importantKeys = ["room", "rent", "layout", "area"];
    importantKeys.forEach((key) => {
      const beforeCount = beforeRows.filter((row) => normalizeText(row && row[key] || "")).length;
      const afterCount = afterRows.filter((row) => normalizeText(row && row[key] || "")).length;
      if (beforeCount >= 3 && afterCount < Math.max(1, Math.floor(beforeCount * 0.5))) {
        report.warnings.push(`採用前確認: ${getListingFieldLabel(key)} の取得件数が ${beforeCount}件 → ${afterCount}件 に減っています。`);
      }
    });
  }

  function validateSelectorForAiReview(selector, label, report) {
    if (!selector) return;
    if (!isSelectorValidForPreview(selector)) {
      report.errors.push(`${label} のCSSセレクタが不正です: ${selector}`);
    }
  }

  function addSelectorQualityWarnings(selector, label, report) {
    if (!selector) return;
    if ((selector.match(/:nth-child|:nth-of-type/g) || []).length >= 3) {
      report.warnings.push(`${label} は nth-child が多く、サイト更新で壊れやすい可能性があります: ${truncateText(selector, 100)}`);
    }
    if (selector.length > 180) {
      report.warnings.push(`${label} のCSSが長すぎます。安定したclassやdata属性に短縮できるか確認してください。`);
    }
    if (/^\.?[a-z0-9_-]+$/i.test(selector) && countSelectorForAiReview(selector, document) > 80) {
      report.warnings.push(`${label} のCSSが広すぎる可能性があります: ${selector}`);
    }
  }

  function countSelectorForAiReview(selector, scope) {
    if (!selector || !isSelectorValidForPreview(selector)) return 0;
    return querySelectorAllForPreview(scope || document, selector).length;
  }

  function countConfiguredRoomsForAiReview(config) {
    try {
      const tableCount = countTableExtractionRowsForAiReview(config);
      if (tableCount) return tableCount;
      return getConfiguredItemScopes(config).reduce((sum, item) => sum + getConfiguredRowScopes(item, config).length, 0);
    } catch (error) {
      return 0;
    }
  }

  function scoreAiConfiguredField(config, key, label) {
    if (isTableExtractionConfiguredForField(config, key)) return scoreAiTableConfiguredField(config, key, label);
    const field = config.fields && config.fields[key];
    const contexts = getListingPreviewContexts(config).slice(0, 20);
    const values = [];
    const rawValues = [];
    const emptyReasons = [];
    contexts.forEach((context) => {
      const value = extractConfiguredField(key, field, context, {});
      if (value) values.push(value);
      const preview = field ? getConfiguredFieldFormatPreview(key, field, context, config) : null;
      if (preview && preview.raw) rawValues.push(preview.raw);
      if (!value) emptyReasons.push(getConfiguredFieldEmptyReason(key, field, context, config));
    });
    const uniqueValues = Array.from(new Set(values.map((value) => normalizeText(value))));
    const requiresFormat = ["room", "rent", "managementFee", "deposit", "keyMoney", "availableDate", "ad", "layout", "area"].includes(key);
    const formatOkCount = values.filter((value, index) => isAiFieldValueFormatOk(key, value, rawValues[index] || "")).length;
    const selectorRule = field ? getListingFieldRule(field, "selector") : null;
    const regexRule = field ? getListingFieldRule(field, "regex") : null;
    const issueReasons = buildAiFieldIssueReasons(key, {
      configured: hasConfiguredFieldInput(field),
      contextCount: contexts.length,
      valueCount: values.length,
      uniqueCount: uniqueValues.length,
      formatOkCount,
      requiresFormat,
      selectorRule,
      emptyReasons,
      values,
      rawValues,
    });
    return {
      key,
      label,
      configured: hasConfiguredFieldInput(field),
      contextCount: contexts.length,
      valueCount: values.length,
      uniqueCount: uniqueValues.length,
      sameValueCount: values.length - uniqueValues.length,
      formatOkCount,
      requiresFormat,
      score: calculateAiFieldScore(values.length, contexts.length, uniqueValues.length, formatOkCount, requiresFormat),
      samples: values.slice(0, 3),
      rawSamples: rawValues.slice(0, 3),
      emptyReasons: Array.from(new Set(emptyReasons.filter(Boolean))).slice(0, 4),
      issueReasons,
      currentRule: serializeAiFieldRuleForRetry(selectorRule, regexRule, key),
      instruction: buildAiFieldRetryInstruction(key, label, issueReasons),
    };
  }

  function validateTableExtractionForAiReview(config, report) {
    const tableConfig = config && config.tableExtraction ? sanitizeTableExtractionConfig(config.tableExtraction) : null;
    if (!tableConfig || tableConfig.enabled !== true) return;
    if (!tableConfig.tableSelector) {
      report.errors.push("テーブル抽出が有効ですが、tableSelector がありません。");
      return;
    }
    validateSelectorForAiReview(tableConfig.tableSelector, "テーブル", report);
    if (tableConfig.rowSelector) validateSelectorForAiReview(tableConfig.rowSelector, "テーブル行", report);
    if (tableConfig.roomSelector) validateSelectorForAiReview(tableConfig.roomSelector, "部屋セル", report);
    if (tableConfig.buildingNameSelector) validateSelectorForAiReview(tableConfig.buildingNameSelector, "物件名", report);
    const tableCount = tableConfig.tableSelector && isSelectorValidForPreview(tableConfig.tableSelector)
      ? safeQuerySelectorAll(document, tableConfig.tableSelector).length
      : 0;
    if (!tableCount) report.errors.push(`テーブルが0件です: ${tableConfig.tableSelector}`);
    if (!Object.keys(tableConfig.columns || {}).length) report.errors.push("テーブル抽出の columns が空です。");
  }

  function countTableExtractionRowsForAiReview(config) {
    const tableConfig = config && config.tableExtraction ? sanitizeTableExtractionConfig(config.tableExtraction) : null;
    if (!tableConfig || tableConfig.enabled !== true) return 0;
    if (tableConfig.mode === "roomCells") {
      return getTableExtractionRoots(tableConfig).reduce((sum, root) => sum + getRoomCellTableRowNodes(root, tableConfig).length, 0);
    }
    return getTableExtractionRoots(tableConfig).reduce((sum, table) => {
      return sum + Math.max(0, getStandardTableRowNodes(table, tableConfig).length - tableConfig.dataStartRowIndex);
    }, 0);
  }

  function isTableExtractionConfiguredForField(config, key) {
    const tableConfig = config && config.tableExtraction ? sanitizeTableExtractionConfig(config.tableExtraction) : null;
    if (!tableConfig || tableConfig.enabled !== true) return false;
    const columns = tableConfig.columns || {};
    if (columns[key]) return true;
    return (key === "deposit" || key === "keyMoney") && Boolean(columns.depositKeyMoney);
  }

  function scoreAiTableConfiguredField(config, key, label) {
    const rows = extractTableBasedListingRows(config).slice(0, 20);
    const values = rows.map((row) => row[key]).filter(Boolean);
    const rawValues = rows.map((row) => {
      if (!row || !row._rawValues) return "";
      return row._rawValues[key] || ((key === "deposit" || key === "keyMoney") ? row._rawValues.depositKeyMoney : "") || row._rawValues.rowText || "";
    }).filter(Boolean);
    const uniqueValues = Array.from(new Set(values.map((value) => normalizeText(value))));
    const requiresFormat = ["room", "rent", "managementFee", "deposit", "keyMoney", "availableDate", "ad", "layout", "area"].includes(key);
    const formatOkCount = values.filter((value, index) => isAiFieldValueFormatOk(key, value, rawValues[index] || value)).length;
    const issueReasons = buildAiFieldIssueReasons(key, {
      configured: true,
      contextCount: rows.length,
      valueCount: values.length,
      uniqueCount: uniqueValues.length,
      formatOkCount,
      requiresFormat,
      selectorRule: null,
      emptyReasons: rows.length && !values.length ? ["テーブル列から値を作れません"] : [],
      values,
      rawValues,
    });
    return {
      key,
      label,
      configured: true,
      contextCount: rows.length,
      valueCount: values.length,
      uniqueCount: uniqueValues.length,
      sameValueCount: values.length - uniqueValues.length,
      formatOkCount,
      requiresFormat,
      score: calculateAiFieldScore(values.length, rows.length, uniqueValues.length, formatOkCount, requiresFormat),
      samples: values.slice(0, 3),
      rawSamples: rawValues.slice(0, 3),
      emptyReasons: rows.length && !values.length ? ["テーブル列から値を作れません"] : [],
      issueReasons,
      currentRule: serializeAiTableFieldRuleForRetry(config, key),
      instruction: buildAiFieldRetryInstruction(key, label, issueReasons),
    };
  }

  function serializeAiTableFieldRuleForRetry(config, key) {
    const tableConfig = config && config.tableExtraction ? sanitizeTableExtractionConfig(config.tableExtraction) : createDefaultTableExtraction();
    const columns = tableConfig.columns || {};
    const relevantColumns = {};
    if (columns[key]) relevantColumns[key] = columns[key];
    if ((key === "deposit" || key === "keyMoney") && columns.depositKeyMoney) relevantColumns.depositKeyMoney = columns.depositKeyMoney;
    return {
      tableExtraction: {
        enabled: true,
        mode: tableConfig.mode,
        tableSelector: tableConfig.tableSelector,
        rowSelector: tableConfig.rowSelector,
        cellSelector: tableConfig.cellSelector,
        dataStartRowIndex: tableConfig.dataStartRowIndex,
        roomSelector: tableConfig.roomSelector,
        columns: relevantColumns,
      },
    };
  }

  function buildAiFieldIssueReasons(key, info) {
    const issues = [];
    if (!info.configured) issues.push("項目の取得設定がありません。");
    if (info.selectorRule && info.selectorRule.selector && !isSelectorValidForPreview(info.selectorRule.selector)) {
      issues.push(`CSSセレクタが不正です: ${info.selectorRule.selector}`);
    }
    if (info.configured && info.valueCount === 0) {
      issues.push(`取得値が0件です。理由例: ${info.emptyReasons.filter(Boolean).slice(0, 2).join(" / ") || "不明"}`);
    }
    if (info.configured && info.contextCount && info.valueCount > 0 && info.valueCount < info.contextCount) {
      issues.push(`一部の行で未取得です: ${info.valueCount}/${info.contextCount}件`);
    }
    if (info.configured && info.valueCount > 0 && info.requiresFormat && info.formatOkCount === 0) {
      issues.push(`取得値が${getAiFieldExpectedFormat(key)}の形式に合っていません。`);
    }
    if (info.configured && info.valueCount > 0 && info.requiresFormat && info.formatOkCount > 0 && info.formatOkCount < info.valueCount) {
      issues.push(`形式に合わない値が混ざっています: ${info.formatOkCount}/${info.valueCount}件だけ正常`);
    }
    const wrongTypeSamples = getWrongTypeSamplesForAiField(key, info.values || [], info.rawValues || [], info.selectorRule);
    if (wrongTypeSamples.length) {
      issues.push(`別項目の値を拾っている可能性があります: ${wrongTypeSamples.join(" / ")}`);
    }
    if (info.configured && info.valueCount >= 4 && info.uniqueCount <= 1 && key !== "buildingName") {
      issues.push("全行で同じ値になっています。セレクタが広すぎるか、物件/部屋のスコープが違う可能性があります。");
    }
    if (info.selectorRule && info.selectorRule.selector && (info.selectorRule.selector.match(/:nth-child|:nth-of-type/g) || []).length >= 3) {
      issues.push("nth-childが多く、安定しないセレクタです。class/data属性/見出し近くの構造を優先してください。");
    }
    return issues;
  }

  function serializeAiFieldRuleForRetry(selectorRule, regexRule, key) {
    return {
      scope: selectorRule && selectorRule.scope || getDefaultListingScope(key, getListingExtractorConfig()),
      selector: selectorRule && selectorRule.selector || "",
      selectorCandidates: selectorRule && selectorRule.aiManagedFallback ? [selectorRule.selector || ""] : undefined,
      lineMode: selectorRule && selectorRule.lineMode || "",
      normalizer: selectorRule && selectorRule.normalizer || getDefaultListingNormalizer(key),
      regex: regexRule && (regexRule.pattern || regexRule.regex) || selectorRule && (selectorRule.pattern || selectorRule.regex) || "",
      group: regexRule && Number.isInteger(regexRule.group) ? regexRule.group : selectorRule && Number.isInteger(selectorRule.group) ? selectorRule.group : 1,
    };
  }

  function buildAiFieldRetryInstruction(key, label, issues) {
    if (!issues.length) return `${label}は大きな問題がなければ変更しないでください。`;
    const expected = getAiFieldExpectedFormat(key);
    const scopeHint = key === "buildingName" ? "1物件内(item)" : "1部屋内(row)";
    return `${label}だけを重点的に直してください。${scopeHint}から、${expected}として使える値だけを返すselector/regex/lineMode/normalizerにしてください。`;
  }

  function getAiFieldExpectedFormat(key) {
    const formats = {
      buildingName: "物件名テキスト",
      room: "号室",
      rent: "円表記の賃料",
      managementFee: "円表記の管理費",
      deposit: "ヶ月または円表記の敷金",
      keyMoney: "ヶ月または円表記の礼金",
      availableDate: "入居日、即入居、相談など",
      ad: "AD/広告料の値。なければ未記載",
      layout: "1K/1LDKなどの間取り",
      area: "㎡表記の面積",
    };
    return formats[key] || "項目に合う値";
  }

  function calculateAiFieldScore(valueCount, contextCount, uniqueCount, formatOkCount, requiresFormat) {
    if (!contextCount) return 0;
    const coverageScore = Math.round((valueCount / contextCount) * 45);
    const formatRate = requiresFormat ? (formatOkCount / Math.max(1, valueCount)) : 1;
    const formatScore = Math.round(formatRate * 40);
    const varietyScore = uniqueCount > 1 || valueCount <= 2 ? 15 : 0;
    let score = coverageScore + formatScore + varietyScore;
    if (requiresFormat && valueCount > 0 && formatOkCount < valueCount) score = Math.min(score, 84);
    if (requiresFormat && valueCount > 0 && formatOkCount === 0) score = Math.min(score, 45);
    return Math.max(0, Math.min(100, score));
  }

  function isAiFieldValueFormatOk(key, value, rawValue) {
    const text = normalizeText(value);
    const raw = normalizeText(rawValue || value);
    if (!text) return false;
    if (key === "buildingName") return !hasAnyAiFieldToken(raw, ["money", "area", "layout", "date", "ad"]) && text.length >= 2;
    if (key === "room") return isExpectedRoomValue(text, raw);
    if (key === "rent") return isExpectedYenValue(text, raw, { allowZero: false, max: 10000000, label: "rent" });
    if (key === "managementFee") return isExpectedYenValue(text, raw, { allowZero: true, max: 500000, label: "fee" });
    if (key === "deposit" || key === "keyMoney") return isExpectedLeaseCostValue(text, raw);
    if (key === "area") return isExpectedAreaValue(text, raw);
    if (key === "layout") return isExpectedLayoutValue(text, raw);
    if (key === "availableDate") return isExpectedAvailableDateValue(text, raw);
    if (key === "ad") return isExpectedAdValue(text, raw);
    return true;
  }

  function isExpectedRoomValue(value, rawValue) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    const raw = normalizeNumberText(rawValue);
    if (hasAnyAiFieldToken(raw, ["money", "area", "layout", "ad"])) return false;
    return /号室$/.test(text) || /^[0-9]{2,5}[A-Za-z]?$/.test(text);
  }

  function isExpectedYenValue(value, rawValue, options) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    const raw = normalizeNumberText(rawValue);
    if (hasAnyAiFieldToken(raw, ["area", "layout", "date", "ad"])) return false;
    if (!options.allowZero && /^(0円|なし|無し|無料|不要|-)$/.test(text)) return false;
    if (!/^[0-9][0-9,]*円$/.test(text)) return false;
    const amount = parseIntegerAmount(text.replace(/円$/, ""));
    if (amount == null) return false;
    if (!options.allowZero && amount <= 0) return false;
    if (amount < 0 || amount > options.max) return false;
    if (options.label === "rent" && amount < 10000) return false;
    return true;
  }

  function isExpectedLeaseCostValue(value, rawValue) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    const raw = normalizeNumberText(rawValue);
    if (hasAnyAiFieldToken(raw, ["area", "layout", "date", "ad"])) return false;
    if (/^(なし|無し|無|無料|不要|-|0|0円|0ヶ月)$/.test(text)) return true;
    if (/^[0-9]+(?:\.[0-9]+)?(?:ヶ月|か月|ヵ月|カ月|ケ月)$/.test(text)) return true;
    if (/^[0-9][0-9,]*円$/.test(text)) return true;
    return false;
  }

  function isExpectedAreaValue(value, rawValue) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    const raw = normalizeNumberText(rawValue);
    if (hasAnyAiFieldToken(raw, ["money", "layout", "date", "ad"])) return false;
    const match = text.match(/^([0-9]+(?:\.[0-9]+)?)㎡$/);
    if (!match) return false;
    const area = Number(match[1]);
    return Number.isFinite(area) && area >= 5 && area <= 300;
  }

  function isExpectedLayoutValue(value, rawValue) {
    const text = normalizeNumberText(value).replace(/\s+/g, "").toUpperCase();
    const raw = normalizeNumberText(rawValue);
    if (hasAnyAiFieldToken(raw, ["money", "area", "date", "ad"])) return false;
    return /^(?:ワンルーム|[1-9][0-9]?(?:R|K|DK|LDK|SLDK|SDK|SK))$/.test(text);
  }

  function isExpectedAvailableDateValue(value, rawValue) {
    const text = normalizeNumberText(value);
    const raw = normalizeNumberText(rawValue);
    if (hasAnyAiFieldToken(raw, ["money", "area", "layout", "ad"])) return false;
    return /即|相談|入居|空|予定|[0-9]{4}年|[0-9]{1,2}月|上旬|中旬|下旬/.test(text);
  }

  function isExpectedAdValue(value, rawValue) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    const raw = normalizeNumberText(rawValue);
    if (text === "未記載") return !/\bAD\b|広告料|広告費/i.test(raw) || /未記載|なし|無し|無/.test(raw);
    if (!/\bAD\b|広告料|広告費/i.test(raw)) return false;
    if (hasAnyAiFieldToken(raw, ["area", "layout", "date"])) return false;
    return /^[0-9]+(?:\.[0-9]+)?(?:%|％|ヶ月|か月|ヵ月|カ月|ケ月|円)?$/.test(text) || /あり|有|相談/.test(text);
  }

  function hasAnyAiFieldToken(text, tokenTypes) {
    const raw = normalizeNumberText(text);
    return tokenTypes.some((type) => {
      if (type === "money") return /[0-9][0-9,.]*\s*(?:万(?:円)?|円)|賃料|家賃|管理費|共益費/.test(raw);
      if (type === "area") return /[0-9]+(?:\.[0-9]+)?\s*(?:㎡|m2|m²|平米)|面積|専有/.test(raw);
      if (type === "layout") return /(?:^|[^A-Z0-9])(?:[1-9][0-9]?\s*(?:SLDK|LDK|SDK|DK|SK|R|K)|ワンルーム)(?:$|[^A-Z])/i.test(raw) || /間取り/.test(raw);
      if (type === "date") return /即入居|入居|相談|[0-9]{4}年|[0-9]{1,2}月|上旬|中旬|下旬/.test(raw);
      if (type === "ad") return /\bAD\b|広告料|広告費/i.test(raw);
      return false;
    });
  }

  function getWrongTypeSamplesForAiField(key, values, rawValues, selectorRule) {
    const samples = [];
    const selector = selectorRule && selectorRule.selector ? selectorRule.selector : "";
    const selectorToken = getSelectorWrongTypeHint(key, selector);
    if (selectorToken) samples.push(selectorToken);
    values.forEach((value, index) => {
      const raw = rawValues[index] || value;
      if (!isAiFieldValueFormatOk(key, value, raw)) {
        samples.push(`${truncateText(raw, 40)} → ${truncateText(value, 40)}`);
      }
    });
    return Array.from(new Set(samples)).slice(0, 3);
  }

  function getSelectorWrongTypeHint(key, selector) {
    const text = String(selector || "").toLowerCase();
    if (!text) return "";
    const hints = [
      ["area", /area|m2|m²|meter|㎡|専有|面積/],
      ["layout", /layout|madori|間取り|roomtype/],
      ["rent", /rent|price|賃料|家賃/],
      ["managementFee", /management|fee|common|管理|共益/],
      ["availableDate", /available|date|入居|空室/],
      ["ad", /advert|ad|広告/],
      ["room", /room|number|号室|部屋/],
    ];
    const matched = hints.find(([candidateKey, pattern]) => candidateKey !== key && pattern.test(text));
    return matched ? `selector名が${getListingFieldLabel(matched[0])}系に見えます: ${selector}` : "";
  }

  function renderAiReviewPanel(container, report) {
    if (!container) return;
    container.innerHTML = "";
    if (!report) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const status = el("div", "rech-ai-review-status");
    const statusText = report.errors.length ? "要修正" : report.warnings.length ? "確認あり" : "採用可能";
    status.dataset.state = report.errors.length ? "error" : report.warnings.length ? "warning" : "ok";
    const previewRowCount = report.previewRowCount || report.rows.length || 0;
    const previewRowTotal = report.previewRowTotal || report.rowCount || previewRowCount;
    const tableCountText = previewRowTotal > previewRowCount ? `表 ${previewRowCount}/${previewRowTotal}件表示` : `表 ${previewRowTotal}件`;
    status.appendChild(el("strong", "", statusText));
    status.appendChild(el("span", "", `反映候補 ${report.applied || 0}件 / ${tableCountText} / 物件 ${report.itemCount || 0}件 / 部屋 ${report.roomCount || 0}件`));
    container.appendChild(status);
    if (report.rows.length) {
      const preview = el("div", "rech-ai-table-preview");
      preview.appendChild(el("strong", "", previewRowTotal > previewRowCount ? `仮プレビュー（${previewRowCount}/${previewRowTotal}件）` : `仮プレビュー（${previewRowCount}件）`));
      if (previewRowTotal > previewRowCount) preview.appendChild(el("small", "rech-ai-preview-note", `先頭${previewRowCount}件を表示しています。`));
      preview.appendChild(renderListingTable(report.rows));
      container.appendChild(preview);
    }
    if (report.corrections.length) container.appendChild(renderAiReviewList("自動補正", report.corrections, "correction"));
    if (report.configDiffs && report.configDiffs.length) container.appendChild(renderAiReviewList("設定差分", report.configDiffs, "correction"));
    if (report.errors.length) container.appendChild(renderAiReviewList("エラー", report.errors, "error"));
    if (report.warnings.length) container.appendChild(renderAiReviewList("警告", report.warnings, "warning"));
    if (report.fieldScores.length) container.appendChild(renderAiFieldScoreTable(report.fieldScores, report));
  }

  function renderAiReviewList(title, items, state) {
    const wrapper = el("div", `rech-ai-review-list is-${state}`);
    wrapper.appendChild(el("strong", "", title));
    const list = el("ul", "");
    items.slice(0, 12).forEach((item) => list.appendChild(el("li", "", item)));
    if (items.length > 12) list.appendChild(el("li", "", `ほか ${items.length - 12}件`));
    wrapper.appendChild(list);
    return wrapper;
  }

  function renderAiFieldScoreTable(scores, report) {
    const wrapper = el("div", "rech-ai-score");
    wrapper.appendChild(el("strong", "", "項目別の採点"));
    wrapper.appendChild(el("small", "rech-ai-score-note", "修正依頼に含める項目だけチェックしてください。正しい項目は警告が出ていても外せます。"));
    const defaultTargets = new Set(getAiRetryTargetFields(report).map((score) => score.key));
    if (!Array.isArray(report.retryFieldKeys)) {
      report.retryFieldKeys = Array.from(defaultTargets);
    }
    const table = el("table", "rech-ai-score-table");
    const thead = document.createElement("thead");
    const head = document.createElement("tr");
    ["修正", "項目", "点", "取得", "形式", "問題", "例"].forEach((label) => head.appendChild(el("th", "", label)));
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    scores.forEach((score) => {
      const tr = document.createElement("tr");
      const checkCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = report.retryFieldKeys.includes(score.key);
      checkbox.title = `${score.label}を修正依頼に含める`;
      checkbox.addEventListener("change", () => {
        const selected = new Set(report.retryFieldKeys || []);
        if (checkbox.checked) selected.add(score.key);
        else selected.delete(score.key);
        report.retryFieldKeys = Array.from(selected);
      });
      checkCell.appendChild(checkbox);
      tr.appendChild(checkCell);
      tr.appendChild(el("td", "", score.label));
      tr.appendChild(el("td", "", String(score.score)));
      tr.appendChild(el("td", "", `${score.valueCount}/${score.contextCount}`));
      tr.appendChild(el("td", "", score.requiresFormat ? `${score.formatOkCount}/${score.valueCount || 0}` : "-"));
      tr.appendChild(el("td", "", score.issueReasons && score.issueReasons.length ? score.issueReasons.slice(0, 2).join(" / ") : "-"));
      tr.appendChild(el("td", "", score.samples.join(" / ")));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  function buildAiSelectorRetryPrompt(report, previousJsonText, options) {
    const previousJson = safeParseJsonObject(previousJsonText);
    const targetFields = getAiRetryTargetFields(report);
    const targetKeys = new Set(targetFields.map((score) => score.key));
    const fieldProblems = targetFields.map((score) => ({
      key: score.key,
      label: score.label,
      currentRule: score.currentRule,
      previousJsonFragment: findPreviousAiFieldFragment(previousJson, score.key, score.label),
      score: score.score,
      retrieved: `${score.valueCount}/${score.contextCount}`,
      formatOk: score.requiresFormat ? `${score.formatOkCount}/${score.valueCount || 0}` : "-",
      samples: score.samples,
      emptyReasons: score.emptyReasons,
      problems: score.issueReasons,
      expectedFormat: getAiFieldExpectedFormat(score.key),
      instruction: score.instruction,
    }));
    const globalProblems = filterAiGlobalProblemsForRetry(report, targetKeys);
    const userReviewNote = normalizeText(options && options.userReviewNote || "");
    const selectedFieldKeys = Array.isArray(report && report.retryFieldKeys) ? report.retryFieldKeys.slice() : targetFields.map((score) => score.key);
    const excludedFieldKeys = Array.isArray(report && report.fieldScores)
      ? report.fieldScores.filter((score) => !selectedFieldKeys.includes(score.key)).map((score) => score.key)
      : [];
    return [
      `前回の抽出設定JSONを修正してください。これは${options && options.round ? `${options.round}回目` : "次"}の修正依頼です。`,
      "全体を作り直すのではなく、下のfieldProblemsに出ている項目を優先して直してください。",
      "extractionStrategyは css / tableExtraction / roomCells の主方式を維持し、必要がない限り別方式へ変えないでください。",
      "humanReviewNoteがある場合は、自動判定より人間の目視判断を優先してください。",
      "問題のない項目はなるべく変更しないでください。",
      "サイト専用の固定ロジックではなく、同じ一覧内で繰り返し使えるCSSセレクタにしてください。",
      "selectorに自信がない場合はselectorCandidatesに複数候補を入れてください。",
      "回答はJSONだけにしてください。説明文やMarkdownコードフェンスは不要です。",
      "",
      "修正対象:",
      JSON.stringify({
        humanReviewNote: userReviewNote || "未記入",
        selectedFieldKeys,
        excludedFieldKeys,
        globalProblems,
        fieldProblems: fieldProblems.length ? fieldProblems : [{
          note: "明確な項目別エラーはありません。nth-childが多い、広すぎる、長すぎるセレクタがあれば安定した候補へ改善してください。",
        }],
        rowSummary: {
          rowCount: report.rowCount,
          itemCount: report.itemCount,
          roomCount: report.roomCount,
          rowIssues: (report.rows || []).filter((row) => row && row._fieldIssues && Object.keys(row._fieldIssues).length).slice(0, 10).map((row) => ({
            rowIndex: row.index,
            issues: row._fieldIssues,
            sample: {
              room: row.room || "",
              rent: row.rent || "",
              managementFee: row.managementFee || "",
              layout: row.layout || "",
              area: row.area || "",
            },
          })),
        },
        requiredOutputShape: {
          tableExtraction: "HTMLテーブルで抽出している場合は維持または修正。表でない場合は使わない",
          itemSelector: "必要なら修正。問題なければ前回値を維持",
          rowSelector: "必要なら修正。問題なければ前回値を維持",
          fields: "修正対象項目だけでなく、最終的に使う全fieldsを含める",
        },
      }, null, 2),
      "",
      "前回JSON:",
      safeExtractJsonObjectText(previousJsonText),
    ].join("\n");
  }

  function getAiRetryTargetFields(report) {
    const scores = Array.isArray(report && report.fieldScores) ? report.fieldScores : [];
    if (Array.isArray(report && report.retryFieldKeys)) {
      const selected = new Set(report.retryFieldKeys);
      return scores.filter((score) => selected.has(score.key));
    }
    const targets = scores.filter((score) => {
      if (!score.configured) return true;
      if (score.issueReasons && score.issueReasons.length) return true;
      if (score.valueCount === 0) return true;
      if (score.score < 75) return true;
      return false;
    });
    return targets.length ? targets : scores.filter((score) => score.score < 95).slice(0, 3);
  }

  function filterAiGlobalProblemsForRetry(report, targetKeys) {
    const scores = Array.isArray(report && report.fieldScores) ? report.fieldScores : [];
    const fieldLabels = scores.map((score) => [score.key, score.label]);
    const isFieldSpecific = (message) => {
      const matched = fieldLabels.find(([, label]) => message.startsWith(`${label} `) || message.startsWith(`${label}は`) || message.startsWith(`${label} は`));
      if (!matched) return true;
      return targetKeys.has(matched[0]);
    };
    return [
      ...report.errors.map((text) => ({ level: "error", message: text })),
      ...report.warnings.map((text) => ({ level: "warning", message: text })),
    ].filter((entry) => isFieldSpecific(entry.message));
  }

  function safeParseJsonObject(value) {
    try {
      return parseAiSelectorResponse(value);
    } catch (error) {
      return null;
    }
  }

  function findPreviousAiFieldFragment(previousJson, key, label) {
    const fields = previousJson && previousJson.fields ? previousJson.fields : previousJson && previousJson.selectors ? previousJson.selectors : null;
    if (!fields || typeof fields !== "object") return null;
    if (fields[key]) return fields[key];
    if (fields[label]) return fields[label];
    const entry = Object.entries(fields).find(([rawKey]) => normalizeAiFieldKey(rawKey) === key);
    return entry ? entry[1] : null;
  }

  function safeExtractJsonObjectText(value) {
    try {
      return extractJsonObjectText(String(value || "{}"));
    } catch (error) {
      return truncateText(String(value || ""), 12000) || "{}";
    }
  }

  function normalizeListingScopeMode(value) {
    const mode = String(value || "").trim();
    return mode === "item" || mode === "row" || mode === "document" || mode === "mixed" ? mode : "mixed";
  }

  function normalizeAiFieldKey(value) {
    const key = String(value || "").trim();
    const compactKey = key.replace(/[\s_-]+/g, "").toLowerCase();
    const aliases = {
      propertyName: "buildingName",
      property_name: "buildingName",
      building_name: "buildingName",
      buildingName: "buildingName",
      building: "buildingName",
      name: "buildingName",
      "物件名": "buildingName",
      "建物名": "buildingName",
      roomNumber: "room",
      room_number: "room",
      roomNo: "room",
      room_no: "room",
      room: "room",
      "号室": "room",
      "部屋番号": "room",
      rent: "rent",
      monthlyRent: "rent",
      monthly_rent: "rent",
      "賃料": "rent",
      "家賃": "rent",
      fee: "managementFee",
      management: "managementFee",
      managementFee: "managementFee",
      management_fee: "managementFee",
      commonServiceFee: "managementFee",
      common_service_fee: "managementFee",
      "管理費": "managementFee",
      "共益費": "managementFee",
      deposit: "deposit",
      "敷金": "deposit",
      keyMoney: "keyMoney",
      key_money: "keyMoney",
      "礼金": "keyMoney",
      key: "keyMoney",
      available: "availableDate",
      availableDate: "availableDate",
      available_date: "availableDate",
      moveIn: "availableDate",
      move_in: "availableDate",
      "入居日": "availableDate",
      "入居可能日": "availableDate",
      ad: "ad",
      advertisementFee: "ad",
      advertisement_fee: "ad",
      "広告料": "ad",
      layout: "layout",
      "間取り": "layout",
      madori: "layout",
      area: "area",
      areaM2: "area",
      area_m2: "area",
      squareMeter: "area",
      square_meter: "area",
      "面積": "area",
      "専有面積": "area",
    };
    if (aliases[key]) return aliases[key];
    const compactAliases = {
      propertyname: "buildingName",
      buildingname: "buildingName",
      roomnumber: "room",
      roomno: "room",
      monthlyrent: "rent",
      managementfee: "managementFee",
      commonservicefee: "managementFee",
      keymoney: "keyMoney",
      availabledate: "availableDate",
      movein: "availableDate",
      advertisementfee: "ad",
      aream2: "area",
      squaremeter: "area",
    };
    if (compactAliases[compactKey]) return compactAliases[compactKey];
    return getListingFieldIds().some((field) => field.key === key) ? key : "";
  }

  function getListingFieldLabel(key) {
    const field = getListingFieldIds().find((candidate) => candidate.key === key);
    return field ? field.label : key;
  }

  function normalizeAiNormalizer(key, value) {
    const normalizer = String(value || "").trim();
    const compactNormalizer = normalizer.replace(/[\s_-]+/g, "").toLowerCase();
    const aliases = {
      "円表記": "yen",
      "賃料": "rent",
      "賃料円表記": "rent",
      "月表記": "month",
      "賃料で月換算": "rentMonth",
      "間取り": "layout",
      "㎡表記": "area",
      "面積": "area",
      "そのまま": "text",
    };
    const compactAliases = {
      currency: "yen",
      yen: "yen",
      rent: "rent",
      rentmonth: "rentMonth",
      month: "month",
      m2: "area",
      sqm: "area",
      squaremeter: "area",
      layout: "layout",
      date: "availableDate",
      availabledate: "availableDate",
      advertisement: "ad",
      ad: "ad",
      text: "text",
      raw: "text",
    };
    if (compactAliases[compactNormalizer]) return compactAliases[compactNormalizer];
    return aliases[normalizer] || normalizer || getDefaultListingNormalizer(key);
  }

  function normalizeAiLineMode(value) {
    const mode = String(value || "").trim();
    const aliases = {
      all: "",
      text: "",
      none: "",
      upper: "firstLine",
      lower: "secondLine",
      first: "firstLine",
      second: "secondLine",
    };
    const normalized = aliases[mode] != null ? aliases[mode] : mode;
    return getLineExtractionOptions().some(([optionValue]) => optionValue === normalized) ? normalized : "";
  }

  function getListingFieldIds() {
    return [
      { key: "buildingName", label: "物件名" },
      { key: "room", label: "号室" },
      { key: "rent", label: "賃料" },
      { key: "managementFee", label: "管理費" },
      { key: "deposit", label: "敷金" },
      { key: "keyMoney", label: "礼金" },
      { key: "availableDate", label: "入居日" },
      { key: "ad", label: "AD" },
      { key: "layout", label: "間取り" },
      { key: "area", label: "面積" },
    ];
  }

  function ensureListingField(config, key, label) {
    if (!config.fields || typeof config.fields !== "object") config.fields = {};
    if (!config.fields[key]) config.fields[key] = createListingField(label, key !== "availableDate" && key !== "ad", []);
    if (!Array.isArray(config.fields[key].rules)) config.fields[key].rules = [];
    return config.fields[key];
  }

  function ensurePrimaryListingRule(field, type) {
    let rule = field.rules.find((candidate) => candidate.type === type);
    if (!rule) {
      rule = { type };
      field.rules.push(rule);
    }
    return rule;
  }

  function syncListingRegexToSelectorRule(selectorRule, regexRule) {
    if (!selectorRule || !regexRule) return;
    const pattern = regexRule.pattern || regexRule.regex || "";
    if (pattern) {
      selectorRule.pattern = pattern;
      selectorRule.group = Number.isInteger(regexRule.group) ? regexRule.group : 1;
      selectorRule.flags = regexRule.flags || "";
    } else {
      delete selectorRule.pattern;
      delete selectorRule.regex;
      delete selectorRule.group;
      delete selectorRule.flags;
    }
  }

  function getDefaultListingNormalizer(key) {
    if (key === "rent") return "rent";
    if (key === "managementFee") return "yen";
    if (key === "deposit") return "rentMonth";
    if (key === "keyMoney") return "rentMonth";
    if (key === "layout") return "layout";
    if (key === "area") return "area";
    if (key === "availableDate") return "availableDate";
    if (key === "ad") return "ad";
    return "text";
  }

  function getNormalizerOptions(key) {
    const base = [["text", "そのまま"]];
    if (key === "rent") {
      return [["rent", "円表記"], ...base];
    }
    if (key === "managementFee") {
      return [["yen", "円表記"], ...base];
    }
    if (key === "keyMoney") {
      return [["rentMonth", "賃料で月換算"], ["month", "月表記"], ["yen", "円表記"], ...base];
    }
    if (key === "deposit") {
      return [["rentMonth", "賃料で月換算"], ["month", "月表記"], ["yen", "円表記"], ...base];
    }
    if (key === "area") {
      return [["area", "㎡表記"], ...base];
    }
    if (key === "layout") {
      return [["layout", "間取り"], ...base];
    }
    if (key === "availableDate" || key === "ad") {
      return [[getDefaultListingNormalizer(key), "表記ゆれ"], ...base];
    }
    return base;
  }

  function getDefaultListingScope(key, config) {
    const mode = (config && config.scopeMode ? String(config.scopeMode) : "mixed").trim();
    if (mode === "document") return "document";
    if (key === "buildingName") return "item";
    if (isRoomScopedListingField(key) && config && config.rowSelector) return "row";
    if (mode === "item" || mode === "row") return mode;
    return "row";
  }

  function isRoomScopedListingField(key) {
    return ["room", "rent", "managementFee", "deposit", "keyMoney", "availableDate", "ad", "layout", "area"].includes(key);
  }

  function normalizeListingScope(value, fallback) {
    const scope = String(value || fallback || "row").trim();
    const compactScope = scope.replace(/[\s_-]+/g, "").toLowerCase();
    const aliases = {
      property: "item",
      building: "item",
      listing: "item",
      itemscope: "item",
      room: "row",
      roomscope: "row",
      rowtext: "row",
      itemtext: "item",
      body: "document",
      page: "document",
      global: "document",
      documentscope: "document",
    };
    if (aliases[compactScope]) return aliases[compactScope];
    if (scope === "itemText") return "item";
    if (scope === "rowText") return "row";
    if (scope === "item" || scope === "row" || scope === "document") return scope;
    return fallback || "row";
  }

  function toListingTextScope(scope) {
    const normalized = normalizeListingScope(scope, "row");
    if (normalized === "item") return "itemText";
    if (normalized === "document") return "document";
    return "rowText";
  }

  function compactInput(label, value, onInput, placeholder) {
    const control = el("label", "rech-compact-control");
    control.appendChild(el("span", "", label));
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.addEventListener("input", () => {
      onInput(input.value);
      markSettingsDirty();
    });
    control.appendChild(input);
    return control;
  }

  function compactInputWithAction(label, value, onInput, placeholder, actionLabel, onAction, helpText) {
    const control = el("div", "rech-compact-control");
    control.appendChild(helpText ? termWithHelp(label, helpText) : el("span", "", label));
    const inputWrap = el("div", "rech-input-action");
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.addEventListener("input", () => {
      onInput(input.value);
      markSettingsDirty();
    });
    const suggestions = el("div", "rech-selector-suggestions");
    const controller = {
      input,
      setValue(nextValue) {
        input.value = nextValue || "";
        onInput(input.value);
        markSettingsDirty();
      },
      setSuggestions(items) {
        renderSelectorSuggestionButtons(suggestions, items, (selector) => this.setValue(selector));
      },
    };
    inputWrap.appendChild(input);
    inputWrap.appendChild(button(actionLabel, "rech-secondary rech-mini-button", () => onAction(controller)));
    control.appendChild(inputWrap);
    control.appendChild(suggestions);
    return control;
  }

  function compactSegmentedControl(label, value, options, onChange, helpText) {
    const control = el("div", "rech-compact-control");
    control.appendChild(helpText ? termWithHelp(label, helpText) : el("span", "", label));
    const group = el("div", "rech-segmented");
    const currentValue = value || "";
    options.forEach(([optionValue, optionLabel]) => {
      const optionButton = button(optionLabel, optionValue === currentValue ? "is-active" : "", () => {
        group.querySelectorAll("button").forEach((node) => node.classList.remove("is-active"));
        optionButton.classList.add("is-active");
        onChange(optionValue);
        markSettingsDirty();
      });
      group.appendChild(optionButton);
    });
    control.appendChild(group);
    return control;
  }

  function renderBodySourcePanel() {
    const panel = el("div", "rech-source-panel");
    const header = el("div", "rech-source-panel-header");
    header.appendChild(el("strong", "", "表示中ページのHTML"));
    header.appendChild(el("span", "", location.href));
    const actions = el("div", "rech-source-actions");
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "HTML内検索";
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") updateBodySourcePanel(panel, searchInput.value);
    });
    actions.appendChild(searchInput);
    actions.appendChild(button("検索", "rech-secondary rech-mini-button", () => updateBodySourcePanel(panel, searchInput.value)));
    const selectorInput = document.createElement("input");
    selectorInput.type = "text";
    selectorInput.placeholder = "CSSで該当HTML";
    selectorInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") showSelectorSource(panel, selectorInput.value);
    });
    actions.appendChild(selectorInput);
    actions.appendChild(button("該当HTML", "rech-secondary rech-mini-button", () => showSelectorSource(panel, selectorInput.value)));
    actions.appendChild(button("全体", "rech-secondary rech-mini-button", () => updateBodySourcePanel(panel)));
    actions.appendChild(button("全選択", "rech-secondary rech-mini-button", () => selectBodySourcePanel(panel)));
    actions.appendChild(button("コピー", "rech-secondary rech-mini-button", async () => {
      try {
        await copyToClipboard(getVisibleSourceText(panel) || getBodySourceText());
        showToast("HTMLをコピーしました", "success");
      } catch (error) {
        console.warn("[RealEstateCopyHelper] HTMLコピーに失敗しました", error);
        showToast("HTMLコピーに失敗しました", "error");
      }
    }));
    header.appendChild(actions);
    const status = el("div", "rech-source-status");
    const code = el("pre", "rech-source-code");
    code.tabIndex = 0;
    panel.appendChild(header);
    panel.appendChild(status);
    panel.appendChild(code);
    updateBodySourcePanel(panel);
    return panel;
  }

  function updateBodySourcePanel(panel, searchText) {
    const code = panel && panel.querySelector ? panel.querySelector(".rech-source-code") : null;
    const status = panel && panel.querySelector ? panel.querySelector(".rech-source-status") : null;
    if (!code) return;
    const source = getBodySourceText();
    renderSourceCode(code, source, searchText);
    if (status) {
      status.textContent = searchText ? getSourceSearchStatus(source, searchText) : "body全体を表示中";
    }
  }

  function getBodySourceText() {
    return document.body ? document.body.outerHTML : "";
  }

  function selectBodySourcePanel(panel) {
    const code = panel && panel.querySelector ? panel.querySelector(".rech-source-code") : null;
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    code.focus();
  }

  function getVisibleSourceText(panel) {
    const code = panel && panel.querySelector ? panel.querySelector(".rech-source-code") : null;
    return code ? code.textContent || "" : "";
  }

  function showSelectorSource(panel, selector) {
    const code = panel && panel.querySelector ? panel.querySelector(".rech-source-code") : null;
    const status = panel && panel.querySelector ? panel.querySelector(".rech-source-status") : null;
    if (!code) return;
    const value = String(selector || "").trim();
    if (!value) {
      updateBodySourcePanel(panel);
      return;
    }
    if (!isSelectorValidForPreview(value)) {
      code.textContent = "";
      if (status) status.textContent = "CSSが不正です";
      return;
    }
    const nodes = safeQuerySelectorAll(document, value);
    const source = nodes.slice(0, 10).map((node) => node.outerHTML || "").join("\n\n");
    renderSourceCode(code, source || "", "");
    if (status) status.textContent = nodes.length ? `${nodes.length}件一致。先頭10件のHTMLを表示中` : "一致0件";
  }

  function renderSourceCode(code, source, searchText) {
    const text = String(source || "");
    const query = String(searchText || "").trim();
    if (!query) {
      code.textContent = text;
      return;
    }
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) {
      code.textContent = text;
      return;
    }
    code.innerHTML = `${escapeHtml(text.slice(0, index))}<mark>${escapeHtml(text.slice(index, index + query.length))}</mark>${escapeHtml(text.slice(index + query.length))}`;
    const marker = code.querySelector("mark");
    if (marker) marker.scrollIntoView({ block: "center", inline: "nearest" });
  }

  function getSourceSearchStatus(source, searchText) {
    const query = String(searchText || "").trim();
    if (!query) return "body全体を表示中";
    const index = String(source || "").toLowerCase().indexOf(query.toLowerCase());
    return index >= 0 ? `検索一致: ${query}` : `一致なし: ${query}`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function termWithHelp(label, helpText, tagName) {
    const wrapper = el(tagName || "span", "rech-term");
    wrapper.appendChild(document.createTextNode(label));
    wrapper.appendChild(helpIcon(helpText));
    return wrapper;
  }

  function helpIcon(helpText) {
    const node = el("button", "rech-help-icon", "?");
    node.type = "button";
    node.setAttribute("aria-label", helpText);
    node.setAttribute("data-help", helpText);
    node.title = helpText;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showHelpPopover(node, helpText);
    });
    return node;
  }

  function showHelpPopover(anchor, helpText) {
    closeHelpPopover();
    const popoverDocument = anchor.ownerDocument || document;
    const popoverWindow = popoverDocument.defaultView || window;
    const popover = el("div", "rech-help-popover");
    popover.id = `${APP_ID}-help-popover`;
    popover.textContent = helpText;
    popoverDocument.documentElement.appendChild(popover);
    helpPopoverDocument = popoverDocument;
    positionHelpPopover(popover, anchor);

    const close = (event) => {
      if (event && (event.target === anchor || popover.contains(event.target))) return;
      closeHelpPopover();
      popoverDocument.removeEventListener("pointerdown", close, true);
      popoverDocument.removeEventListener("keydown", onKeyDown, true);
      popoverWindow.removeEventListener("resize", close, true);
      popoverWindow.removeEventListener("scroll", close, true);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") close(event);
    };
    window.setTimeout(() => {
      popoverDocument.addEventListener("pointerdown", close, true);
      popoverDocument.addEventListener("keydown", onKeyDown, true);
      popoverWindow.addEventListener("resize", close, true);
      popoverWindow.addEventListener("scroll", close, true);
    }, 0);
  }

  function closeHelpPopover() {
    (helpPopoverDocument || document).getElementById(`${APP_ID}-help-popover`)?.remove();
    helpPopoverDocument = null;
  }

  function positionHelpPopover(popover, anchor) {
    const rect = anchor.getBoundingClientRect();
    const view = (anchor.ownerDocument && anchor.ownerDocument.defaultView) || window;
    const margin = 10;
    const maxLeft = Math.max(margin, view.innerWidth - popover.offsetWidth - margin);
    const left = clamp(rect.left + rect.width / 2 - popover.offsetWidth / 2, margin, maxLeft);
    const aboveTop = rect.top - popover.offsetHeight - 8;
    const belowTop = rect.bottom + 8;
    const top = aboveTop >= margin ? aboveTop : Math.min(belowTop, Math.max(margin, view.innerHeight - popover.offsetHeight - margin));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function compactCellInput(value, onInput, placeholder) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.addEventListener("input", () => {
      onInput(input.value);
      markSettingsDirty();
    });
    cell.appendChild(input);
    return cell;
  }

  function compactCellSelect(value, options, onChange) {
    const cell = document.createElement("td");
    const select = document.createElement("select");
    options.forEach(([optionValue, optionLabel]) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionLabel;
      select.appendChild(option);
    });
    select.value = value || "";
    select.addEventListener("change", () => {
      onChange(select.value);
      markSettingsDirty();
    });
    cell.appendChild(select);
    return cell;
  }

  function compactSelectorCellInput(value, onInput, placeholder, onPick, previewOptions) {
    const cell = document.createElement("td");
    cell.dataset.previewCell = "true";
    const inputWrap = el("div", "rech-cell-input-action");
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder || "";
    const preview = el("small", "rech-field-preview");
    const suggestions = el("div", "rech-selector-suggestions");
    const refreshPreview = () => refreshListingFieldPreview(preview, previewOptions);
    input.addEventListener("input", () => {
      onInput(input.value);
      markSettingsDirty();
      refreshPreview();
    });
    inputWrap.appendChild(input);
    const controller = {
      input,
      setValue(nextValue) {
        input.value = nextValue || "";
        onInput(input.value);
        markSettingsDirty();
        refreshPreview();
      },
      setSuggestions(items) {
        renderSelectorSuggestionButtons(suggestions, items, (selector) => {
          this.setValue(selector);
        });
      },
    };
    inputWrap.appendChild(button("値選択", "rech-secondary rech-mini-button", () => onPick(controller)));
    cell.appendChild(inputWrap);
    cell.appendChild(suggestions);
    cell.appendChild(preview);
    cell.refreshPreview = refreshPreview;
    refreshPreview();
    return cell;
  }

  function renderSelectorSuggestionButtons(container, suggestions, onSelect) {
    if (!container) return;
    container.innerHTML = "";
    const items = Array.isArray(suggestions) ? suggestions.filter((item) => item && item.selector) : [];
    if (!items.length) return;
    container.appendChild(el("span", "", "候補"));
    items.slice(0, 6).forEach((item) => {
      const label = `${item.selector}${Number.isFinite(item.count) ? ` (${item.count})` : ""}`;
      container.appendChild(button(label, "rech-selector-suggestion", () => onSelect(item.selector)));
    });
  }

  function refreshListingFieldPreview(probe, options) {
    if (!probe || !options || !options.field || !options.config || !options.fieldKey) return;
    const selectorRule = getListingFieldRule(options.field, "selector");
    const regexRule = getListingFieldRule(options.field, "regex");
    const hasSelector = Boolean(selectorRule && selectorRule.selector);
    const hasRegex = Boolean(regexRule && (regexRule.pattern || regexRule.regex));
    probe.classList.remove("is-error", "is-empty");
    if (!hasSelector && !hasRegex) {
      probe.textContent = "未設定";
      probe.classList.add("is-empty");
      return;
    }

    if (hasSelector && !isSelectorValidForPreview(selectorRule.selector)) {
      probe.textContent = "値の場所が不正です";
      probe.classList.add("is-error");
      return;
    }

    const preview = getListingFieldPreview(options.fieldKey, options.field, options.config);
    if (preview.error) {
      probe.textContent = preview.error;
      probe.classList.add("is-error");
      return;
    }
    if (preview.valueCount) {
      probe.textContent = `取得 ${preview.valueCount}件 / 例: ${preview.values.slice(0, 3).join(" / ")}`;
      return;
    }
    if (hasSelector) {
      probe.textContent = `一致 ${preview.matchCount}件 / 値なし`;
      if (!preview.matchCount) probe.classList.add("is-empty");
      return;
    }
    probe.textContent = "値なし";
    probe.classList.add("is-empty");
  }

  function refreshListingResultPreview(statusNode, tableNode) {
    if (!statusNode || !tableNode) return;
    const config = getListingExtractorConfig();
    const rows = extractConfiguredListingRows();
    tableNode.innerHTML = "";
    statusNode.classList.remove("is-error");
    if (rows.length) {
      statusNode.textContent = `${rows.length}件`;
      tableNode.appendChild(renderListingTable(rows.slice(0, 20)));
      return;
    }
    statusNode.textContent = getListingNoRowsMessage(config);
    statusNode.classList.add("is-error");
    tableNode.appendChild(el("div", "rech-empty", "まだ表に出せる行がありません"));
  }

  function getListingFieldRule(field, type) {
    return field && Array.isArray(field.rules) ? field.rules.find((rule) => rule && rule.type === type) : null;
  }

  function isSelectorValidForPreview(selector) {
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch (error) {
      return false;
    }
  }

  function getListingFieldPreview(fieldKey, field, config) {
    const contexts = getListingPreviewContexts(config).slice(0, 60);
    const selectorRule = getListingFieldRule(field, "selector");
    let matchCount = 0;
    const values = [];

    contexts.forEach((context) => {
      if (selectorRule && selectorRule.selector) {
        const scope = getConfiguredScope(getConfiguredRuleScope(fieldKey, selectorRule, config), context);
        matchCount += countPreviewSelectorMatches(scope, selectorRule.selector);
      }
      const localValues = {};
      const value = extractConfiguredField(fieldKey, field, context, localValues);
      if (value) values.push(value);
    });

    return {
      matchCount,
      valueCount: values.length,
      values: Array.from(new Set(values)).slice(0, 20),
    };
  }

  function getListingPreviewContexts(config) {
    const items = getListingPreviewItems(config);
    return items.flatMap((item, itemIndex) => {
      const rows = getConfiguredRowScopes(item, config);
      return (rows.length ? rows : [item]).map((row, rowIndex) => ({
        item: item === document.body && row && row !== document.body ? row : item,
        row,
        document: document.body,
        config,
        itemIndex,
        rowIndex,
      }));
    });
  }

  function getListingPreviewItems(config) {
    if (config && config.itemSelector) {
      const items = querySelectorAllForPreview(document, config.itemSelector);
      if (items.length) return items.slice(0, 30);
    }
    return document.body ? [document.body] : [];
  }

  function querySelectorAllForPreview(scope, selector) {
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch (error) {
      return [];
    }
  }

  function countPreviewSelectorMatches(scope, selector) {
    if (!scope || !selector) return 0;
    let count = querySelectorAllForPreview(scope, selector).length;
    try {
      if (scope.matches && scope.matches(selector)) count += 1;
    } catch (error) {
      // Invalid selector is checked before preview rendering.
    }
    return count;
  }

  function refreshCssProbe(control, selector) {
    const probe = control.querySelector(".rech-css-probe");
    if (!probe) return;
    if (!selector) {
      probe.textContent = "未設定";
      return;
    }
    try {
      const nodes = Array.from(document.querySelectorAll(selector));
      const firstText = nodes[0] ? normalizeText(nodes[0].innerText || nodes[0].textContent || "").slice(0, 80) : "";
      probe.textContent = `一致 ${nodes.length}件${firstText ? ` / 先頭: ${firstText}` : ""}`;
    } catch (error) {
      probe.textContent = "セレクタが不正です";
    }
  }

  function refreshListingItemSelectorPreview(probe, selector) {
    if (!probe) return;
    probe.classList.remove("is-error", "is-empty");
    if (!selector) {
      probe.textContent = "未設定 / ページ全体から試します";
      probe.classList.add("is-empty");
      return;
    }
    if (!isSelectorValidForPreview(selector)) {
      probe.textContent = "1物件のまとまりCSSが不正です";
      probe.classList.add("is-error");
      return;
    }
    const nodes = querySelectorAllForPreview(document, selector);
    if (!nodes.length) {
      probe.textContent = "一致 0件 / この状態だと一覧は取得できません";
      probe.classList.add("is-error");
      return;
    }
    const firstText = normalizeText(nodes[0].innerText || nodes[0].textContent || "").slice(0, 70);
    probe.textContent = `一致 ${nodes.length}件${firstText ? ` / 先頭: ${firstText}` : ""}`;
  }

  function refreshListingRoomSelectorPreview(probe, config) {
    if (!probe) return;
    probe.classList.remove("is-error", "is-empty");
    if (!config || !config.rowSelector) {
      probe.textContent = "未指定 / 1部屋だけならこのままで可。複数部屋は値選択から自動分割します";
      probe.classList.add("is-empty");
      return;
    }
    if (!isSelectorValidForPreview(config.rowSelector)) {
      probe.textContent = "1部屋のまとまりCSSが不正です";
      probe.classList.add("is-error");
      return;
    }
    const items = getConfiguredItemScopes(config);
    const rowCount = items.reduce((count, item) => count + getConfiguredRowScopes(item, config).length, 0);
    if (!rowCount) {
      probe.textContent = "一致 0件 / 1部屋のまとまり指定が外れています";
      probe.classList.add("is-error");
      return;
    }
    probe.textContent = `一致 ${rowCount}件`;
  }

  function highlightConfiguredListingMatches(config) {
    clearListingHighlights();
    const currentConfig = config || getListingExtractorConfig();
    const items = currentConfig.itemSelector ? safeQuerySelectorAll(document, currentConfig.itemSelector) : [];
    items.forEach((node) => node.classList.add("rech-highlight-item"));
    items.forEach((item) => {
      if (currentConfig.rowSelector) {
        getConfiguredRowScopes(item, currentConfig).forEach((node) => node.classList.add("rech-highlight-room"));
      }
    });
    getListingPreviewContexts(currentConfig).forEach((context) => {
      Object.entries((currentConfig && currentConfig.fields) || {}).forEach(([fieldId, field]) => {
        const selectorRule = getListingFieldRule(field, "selector");
        if (!selectorRule || !selectorRule.selector) return;
        const scope = getConfiguredScope(getConfiguredRuleScope(fieldId, selectorRule, currentConfig), context);
        safeQuerySelectorAllIncludingSelf(scope, selectorRule.selector).forEach((node) => node.classList.add("rech-highlight-value"));
      });
    });
    showToast("設定済みの取得場所を強調しました", "success");
    window.setTimeout(clearListingHighlights, 2400);
  }

  function clearListingHighlights() {
    document.querySelectorAll(".rech-highlight-item, .rech-highlight-room, .rech-highlight-value").forEach((node) => {
      node.classList.remove("rech-highlight-item", "rech-highlight-room", "rech-highlight-value");
    });
  }

  function startSelectorPicker(fieldId, options) {
    const field = activeProfile.fields.find((candidate) => candidate.id === fieldId);
    if (!field) return;
    stopSelectorPicker();
    showPickerNotice(`${field.label} の値をクリックしてください。Escでキャンセル`);

    const onMouseOver = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.target.classList.add("rech-picker-target");
    };
    const onMouseOut = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.target.classList.remove("rech-picker-target");
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        stopSelectorPicker();
        showPickerNotice("選択をキャンセルしました", "error");
        window.setTimeout(closePickerNotice, 900);
      }
    };
    const onClick = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const selector = buildCssSelector(event.target, document, { preferUnique: true });
      const rule = findOrCreateRule(field, "css");
      rule.selector = selector;
      rule.target = "textContent";
      activeProfile.updatedAt = new Date().toISOString();
      persistPickerChange();
      stopSelectorPicker();
      if (options && typeof options.onPicked === "function") options.onPicked(selector);
      showPickerNotice(`${field.label} の値の場所を設定しました`, "success");
      window.setTimeout(closePickerNotice, 900);
      renderPanel();
    };

    selectorPicker = { onMouseOver, onMouseOut, onKeyDown, onClick };
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
  }

  function startListingSelectorPicker(options) {
    stopSelectorPicker();
    const label = options && options.label ? options.label : "値の場所";
    const instruction = getListingPickerInstruction(options, label);
    showPickerNotice(instruction);

    const onMouseOver = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.target.classList.add("rech-picker-target");
    };
    const onMouseOut = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.target.classList.remove("rech-picker-target");
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        stopSelectorPicker();
        showPickerNotice("選択をキャンセルしました", "error");
        window.setTimeout(closePickerNotice, 900);
      }
    };
    const onClick = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();

      const selector = resolveListingPickerSelector(event.target, options);
      if (!selector) {
        showPickerNotice("値そのものではなく、範囲内の子要素を選択してください", "error");
        return;
      }
      const suggestions = getListingPickerSelectorSuggestions(event.target, options);

      applyListingPickerSelector(selector, options);
      activeProfile.updatedAt = new Date().toISOString();
      persistPickerChange();
      stopSelectorPicker();
      if (options && typeof options.onPicked === "function") options.onPicked(selector, suggestions);
      showPickerNotice(`${label} の値の場所を設定しました`, "success");
      window.setTimeout(closePickerNotice, 900);
      renderPanel();
    };

    selectorPicker = { onMouseOver, onMouseOut, onKeyDown, onClick };
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
  }

  function persistPickerChange() {
    if (settingsOverlay) {
      markSettingsDirty("未保存");
      return;
    }
    saveSettings(settings);
  }

  function startElementPicker(message, options) {
    stopSelectorPicker();
    const pickerOptions = typeof options === "function" ? { onPicked: options } : (options || {});
    let hiddenModal = null;
    let previousModalDisplay = "";
    if (pickerOptions.hideSettingsModal && settingsOverlay) {
      hiddenModal = settingsOverlay;
      previousModalDisplay = hiddenModal.style.display || "";
      hiddenModal.style.display = "none";
    }
    const restoreHiddenModal = () => {
      if (hiddenModal) {
        hiddenModal.style.display = previousModalDisplay;
        hiddenModal = null;
      }
    };
    showPickerNotice(message || "要素をクリックしてください。Escでキャンセル");
    const onMouseOver = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.target.classList.add("rech-picker-target");
    };
    const onMouseOut = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.target.classList.remove("rech-picker-target");
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        stopSelectorPicker();
        restoreHiddenModal();
        showPickerNotice("選択をキャンセルしました", "error");
        window.setTimeout(closePickerNotice, 900);
      }
    };
    const onClick = (event) => {
      if (isPickerIgnoredTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const node = event.target;
      stopSelectorPicker();
      restoreHiddenModal();
      if (typeof pickerOptions.onPicked === "function") pickerOptions.onPicked(node);
      showPickerNotice("HTML範囲を選択しました", "success");
      window.setTimeout(closePickerNotice, 900);
    };
    selectorPicker = { onMouseOver, onMouseOut, onKeyDown, onClick };
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
  }

  function getListingPickerInstruction(options, label) {
    if (options.kind === "row") {
      return "賃料・管理費・間取り・面積などが入っている1部屋のまとまりをクリックしてください。通常は値選択から自動で分割されます";
    }
    if (options.kind === "item") {
      return "物件名や部屋情報を含む、1物件分の外枠をクリックしてください。Escでキャンセルできます";
    }
    if (options.kind === "field") {
      return `${label} の値そのもの、または値を包む小さな要素をクリックしてください。Escでキャンセルできます`;
    }
    return `${label} の要素をクリックしてください。Escでキャンセルできます`;
  }

  function resolveListingPickerSelector(target, options) {
    if (!target || !options || !options.config) return "";
    if (options.kind === "item") {
      return buildCssSelector(target, document, { preferReusable: true });
    }
    if (options.kind === "row") {
      const itemRoot = options.config.itemSelector ? safeClosest(target, options.config.itemSelector) : null;
      const root = itemRoot || document;
      if (root === target) return "";
      return buildCssSelector(target, root, { preferReusable: true });
    }
    if (options.kind === "field") {
      const fallbackScope = getDefaultListingScope(options.fieldKey, options.config);
      const scope = isRoomScopedListingField(options.fieldKey) && options.config.rowSelector
        ? "row"
        : normalizeListingScope(options.selectorRule.scope || fallbackScope, fallbackScope);
      const root = getListingPickerScopeRoot(target, scope, options.config);
      if (!root || root === target) return "";
      return buildCssSelector(target, root, { preferUnique: true });
    }
    return "";
  }

  function getListingPickerSelectorSuggestions(target, options) {
    if (!target || !options || !options.config) return [];
    if (options.kind === "item") {
      return buildCssSelectorSuggestions(target, document, { preferReusable: true });
    }
    if (options.kind === "row") {
      const itemRoot = options.config.itemSelector ? safeClosest(target, options.config.itemSelector) : null;
      const root = itemRoot || document;
      return buildCssSelectorSuggestions(target, root, { preferReusable: true });
    }
    if (options.kind === "field") {
      const fallbackScope = getDefaultListingScope(options.fieldKey, options.config);
      const scope = isRoomScopedListingField(options.fieldKey) && options.config.rowSelector
        ? "row"
        : normalizeListingScope(options.selectorRule.scope || fallbackScope, fallbackScope);
      const root = getListingPickerScopeRoot(target, scope, options.config);
      return root && root !== target ? buildCssSelectorSuggestions(target, root, { preferUnique: true }) : [];
    }
    return [];
  }

  function applyListingPickerSelector(selector, options) {
    if (options.kind === "item") {
      options.config.itemSelector = selector;
    } else if (options.kind === "row") {
      options.config.rowSelector = selector;
    } else if (options.kind === "field") {
      const fallbackScope = getDefaultListingScope(options.fieldKey, options.config);
      const scope = isRoomScopedListingField(options.fieldKey) && options.config.rowSelector
        ? "row"
        : normalizeListingScope(options.selectorRule.scope || fallbackScope, fallbackScope);
      options.selectorRule.scope = scope;
      options.selectorRule.selector = selector;
      options.selectorRule.attribute = options.selectorRule.attribute || "text";
      options.selectorRule.normalizer = options.selectorRule.normalizer || getDefaultListingNormalizer(options.fieldKey);
      if (options.regexRule) options.regexRule.scope = toListingTextScope(scope);
    }
    if (typeof options.onChange === "function") options.onChange();
  }

  function getListingPickerScopeRoot(target, scope, config) {
    if (scope === "document") return document;
    if (scope === "item") {
      return config.itemSelector ? safeClosest(target, config.itemSelector) : document.body;
    }
    if (config.rowSelector) {
      const rowRoot = safeClosest(target, config.rowSelector);
      if (rowRoot) return rowRoot;
    }
    if (config.itemSelector) return safeClosest(target, config.itemSelector);
    return document.body;
  }

  function safeClosest(node, selector) {
    if (!node || !selector || !node.closest) return null;
    try {
      return node.closest(selector);
    } catch (error) {
      console.warn("[RealEstateCopyHelper] selector is invalid", selector, error);
      return null;
    }
  }

  function isPickerIgnoredTarget(target) {
    return !target || !target.closest || Boolean(target.closest(`#${APP_ID}, #${APP_ID}-modal`));
  }

  function stopSelectorPicker() {
    if (!selectorPicker) return;
    document.removeEventListener("mouseover", selectorPicker.onMouseOver, true);
    document.removeEventListener("mouseout", selectorPicker.onMouseOut, true);
    document.removeEventListener("keydown", selectorPicker.onKeyDown, true);
    document.removeEventListener("click", selectorPicker.onClick, true);
    document.querySelectorAll(".rech-picker-target").forEach((node) => node.classList.remove("rech-picker-target"));
    selectorPicker = null;
  }

  function showPickerNotice(message, type) {
    let notice = document.getElementById(`${APP_ID}-picker-notice`);
    if (!notice) {
      notice = el("div", "rech-picker-notice");
      notice.id = `${APP_ID}-picker-notice`;
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    notice.setAttribute("data-type", type || "info");
  }

  function closePickerNotice() {
    document.getElementById(`${APP_ID}-picker-notice`)?.remove();
  }

  function buildCssSelector(node, rootOrOptions, maybeOptions) {
    if (!node || node.nodeType !== 1) return "";
    const hasExplicitRoot = rootOrOptions && typeof rootOrOptions.querySelectorAll === "function";
    const root = hasExplicitRoot ? rootOrOptions : document;
    const options = hasExplicitRoot ? (maybeOptions || {}) : (rootOrOptions || {});
    const candidates = collectCssSelectorCandidates(node, root, options);
    const best = chooseBestCssSelector(candidates, node, root, options);
    return best || buildFallbackCssPath(node, root);
  }

  function buildCssSelectorSuggestions(node, root, options) {
    if (!node || node.nodeType !== 1 || !root) return [];
    const candidates = collectCssSelectorCandidates(node, root, options || {});
    return candidates
      .map((selector) => {
        const matches = getSelectorMatches(root, selector);
        if (!matches.includes(node)) return null;
        return {
          selector,
          count: matches.length,
          score: scoreCssSelector(selector, matches.length, options || {}),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .filter((candidate, index, list) => list.findIndex((item) => item.selector === candidate.selector) === index)
      .slice(0, 8);
  }

  function collectCssSelectorCandidates(node, root, options) {
    const selectors = [];
    const push = (selector) => {
      if (selector && !selectors.includes(selector)) selectors.push(selector);
    };

    getLocalSelectorCandidates(node, options).forEach(push);

    const parts = [];
    let current = node;
    let depth = 0;
    while (current && current.nodeType === 1 && current !== document.body && current !== document.documentElement && current !== root) {
      parts.unshift(getCssPathSegment(current, options));
      push(parts.join(" > "));
      depth += 1;
      if (depth >= 6) break;
      current = current.parentElement;
    }
    return selectors;
  }

  function chooseBestCssSelector(candidates, node, root, options) {
    const ranked = candidates
      .map((selector) => {
        const matches = getSelectorMatches(root, selector);
        if (!matches.includes(node)) return null;
        return {
          selector,
          count: matches.length,
          score: scoreCssSelector(selector, matches.length, options),
        };
      })
      .filter(Boolean);
    if (!ranked.length) return "";

    if (options.preferUnique) {
      const unique = ranked.filter((candidate) => candidate.count === 1);
      if (unique.length) return unique.sort((a, b) => a.score - b.score)[0].selector;
    }

    if (options.preferReusable) {
      const reusable = ranked.filter((candidate) => candidate.count > 1);
      if (reusable.length) return reusable.sort((a, b) => a.score - b.score)[0].selector;
    }

    return ranked.sort((a, b) => a.score - b.score)[0].selector;
  }

  function scoreCssSelector(selector, matchCount, options) {
    let score = selector.length;
    const segmentCount = selector.split(">").length;
    score += (segmentCount - 1) * 12;
    if (selector.includes(":nth-of-type")) score += options.preferReusable ? 120 : 35;
    if (/^#/.test(selector)) score += options.preferReusable ? 90 : -20;
    if (options.preferUnique && matchCount !== 1) score += 1000 + matchCount;
    if (options.preferReusable) {
      if (matchCount === 1) score += 80;
      if (matchCount > 150) score += 60;
    }
    return score;
  }

  function getLocalSelectorCandidates(node, options) {
    const tagName = node.tagName.toLowerCase();
    const candidates = [];
    if (!options.preferReusable && isStableSelectorValue(node.id)) {
      candidates.push(`#${cssEscape(node.id)}`);
    }

    getStableAttributeSelectors(node, tagName).forEach((selector) => candidates.push(selector));

    const classes = Array.from(node.classList || []).filter(isStableClassName).slice(0, 4);
    classes.forEach((className) => {
      candidates.push(`.${cssEscape(className)}`);
      candidates.push(`${tagName}.${cssEscape(className)}`);
    });
    if (classes.length >= 2) {
      candidates.push(`${tagName}.${classes.slice(0, 2).map(cssEscape).join(".")}`);
    }
    if (["article", "li", "tr", "tbody", "section"].includes(tagName)) candidates.push(tagName);
    return candidates;
  }

  function getStableAttributeSelectors(node, tagName) {
    const selectors = [];
    ["data-testid", "data-test", "data-cy", "data-qa", "data-role", "role", "name", "aria-label"].forEach((attribute) => {
      const value = node.getAttribute(attribute);
      if (!isStableSelectorValue(value)) return;
      const selector = `[${attribute}="${cssStringEscape(value)}"]`;
      selectors.push(selector);
      selectors.push(`${tagName}${selector}`);
    });
    return selectors;
  }

  function getCssPathSegment(node, options) {
    const local = getLocalSelectorCandidates(node, { ...options, preferReusable: true })
      .find((selector) => selector && !selector.includes(" "));
    if (local) return local;
    return getNthOfTypeSegment(node);
  }

  function buildFallbackCssPath(node, root) {
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && current !== document.body && current !== document.documentElement && current !== root) {
      parts.unshift(getNthOfTypeSegment(current));
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function getNthOfTypeSegment(node) {
    const tagName = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) return tagName;
    const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    if (sameTag.length <= 1) return tagName;
    return `${tagName}:nth-of-type(${sameTag.indexOf(node) + 1})`;
  }

  function getSelectorMatches(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (error) {
      return [];
    }
  }

  function isStableClassName(value) {
    if (!isStableSelectorValue(value)) return false;
    if (value.startsWith("rech-") || value.startsWith(APP_ID)) return false;
    if (/^(active|selected|current|hover|focus|disabled|hidden|show|hide|open|closed|on|off)$/i.test(value)) return false;
    if (/^(is|has)-/i.test(value)) return false;
    if (/^[a-f0-9]{8,}$/i.test(value)) return false;
    return true;
  }

  function isStableSelectorValue(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (text.startsWith(APP_ID) || text.startsWith("rech-")) return false;
    if (text.length > 80) return false;
    return !/[{}]/.test(text);
  }

  function cssStringEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function findOrCreateRule(field, ruleType) {
    if (!Array.isArray(field.rules)) field.rules = [];
    let rule = field.rules.find((candidate) => candidate.ruleType === ruleType);
    if (!rule) {
      rule = { ruleType };
      field.rules.push(rule);
    }
    return rule;
  }

  function exportSettings() {
    return JSON.stringify(settings, null, 2);
  }

  function importSettings(json) {
    const parsed = JSON.parse(json);
    settings = migrateSettingsIfNeeded(parsed);
    saveSettings(settings);
  }

  function duplicateProfile(profile) {
    const now = new Date().toISOString();
    const copy = clonePlain(profile || createDefaultProfileForCurrentSite(getCurrentUrlContext()));
    copy.id = `profile-${getCurrentSiteKey(getCurrentUrlContext()) || "local"}-${Date.now()}`;
    copy.name = `${copy.name || "物件設定"} 複製`;
    copy.enabled = true;
    copy.createdAt = now;
    copy.updatedAt = now;
    settings.profiles.push(copy);
    return copy;
  }

  function renderSettingsBackupPanel() {
    const wrapper = el("div", "rech-backup-panel");
    wrapper.appendChild(el("strong", "", "前の保存状態に戻す"));
    wrapper.appendChild(el("small", "", "設定を保存した時に、直前の状態が自動で残ります。操作を戻したい時だけ使います。"));
    const backups = Array.isArray(settings.settingsBackups) ? settings.settingsBackups : [];
    if (!backups.length) {
      wrapper.appendChild(el("small", "", "まだ戻せる保存状態はありません。"));
      return wrapper;
    }
    backups.slice(0, 8).forEach((backup, index) => {
      const row = el("div", "rech-backup-row");
      row.appendChild(el("span", "", `${index + 1}. ${formatBackupDate(backup.createdAt)}`));
      row.appendChild(button("この保存状態に戻す", "rech-secondary rech-mini-button", () => {
        restoreSettingsBackup(backup);
      }));
      wrapper.appendChild(row);
    });
    return wrapper;
  }

  function restoreSettingsBackup(backup) {
    if (!backup || !backup.settings) return;
    const currentBackups = Array.isArray(settings.settingsBackups) ? settings.settingsBackups.slice() : [];
    settings = migrateSettingsIfNeeded({
      ...clonePlain(backup.settings),
      settingsBackups: currentBackups,
      uiSettings: settings.uiSettings,
    });
    saveSettings(settings);
    activeProfile = findMatchingProfile(getCurrentUrlContext()) || settings.profiles[0] || ensureProfileForCurrentSite(getCurrentUrlContext());
    closeSettingsModal({ saved: true });
    showToast("バックアップから復元しました", "success");
    renderPanel();
    openSettingsModal();
  }

  function formatBackupDate(value) {
    try {
      return new Date(value).toLocaleString("ja-JP");
    } catch (error) {
      return value || "日時不明";
    }
  }

  function extractListingRows() {
    const configuredRows = extractConfiguredListingRows();
    return reindexRows(dedupeRows(configuredRows).slice(0, 100));
  }

  function extractConfiguredListingRows() {
    if (!(activeProfile && activeProfile.listingExtractor)) return [];
    const config = getListingExtractorConfig();
    if (config.enabled === false) return [];
    return extractRowsForListingConfig(config);
  }

  function extractRowsForListingConfig(config) {
    const tableRows = extractTableBasedListingRows(config);
    if (tableRows.length) return tableRows;
    const ruleRows = extractRuleBasedListingRows(config);
    if (ruleRows.length) return ruleRows;
    return [];
  }

  function reindexRows(rows) {
    return rows.map((row, index) => ({ ...row, index: index + 1 }));
  }

  function extractTableBasedListingRows(config) {
    const tableConfig = config && config.tableExtraction ? sanitizeTableExtractionConfig(config.tableExtraction) : null;
    if (!tableConfig || tableConfig.enabled !== true) return [];
    const rows = tableConfig.mode === "roomCells"
      ? extractRoomCellTableRows(config, tableConfig)
      : extractStandardTableRows(config, tableConfig);
    return rows.filter(hasMeaningfulTableRow);
  }

  function extractStandardTableRows(config, tableConfig) {
    const tables = getTableExtractionRoots(tableConfig);
    if (!tables.length || !Object.keys(tableConfig.columns || {}).length) return [];
    return tables.flatMap((table, tableIndex) => {
      const rowNodes = getStandardTableRowNodes(table, tableConfig);
      return rowNodes
        .slice(tableConfig.dataStartRowIndex)
        .map((row, rowIndex) => buildTableListingRow(config, tableConfig, table, row, rowIndex, tableIndex, getTableRowCells(row, tableConfig.cellSelector)));
    });
  }

  function extractRoomCellTableRows(config, tableConfig) {
    const roots = getTableExtractionRoots(tableConfig);
    if (!roots.length) return [];
    return roots.flatMap((root, tableIndex) => {
      const roomNodes = getRoomCellTableRowNodes(root, tableConfig);
      return roomNodes.map((node, rowIndex) => buildTableListingRow(config, tableConfig, root, node, rowIndex, tableIndex, getTableRowCells(node, tableConfig.cellSelector)));
    });
  }

  function getTableExtractionRoots(tableConfig) {
    if (!tableConfig || !tableConfig.tableSelector || !isSelectorValidForPreview(tableConfig.tableSelector)) return [];
    return safeQuerySelectorAll(document, tableConfig.tableSelector)
      .filter((node) => node && !(node.closest && node.closest(`#${APP_ID}, #${APP_ID}-modal`)))
      .slice(0, 20);
  }

  function getStandardTableRowNodes(table, tableConfig) {
    const rows = tableConfig.rowSelector && isSelectorValidForPreview(tableConfig.rowSelector)
      ? safeQuerySelectorAll(table, tableConfig.rowSelector)
      : Array.from(table.rows || []);
    return rows.filter((row) => row && row.nodeType === Node.ELEMENT_NODE);
  }

  function getRoomCellTableRowNodes(root, tableConfig) {
    const selector = tableConfig.roomSelector || (tableConfig.rowSelector && tableConfig.rowSelector !== "tr" ? tableConfig.rowSelector : "td.room, [class~='room']");
    if (!selector || !isSelectorValidForPreview(selector)) return [];
    return safeQuerySelectorAll(root, selector).filter((node) => node && node.nodeType === Node.ELEMENT_NODE);
  }

  function getTableRowCells(row, cellSelector) {
    if (!row) return [];
    const directCells = Array.from(row.children || []).filter((child) => child && (child.tagName === "TD" || child.tagName === "TH"));
    if (directCells.length) return directCells;
    const selector = cellSelector && isSelectorValidForPreview(cellSelector) ? cellSelector : "td,th";
    return safeQuerySelectorAll(row, selector).filter((cell) => cell.closest && cell.closest("tr") === row);
  }

  function buildTableListingRow(config, tableConfig, table, rowNode, rowIndex, tableIndex, cells) {
    const values = {};
    const rawValues = {};
    const columns = tableConfig.columns || {};
    getListingFieldIds().forEach(({ key }) => {
      const spec = columns[key];
      if (!spec) return;
      const extracted = readTableColumnValueWithRaw(config, tableConfig, table, rowNode, cells, spec, key, rawValues);
      rawValues[key] = extracted.raw || extracted.cut;
      if (extracted.cut && extracted.cut !== extracted.raw) rawValues[`${key}Cut`] = extracted.cut;
      values[key] = normalizeTableColumnValue(key, extracted.cut || extracted.raw, values.rent, spec);
    });
    if (columns.depositKeyMoney && (!values.deposit || !values.keyMoney)) {
      const extracted = readTableColumnValueWithRaw(config, tableConfig, table, rowNode, cells, columns.depositKeyMoney, "depositKeyMoney", rawValues);
      rawValues.depositKeyMoney = extracted.raw || extracted.cut;
      if (extracted.cut && extracted.cut !== extracted.raw) rawValues.depositKeyMoneyCut = extracted.cut;
      const split = splitTableDepositKeyMoney(extracted.cut || extracted.raw);
      if (!values.deposit && split.deposit) values.deposit = normalizeLeaseCostByRent(split.deposit, values.rent, columns.depositKeyMoney.normalizer || "rentMonth");
      if (!values.keyMoney && split.keyMoney) values.keyMoney = normalizeLeaseCostByRent(split.keyMoney, values.rent, columns.depositKeyMoney.normalizer || "rentMonth");
    }
    if (!values.buildingName) {
      const buildingName = readTableBuildingName(config, tableConfig, table);
      if (buildingName) {
        rawValues.buildingName = rawValues.buildingName || buildingName;
        values.buildingName = cleanConfiguredBuildingName(buildingName);
      }
    }
    applyTableFallbackValues(rowNode, values, rawValues);
    const buildingName = cleanConfiguredBuildingName(values.buildingName || "");
    const rowUrl = getFirstUrl(rowNode);
    const tableUrl = getFirstUrl(table);
    const rowIdentityText = normalizeText(rowNode && (rowNode.innerText || rowNode.textContent) || "");
    return {
      ...values,
      _emptyReasons: {},
      _explicitRoomScope: true,
      _itemScopeIsDocument: false,
      _itemScopeKey: getNodeUid(table),
      _roomScopeKey: getNodeUid(rowNode),
      _rowIdentityText: rowIdentityText,
      _rawValues: rawValues,
      index: rowIndex + 1,
      propertyName: buildingName,
      buildingName,
      room: values.room || "",
      rent: values.rent || "",
      managementFee: values.managementFee || "",
      deposit: values.deposit || "",
      keyMoney: values.keyMoney || "",
      availableDate: values.availableDate || "",
      ad: values.ad || "未記載",
      layout: values.layout || "",
      area: values.area || "",
      source: tableConfig.mode === "roomCells" ? "configured room-cell table" : "configured table",
      _rowUrl: rowUrl,
      url: rowUrl || tableUrl,
      _tableIndex: tableIndex + 1,
    };
  }

  function readTableColumnValue(config, tableConfig, table, rowNode, cells, spec, key, rawValues) {
    const extracted = readTableColumnValueWithRaw(config, tableConfig, table, rowNode, cells, spec, key, rawValues);
    return extracted.cut || extracted.raw || "";
  }

  function readTableColumnValueWithRaw(config, tableConfig, table, rowNode, cells, spec, key, rawValues) {
    if (!spec) return { raw: "", cut: "" };
    if (spec.source && rawValues && rawValues[spec.source]) {
      const cut = extractTablePartValue(rawValues[spec.source], spec);
      return { raw: rawValues[spec.source], cut };
    }
    let node = null;
    if (spec.selector) {
      const scope = key === "buildingName" ? table : rowNode;
      node = safeQuerySelectorIncludingSelf(scope, spec.selector) || (key === "buildingName" ? safeQuerySelector(document, spec.selector) : null);
    }
    if (!node && Number.isInteger(spec.index) && spec.index >= 0) node = cells[spec.index] || null;
    if (!node) return { raw: "", cut: "" };
    const raw = readConfiguredAttribute(node, spec.attribute || "text", config, { ...spec, lineMode: "" });
    const lineValue = applyConfiguredLineMode(raw, spec.lineMode);
    return {
      raw: normalizeText(raw),
      cut: spec.regex ? applyRuleRegex(lineValue, spec) : normalizeText(lineValue),
    };
  }

  function readTableBuildingName(config, tableConfig, table) {
    if (!tableConfig.buildingNameSelector || !isSelectorValidForPreview(tableConfig.buildingNameSelector)) return "";
    const node = safeQuerySelectorIncludingSelf(table, tableConfig.buildingNameSelector) || safeQuerySelector(document, tableConfig.buildingNameSelector);
    if (!node) return "";
    return normalizeText(readConfiguredAttribute(node, "text", config, { lineMode: "" }));
  }

  function normalizeTableColumnValue(key, raw, rentValue, spec) {
    if (!raw) return "";
    const normalizer = spec && spec.normalizer || getDefaultListingNormalizer(key);
    if (key === "deposit" || key === "keyMoney") return normalizeLeaseCostByRent(raw, rentValue, normalizer);
    return normalizeConfiguredValue(raw, normalizer, key);
  }

  function extractTablePartValue(sourceValue, spec) {
    if (!sourceValue) return "";
    const parts = splitTablePairParts(sourceValue, spec && spec.delimiter);
    const part = String(spec && spec.part || "").toLowerCase();
    if (part === "keymoney" || part === "key" || part === "礼金") return parts[1] || "";
    if (part === "deposit" || part === "敷金") return parts[0] || "";
    const index = Number(spec && spec.index);
    if (Number.isFinite(index) && parts[index]) return parts[index];
    return parts[0] || "";
  }

  function splitTableDepositKeyMoney(sourceValue) {
    const parts = splitTablePairParts(sourceValue);
    return {
      deposit: parts[0] || "",
      keyMoney: parts[1] || "",
    };
  }

  function splitTablePairParts(sourceValue, delimiter) {
    const text = normalizeText(sourceValue);
    if (!text) return [];
    let pattern = /[/／・|]/;
    if (delimiter) {
      try {
        pattern = new RegExp(delimiter);
      } catch (error) {
        pattern = /[/／・|]/;
      }
    }
    const parts = text.split(pattern).map((part) => normalizeText(part)).filter(Boolean);
    if (parts.length >= 2) return parts;
    const labeled = text.match(/(?:敷金?|保証金)\s*[:：]?\s*([^/\s　]+).*?(?:礼金?)\s*[:：]?\s*([^/\s　]+)/);
    return labeled ? [labeled[1], labeled[2]] : parts;
  }

  function applyTableFallbackValues(rowNode, values, rawValues) {
    const text = normalizeNumberText(rowNode && (rowNode.innerText || rowNode.textContent) || "");
    if (!text) return;
    if (!values.rent) values.rent = normalizeConfiguredValue(extractRentFromText(text), "rent", "rent");
    if (!values.managementFee) values.managementFee = normalizeConfiguredValue(extractManagementFeeFromText(text, values.rent), "yen", "managementFee");
    if (!values.layout) values.layout = normalizeConfiguredValue(extractLayoutFromText(text), "layout", "layout");
    if (!values.area) values.area = normalizeConfiguredValue(extractAreaFromText(text), "area", "area");
    if (!values.room) {
      const labeled = text.match(/(?:部屋番号|号室)\s*[:：]?\s*([0-9A-Za-z-]+)/);
      values.room = labeled ? normalizeText(labeled[1]) : "";
    }
    if (!rawValues.rowText) rawValues.rowText = truncateText(text, 500);
  }

  function hasMeaningfulTableRow(row) {
    if (!row) return false;
    return ["buildingName", "room", "rent", "managementFee", "deposit", "keyMoney", "availableDate", "layout", "area"].some((key) => {
      const value = normalizeText(row[key] || "");
      return value && value !== "相談" && value !== "未記載";
    });
  }

  function extractRuleBasedListingRows(config) {
    if (!config.fields || !Object.keys(config.fields).length) return [];
    const items = getConfiguredItemScopes(config);
    return items.flatMap((item, itemIndex) => {
      const rowScopes = getConfiguredRowScopes(item, config);
      return rowScopes.map((row, rowIndex) => {
        const values = {};
        const rawValues = {};
        const context = {
          item: item === document.body && row && row !== document.body ? row : item,
          row,
          document: document.body,
          config,
          itemIndex,
          rowIndex,
        };

        Object.entries(config.fields || {}).forEach(([fieldId, field]) => {
          if (!field || field.enabled === false) return;
          const extracted = extractConfiguredFieldWithRaw(fieldId, field, context, values);
          values[fieldId] = extracted.value;
          if (extracted.raw) rawValues[fieldId] = extracted.raw;
          if (extracted.cut && extracted.cut !== extracted.raw) {
            rawValues[`${fieldId}Cut`] = extracted.cut;
          }
        });

        applyConfiguredSplitRules(config, context, values);
        const emptyReasons = buildConfiguredEmptyReasons(config, context, values);

        const buildingName = cleanConfiguredBuildingName(values.buildingName || "");
        const rentValue = values.rent || "";
        const roomValue = values.room || extractFloorFromText(getConfiguredScopeText("rowText", context));
        const rowUrl = getFirstUrl(row);
        const itemUrl = getFirstUrl(item);
        const rowIdentityText = normalizeText(row && (row.innerText || row.textContent) || "");
        return {
          ...values,
          _emptyReasons: emptyReasons,
          _explicitRoomScope: Boolean(config.rowSelector),
          _itemScopeIsDocument: item === document.body,
          _itemScopeKey: getNodeUid(item),
          _roomScopeKey: getNodeUid(row),
          _rowIdentityText: rowIdentityText,
          _rawValues: rawValues,
          index: rowIndex + 1,
          propertyName: buildingName,
          buildingName,
          room: roomValue,
          rent: rentValue,
          managementFee: values.managementFee || "",
          deposit: hasConfiguredFieldInput(config.fields.deposit) ? normalizeLeaseCostByRent(values.deposit, rentValue, getConfiguredFieldNormalizer(config, "deposit")) : "",
          keyMoney: hasConfiguredFieldInput(config.fields.keyMoney) ? normalizeLeaseCostByRent(values.keyMoney, rentValue, getConfiguredFieldNormalizer(config, "keyMoney")) : "",
          availableDate: values.availableDate || "相談",
          ad: values.ad || "未記載",
          layout: values.layout || "",
          area: values.area || "",
          source: "configured rules",
          _rowUrl: rowUrl,
          url: rowUrl || itemUrl,
        };
      });
    }).filter((row) => hasConfiguredRowValue(row, config));
  }

  function getConfiguredItemScopes(config) {
    if (config.itemSelector) {
      const items = filterNestedOuterScopeNodes(safeQuerySelectorAll(document, config.itemSelector));
      if (items.length) return items;
    }
    return document.body ? [document.body] : [];
  }

  function filterNestedOuterScopeNodes(nodes) {
    const uniqueNodes = dedupeNodes(nodes || []);
    return uniqueNodes.filter((node) => {
      return !uniqueNodes.some((candidate) => candidate !== node && candidate.contains && candidate.contains(node));
    });
  }

  function filterNestedLeafScopeNodes(nodes) {
    const uniqueNodes = dedupeNodes(nodes || []);
    return uniqueNodes.filter((node) => {
      return !uniqueNodes.some((candidate) => candidate !== node && node.contains && node.contains(candidate));
    });
  }

  function getConfiguredRowScopes(item, config) {
    if (config.rowSelector) {
      return normalizeConfiguredRowScopes(safeQuerySelectorAllIncludingSelf(item, config.rowSelector), item);
    }
    const inferredRows = inferConfiguredRowScopes(item, config);
    if (inferredRows.length) return normalizeConfiguredRowScopes(inferredRows, item);
    return [item];
  }

  function normalizeConfiguredRowScopes(nodes, item) {
    const scopes = dedupeNodes(nodes || [])
      .map((node) => normalizeConfiguredRowScope(node, item))
      .filter(Boolean)
      .filter((node) => !isTitleOnlyRoomScope(node));
    const roomLikeScopes = scopes.filter(isLikelyRoomScope);
    return filterBroadRoomScopes(filterNestedLeafScopeNodes(roomLikeScopes.length ? roomLikeScopes : scopes));
  }

  function filterBroadRoomScopes(nodes) {
    const uniqueNodes = dedupeNodes(nodes || []);
    if (uniqueNodes.length < 2) return uniqueNodes;
    const infos = uniqueNodes.map((node) => ({
      node,
      text: normalizeNumberText(getConfiguredNodeText(node, null)),
    }));
    return infos.filter((info, index) => {
      if (!info.text) return false;
      const markerCount = countRoomValueMarkers(info.text);
      return !infos.some((candidate, candidateIndex) => {
        if (candidateIndex === index || !candidate.text) return false;
        if (candidate.text.length >= info.text.length) return false;
        if (candidate.text.length < 40) return false;
        if (!info.text.includes(candidate.text)) return false;
        const candidateMarkers = countRoomValueMarkers(candidate.text);
        return markerCount > candidateMarkers + 2;
      });
    }).map((info) => info.node);
  }

  function countRoomValueMarkers(text) {
    const normalized = normalizeNumberText(text);
    const matches = normalized.match(/[0-9]+(?:\.[0-9]+)?\s*万(?:円)?|[0-9][0-9,]*\s*円|[0-9]+\s*(?:SLDK|LDK|SDK|DK|SK|R|K)(?![A-Z])|ワンルーム|[0-9]+(?:\.[0-9]+)?\s*(?:m²|m2|㎡|平米)|[0-9]+\s*階/gi);
    return matches ? matches.length : 0;
  }

  function normalizeConfiguredRowScope(node, item) {
    if (!node) return null;
    if (isTableCell(node)) {
      const row = node.closest("tr");
      if (row && (!item || row === item || item.contains(row))) return row;
    }
    return node;
  }

  function isTableCell(node) {
    return node && (node.tagName === "TD" || node.tagName === "TH");
  }

  function isTitleOnlyRoomScope(node) {
    if (!node || !node.querySelector) return false;
    if (!node.querySelector("h1, h2, h3")) return false;
    return !hasRoomLikeText(getConfiguredNodeText(node, null));
  }

  function isLikelyRoomScope(node) {
    return hasRoomLikeText(getConfiguredNodeText(node, null));
  }

  function hasRoomLikeText(text) {
    const normalized = normalizeNumberText(text);
    return /[0-9,.]+\s*万(?:円)?|[0-9,]+\s*円|[0-9]+\s*(?:SLDK|LDK|SDK|DK|SK|R|K)\b|m²|m2|㎡|平米|[0-9]+\s*階/i.test(normalized);
  }

  function inferConfiguredRowScopes(item, config) {
    const rules = getAutoRowCandidateRules(config);
    if (!rules.length) return [];
    const primaryRule = chooseAutoRowPrimaryRule(item, rules);
    if (!primaryRule) return [];
    const nodes = safeQuerySelectorAll(item, primaryRule.selector);
    if (!nodes.length) return [];

    const scopes = nodes
      .map((node) => findAutoRowScope(node, item, rules, primaryRule))
      .filter(Boolean);
    return dedupeNodes(scopes).filter((scope) => scope !== item || scopes.length === 1);
  }

  function getAutoRowCandidateRules(config) {
    const rowFieldIds = new Set(["buildingName", "room", "rent", "managementFee", "deposit", "keyMoney", "availableDate", "ad", "layout", "area"]);
    return Object.entries((config && config.fields) || {}).flatMap(([fieldId, field]) => {
      if (!rowFieldIds.has(fieldId) || !field || field.enabled === false) return [];
      return (field.rules || []).filter((rule) => {
        if (!rule || rule.enabled === false || rule.type !== "selector" || !rule.selector) return false;
        const fallbackScope = getDefaultListingScope(fieldId, config);
        const scope = normalizeListingScope(rule.scope || fallbackScope, fallbackScope);
        if (fieldId === "buildingName" && scope === "item") return true;
        return scope !== "item" && scope !== "document";
      }).map((rule) => ({ fieldId, selector: rule.selector }));
    });
  }

  function chooseAutoRowPrimaryRule(item, rules) {
    const preferred = ["rent", "layout", "area", "managementFee", "room"];
    const withCounts = rules.map((rule) => ({
      ...rule,
      count: safeQuerySelectorAll(item, rule.selector).length,
    })).filter((rule) => rule.count > 0);
    if (!withCounts.length) return null;
    const repeated = withCounts.filter((rule) => rule.count > 1);
    const candidates = repeated.length ? repeated : withCounts;
    return candidates.sort((a, b) => {
      const preferredDiff = getAutoRowFieldRank(a.fieldId, preferred) - getAutoRowFieldRank(b.fieldId, preferred);
      if (preferredDiff !== 0) return preferredDiff;
      return b.count - a.count;
    })[0];
  }

  function getAutoRowFieldRank(fieldId, preferred) {
    const index = preferred.indexOf(fieldId);
    return index >= 0 ? index : preferred.length;
  }

  function findAutoRowScope(node, item, rules, primaryRule) {
    const minHits = Math.min(2, rules.length);
    let current = node;
    while (current && current.nodeType === 1 && current !== item && current !== document.body && current !== document.documentElement) {
      const fieldHits = countAutoRowFieldHits(current, rules);
      const primaryCount = countSelectorMatchesWithin(current, primaryRule.selector);
      if (fieldHits >= minHits && primaryCount <= 1) return current;
      current = current.parentElement;
    }
    return node;
  }

  function countAutoRowFieldHits(scope, rules) {
    const matchedFields = new Set();
    rules.forEach((rule) => {
      if (countSelectorMatchesWithin(scope, rule.selector) > 0) matchedFields.add(rule.fieldId);
    });
    return matchedFields.size;
  }

  function countSelectorMatchesWithin(scope, selector) {
    let count = safeQuerySelectorAll(scope, selector).length;
    try {
      if (scope.matches && scope.matches(selector)) count += 1;
    } catch (error) {
      // Invalid selectors are already handled by safeQuerySelectorAll.
    }
    return count;
  }

  function dedupeNodes(nodes) {
    const seen = new Set();
    return nodes.filter((node) => {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      return true;
    });
  }

  function getNodeUid(node) {
    if (!node || typeof node !== "object") return "";
    if (!nodeUids.has(node)) {
      nodeUids.set(node, `node-${nodeUidCounter}`);
      nodeUidCounter += 1;
    }
    return nodeUids.get(node);
  }

  function extractConfiguredField(fieldId, field, context, values) {
    return extractConfiguredFieldWithRaw(fieldId, field, context, values).value;
  }

  function extractConfiguredFieldWithRaw(fieldId, field, context, values) {
    for (const rule of field.rules || []) {
      const extracted = extractConfiguredRuleWithRaw(fieldId, rule, context, values);
      const raw = extracted.cut || extracted.raw || "";
      const normalized = normalizeConfiguredValue(raw, rule.normalizer || field.normalizer || "text", fieldId);
      if (normalized) {
        if (rule.field && rule.field !== fieldId) {
          if (!values[rule.field]) values[rule.field] = normalized;
          continue;
        }
        return {
          value: normalized,
          raw: extracted.raw || raw,
          cut: extracted.cut || raw,
        };
      }
    }
    if (hasConfiguredFieldInput(field)) {
      const fallback = extractConfiguredFieldFallback(fieldId, context, values);
      if (fallback) {
        return {
          value: normalizeConfiguredValue(fallback, getConfiguredFieldNormalizer(context.config, fieldId), fieldId),
          raw: fallback,
          cut: fallback,
        };
      }
    }
    return { value: "", raw: "", cut: "" };
  }

  function extractConfiguredFieldFallback(fieldId, context, values) {
    const text = getConfiguredScopeText("rowText", context);
    if (fieldId === "rent") return extractRentFromText(text);
    if (fieldId === "managementFee") return extractManagementFeeFromText(text, values && values.rent);
    if (fieldId === "deposit") return extractDepositFromText(text);
    if (fieldId === "keyMoney") return extractKeyMoneyFromText(text);
    if (fieldId === "room") return extractFloorFromText(text);
    if (fieldId === "layout") return extractLayoutFromText(text);
    if (fieldId === "area") return extractAreaFromText(text);
    return "";
  }

  function hasConfiguredFieldInput(field) {
    return Boolean(field && Array.isArray(field.rules) && field.rules.some((rule) => {
      if (!rule || rule.enabled === false) return false;
      if (rule.type === "selector") return Boolean(rule.selector);
      if (rule.type === "regex") return Boolean(rule.regex || rule.pattern);
      return false;
    }));
  }

  function buildConfiguredEmptyReasons(config, context, values) {
    const reasons = {};
    getListingFieldIds().forEach(({ key }) => {
      if (values[key]) return;
      reasons[key] = getConfiguredFieldEmptyReason(key, config.fields && config.fields[key], context, config);
    });
    if (!values.propertyName && !values.buildingName) reasons.propertyName = reasons.buildingName || "未設定";
    return reasons;
  }

  function getConfiguredFieldEmptyReason(fieldId, field, context, config) {
    if (!hasConfiguredFieldInput(field)) return "未設定";
    const selectorRule = getListingFieldRule(field, "selector");
    if (selectorRule && selectorRule.selector) {
      if (!isSelectorValidForPreview(selectorRule.selector)) return `CSS不正: ${selectorRule.selector}`;
      const ruleScope = getConfiguredRuleScope(fieldId, selectorRule, config);
      const scope = getConfiguredScope(ruleScope, context);
      if (!scope) return `探す範囲なし: ${getListingScopeLabel(ruleScope)}`;
      const matches = safeQuerySelectorAllIncludingSelf(scope, selectorRule.selector);
      const node = matches[0] || (ruleScope === "row" ? findIndexedRoomFieldNode(fieldId, selectorRule, context) : null);
      if (!node) return `CSS一致0件: ${getListingScopeLabel(ruleScope)}`;
      const raw = readConfiguredAttribute(node, selectorRule.attribute || "text", config, selectorRule);
      const cut = applyRuleRegex(raw, selectorRule);
      if ((selectorRule.regex || selectorRule.pattern) && !cut) return `正規表現0件: ${getEmptyReasonSample(raw)}`;
      if (!normalizeText(raw)) return "文字なし: CSSは一致";
      const normalized = normalizeConfiguredValue(cut || raw, selectorRule.normalizer || field.normalizer || getDefaultListingNormalizer(fieldId), fieldId);
      return normalized ? "値なし" : `整形後に空: ${getEmptyReasonSample(cut || raw)}`;
    }
    const regexRule = getListingFieldRule(field, "regex");
    if (regexRule && (regexRule.regex || regexRule.pattern)) {
      const source = getConfiguredScopeText(toListingTextScope(getConfiguredRuleScope(fieldId, regexRule, config)), context);
      if (!source) return `範囲の文字なし: ${getListingScopeLabel(getConfiguredRuleScope(fieldId, regexRule, config))}`;
      const cut = applyRuleRegex(source, regexRule);
      if (!cut) return `正規表現0件: ${getEmptyReasonSample(source)}`;
      const normalized = normalizeConfiguredValue(cut, regexRule.normalizer || field.normalizer || getDefaultListingNormalizer(fieldId), fieldId);
      return normalized ? "値なし" : `整形後に空: ${getEmptyReasonSample(cut)}`;
    }
    return "値なし";
  }

  function getListingScopeLabel(scope) {
    const normalized = normalizeListingScope(scope, "row");
    if (normalized === "item") return "1物件内";
    if (normalized === "document") return "ページ全体";
    return "1部屋内";
  }

  function getEmptyReasonSample(value) {
    const text = normalizeText(value || "");
    return text ? truncateText(text, 60).replace(/\n/g, " ") : "空文字";
  }

  function extractConfiguredRule(fieldId, rule, context, values) {
    const extracted = extractConfiguredRuleWithRaw(fieldId, rule, context, values);
    return extracted.cut || extracted.raw || "";
  }

  function extractConfiguredRuleWithRaw(fieldId, rule, context, values) {
    if (!rule || rule.enabled === false) return { raw: "", cut: "" };
    if ((rule.type === "selector" || rule.type === "regex") && !rule.selector && !rule.regex && !rule.pattern) return { raw: "", cut: "" };
    if (rule.type === "selector") return extractConfiguredSelectorRuleWithRaw(fieldId, rule, context);
    if (rule.type === "label") {
      const raw = extractConfiguredLabelRule(rule, context);
      return { raw, cut: raw };
    }
    if (rule.type === "regex") {
      const raw = getConfiguredScopeText(toListingTextScope(getConfiguredRuleScope(fieldId, rule, context.config)), context);
      return { raw, cut: applyRuleRegex(raw, rule) };
    }
    if (rule.type === "split") {
      const cut = extractConfiguredSplitRule(rule, values);
      return { raw: values[rule.sourceField] || cut, cut };
    }
    return { raw: "", cut: "" };
  }

  function extractConfiguredSelectorRule(fieldId, rule, context) {
    const extracted = extractConfiguredSelectorRuleWithRaw(fieldId, rule, context);
    return extracted.cut || extracted.raw || "";
  }

  function extractConfiguredSelectorRuleWithRaw(fieldId, rule, context) {
    const ruleScope = getConfiguredRuleScope(fieldId, rule, context.config);
    const scope = getConfiguredScope(ruleScope, context);
    let node = rule.selector ? safeQuerySelectorIncludingSelf(scope, rule.selector) : scope;
    if (!node && ruleScope === "row") node = findIndexedRoomFieldNode(fieldId, rule, context);
    if (!node) return { raw: "", cut: "" };
    const rawValue = readConfiguredAttribute(node, rule.attribute || "text", context.config, rule);
    return {
      raw: normalizeText(rawValue),
      cut: applyRuleRegex(rawValue, rule),
    };
  }

  function findIndexedRoomFieldNode(fieldId, rule, context) {
    if (!isRoomScopedListingField(fieldId) || !context || !context.config || !context.config.rowSelector || !rule || !rule.selector) return null;
    const item = context.item || context.document;
    const matches = safeQuerySelectorAllIncludingSelf(item, rule.selector);
    const rowScopes = getConfiguredRowScopes(item, context.config);
    if (!matches.length || !rowScopes.length) return null;
    const index = Number.isInteger(context.rowIndex) ? context.rowIndex : rowScopes.indexOf(context.row);
    if (index < 0) return null;
    return matches[index] || null;
  }

  function extractConfiguredLabelRule(rule, context) {
    const scope = getConfiguredScope(rule.scope || "row", context);
    const labels = rule.labelTexts || rule.labels || [];
    let value = "";
    for (const label of labels) {
      value = getLabelLikeValue(scope, [label]);
      if (value) break;
    }
    if (!value && (rule.regex || rule.pattern)) value = getConfiguredNodeText(scope, context.config);
    return applyRuleRegex(value, rule);
  }

  function extractConfiguredRegexRule(fieldId, rule, context) {
    return applyRuleRegex(getConfiguredScopeText(toListingTextScope(getConfiguredRuleScope(fieldId, rule, context.config)), context), rule);
  }

  function extractConfiguredSplitRule(rule, values) {
    const source = values[rule.sourceField] || "";
    if (!source) return "";
    let splitter;
    try {
      splitter = new RegExp(rule.delimiter || rule.separatorPattern || "[/／・]");
    } catch (error) {
      splitter = /[/／・]/;
    }
    const parts = normalizeText(source).split(splitter).map((part) => part.trim());
    const index = Number.isInteger(rule.index) ? rule.index : 0;
    return parts[index] || "";
  }

  function applyConfiguredSplitRules(config, context, values) {
    Object.values(config.fields || {}).forEach((field) => {
      (field.rules || []).filter((rule) => rule.type === "split").forEach((rule) => {
        const value = normalizeConfiguredValue(extractConfiguredSplitRule(rule, values), rule.normalizer || field.normalizer || "text", rule.field || "");
        if (value && rule.field && !values[rule.field]) values[rule.field] = value;
      });
    });
  }

  function getConfiguredScope(scope, context) {
    if (scope === "item" || scope === "itemText") return context.item;
    if (scope === "document") return context.document;
    return context.row || context.item || context.document;
  }

  function getConfiguredRuleScope(fieldId, rule, config) {
    if (isRoomScopedListingField(fieldId) && config && config.rowSelector && normalizeListingScope(rule && rule.scope, "") === "item") {
      return "row";
    }
    return normalizeListingScope(rule.scope || getDefaultListingScope(fieldId, config), getDefaultListingScope(fieldId, config));
  }

  function getConfiguredScopeText(scope, context) {
    if (scope === "itemText") return getConfiguredNodeText(context.item, context.config);
    if (scope === "document") return getConfiguredNodeText(context.document, context.config);
    return getConfiguredNodeText(context.row || context.item, context.config);
  }

  function readConfiguredAttribute(node, attribute, config, rule) {
    if (!node) return "";
    if (attribute === "text" || attribute === "textContent") {
      const text = getConfiguredNodeTextWithBreaks(node, config);
      return applyConfiguredLineMode(text, rule && rule.lineMode);
    }
    if (attribute === "html") return node.innerHTML || "";
    if (attribute === "href") return node.href || node.getAttribute("href") || "";
    if (attribute === "src") return node.src || node.getAttribute("src") || "";
    if (attribute === "value" && "value" in node) return node.value || "";
    return node.getAttribute(attribute) || "";
  }

  function getConfiguredNodeTextWithBreaks(node, config) {
    if (!node) return "";
    const parts = [];
    const cellText = (config && config.cellText) || {};
    if (cellText.includeBeforeContent) parts.push(getPseudoContent(node, "::before"));
    parts.push(getNodeTextWithBreaks(node));
    if (cellText.includeAfterContent) parts.push(getPseudoContent(node, "::after"));
    return parts.filter(Boolean).join("\n");
  }

  function getNodeTextWithBreaks(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    return clone.innerText || clone.textContent || "";
  }

  function applyConfiguredLineMode(value, mode) {
    const raw = String(value || "");
    if (!mode) return raw;
    const lines = raw
      .replace(/\r/g, "\n")
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean);
    const fallbackText = normalizeText(raw);
    if (mode === "firstLine") return lines[0] || fallbackText;
    if (mode === "secondLine") return lines[1] || extractSecondMoneyLikePart(fallbackText) || "";
    if (mode === "lineWithManYen") return lines.find((line) => /万(?:円)?/.test(line)) || extractManYenPart(fallbackText) || "";
    if (mode === "lineWithoutManYen") return lines.find((line) => !/万(?:円)?/.test(line) && /円|込|無料|不要|なし|無し|-/.test(line)) || extractYenPart(fallbackText) || "";
    if (mode === "lineWithYen") return lines.find((line) => /円/.test(line) && !/万(?:円)?/.test(line)) || extractYenPart(fallbackText) || "";
    return raw;
  }

  function extractSecondMoneyLikePart(text) {
    const parts = normalizeText(text).match(/[0-9０-９,，.．]+\s*(?:万円|万|円)/g);
    return parts && parts[1] ? parts[1] : "";
  }

  function extractManYenPart(text) {
    const match = normalizeText(text).match(/[0-9０-９,，.．]+\s*万(?:円)?/);
    return match ? match[0] : "";
  }

  function extractYenPart(text) {
    const match = normalizeText(text).match(/[0-9０-９,，]+\s*円/);
    return match ? match[0] : "";
  }

  function applyRuleRegex(value, rule) {
    const text = normalizeText(value);
    if (!text || !rule.regex && !rule.pattern) return text;
    try {
      const regex = new RegExp(rule.regex || rule.pattern, rule.flags || "");
      const match = regex.exec(text);
      if (!match) return "";
      const group = Number.isInteger(rule.group) ? rule.group : 1;
      return normalizeText(match[group] || match[0] || "");
    } catch (error) {
      console.warn("[RealEstateCopyHelper] configured regex is invalid", rule.regex || rule.pattern, error);
      return "";
    }
  }

  function normalizeConfiguredValue(value, normalizer, fieldId) {
    let result = normalizeText(value);
    if (!result) return "";
    if (normalizer === "rent") return normalizeRentValue(result);
    if (normalizer === "yen") return normalizeYenValue(result);
    if (normalizer === "rentMonth") return normalizeText(result);
    if (normalizer === "month") return normalizeMonth(result);
    if (normalizer === "area") return normalizeAreaValue(result);
    if (normalizer === "layout") return normalizeLayoutValue(result);
    if (normalizer === "availableDate") return normalizeAvailableDateValue(result);
    if (normalizer === "ad") return normalizeAdValue(result);
    return normalizeByFieldAliases(result, fieldId, normalizer);
  }

  function normalizeAdValue(value) {
    const text = normalizeNumberText(value);
    if (!text) return "未記載";
    if (!/\bAD\b|広告料|広告費|広告\s*[:：]?\s*[0-9あり有なし無し無無料相談]/i.test(text)) return "未記載";
    if (/仲介手数料|手数料|家賃の\s*[0-9.]+\s*%|[0-9.]+\s*%\s*以下/.test(text) && !/\bAD\b|広告料|広告費/i.test(text)) return "未記載";
    const labeled = text.match(/(?:\bAD\b|広告料|広告費)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?\s*(?:ヶ月|か月|ヵ月|カ月|ケ月|%|％)?|あり|有|なし|無し|無|無料|相談)/i);
    if (labeled) return normalizeText(labeled[1]);
    return "未記載";
  }

  function normalizeAvailableDateValue(value) {
    const text = normalizeByGlobalAliases(value);
    if (!text) return "相談";
    return text;
  }

  function normalizeRentValue(value) {
    const yen = parseJapaneseYenAmount(value, {
      allowManYen: true,
      assumeYenForPlainNumber: true,
      assumeManYenForPlainDecimal: true,
      assumeManYenForSmallPlainNumber: true,
    });
    return yen == null ? normalizeText(value).replace(/\s+/g, "") : formatYen(yen);
  }

  function normalizeYenValue(value) {
    const zeroLike = normalizeZeroLikeYen(value);
    if (zeroLike) return zeroLike;
    const yen = parseJapaneseYenAmount(value, { allowManYen: true, assumeYenForPlainNumber: true });
    return yen == null ? normalizeText(value).replace(/\s+/g, "") : formatYen(yen);
  }

  function normalizeZeroLikeYen(value) {
    const text = normalizeText(value).replace(/\s+/g, "");
    if (/^(なし|無し|無|無料|不要|-|0|0円)$/.test(text)) return "0円";
    return "";
  }

  function parseJapaneseYenAmount(value, options) {
    const text = normalizeNumberText(value).replace(/[￥¥\\]/g, "").replace(/\s+/g, "");
    if (!text) return null;
    if (options && options.allowManYen) {
      const manMatch = text.match(/([0-9]+(?:\.[0-9]+)?)万(?:円)?/);
      if (manMatch) {
        const amount = Number(manMatch[1]);
        return Number.isFinite(amount) ? Math.round(amount * 10000) : null;
      }
    }
    const yenMatch = text.match(/([0-9][0-9,]*)円/);
    if (yenMatch) return parseIntegerAmount(yenMatch[1]);
    if (options && options.assumeManYenForPlainDecimal && /^[0-9]+\.[0-9]+$/.test(text)) {
      const amount = Number(text);
      return Number.isFinite(amount) ? Math.round(amount * 10000) : null;
    }
    if (options && options.assumeManYenForSmallPlainNumber && /^[0-9]+$/.test(text)) {
      const amount = Number(text);
      if (Number.isFinite(amount) && amount > 0 && amount < 1000) return Math.round(amount * 10000);
    }
    if (options && options.assumeYenForPlainNumber && /^[0-9][0-9,]*$/.test(text)) {
      return parseIntegerAmount(text);
    }
    return null;
  }

  function parseIntegerAmount(value) {
    const amount = Number(String(value || "").replace(/,/g, ""));
    return Number.isFinite(amount) ? Math.round(amount) : null;
  }

  function formatYen(value) {
    return `${Math.round(value).toLocaleString("ja-JP")}円`;
  }

  function normalizeNumberText(value) {
    return normalizeText(value)
      .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/[Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/[．，]/g, (char) => char === "．" ? "." : ",");
  }

  function normalizeAreaValue(value) {
    return extractAreaFromText(value) || normalizePlainAreaValue(value);
  }

  function normalizeLayoutValue(value) {
    return extractLayoutFromText(value);
  }

  function extractLayoutFromText(value) {
    const text = normalizeNumberText(value);
    if (/ワンルーム/.test(text)) return "ワンルーム";
    const match = text.match(/[0-9]+\s*(?:SLDK|LDK|SDK|DK|SK|R|K)(?![A-Z])/i);
    return match ? match[0].replace(/\s+/g, "").toUpperCase() : "";
  }

  function extractAreaFromText(value) {
    const text = normalizeNumberText(value);
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:m²|m2|㎡|平米)/i);
    return match ? `${match[1]}㎡` : "";
  }

  function normalizePlainAreaValue(value) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    return /^[0-9]+(?:\.[0-9]+)?$/.test(text) ? `${text}㎡` : "";
  }

  function extractFloorFromText(value) {
    const text = normalizeNumberText(value);
    const match = text.match(/(?:^|\s)([0-9]+)\s*階(?:\s*\/\s*[0-9]+\s*階建)?/);
    return match ? `${match[1]}階` : "";
  }

  function extractRentFromText(value) {
    const text = normalizeNumberText(value);
    const labeled = text.match(/(?:賃料|家賃)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?\s*万(?:円)?|[0-9][0-9,]*\s*円)/);
    if (labeled) return labeled[1];
    const amounts = getMoneyLikeMatches(text);
    const rent = amounts.find((match) => /万/.test(match.value)) || amounts[0];
    return rent ? rent.value : "";
  }

  function extractManagementFeeFromText(value, rentValue) {
    const text = normalizeNumberText(value);
    const labeled = text.match(/(?:管理費(?:等)?|共益費|管理・共益費|管理費・共益費)\s*[:：]?\s*(無料|なし|無し|不要|込|込み|-|[0-9][0-9,]*\s*円)/);
    if (labeled) return labeled[1];
    const rentMatch = findRentMoneyMatch(text, rentValue);
    if (!rentMatch) return "";
    const afterRent = text.slice(rentMatch.index + rentMatch.value.length, rentMatch.index + rentMatch.value.length + 80);
    const fee = afterRent.match(/[0-9][0-9,]*\s*円|無料|なし|無し|不要|込|込み|-/);
    return fee ? fee[0] : "";
  }

  function extractDepositFromText(value) {
    return extractLabeledLeaseCost(value, ["敷金", "敷"]) || extractSequentialLeaseCost(value, 0);
  }

  function extractKeyMoneyFromText(value) {
    return extractLabeledLeaseCost(value, ["礼金", "礼"]) || extractSequentialLeaseCost(value, 1);
  }

  function extractLabeledLeaseCost(value, labels) {
    const text = normalizeNumberText(value);
    const valuePattern = "(無料|なし|無し|不要|ゼロ|相談|-|[0-9]+(?:\\.[0-9]+)?\\s*(?:ヶ月|か月|ヵ月|カ月|ケ月|万(?:円)?|円)?)";
    for (const label of labels) {
      const regex = new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s*${valuePattern}`);
      const match = text.match(regex);
      if (match) return match[1];
    }
    return "";
  }

  function extractSequentialLeaseCost(value, index) {
    const text = normalizeNumberText(value);
    const rentMatch = findRentMoneyMatch(text);
    if (!rentMatch) return "";
    const layoutMatch = text.slice(rentMatch.index).match(/[0-9]+\s*(?:SLDK|LDK|SDK|DK|SK|R|K)(?![A-Z])|ワンルーム/i);
    const endIndex = layoutMatch ? rentMatch.index + layoutMatch.index : rentMatch.index + 160;
    const afterRent = text.slice(rentMatch.index + rentMatch.value.length, endIndex);
    const fee = afterRent.match(/[0-9][0-9,]*\s*円|無料|なし|無し|不要|込|込み|-/);
    const afterFee = fee ? afterRent.slice(fee.index + fee[0].length) : afterRent;
    const tokens = Array.from(afterFee.matchAll(/無料|なし|無し|不要|ゼロ|相談|-|[0-9]+(?:\.[0-9]+)?\s*(?:ヶ月|か月|ヵ月|カ月|ケ月|万(?:円)?|円)/g))
      .map((match) => match[0])
      .filter(Boolean);
    return tokens[index] || "";
  }

  function findRentMoneyMatch(text, rentValue) {
    const normalized = normalizeNumberText(text);
    const rent = normalizeNumberText(rentValue || "");
    const amounts = getMoneyLikeMatches(normalized);
    if (!amounts.length) return null;
    if (rent) {
      const exact = amounts.find((match) => normalizeNumberText(match.value).replace(/\s+/g, "") === rent.replace(/\s+/g, ""));
      if (exact) return exact;
    }
    return amounts.find((match) => /万/.test(match.value)) || amounts[0];
  }

  function getMoneyLikeMatches(text) {
    return Array.from(normalizeNumberText(text).matchAll(/[0-9]+(?:\.[0-9]+)?\s*万(?:円)?|[0-9][0-9,]*\s*円/g))
      .map((match) => ({ value: match[0], index: match.index || 0 }));
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function cleanConfiguredBuildingName(value) {
    return normalizeText(value)
      .replace(/^PR\s*/, "")
      .replace(/^賃貸(?:マンション|アパート|一戸建て|テラスハウス)?\s*/, "")
      .trim();
  }

  function hasConfiguredRowValue(row, config) {
    if (row && row._explicitRoomScope) return true;
    const configuredKeys = getConfiguredInputFieldKeys(config);
    if (configuredKeys.some((key) => row[key])) return true;
    const outputKeys = (config.outputColumns || []).map((column) => column.key).filter(Boolean);
    const keys = outputKeys.length ? outputKeys : ["buildingName", "rent", "managementFee", "deposit", "keyMoney", "availableDate", "ad", "layout", "area"];
    return keys.some((key) => row[key]);
  }

  function getConfiguredInputFieldKeys(config) {
    return Object.entries((config && config.fields) || {})
      .filter(([, field]) => hasConfiguredFieldInput(field))
      .map(([key]) => key);
  }

  function getConfiguredFieldNormalizer(config, fieldId) {
    const field = config && config.fields ? config.fields[fieldId] : null;
    if (!field || !Array.isArray(field.rules)) return getDefaultListingNormalizer(fieldId);
    const rule = field.rules.find((candidate) => candidate && candidate.enabled !== false && candidate.normalizer);
    return rule && rule.normalizer ? rule.normalizer : getDefaultListingNormalizer(fieldId);
  }

  function getListingNoRowsMessage(config) {
    const tableConfig = config && config.tableExtraction ? sanitizeTableExtractionConfig(config.tableExtraction) : null;
    if (tableConfig && tableConfig.enabled === true) {
      if (!tableConfig.tableSelector) return "テーブル抽出が有効ですが、対象テーブルCSSが未設定です";
      if (!getTableExtractionRoots(tableConfig).length) return "テーブル抽出の対象テーブルが0件です。tableSelectorを見直してください";
      if (!Object.keys(tableConfig.columns || {}).length) return "テーブル抽出の列設定がありません";
      if (!extractTableBasedListingRows(config).length) return "テーブルは見つかりましたが、部屋行を作れませんでした。行開始位置か列設定を見直してください";
    }
    if (config && config.itemSelector && !safeQuerySelectorAll(document, config.itemSelector).length) {
      return "1物件のまとまりが0件です。項目が取れていても、まとまり指定が外れています";
    }
    if (config && config.rowSelector && !getExplicitRoomScopeCount(config)) {
      return "1部屋のまとまりが0件です。部屋として選んだ場所が、1物件のまとまりの中で見つかっていません";
    }
    if (!getConfiguredInputFieldKeys(config).length) {
      return "コピー項目が未設定です。値選択か値のCSSを入れてください";
    }
    return "取得できた項目はありますが、表にできませんでした";
  }

  function getExplicitRoomScopeCount(config) {
    if (!config || !config.rowSelector) return 0;
    return getConfiguredItemScopes(config)
      .reduce((count, item) => count + getConfiguredRowScopes(item, config).length, 0);
  }

  function getFirstUrl(scope) {
    if (!scope) return "";
    const ownValue = scope.getAttribute ? scope.getAttribute("data-detailurl") || scope.getAttribute("href") : "";
    if (ownValue) return toHttpUrl(ownValue);
    const node = scope.querySelector ? scope.querySelector("[data-detailurl], a[href], [href]") : null;
    if (!node) return "";
    return toHttpUrl(node.getAttribute("data-detailurl") || node.getAttribute("href") || "");
  }

  function toHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || /^javascript:/i.test(raw)) return "";
    try {
      const url = new URL(raw, location.href);
      return /^https?:$/i.test(url.protocol) ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function getListingExtractorConfig() {
    const defaults = createDefaultListingExtractor();
    const configured = (activeProfile && activeProfile.listingExtractor) || {};
    const merged = sanitizeListingExtractorConfig({
      ...defaults,
      ...configured,
      fields: mergeNestedObjects(defaults.fields, configured.fields),
      cellText: {
        ...defaults.cellText,
        ...(configured.cellText || {}),
      },
      tableExtraction: {
        ...defaults.tableExtraction,
        ...((configured && configured.tableExtraction) || {}),
        columns: {
          ...((defaults.tableExtraction && defaults.tableExtraction.columns) || {}),
          ...((configured && configured.tableExtraction && configured.tableExtraction.columns) || {}),
        },
      },
    });
    ensureListingOutputColumns(merged);
    return merged;
  }

  function sanitizeListingExtractorConfig(config) {
    const next = { ...(config || {}) };
    next.fields = {};
    Object.entries((config && config.fields) || {}).forEach(([key, field]) => {
      next.fields[key] = {
        ...(field || {}),
        rules: ((field && field.rules) || []).filter((rule) => rule && (rule.type === "selector" || rule.type === "regex")),
      };
    });
    next.tableExtraction = sanitizeTableExtractionConfig(next.tableExtraction);
    return next;
  }

  function sanitizeTableExtractionConfig(rawConfig) {
    const defaults = createDefaultTableExtraction();
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    const next = {
      ...defaults,
      ...source,
      enabled: source.enabled === true,
      mode: normalizeTableExtractionMode(source.mode || defaults.mode),
      tableSelector: typeof source.tableSelector === "string" ? source.tableSelector.trim() : "",
      rowSelector: typeof source.rowSelector === "string" ? source.rowSelector.trim() : defaults.rowSelector,
      cellSelector: typeof source.cellSelector === "string" ? source.cellSelector.trim() : defaults.cellSelector,
      headerRowIndex: normalizeTableRowIndex(source.headerRowIndex, defaults.headerRowIndex),
      dataStartRowIndex: normalizeTableRowIndex(source.dataStartRowIndex, defaults.dataStartRowIndex),
      roomSelector: typeof source.roomSelector === "string" ? source.roomSelector.trim() : "",
      buildingNameSelector: typeof source.buildingNameSelector === "string" ? source.buildingNameSelector.trim() : "",
      columns: {},
      excludeColumns: Array.isArray(source.excludeColumns)
        ? source.excludeColumns.map((value) => normalizeText(value)).filter(Boolean).slice(0, 20)
        : [],
    };
    Object.entries((source && source.columns) || {}).forEach(([rawKey, rawValue]) => {
      const key = normalizeTableColumnKey(rawKey);
      const spec = normalizeTableColumnSpec(rawValue, key);
      if (key && spec) next.columns[key] = spec;
    });
    return next;
  }

  function normalizeTableExtractionMode(value) {
    const mode = String(value || "").trim();
    return mode === "roomCells" ? "roomCells" : "standard";
  }

  function normalizeTableRowIndex(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  }

  function normalizeTableColumnKey(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw === "depositKeyMoney" || raw === "deposit_key_money" || raw === "敷金/礼金" || raw === "敷礼") return "depositKeyMoney";
    return normalizeAiFieldKey(raw);
  }

  function normalizeTableColumnSpec(rawValue, key) {
    if (rawValue == null || rawValue === false) return null;
    if (Number.isInteger(rawValue) || String(rawValue).match(/^\d+$/)) {
      return {
        index: Number(rawValue),
        selector: "",
        attribute: "text",
        normalizer: getTableColumnDefaultNormalizer(key),
      };
    }
    if (typeof rawValue === "string") {
      return {
        index: null,
        selector: rawValue.trim(),
        attribute: "text",
        normalizer: getTableColumnDefaultNormalizer(key),
      };
    }
    if (typeof rawValue !== "object") return null;
    const indexValue = rawValue.index != null ? rawValue.index : rawValue.columnIndex;
    const index = Number(indexValue);
    return {
      index: Number.isFinite(index) && index >= 0 ? Math.floor(index) : null,
      selector: typeof rawValue.selector === "string" ? rawValue.selector.trim() : typeof rawValue.css === "string" ? rawValue.css.trim() : "",
      attribute: typeof rawValue.attribute === "string" ? rawValue.attribute.trim() || "text" : "text",
      normalizer: normalizeAiNormalizer(key === "depositKeyMoney" ? "deposit" : key, rawValue.normalizer || rawValue.format || rawValue.formatter || getTableColumnDefaultNormalizer(key)),
      regex: typeof rawValue.regex === "string" ? rawValue.regex.trim() : typeof rawValue.pattern === "string" ? rawValue.pattern.trim() : "",
      group: Number.isInteger(rawValue.group) ? rawValue.group : Number.isInteger(rawValue.captureGroup) ? rawValue.captureGroup : 1,
      flags: typeof rawValue.flags === "string" ? rawValue.flags : "",
      lineMode: normalizeAiLineMode(rawValue.lineMode || rawValue.line_mode || ""),
      source: typeof rawValue.source === "string" ? normalizeTableColumnKey(rawValue.source) : "",
      part: typeof rawValue.part === "string" ? rawValue.part.trim() : "",
      delimiter: typeof rawValue.delimiter === "string" ? rawValue.delimiter : typeof rawValue.separator === "string" ? rawValue.separator : "",
    };
  }

  function getTableColumnDefaultNormalizer(key) {
    if (key === "depositKeyMoney") return "rentMonth";
    return getDefaultListingNormalizer(key);
  }

  function clearListingFieldRules(config) {
    Object.values((config && config.fields) || {}).forEach((field) => {
      if (field && Array.isArray(field.rules)) field.rules = [];
    });
  }

  function clearDefaultSingleFieldRules(profile) {
    (profile.fields || []).forEach((field) => {
      const defaults = DEFAULT_FIELD_DEFS.find((definition) => definition.id === field.id);
      if (!defaults || !Array.isArray(field.rules)) return;
      field.rules = field.rules.filter((rule) => !isDefaultSingleFieldRule(rule, defaults));
    });
    if (Array.isArray(profile.derivedFields)) {
      profile.derivedFields = profile.derivedFields.filter((rule) => rule && rule.id !== "depositKeyMoneySplit");
    }
  }

  function isDefaultSingleFieldRule(rule, defaults) {
    if (!rule || rule.ruleType !== "labelAdjacent") return false;
    const labels = Array.isArray(rule.labels) ? rule.labels : [];
    return labels.length === defaults.labels.length && labels.every((label, index) => label === defaults.labels[index]);
  }

  function ensureListingOutputColumns(config) {
    if (!config) return;
    const defaults = createDefaultListingExtractor().outputColumns || [];
    const existing = Array.isArray(config.outputColumns) ? config.outputColumns : [];
    const existingKeys = new Set(existing.map((column) => column && column.key).filter(Boolean));
    const nextColumns = [];
    defaults.forEach((column) => {
      if (!column || !column.key) return;
      const current = existing.find((candidate) => candidate && candidate.key === column.key);
      nextColumns.push(current || column);
      existingKeys.delete(column.key);
    });
    existing.forEach((column) => {
      if (column && existingKeys.has(column.key)) nextColumns.push(column);
    });
    config.outputColumns = nextColumns;
  }

  function mergeNestedObjects(defaults, overrides) {
    const result = { ...(defaults || {}) };
    Object.keys(overrides || {}).forEach((key) => {
      result[key] = {
        ...((defaults && defaults[key]) || {}),
        ...(overrides[key] || {}),
      };
    });
    return result;
  }

  function getConfiguredNodeText(node, config) {
    if (!node) return "";
    const parts = [];
    const cellText = (config && config.cellText) || {};
    if (cellText.includeBeforeContent) parts.push(getPseudoContent(node, "::before"));
    parts.push(node.innerText || node.textContent || "");
    if (cellText.includeAfterContent) parts.push(getPseudoContent(node, "::after"));
    return normalizeText(parts.filter(Boolean).join(" "));
  }

  function getPseudoContent(node, pseudoElement) {
    try {
      const value = window.getComputedStyle(node, pseudoElement).content;
      if (!value || value === "none" || value === "normal") return "";
      return value.replace(/^["']|["']$/g, "");
    } catch (error) {
      return "";
    }
  }

  function safeQuerySelectorAll(scope, selector) {
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch (error) {
      console.warn("[RealEstateCopyHelper] selector is invalid", selector, error);
      return [];
    }
  }

  function safeQuerySelector(scope, selector) {
    try {
      return scope.querySelector(selector);
    } catch (error) {
      console.warn("[RealEstateCopyHelper] selector is invalid", selector, error);
      return null;
    }
  }

  function safeQuerySelectorIncludingSelf(scope, selector) {
    if (!scope || !selector) return null;
    try {
      if (scope.matches && scope.matches(selector)) return scope;
      return scope.querySelector(selector);
    } catch (error) {
      console.warn("[RealEstateCopyHelper] selector is invalid", selector, error);
      return null;
    }
  }

  function safeQuerySelectorAllIncludingSelf(scope, selector) {
    if (!scope || !selector) return [];
    try {
      const nodes = Array.from(scope.querySelectorAll(selector));
      if (scope.matches && scope.matches(selector)) nodes.unshift(scope);
      return dedupeNodes(nodes);
    } catch (error) {
      console.warn("[RealEstateCopyHelper] selector is invalid", selector, error);
      return [];
    }
  }

  function renderListingTable(rows, emptyText, options) {
    if (!rows.length) {
      return el("div", "rech-empty", emptyText || "一覧テーブルにできる物件データが見つかりませんでした");
    }

    const wrapper = el("div", "rech-table-wrap");
    const table = el("table", "rech-result-table");
    const columns = [["index", "#"], ...getListingOutputColumns().filter(([key]) => key !== "url")];
    const rowCopyTemplates = options && Array.isArray(options.rowCopyTemplates) ? options.rowCopyTemplates : [];
    const displayColumns = rowCopyTemplates.length ? [["__copy", "コピー"], ...columns] : columns;
    const sortState = options && options.sortState ? options.sortState : { key: "", direction: "asc" };
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    displayColumns.forEach(([key, label]) => {
      const th = el("th", "", "");
      if (key === "__copy") {
        th.textContent = label;
        th.classList.add("is-copy-column");
      } else if (options && options.sortable && typeof options.onSort === "function") {
        const sortButton = button(getSortableHeaderLabel(key, label, sortState), "rech-sort-button", () => options.onSort(key));
        sortButton.type = "button";
        sortButton.title = `${label}で並び替え`;
        sortButton.setAttribute("aria-sort", sortState.key === key ? (sortState.direction === "desc" ? "descending" : "ascending") : "none");
        th.classList.add("is-sortable");
        if (sortState.key === key) th.classList.add("is-sorted");
        th.appendChild(sortButton);
      } else {
        th.textContent = label;
      }
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      tr.classList.add(rowIndex % 2 === 1 ? "is-even-row" : "is-odd-row");
      displayColumns.forEach(([key]) => {
        const td = document.createElement("td");
        const value = getListingTableCellDisplayValue(row, key, rowIndex, options);
        const fieldKey = getListingFieldKeyForColumn(key);
        const fieldIssue = fieldKey && row._fieldIssues && row._fieldIssues[fieldKey] ? row._fieldIssues[fieldKey] : "";
        if (key === "__copy") {
          td.className = "rech-row-copy-cell";
          rowCopyTemplates.forEach((templateEntry, templateIndex) => {
            const copyButton = button(templateEntry.name || `文面${templateIndex + 1}`, "rech-secondary rech-mini-button rech-row-copy-button", () => {
              if (options && typeof options.onCopyRowTemplate === "function") {
                options.onCopyRowTemplate(row, templateEntry);
              }
            });
            copyButton.type = "button";
            copyButton.title = `この部屋を${templateEntry.name || `文面${templateIndex + 1}`}でコピー`;
            td.appendChild(copyButton);
          });
        } else if (key === "propertyName" && row.url) {
          const link = document.createElement("a");
          link.href = row.url;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = value;
          td.appendChild(link);
        } else if (key === "index" && row._duplicates && row._duplicates.length) {
          const stack = el("div", "rech-index-stack");
          stack.appendChild(el("span", "", value));
          const duplicateButton = button(`候補${row._duplicates.length}`, "rech-duplicate-toggle", () => {
            const duplicateRow = tr.nextElementSibling;
            if (!duplicateRow || !duplicateRow.classList.contains("rech-duplicate-row")) return;
            const hidden = duplicateRow.hidden;
            duplicateRow.hidden = !hidden;
          });
          duplicateButton.type = "button";
          duplicateButton.title = `重複候補を表示: ${row._duplicates.length}件`;
          stack.appendChild(duplicateButton);
          td.appendChild(stack);
        } else if (!value && key !== "index") {
          const reason = getRowEmptyReason(row, key);
          td.textContent = "未取得";
          td.title = reason ? `クリックしてこの項目の取得場所を設定: ${reason}` : "クリックしてこの項目の取得場所を設定";
          td.classList.add("is-empty", "is-clickable");
          td.addEventListener("click", () => {
            if (options && options.directFieldPick && fieldKey && typeof options.onPickField === "function") {
              options.onPickField(fieldKey);
            } else {
              openSettingsModal({ focusFieldKey: fieldKey || key });
            }
          });
        } else {
          if (key === "room" && isFloorOnlyRoomValue(value)) {
            td.appendChild(el("span", "", value));
            td.appendChild(el("span", "rech-cell-badge", "号室なし"));
            td.title = "階数だけを取得しています。号室がある画面では号室の取得設定を確認してください。";
          } else {
            td.textContent = value;
          }
        }
        if (fieldIssue) {
          td.classList.add("is-suspicious");
          td.title = td.title ? `${td.title} / ${fieldIssue}` : fieldIssue;
        }
        if (options && options.directFieldPick && fieldKey && key !== "propertyName" && typeof options.onPickField === "function") {
          td.title = td.title || "ダブルクリックでこの項目の取得場所を設定";
          td.addEventListener("dblclick", () => options.onPickField(fieldKey));
        }
        if (!value && key === "index") td.classList.add("is-empty");
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
      if (row._duplicates && row._duplicates.length) {
        tbody.appendChild(renderDuplicateRows(row._duplicates, displayColumns));
      }
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  function getListingTableCellDisplayValue(row, key, rowIndex, options) {
    if (key === "index") return String(rowIndex + 1);
    if (key === "__copy") return "";
    if (options && options.valueMode === "raw") {
      const raw = getListingRawDisplayValue(row, key);
      if (raw) return raw;
    }
    return key === "propertyName" ? row.propertyName || row.buildingName || "" : row[key] || "";
  }

  function getListingRawDisplayValue(row, key) {
    if (!row || !row._rawValues) return "";
    if (key === "propertyName") return normalizeText(row._rawValues.buildingName || row._rawValues.propertyName || "");
    const fieldKey = getListingFieldKeyForColumn(key);
    if (!fieldKey) return "";
    return normalizeText(row._rawValues[fieldKey] || row._rawValues[`${fieldKey}Cut`] || "");
  }

  function getListingFieldKeyForColumn(key) {
    if (key === "propertyName") return "buildingName";
    return getListingFieldIds().some((field) => field.key === key) ? key : "";
  }

  function renderDuplicateRows(duplicates, columns) {
    const tr = document.createElement("tr");
    tr.className = "rech-duplicate-row";
    tr.hidden = true;
    const td = document.createElement("td");
    td.colSpan = columns.length;
    const box = el("div", "rech-duplicate-box");
    box.appendChild(el("strong", "", `重複候補 ${duplicates.length}件`));
    const table = el("table", "rech-duplicate-table");
    const tbody = document.createElement("tbody");
    duplicates.slice(0, 10).forEach((row) => {
      const duplicateTr = document.createElement("tr");
      columns.filter(([key]) => key !== "index" && key !== "__copy").forEach(([key]) => {
        const cell = document.createElement("td");
        cell.textContent = key === "propertyName" ? row.propertyName || row.buildingName || "" : row[key] || "";
        duplicateTr.appendChild(cell);
      });
      tbody.appendChild(duplicateTr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function getSortableHeaderLabel(key, label, sortState) {
    if (!sortState || sortState.key !== key) return `${label} ⇅`;
    return `${label} ${sortState.direction === "desc" ? "↓" : "↑"}`;
  }

  function getRowEmptyReason(row, key) {
    const reasons = row && row._emptyReasons ? row._emptyReasons : {};
    if (key === "propertyName") return reasons.propertyName || reasons.buildingName || "未設定";
    return reasons[key] || "未取得";
  }

  function buildListingTsv(rows) {
    const columns = getListingOutputColumns();
    return [
      columns.map(([, label]) => label).join("\t"),
      ...rows.map((row) => columns.map(([key]) => sanitizeTsvCell(row[key] || "")).join("\t")),
    ].join("\n");
  }

  function getListingOutputColumns() {
    const configured = activeProfile && activeProfile.listingExtractor && activeProfile.listingExtractor.outputColumns;
    const columns = Array.isArray(configured) && configured.length ? configured : createDefaultListingExtractor().outputColumns;
    return columns
      .map((column) => Array.isArray(column) ? column : [column.key, column.label || column.key])
      .filter(([key]) => key);
  }

  function getText(node) {
    return node ? normalizeText(node.innerText || node.textContent || "") : "";
  }

  function getLabelLikeValue(scope, labels) {
    for (const label of labels) {
      const value = getTableLikeLabelValue(scope, label) || getDefinitionLikeLabelValue(scope, label) || getTextLikeLabelValue(scope, label);
      if (value) return value;
    }
    return "";
  }

  function getTableLikeLabelValue(scope, label) {
    const rows = Array.from(scope.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.children);
      const index = cells.findIndex((cell) => normalizeText(cell.innerText || cell.textContent || "") === label);
      if (index >= 0 && cells[index + 1]) return getText(cells[index + 1]);
      const first = getText(cells[0]);
      if (first === label && cells[1]) return getText(cells[1]);
    }
    return "";
  }

  function getDefinitionLikeLabelValue(scope, label) {
    const dts = Array.from(scope.querySelectorAll("dt"));
    for (const dt of dts) {
      if (normalizeText(dt.innerText || dt.textContent || "") !== label) continue;
      let next = dt.nextElementSibling;
      while (next && next.tagName !== "DD") next = next.nextElementSibling;
      if (next) return getText(next);
    }
    return "";
  }

  function getTextLikeLabelValue(scope, label) {
    const text = normalizeText(scope.innerText || scope.textContent || "");
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return extractByRegexText(text, new RegExp(`${escaped}\\s*[:：]?\\s*([^\\s　]+(?:\\s?[^\\s　]+)?)`));
  }

  function extractLabelValueFromText(scope, label) {
    const row = Array.from(scope.querySelectorAll("tr")).find((candidate) => normalizeText(candidate.textContent || "").startsWith(label));
    if (row) return normalizeText((row.textContent || "").replace(label, ""));
    const text = normalizeText(scope.textContent || "");
    if (label === "所在地") return extractByRegexText(text, /所在地\s*([^交]+?)\s*交通/);
    if (label === "交通") return extractByRegexText(text, /交通\s*(.+?)(?:築年数|間取り図|専有面積|$)/);
    return "";
  }

  function extractByRegexText(text, regex) {
    const match = regex.exec(text || "");
    return match ? normalizeText(match[1] || match[0] || "") : "";
  }

  function cleanPropertyName(value) {
    return normalizeText(value)
      .replace(/^PR\s*/, "")
      .replace(/^賃貸(?:マンション|アパート|一戸建て|テラスハウス)?\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sanitizeTsvCell(value) {
    return String(value || "").replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
  }

  function dedupeRows(rows) {
    const kept = [];
    const keyToIndex = new Map();
    let previousLooseIdentity = "";
    const columns = getListingOutputColumns()
      .map(([key]) => key)
      .filter((key) => key !== "index");
    rows.forEach((row) => {
      const keys = getRowDedupeKeys(row, columns);
      const looseIdentity = getLooseAdjacentRoomIdentity(row);
      const matchedKey = keys.find((key) => keyToIndex.has(key));
      let existingIndex = matchedKey ? keyToIndex.get(matchedKey) : -1;
      if (existingIndex < 0 && looseIdentity && looseIdentity === previousLooseIdentity) {
        existingIndex = kept.length - 1;
      }
      if (existingIndex >= 0 && kept[existingIndex]) {
        const existingRow = kept[existingIndex];
        if (getRowCompletenessScore(row, columns) > getRowCompletenessScore(existingRow, columns)) {
          row._duplicates = mergeDuplicateRows([existingRow, ...(existingRow._duplicates || []), ...(row._duplicates || [])]);
          kept[existingIndex] = row;
        } else {
          existingRow._duplicates = mergeDuplicateRows([...(existingRow._duplicates || []), row, ...(row._duplicates || [])]);
        }
        keys.forEach((key) => keyToIndex.set(key, existingIndex));
      } else {
        const index = kept.length;
        kept.push(row);
        keys.forEach((key) => keyToIndex.set(key, index));
      }
      previousLooseIdentity = looseIdentity || "";
    });
    return kept;
  }

  function mergeDuplicateRows(rows) {
    const seen = new Set();
    return (rows || []).filter((row) => {
      if (!row) return false;
      const key = [row._roomScopeKey, row._rowUrl, row.propertyName, row.room, row.rent, row.managementFee, row.layout, row.area].map((value) => normalizeText(value || "")).join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getRowDedupeKeys(row, columns) {
    const keys = [];
    if (row._explicitRoomScope && row._roomScopeKey) keys.push(`explicit-room-node:${row._roomScopeKey}`);
    const context = getRowDedupeContext(row);
    const valueKey = [...columns.map((column) => row[column] || ""), context.marker || ""].join("|")
      || [row.propertyName, row.room, row.rent, row.managementFee, row.url, context.marker].join("|");
    if (valueKey && hasDedupeValue(row, columns)) keys.push(`values:${valueKey}`);
    keys.push(...getRoomIdentityKeys(row));
    const looseIdentity = getLooseAdjacentRoomIdentity(row);
    if (looseIdentity && row._itemScopeKey && !row._itemScopeIsDocument) keys.push(`item-loose:${row._itemScopeKey}:${looseIdentity}`);
    return keys;
  }

  function getRowCompletenessScore(row, columns) {
    const weights = {
      buildingName: 2,
      propertyName: 2,
      room: 2,
      rent: 5,
      managementFee: 2,
      deposit: 1,
      keyMoney: 1,
      availableDate: 1,
      ad: 1,
      layout: 6,
      area: 4,
      url: 1,
    };
    const keys = new Set([...columns, "propertyName", "buildingName", "room", "rent", "managementFee", "deposit", "keyMoney", "layout", "area", "url"]);
    let score = 0;
    keys.forEach((key) => {
      if (normalizeText(row[key] || "")) score += weights[key] || 1;
    });
    if (row._rowUrl) score += 2;
    if (row._explicitRoomScope) score += 1;
    return score;
  }

  function hasDedupeValue(row, columns) {
    return columns.some((column) => column !== "index" && normalizeText(row[column] || ""));
  }

  function getRoomIdentityKeys(row) {
    const keys = [];
    const values = getRoomIdentityValues(row);
    const context = getRowDedupeContext(row);
    const roomNumber = getSpecificRoomIdentifier(values.room);
    if (row._rowUrl && values.nonEmptyCount >= 1) keys.push(`url:${normalizeText(row._rowUrl)}`);
    if (roomNumber && context.building) keys.push(`room-number:${context.building}|${roomNumber}`);
    if (roomNumber && row._itemScopeKey && !row._itemScopeIsDocument) keys.push(`item-room-number:${row._itemScopeKey}|${roomNumber}`);
    const buildingFingerprint = getRoomFingerprint(row);
    if (buildingFingerprint) keys.push(`building:${buildingFingerprint}`);
    if (!row._itemScopeIsDocument && row._itemScopeKey && values.nonEmptyCount >= 3 && (context.building || context.marker)) {
      keys.push(`item:${row._itemScopeKey}:${context.building}|${context.marker}|${values.parts.join("|")}`);
    }
    if (values.nonEmptyCount >= 4 && (context.building || context.marker)) {
      keys.push(`room-values:${context.building}|${context.marker}|${values.parts.join("|")}`);
    }
    return keys;
  }

  function getRoomIdentityValues(row) {
    const parts = ["room", "rent", "managementFee", "layout", "area"].map((key) => normalizeText(row[key] || ""));
    return {
      parts,
      room: parts[0],
      nonEmptyCount: parts.filter(Boolean).length,
    };
  }

  function getSpecificRoomIdentifier(value) {
    const text = normalizeNumberText(value).replace(/\s+/g, " ").trim();
    if (!text) return "";
    const compact = text.replace(/\s+/g, "");
    if (/^[0-9]+階(?:建)?$/.test(compact)) return "";
    if (/^(?:地下|B)?[0-9]+階$/.test(compact)) return "";
    const afterFloor = text.match(/[0-9]+階\s*[/／・-]?\s*([A-Z]?[0-9]{2,5}[A-Z]?|[A-Z][0-9]{1,5}|[0-9]{1,5}[A-Z])\s*(?:号室?|室)?/i);
    if (afterFloor) return normalizeRoomIdentifier(afterFloor[1]);
    const labeled = text.match(/([A-Z]?[0-9]{2,5}[A-Z]?|[A-Z][0-9]{1,5}|[0-9]{1,5}[A-Z])\s*(?:号室?|室)\b/i);
    if (labeled) return normalizeRoomIdentifier(labeled[1]);
    if (/^(?:[A-Z]?[0-9]{2,5}[A-Z]?|[A-Z][0-9]{1,5}|[0-9]{1,5}[A-Z])$/i.test(compact)) {
      return normalizeRoomIdentifier(compact);
    }
    return "";
  }

  function normalizeRoomIdentifier(value) {
    return normalizeNumberText(value)
      .replace(/\s+/g, "")
      .replace(/(?:号室?|室)$/g, "")
      .toUpperCase();
  }

  function getLooseAdjacentRoomIdentity(row) {
    const values = getRoomIdentityValues(row);
    const context = getRowDedupeContext(row);
    if (!context.building && !context.marker) return "";
    if (values.nonEmptyCount < 3) return "";
    return `${context.building}|${context.marker}|${values.parts.join("|")}`;
  }

  function getRoomFingerprint(row) {
    const context = getRowDedupeContext(row);
    const values = getRoomIdentityValues(row);
    if ((!context.building && !context.marker) || values.nonEmptyCount < 2) return "";
    return [context.building, context.marker, ...values.parts].join("|");
  }

  function getRowDedupeContext(row) {
    return {
      building: normalizeText(row && (row.buildingName || row.propertyName) || ""),
      marker: extractBuildingMarkerFromText(row && row._rowIdentityText || ""),
    };
  }

  function extractBuildingMarkerFromText(value) {
    const text = normalizeNumberText(value);
    const matches = text.match(/(?:[A-Z0-9]+|第?[一二三四五六七八九十]+|東|西|南|北|中央|本|別|新|旧)\s*(?:棟|号棟|館)|(?:A|B|C|D|E|F|G|H|I|J|K|L|M|N|O|P|Q|R|S|T|U|V|W|X|Y|Z)\s*(?:type|タイプ)/gi);
    return matches ? matches.map((match) => match.replace(/\s+/g, "").toUpperCase()).join(",") : "";
  }

  function extractAllFields(profile) {
    const values = {};
    lastDebug = {};
    getEnabledFields(profile).forEach((field) => {
      values[field.id] = extractField(field, getCurrentUrlContext());
    });
    applyDerivedFields(values, profile);
    return values;
  }

  function getEnabledFields(profile) {
    return (profile.fields || [])
      .filter((field) => field.enabled !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function extractField(field, context) {
    const rules = Array.isArray(field.rules) ? field.rules : [];
    for (const rule of rules) {
      const raw = extractByRule(rule, context);
      const normalized = normalizeValue(raw, [...(rule.normalizers || []), ...(field.normalizers || [])], field);
      if (normalized) {
        lastDebug[field.id] = { rule, raw, normalized };
        return normalized;
      }
    }
    return field.fallbackValue || "";
  }

  function extractByRule(rule, context) {
    try {
      if (!rule || !rule.ruleType) return "";
      if (rule.ruleType === "css") return extractByCss(rule);
      if (rule.ruleType === "labelAdjacent") return extractByLabelAdjacent(rule);
      if (rule.ruleType === "regex") return extractByRegex(rule);
      if (rule.ruleType === "static") return extractByStatic(rule);
      if (rule.ruleType === "split") return extractBySplit(rule, context);
      return "";
    } catch (error) {
      console.warn("[RealEstateCopyHelper] 抽出ルールの実行に失敗しました", rule, error);
      return "";
    }
  }

  function extractByCss(rule) {
    if (!rule.selector) return "";
    let nodes;
    try {
      nodes = document.querySelectorAll(rule.selector);
    } catch (error) {
      console.warn("[RealEstateCopyHelper] CSSセレクタが不正です", rule.selector, error);
      return "";
    }
    const index = Number.isInteger(rule.index) ? rule.index : 0;
    const node = nodes[index];
    if (!node) return "";
    const target = rule.target || "textContent";
    if (target === "value" && "value" in node) return node.value || "";
    if (target === "href" && "href" in node) return node.href || "";
    if (target === "src" && "src" in node) return node.src || "";
    if (target === "attribute" && rule.attributeName) return node.getAttribute(rule.attributeName) || "";
    return node.textContent || "";
  }

  function extractByLabelAdjacent(rule) {
    const labels = rule.labels || [];
    if (!labels.length) return "";
    const candidates = Array.from(document.body.querySelectorAll("th,td,dt,dd,label,div,span,p,li"));
    for (const node of candidates) {
      const text = normalizeText(node.textContent || "");
      if (!text || !matchesLabel(text, labels, rule.matchMode || "contains")) continue;
      const valueNode = findAdjacentValueNode(node, rule);
      const value = valueNode ? valueNode.textContent || "" : "";
      if (normalizeText(value) && normalizeText(value) !== text) return value;
    }
    return "";
  }

  function matchesLabel(text, labels, matchMode) {
    return labels.some((label) => {
      const normalizedLabel = normalizeText(label);
      if (!normalizedLabel) return false;
      if (matchMode === "exact") return text === normalizedLabel;
      if (matchMode === "regex") {
        try {
          return new RegExp(label).test(text);
        } catch (error) {
          console.warn("[RealEstateCopyHelper] ラベル正規表現が不正です", label, error);
          return false;
        }
      }
      return text.includes(normalizedLabel);
    });
  }

  function findAdjacentValueNode(node, rule) {
    const position = rule.valuePosition || "sameRowNextCell";

    if (position === "parentQuery" && rule.parentSelector && rule.valueSelector) {
      const parent = node.closest(rule.parentSelector);
      return parent ? parent.querySelector(rule.valueSelector) : null;
    }

    if (position === "nextDefinition" || node.tagName.toLowerCase() === "dt") {
      let next = node.nextElementSibling;
      while (next && next.tagName.toLowerCase() !== "dd") next = next.nextElementSibling;
      if (next) return next;
    }

    if (position === "nextSibling") {
      return node.nextElementSibling;
    }

    const row = node.closest("tr");
    if (row) {
      const cells = Array.from(row.children).filter((child) => ["TH", "TD"].includes(child.tagName));
      const index = cells.indexOf(node);
      if (index >= 0) {
        const laterCells = cells.slice(index + 1).filter((cell) => normalizeText(cell.textContent || ""));
        if (laterCells.length) return laterCells[0];
      }
      const td = row.querySelector("td");
      if (td && td !== node) return td;
    }

    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(node);
      const next = siblings.slice(index + 1).find((child) => normalizeText(child.textContent || ""));
      if (next) return next;
    }
    return null;
  }

  function extractByRegex(rule) {
    if (!rule.pattern) return "";
    let scope = document.body;
    if (rule.scopeSelector) {
      try {
        scope = document.querySelector(rule.scopeSelector) || document.body;
      } catch (error) {
        console.warn("[RealEstateCopyHelper] scopeSelector が不正です", rule.scopeSelector, error);
        scope = document.body;
      }
    }
    try {
      const regex = new RegExp(rule.pattern, rule.flags || "");
      const match = regex.exec(scope.innerText || scope.textContent || "");
      if (!match) return "";
      const groupIndex = Number.isInteger(rule.captureGroup) ? rule.captureGroup : 1;
      return match[groupIndex] || match[0] || "";
    } catch (error) {
      console.warn("[RealEstateCopyHelper] 正規表現が不正です", rule.pattern, error);
      return "";
    }
  }

  function extractByStatic(rule) {
    return rule.value || "";
  }

  function extractBySplit(rule, context) {
    const source = extractByRule(rule.sourceRule, context);
    return source ? splitDepositKeyMoney(source, rule) : "";
  }

  function applyDerivedFields(values, profile) {
    (profile.derivedFields || []).forEach((derivedField) => {
      if (!derivedField.enabled) return;
      if (derivedField.targetFields && derivedField.targetFields.includes("deposit") && derivedField.targetFields.includes("keyMoney")) {
        if (values.deposit && values.keyMoney) return;
        const sourceValue = extractByRule(derivedField.sourceRule, getCurrentUrlContext());
        const split = splitDepositKeyMoney(sourceValue, derivedField);
        if (!values.deposit && split.deposit) values.deposit = split.deposit;
        if (!values.keyMoney && split.keyMoney) values.keyMoney = split.keyMoney;
      }
    });
  }

  function splitDepositKeyMoney(sourceValue, derivedField) {
    const normalized = normalizeValue(sourceValue, derivedField.normalizers || []);
    if (!normalized) return { deposit: "", keyMoney: "" };

    const separator = derivedField.separator || "/";
    let parts = [];
    if (normalized.includes(separator)) {
      parts = normalized.split(separator);
    } else {
      const match = normalized.match(/(?:敷金?|保証金)\s*([0-9.]+|なし|無|無料|不要|相談|-).*?(?:礼金?)\s*([0-9.]+|なし|無|無料|不要|相談|-)/);
      if (match) parts = [match[1], match[2]];
    }

    if (parts.length < 2) return { deposit: "", keyMoney: "" };
    const positions = derivedField.positions || {
      deposit: derivedField.depositPosition || 1,
      keyMoney: derivedField.keyMoneyPosition || 2,
    };
    const deposit = normalizeMonth(normalizeText(parts[(positions.deposit || 1) - 1] || ""));
    const keyMoney = normalizeMonth(normalizeText(parts[(positions.keyMoney || 2) - 1] || ""));
    return { deposit, keyMoney };
  }

  function normalizeValue(value, normalizers, field) {
    let result = value == null ? "" : String(value);
    const uniqueNormalizers = Array.from(new Set(normalizers || []));
    uniqueNormalizers.forEach((normalizer) => {
      if (normalizer === "trim") result = trim(result);
      if (normalizer === "collapseWhitespace") result = collapseWhitespace(result);
      if (normalizer === "normalizeSlash") result = normalizeSlash(result);
      if (normalizer === "removeLabelPrefix") result = removeLabelPrefix(result, field);
      if (normalizer === "normalizeMonth") result = normalizeMonth(result);
    });
    return result;
  }

  function trim(value) {
    return String(value || "").trim();
  }

  function collapseWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeSlash(value) {
    return String(value || "")
      .replace(/[／]/g, "/")
      .replace(/\s*\/\s*/g, "/")
      .trim();
  }

  function removeLabelPrefix(value, field) {
    let result = String(value || "").trim();
    const labels = new Set([field && field.label, ...(field && field.rules ? field.rules.flatMap((rule) => rule.labels || []) : [])].filter(Boolean));
    labels.forEach((label) => {
      const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`^${escaped}\\s*[:：]?\\s*`), "");
    });
    return result.trim();
  }

  function normalizeMonth(value) {
    const result = String(value || "").trim();
    if (!result) return "";
    const aliased = normalizeByGlobalAliases(result);
    if (aliased !== result) return aliased;
    if (/^相談$/.test(result)) return result;
    if (/円|ヶ月|か月|ヵ月|カ月|ケ月/.test(result)) return result;
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(result)) return `${result}ヶ月`;
    return result;
  }

  function normalizeLeaseCostByRent(value, rentValue, normalizer) {
    const result = normalizeText(value);
    if (!result) return normalizeByGlobalAliases("");
    if (normalizer === "text") return result;
    if (normalizer === "yen") return normalizeYenValue(result);
    if (normalizer !== "rentMonth") return normalizeMonth(result);
    const aliased = normalizeByGlobalAliases(result);
    if (aliased !== result) return aliased;
    if (/相談/.test(result)) return result;
    if (/ヶ月|か月|ヵ月|カ月|ケ月/.test(result)) return normalizeMonth(result);
    const rentYen = parseJapaneseYenAmount(rentValue, {
      allowManYen: true,
      assumeYenForPlainNumber: true,
      assumeManYenForPlainDecimal: true,
      assumeManYenForSmallPlainNumber: true,
    });
    const leaseCostYen = parseLeaseCostAmountForRentMonth(result, rentYen);
    if (rentYen && leaseCostYen != null) return formatRentMonthRatio(leaseCostYen / rentYen);
    return normalizeMonth(result);
  }

  function parseLeaseCostAmountForRentMonth(value, rentYen) {
    const text = normalizeNumberText(value).replace(/\s+/g, "");
    if (!text) return null;
    if (/ヶ月|か月|ヵ月|カ月|ケ月/.test(text)) return null;
    const aliased = normalizeByGlobalAliases(text);
    if (aliased !== text && /ヶ月|相談/.test(aliased)) return null;
    const manMatch = text.match(/([0-9]+(?:\.[0-9]+)?)万(?:円)?/);
    if (manMatch) {
      const amount = Number(manMatch[1]);
      return Number.isFinite(amount) ? Math.round(amount * 10000) : null;
    }
    const yenMatch = text.match(/([0-9][0-9,]*)円/);
    if (yenMatch) return parseIntegerAmount(yenMatch[1]);
    if (/^[0-9]+\.[0-9]+$/.test(text)) {
      const amount = Number(text);
      return Number.isFinite(amount) ? Math.round(amount * 10000) : null;
    }
    if (/^[0-9][0-9,]*$/.test(text)) {
      const number = parseIntegerAmount(text);
      if (number == null) return null;
      if (String(text).replace(/,/g, "").length >= 4 || number >= 1000) return number;
      if (rentYen) {
        const assumedYen = number * 10000;
        if (isPlausibleRentMonthRatio(assumedYen / rentYen)) return assumedYen;
      }
      return null;
    }
    return null;
  }

  function isPlausibleRentMonthRatio(ratio) {
    if (!Number.isFinite(ratio) || ratio < 0) return false;
    return [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6].some((candidate) => Math.abs(ratio - candidate) < 0.04);
  }

  function formatRentMonthRatio(ratio) {
    if (!Number.isFinite(ratio)) return "";
    const rounded = Math.round(ratio * 100) / 100;
    const integer = Math.round(rounded);
    if (Math.abs(rounded - integer) < 0.01) return `${integer}ヶ月`;
    const oneDecimal = Math.round(rounded * 10) / 10;
    const text = Math.abs(rounded - oneDecimal) < 0.01 ? String(oneDecimal) : String(rounded);
    return `${text.replace(/\.0$/, "")}ヶ月`;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeByGlobalAliases(value) {
    const text = normalizeText(value);
    const rules = Array.isArray(settings.globalValueAliases) ? settings.globalValueAliases : DEFAULT_VALUE_ALIASES;
    const matched = rules.find((rule) => {
      const aliases = Array.isArray(rule && rule.aliases) ? rule.aliases : [];
      return aliases.some((alias) => normalizeText(alias) === text);
    });
    return matched && typeof matched.output === "string" ? matched.output : text;
  }

  function normalizeByFieldAliases(value, fieldId, normalizer) {
    const text = normalizeText(value);
    if (!text) return "";
    const compact = text.replace(/\s+/g, "");
    if (fieldId === "managementFee") {
      const zeroYen = normalizeZeroLikeYen(compact);
      if (zeroYen) return zeroYen;
      if (/^(込|込み|賃料込|賃料込み)$/.test(compact)) return "込み";
      if (normalizer === "text") return text;
      return normalizeYenValue(text);
    }
    if (fieldId === "deposit" || fieldId === "keyMoney") {
      return normalizeByGlobalAliases(text);
    }
    if (fieldId === "availableDate" || fieldId === "moveInDate") {
      return normalizeAvailableDateValue(text);
    }
    if (fieldId === "ad") {
      return normalizeAdValue(text);
    }
    return fieldId ? text : normalizeByGlobalAliases(text);
  }

  function buildOutputText(values, template) {
    return String(template || DEFAULT_OUTPUT_TEMPLATE).replace(/\{([^}]+)\}/g, (_match, key) => {
      return values[key] || "";
    });
  }

  function createOutputValuesForRow(row, options) {
    const values = {
      ...(row || {}),
      propertyName: row && (row.propertyName || row.buildingName) || "",
      buildingName: row && (row.buildingName || row.propertyName) || "",
      moveInDate: row && (row.moveInDate || row.availableDate) || "",
      availableDate: row && (row.availableDate || row.moveInDate) || "",
    };
    if (options && options.htmlCell) {
      values.rent = formatYenForHtmlCell(values.rent);
      values.managementFee = formatYenForHtmlCell(values.managementFee);
    }
    return values;
  }

  function formatYenForHtmlCell(value) {
    const text = normalizeText(value || "");
    if (!text) return "";
    if (/申込|申し込み|申込み|非募集|募集停止|満室/.test(text)) return text;
    const amount = parseJapaneseYenAmount(text, { allowManYen: true, assumeYenForPlainNumber: true, assumeManYenForPlainDecimal: true, assumeManYenForSmallPlainNumber: true });
    if (amount != null) return amount.toLocaleString("ja-JP");
    return text.replace(/[￥¥\\]/g, "").replace(/円$/, "").trim();
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    fallbackCopyToClipboard(text);
  }

  function fallbackCopyToClipboard(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand("copy");
    textarea.remove();
    if (!success) throw new Error("document.execCommand(copy) failed");
  }

  function showToast(message, type) {
    const toast = document.getElementById(`${APP_ID}-toast`) || panelRoot;
    if (settingsOverlay && (!toast || toast === panelRoot || panelRoot?.style.display === "none")) {
      showPickerNotice(message, type);
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(closePickerNotice, 2800);
      return;
    }
    if (!toast) return;
    toast.textContent = message;
    toast.setAttribute("data-type", type || "info");
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2800);
  }

  function splitCommaList(value) {
    return String(value || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function el(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(text, className, onClick) {
    const node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function sectionTitle(label, helpText) {
    const title = el("h3", "");
    title.appendChild(termWithHelp(label, helpText));
    return title;
  }

  function labeledInput(label, value, onInput, hint, helpText) {
    const wrapper = el("label", "rech-control");
    wrapper.appendChild(helpText ? termWithHelp(label, helpText) : el("span", "", label));
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.addEventListener("input", () => {
      onInput(input.value);
      markSettingsDirty();
    });
    wrapper.appendChild(input);
    if (hint) wrapper.appendChild(el("small", "rech-control-hint", hint));
    return wrapper;
  }

  function labeledTextarea(label, value, onInput, hint, helpText) {
    const wrapper = el("label", "rech-control");
    wrapper.appendChild(helpText ? termWithHelp(label, helpText) : el("span", "", label));
    const textarea = document.createElement("textarea");
    textarea.value = value || "";
    textarea.addEventListener("input", () => {
      onInput(textarea.value);
      markSettingsDirty();
    });
    wrapper.appendChild(textarea);
    if (hint) wrapper.appendChild(el("small", "rech-control-hint", hint));
    return wrapper;
  }

  function helpText(text) {
    return el("p", "rech-help-text", text);
  }

  function helpList(items) {
    const list = el("ul", "rech-help-list");
    items.forEach((item) => list.appendChild(el("li", "", item)));
    return list;
  }

  function injectStyles(targetDocument) {
    const styleDocument = targetDocument || document;
    if (styleDocument.getElementById(`${APP_ID}-styles`)) return;
    const style = styleDocument.createElement("style");
    style.id = `${APP_ID}-styles`;
    style.textContent = `
#${APP_ID}, #${APP_ID} * {
  box-sizing: border-box;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#${APP_ID} {
  position: fixed;
  right: 16px;
  top: 16px;
  z-index: 2147483647;
  width: min(1120px, calc(100vw - 32px));
  max-height: min(720px, calc(100vh - 32px));
  display: flex;
  flex-direction: column;
  color: #17202a;
  background: #ffffff;
  border: 1px solid #cfd7df;
  border-radius: 8px;
  box-shadow: 0 12px 36px rgba(16, 24, 40, 0.20);
  overflow: hidden;
}
#${APP_ID}.is-collapsed {
  width: auto;
  height: auto;
  max-height: none;
  overflow: visible;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
#${APP_ID}.is-collapsed .rech-collapsed-button {
  display: block;
  min-width: 0;
  min-height: 32px;
  padding: 7px 10px;
  color: #ffffff;
  background: #17202a;
  border: 1px solid rgba(255, 255, 255, 0.20);
  border-radius: 6px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.24);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  cursor: move;
}
#${APP_ID} .rech-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  background: #f4f7f9;
  border-bottom: 1px solid #d8e0e7;
  cursor: move;
  user-select: none;
}
#${APP_ID} .rech-header button {
  cursor: pointer;
}
#${APP_ID} .rech-header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
}
#${APP_ID} .rech-compact-button {
  min-height: 26px;
  padding: 3px 6px;
  font-size: 11px;
  line-height: 1.1;
  white-space: nowrap;
}
#${APP_ID} .rech-placement-menu {
  position: relative;
}
#${APP_ID} .rech-placement-menu summary {
  min-height: 28px;
  padding: 5px 8px;
  color: #334155;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
  cursor: pointer;
  list-style: none;
}
#${APP_ID} .rech-placement-menu summary::-webkit-details-marker {
  display: none;
}
#${APP_ID} .rech-placement-menu summary::after {
  content: "▾";
  margin-left: 5px;
  color: #64748b;
  font-size: 10px;
}
#${APP_ID} .rech-placement-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 8;
  display: grid;
  grid-template-columns: repeat(2, max-content);
  gap: 4px;
  padding: 6px;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 7px;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.18);
}
#${APP_ID} .rech-panel-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
  background: #ffffff;
}
#${APP_ID} .rech-panel-tab {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  min-height: 30px;
  padding: 5px 12px;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #dbe3ea;
  border-radius: 6px 6px 0 0;
  font-size: 12px;
  font-weight: 700;
}
#${APP_ID} .rech-panel-tab.is-active {
  z-index: 2;
  color: #0f172a;
  background: #e8eef5;
  border-color: #cbd5df;
}
#${APP_ID} .rech-panel-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 0;
}
#${APP_ID} .rech-summary-pill {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 3px 7px;
  color: #334155;
  background: #f1f5f9;
  border: 1px solid #dbe3ea;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
#${APP_ID} .rech-summary-pill[data-tone="warn"] {
  color: #9a3412;
  background: #fff7ed;
  border-color: #fed7aa;
}
#${APP_ID} .rech-summary-pill[data-tone="muted"] {
  color: #64748b;
  background: #ffffff;
}
#${APP_ID} .rech-panel-mode {
  display: grid;
  gap: 8px;
  margin: 12px;
  padding: 14px;
  color: #334155;
  background: #f8fafc;
  border: 1px solid #dbe3ea;
  border-radius: 7px;
  font-size: 13px;
}
#${APP_ID} .rech-panel-mode strong {
  color: #17202a;
  font-size: 14px;
}
#${APP_ID} .rech-panel-mode p {
  margin: 0;
  line-height: 1.5;
}
#${APP_ID} .rech-panel-mode-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
#${APP_ID} .rech-title {
  font-size: 14px;
}
#${APP_ID} .rech-host {
  overflow: hidden;
  color: #526171;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${APP_ID} .rech-preview {
  display: block;
  width: calc(100% - 24px);
  min-height: 132px;
  margin: 12px;
  padding: 10px;
  color: #17202a;
  background: #fbfcfd;
  border: 1px solid #ccd6df;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}
#${APP_ID} .rech-status {
  flex: 0 0 auto;
  padding: 0 12px 8px;
  color: #526171;
  font-size: 12px;
}
#${APP_ID} .rech-table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 430px;
  margin: 12px;
  overflow: auto;
  border: 1px solid #ccd6df;
  border-radius: 6px;
  background: #ffffff;
}
#${APP_ID}[style*="height"] .rech-table-wrap {
  max-height: none;
}
#${APP_ID} .rech-table-slot {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#${APP_ID} .rech-table-slot > .rech-table-wrap {
  min-height: 0;
  margin: 10px 12px 8px;
}
#${APP_ID} .rech-table-slot > .rech-empty {
  margin: 10px 12px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #ffffff;
}
#${APP_ID} .rech-keyword-filter {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px 12px 0;
}
#${APP_ID} .rech-keyword-filter label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-width: 0;
  color: #475569;
  font-size: 12px;
  font-weight: 700;
}
#${APP_ID} .rech-keyword-filter input {
  min-width: 0;
  height: 30px;
  padding: 5px 8px;
  color: #17202a;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  font-size: 13px;
}
#${APP_ID} .rech-keyword-count {
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
}
#${APP_ID} .rech-value-mode-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 6px 12px 0;
  padding: 6px 8px;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #e1e7ed;
  border-radius: 6px;
  font-size: 11px;
}
#${APP_ID} .rech-value-mode-toggle > span {
  font-weight: 800;
  color: #334155;
}
#${APP_ID} .rech-value-mode-toggle .is-active {
  color: #ffffff;
  background: #334155;
  border-color: #334155;
}
#${APP_ID} .rech-value-mode-toggle small {
  flex-basis: 100%;
  color: #64748b;
  line-height: 1.35;
}
#${APP_ID} .rech-anomaly-slot {
  flex: 0 0 auto;
}
#${APP_ID} .rech-anomaly-warnings {
  display: grid;
  gap: 3px;
  margin: 0 12px 8px;
  padding: 8px 10px;
  color: #9a3412;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.35;
}
#${APP_ID} .rech-anomaly-warnings[hidden] {
  display: none;
}
#${APP_ID} .rech-anomaly-warning-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}
#${APP_ID} .rech-anomaly-close {
  min-height: 22px;
  padding: 2px 6px;
  font-size: 11px;
}
#${APP_ID} .rech-resize-edge,
.rech-modal .rech-resize-edge {
  position: absolute;
  z-index: 5;
  pointer-events: auto;
  user-select: none;
  touch-action: none;
  background: transparent;
}
#${APP_ID} .rech-resize-n,
.rech-modal .rech-resize-n {
  top: 0;
  left: 14px;
  right: 14px;
  height: 8px;
  cursor: ns-resize;
}
#${APP_ID} .rech-resize-s,
.rech-modal .rech-resize-s {
  bottom: 0;
  left: 14px;
  right: 14px;
  height: 8px;
  cursor: ns-resize;
}
#${APP_ID} .rech-resize-e,
.rech-modal .rech-resize-e {
  top: 14px;
  right: 0;
  bottom: 14px;
  width: 8px;
  cursor: ew-resize;
}
#${APP_ID} .rech-resize-w,
.rech-modal .rech-resize-w {
  top: 14px;
  left: 0;
  bottom: 14px;
  width: 8px;
  cursor: ew-resize;
}
#${APP_ID} .rech-resize-ne,
.rech-modal .rech-resize-ne {
  top: 0;
  right: 0;
  width: 16px;
  height: 16px;
  cursor: nesw-resize;
}
#${APP_ID} .rech-resize-se,
.rech-modal .rech-resize-se {
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
}
#${APP_ID} .rech-resize-sw,
.rech-modal .rech-resize-sw {
  left: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nesw-resize;
}
#${APP_ID} .rech-resize-nw,
.rech-modal .rech-resize-nw {
  top: 0;
  left: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
}
.rech-resizing-panel {
  user-select: none !important;
}
.rech-resizing-panel * {
  cursor: inherit !important;
  user-select: none !important;
}
.rech-dragging-panel,
.rech-dragging-panel * {
  cursor: move !important;
  user-select: none !important;
}
#${APP_ID} .rech-result-table,
.rech-modal .rech-result-table {
  width: 100%;
  min-width: 980px;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.35;
}
#${APP_ID} .rech-result-table th,
#${APP_ID} .rech-result-table td,
.rech-modal .rech-result-table th,
.rech-modal .rech-result-table td {
  max-width: 220px;
  padding: 7px 8px;
  border-bottom: 1px solid #e1e7ed;
  border-right: 1px solid #edf1f5;
  vertical-align: top;
  text-align: left;
}
#${APP_ID} .rech-result-table th,
.rech-modal .rech-result-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  color: #334155;
  background: #dbe4ee;
  font-weight: 700;
  white-space: nowrap;
}
#${APP_ID} .rech-result-table th.is-sortable,
.rech-modal .rech-result-table th.is-sortable {
  padding: 0;
}
#${APP_ID} .rech-sort-button,
.rech-modal .rech-sort-button {
  width: 100%;
  min-height: 30px;
  padding: 7px 8px;
  border: 0;
  border-radius: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}
#${APP_ID} .rech-result-table th.is-sorted .rech-sort-button,
.rech-modal .rech-result-table th.is-sorted .rech-sort-button {
  color: #0f3e88;
  background: #dbeafe;
}
#${APP_ID} .rech-result-table td,
.rech-modal .rech-result-table td {
  overflow-wrap: anywhere;
}
#${APP_ID} .rech-result-table tbody tr.is-even-row > td,
.rech-modal .rech-result-table tbody tr.is-even-row > td {
  background: #f6f7f9;
}
#${APP_ID} .rech-result-table td.is-suspicious,
.rech-modal .rech-result-table td.is-suspicious,
#${APP_ID} .rech-result-table tbody tr.is-even-row > td.is-suspicious,
.rech-modal .rech-result-table tbody tr.is-even-row > td.is-suspicious {
  background: #fff7d6;
  box-shadow: inset 0 0 0 1px #facc15;
}
#${APP_ID} .rech-cell-badge,
.rech-modal .rech-cell-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 5px;
  padding: 1px 4px;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
}
#${APP_ID} .rech-index-stack,
.rech-modal .rech-index-stack {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
#${APP_ID} .rech-row-copy-cell,
.rech-modal .rech-row-copy-cell {
  min-width: 104px;
  max-width: 140px;
  white-space: normal;
}
#${APP_ID} .rech-row-copy-button,
.rech-modal .rech-row-copy-button {
  display: inline-flex;
  max-width: 100%;
  min-height: 18px;
  margin: 1px 2px 1px 0;
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.2;
  white-space: normal;
  overflow-wrap: anywhere;
}
#${APP_ID} .rech-duplicate-toggle,
.rech-modal .rech-duplicate-toggle {
  min-height: 18px;
  padding: 1px 4px;
  color: #7c2d12;
  background: #fff7ed;
  border-color: #fed7aa;
  font-size: 10px;
  line-height: 1.2;
}
#${APP_ID} .rech-duplicate-row > td,
.rech-modal .rech-duplicate-row > td {
  padding: 8px;
  background: #fffaf3;
}
#${APP_ID} .rech-duplicate-box,
.rech-modal .rech-duplicate-box {
  display: grid;
  gap: 6px;
}
#${APP_ID} .rech-duplicate-box strong,
.rech-modal .rech-duplicate-box strong {
  color: #7c2d12;
  font-size: 12px;
}
#${APP_ID} .rech-duplicate-table,
.rech-modal .rech-duplicate-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
#${APP_ID} .rech-duplicate-table td,
.rech-modal .rech-duplicate-table td {
  padding: 5px 6px;
  border: 1px solid #fde7c7;
  background: #ffffff;
  overflow-wrap: anywhere;
}
#${APP_ID} .rech-result-table td.is-empty,
.rech-modal .rech-result-table td.is-empty {
  color: #9a3412;
  background: #fff7ed;
  font-size: 11px;
  font-weight: 700;
}
#${APP_ID} .rech-result-table td.is-clickable,
.rech-modal .rech-result-table td.is-clickable {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
#${APP_ID} .rech-result-table a,
.rech-modal .rech-result-table a {
  color: #1f6feb;
  text-decoration: underline;
}
#${APP_ID} .rech-empty {
  padding: 14px;
  color: #6b7280;
  font-size: 13px;
}
#${APP_ID} .rech-help,
.rech-modal .rech-help {
  margin: 0 0 10px;
  color: #526171;
  font-size: 13px;
}
.rech-modal .rech-ai-assistant {
  margin: 8px 0;
  padding: 10px;
  border: 1px solid #d8e0e7;
  border-radius: 6px;
  background: #f8fafc;
}
.rech-modal .rech-ai-assistant summary {
  cursor: pointer;
  font-weight: 700;
}
.rech-modal .rech-ai-guide {
  margin: 8px 0 10px;
  padding: 10px;
  border: 1px solid #e1e7ed;
  border-radius: 6px;
  background: #ffffff;
  color: #334155;
  font-size: 12px;
  line-height: 1.5;
}
.rech-modal .rech-ai-guide small {
  display: block;
  color: #6b7280;
}
.rech-modal .rech-ai-session {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 10px;
  margin: 8px 0;
  padding: 9px 10px;
  color: #334155;
  background: #ffffff;
  border: 1px solid #d8e0e7;
  border-radius: 6px;
  font-size: 12px;
}
.rech-modal .rech-ai-session strong {
  color: #17202a;
  font-size: 12px;
}
.rech-modal .rech-ai-session span {
  min-width: 0;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.rech-modal .rech-ai-session small {
  grid-column: 1 / -1;
  color: #64748b;
  line-height: 1.35;
}
.rech-modal .rech-ai-flow {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
  gap: 6px;
  margin: 8px 0;
}
.rech-modal .rech-ai-flow-item {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 7px;
  background: #f8fafc;
  border: 1px solid #e1e7ed;
  border-radius: 6px;
}
.rech-modal .rech-ai-flow-item span {
  color: #17202a;
  font-size: 12px;
  font-weight: 800;
}
.rech-modal .rech-ai-flow-item small {
  color: #64748b;
  font-size: 11px;
  line-height: 1.3;
}
.rech-modal .rech-ai-step {
  display: grid;
  gap: 8px;
  margin: 8px 0;
  padding: 10px;
  background: #ffffff;
  border: 1px solid #dfe6ed;
  border-radius: 7px;
}
.rech-modal .rech-ai-step-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.rech-modal .rech-ai-step-number {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  color: #ffffff;
  background: #1f2937;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
}
.rech-modal .rech-ai-step-title {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.rech-modal .rech-ai-step-title strong {
  color: #17202a;
  font-size: 13px;
}
.rech-modal .rech-ai-step-title small {
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}
.rech-modal .rech-ai-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
}
.rech-modal .rech-ai-actions .is-soft-disabled {
  opacity: 0.55;
}
.rech-modal .rech-ai-source-control {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 8px;
  border: 1px solid #e1e7ed;
  border-radius: 6px;
  background: #ffffff;
}
.rech-modal .rech-ai-source-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.rech-modal .rech-ai-source-step {
  display: inline-grid;
  place-items: center;
  min-width: 34px;
  height: 20px;
  padding: 0 6px;
  color: #ffffff;
  background: #334155;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
.rech-modal .rech-ai-source-row select {
  min-height: 30px;
  padding: 5px 8px;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  background: #ffffff;
}
.rech-modal .rech-ai-source-status {
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.rech-modal .rech-ai-source-diagnostics {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 6px;
  align-items: center;
  min-width: 0;
  padding: 6px 7px;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #edf1f5;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.35;
}
.rech-modal .rech-ai-source-metric {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  min-height: 20px;
  padding: 2px 6px;
  background: #ffffff;
  border: 1px solid #dbe3ea;
  border-radius: 999px;
  white-space: nowrap;
}
.rech-modal .rech-ai-source-metric strong {
  color: #334155;
  font-weight: 800;
}
.rech-modal .rech-ai-source-diagnostics-note {
  flex-basis: 100%;
  color: #64748b;
  overflow-wrap: anywhere;
}
.rech-modal .rech-ai-source-diagnostics-note.is-warning {
  color: #9a3412;
}
.rech-modal .rech-ai-source-note {
  color: #475569;
  font-size: 12px;
  line-height: 1.4;
}
.rech-modal .rech-ai-source-help {
  display: grid;
  gap: 3px;
  padding: 7px 8px;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #edf1f5;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.35;
}
.rech-modal .rech-ai-label {
  display: block;
  margin: 0 0 -4px;
  color: #334155;
  font-size: 12px;
  font-weight: 700;
}
.rech-modal .rech-ai-textarea {
  width: 100%;
  min-height: 120px;
  max-height: 260px;
  resize: vertical;
  padding: 8px;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.4;
  background: #ffffff;
}
.rech-modal .rech-ai-note-textarea {
  min-height: 72px;
  max-height: 150px;
}
.rech-modal .rech-ai-retry-textarea {
  min-height: 92px;
  max-height: 220px;
}
.rech-modal .rech-ai-shape-list {
  display: grid;
  gap: 4px;
  padding: 8px;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #edf1f5;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.35;
}
.rech-modal .rech-ai-shape-list span::before {
  content: "・";
  color: #64748b;
}
.rech-modal .rech-ai-review {
  display: grid;
  gap: 8px;
  margin-top: 0;
  min-width: 0;
  overflow: visible;
}
.rech-modal .rech-ai-review[hidden] {
  display: none;
}
.rech-modal .rech-ai-review-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  color: #334155;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  font-size: 12px;
}
.rech-modal .rech-ai-review-status[data-state="ok"] {
  color: #166534;
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.rech-modal .rech-ai-review-status[data-state="warning"] {
  color: #9a3412;
  background: #fff7ed;
  border-color: #fed7aa;
}
.rech-modal .rech-ai-review-status[data-state="error"] {
  color: #991b1b;
  background: #fef2f2;
  border-color: #fecaca;
}
.rech-modal .rech-ai-review-list,
.rech-modal .rech-ai-score,
.rech-modal .rech-ai-table-preview {
  min-width: 0;
  padding: 9px 10px;
  color: #334155;
  background: #ffffff;
  border: 1px solid #e1e7ed;
  border-radius: 6px;
  font-size: 12px;
}
.rech-modal .rech-ai-score,
.rech-modal .rech-ai-table-preview {
  overflow: hidden;
}
.rech-modal .rech-ai-score {
  overflow: auto;
}
.rech-modal .rech-ai-review-list strong,
.rech-modal .rech-ai-score strong,
.rech-modal .rech-ai-table-preview strong {
  display: block;
  margin-bottom: 5px;
}
.rech-modal .rech-ai-preview-note {
  display: block;
  margin: 0 0 6px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.35;
}
.rech-modal .rech-ai-review-list ul {
  margin: 0;
  padding-left: 18px;
}
.rech-modal .rech-ai-review-list li {
  margin: 2px 0;
  overflow-wrap: anywhere;
}
.rech-modal .rech-ai-review-list.is-error {
  background: #fff7f7;
  border-color: #fecaca;
}
.rech-modal .rech-ai-review-list.is-warning {
  background: #fffaf0;
  border-color: #fed7aa;
}
.rech-modal .rech-ai-review-list.is-correction {
  background: #eff6ff;
  border-color: #bfdbfe;
}
.rech-modal .rech-ai-score-table {
  min-width: 560px;
  width: 100%;
  border-collapse: collapse;
}
.rech-modal .rech-ai-score-note {
  display: block;
  margin: 0 0 6px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.35;
}
.rech-modal .rech-ai-score-table th,
.rech-modal .rech-ai-score-table td {
  padding: 5px 6px;
  border-bottom: 1px solid #e6ebef;
  text-align: left;
  vertical-align: top;
}
.rech-modal .rech-ai-score-table th:first-child,
.rech-modal .rech-ai-score-table td:first-child {
  width: 44px;
  text-align: center;
}
.rech-modal .rech-ai-score-table input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
}
.rech-modal .rech-ai-table-preview .rech-table-wrap {
  display: block;
  width: 100%;
  max-width: 100%;
  max-height: min(520px, 55vh);
  margin: 6px 0 0;
  overflow: auto;
  background: #ffffff;
  border: 1px solid #dbe3ea;
  border-radius: 6px;
}
.rech-modal .rech-ai-table-preview .rech-result-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
}
.rech-modal .rech-ai-table-preview .rech-result-table th,
.rech-modal .rech-ai-table-preview .rech-result-table td {
  padding: 5px 7px;
  white-space: nowrap;
}
.rech-modal .rech-candidate-panel {
  margin: 8px 0;
  padding: 10px;
  border: 1px solid #d8e0e7;
  border-radius: 6px;
  background: #ffffff;
}
.rech-modal .rech-candidate-panel summary {
  cursor: pointer;
  font-weight: 700;
}
.rech-modal .rech-candidate-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;
}
.rech-modal .rech-candidate-status {
  color: #64748b;
  font-size: 12px;
}
.rech-modal .rech-candidate-body {
  display: grid;
  gap: 8px;
}
.rech-modal .rech-candidate-group {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid #e1e7ed;
  border-radius: 6px;
  background: #f8fafc;
}
.rech-modal .rech-candidate-group > strong {
  color: #17202a;
  font-size: 12px;
}
.rech-modal .rech-candidate-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 3px;
}
.rech-modal .rech-candidate-selector {
  justify-content: flex-start;
  width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: left;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
}
.rech-modal .rech-candidate-row small {
  color: #64748b;
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.rech-modal .rech-format-preview,
.rech-modal .rech-backup-panel {
  margin: 8px 0;
  padding: 10px;
  border: 1px solid #d8e0e7;
  border-radius: 6px;
  background: #ffffff;
}
.rech-modal .rech-format-preview summary {
  cursor: pointer;
  font-weight: 700;
}
.rech-modal .rech-format-preview-body {
  margin-top: 8px;
  overflow: auto;
}
.rech-modal .rech-format-preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.rech-modal .rech-format-preview-table th,
.rech-modal .rech-format-preview-table td {
  padding: 6px 7px;
  border-bottom: 1px solid #e5edf4;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.rech-modal .rech-backup-panel {
  display: grid;
  gap: 7px;
}
.rech-modal .rech-backup-panel > strong {
  font-size: 13px;
}
.rech-modal .rech-backup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #edf1f5;
}
.rech-modal .rech-backup-row span,
.rech-modal .rech-backup-panel small {
  color: #64748b;
  font-size: 12px;
}
#${APP_ID} .rech-actions {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px 14px 42px;
  background: #ffffff;
  border-top: 1px solid #e6ebef;
}
#${APP_ID} button,
.rech-modal button {
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid #b7c2cc;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
#${APP_ID} button:hover,
.rech-modal button:hover {
  filter: brightness(0.97);
}
#${APP_ID} .rech-primary,
.rech-modal .rech-primary {
  color: #ffffff;
  background: #1f6feb;
  border-color: #1f6feb;
}
#${APP_ID} .rech-secondary,
.rech-modal .rech-secondary {
  color: #17202a;
  background: #ffffff;
}
#${APP_ID} .rech-toast {
  display: none;
  margin: 0 12px 12px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
}
#${APP_ID} .rech-toast.is-visible {
  display: block;
}
#${APP_ID} .rech-toast[data-type="success"] {
  color: #0f5132;
  background: #d1e7dd;
}
#${APP_ID} .rech-toast[data-type="error"] {
  color: #842029;
  background: #f8d7da;
}
.rech-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: block;
  padding: 10px;
  pointer-events: auto;
  background: rgba(15, 23, 42, 0.08);
}
.rech-modal, .rech-modal * {
  box-sizing: border-box;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.rech-modal {
  width: min(760px, calc(100vw - 24px));
  height: min(620px, calc(100vh - 20px));
  max-height: calc(100vh - 20px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: fixed;
  pointer-events: auto;
  color: #17202a;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 8px;
  box-shadow: 0 10px 34px rgba(16, 24, 40, 0.22);
}
.rech-modal.is-attention {
  animation: rech-modal-attention 0.28s ease-out;
}
@keyframes rech-modal-attention {
  0% {
    box-shadow: 0 10px 34px rgba(16, 24, 40, 0.22);
    transform: translateX(0);
  }
  35% {
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.22), 0 10px 34px rgba(16, 24, 40, 0.22);
    transform: translateX(-2px);
  }
  70% {
    transform: translateX(2px);
  }
  100% {
    box-shadow: 0 10px 34px rgba(16, 24, 40, 0.22);
    transform: translateX(0);
  }
}
.rech-modal-header,
.rech-modal-footer {
  flex: 0 0 auto;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: #ffffff;
  border-bottom: 1px solid #d8e0e7;
}
.rech-modal-header {
  cursor: move;
  user-select: none;
}
.rech-modal-header button {
  cursor: pointer;
}
.rech-settings-tabs {
  flex: 0 0 auto;
  z-index: 1;
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  background: #f8fafc;
  border-bottom: 1px solid #d8e0e7;
}
.rech-modal .rech-tab {
  flex: 1;
  min-width: 0;
  padding: 7px 6px;
  color: #475569;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
}
.rech-modal .rech-tab.is-active {
  color: #0f172a;
  background: #ffffff;
  border-color: #cbd5df;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}
.rech-modal .rech-output-templates {
  display: grid;
  gap: 8px;
  margin: 8px 0;
}
.rech-modal .rech-output-template-note {
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}
.rech-modal .rech-output-template-list {
  display: grid;
  gap: 10px;
}
.rech-modal .rech-output-template-item {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid #e1e7ed;
  border-radius: 6px;
  background: #f8fafc;
}
.rech-modal .rech-output-template-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
.rech-modal .rech-output-template-header input,
.rech-modal .rech-output-template-item textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  background: #ffffff;
}
.rech-modal .rech-output-template-header input {
  min-height: 30px;
  padding: 5px 8px;
}
.rech-modal .rech-output-template-item textarea {
  min-height: 96px;
  padding: 8px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.4;
}
.rech-settings-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.rech-modal-footer {
  justify-content: space-between;
  border-top: 1px solid #d8e0e7;
  border-bottom: 0;
}
.rech-save-status {
  color: #64748b;
  font-size: 12px;
}
.rech-save-status[data-state="dirty"] {
  color: #9a3412;
  font-weight: 700;
}
.rech-save-status[data-state="saved"] {
  color: #166534;
}
.rech-resizing-settings {
  user-select: none !important;
}
.rech-resizing-settings * {
  cursor: inherit !important;
  user-select: none !important;
}
.rech-dragging-settings,
.rech-dragging-settings * {
  cursor: move !important;
  user-select: none !important;
}
.rech-modal h2,
.rech-modal h3 {
  margin: 0;
}
.rech-modal h2 {
  font-size: 16px;
}
.rech-modal h3 {
  margin-bottom: 6px;
  font-size: 13px;
}
.rech-section {
  padding: 11px 12px;
  border-bottom: 1px solid #e6ebef;
}
.rech-section.is-hidden {
  display: none;
}
.rech-control {
  display: grid;
  gap: 4px;
  margin: 0 0 8px;
  font-size: 12px;
  color: #526171;
}
.rech-control input,
.rech-control select,
.rech-control textarea {
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  color: #17202a;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  font-size: 13px;
}
.rech-control textarea {
  min-height: 72px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.rech-control textarea.rech-json-editor {
  min-height: 260px;
  max-height: 45vh;
  font-size: 12px;
  line-height: 1.45;
}
.rech-regex-preset {
  width: 100%;
  min-height: 30px;
  color: #17202a;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 6px;
  font-size: 12px;
}
.rech-regex-preset.is-compact {
  margin-top: 3px;
  min-height: 26px;
  padding: 2px 4px;
  font-size: 11px;
}
.rech-match-explain {
  display: grid;
  gap: 3px;
  margin: 8px 0 10px;
  padding: 9px 10px;
  border: 1px solid #d8e0e7;
  border-radius: 6px;
  background: #f8fafc;
  color: #334155;
  font-size: 12px;
  line-height: 1.4;
}
.rech-match-explain strong {
  color: #17202a;
}
.rech-match-explain small {
  color: #64748b;
}
.rech-control-hint,
.rech-help-text,
.rech-help-list {
  margin: 0;
  color: #64748b;
  font-size: 11px;
  line-height: 1.45;
}
.rech-help-text {
  margin-bottom: 8px;
}
.rech-help-list {
  padding-left: 18px;
  margin-bottom: 10px;
}
.rech-help-list li {
  margin: 2px 0;
}
.rech-term {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.rech-modal .rech-help-icon {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  min-height: 16px;
  padding: 0;
  color: #475569;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.rech-help-popover {
  position: fixed;
  z-index: 2147483647;
  width: min(320px, calc(100vw - 20px));
  max-height: min(260px, calc(100vh - 20px));
  padding: 9px 11px;
  overflow: auto;
  color: #ffffff;
  background: #1f2937;
  border-radius: 6px;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.28);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  white-space: normal;
  pointer-events: auto;
}
.rech-listing-editor {
  display: grid;
  gap: 10px;
}
.rech-setup-guide {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #d8e0e7;
  border-radius: 7px;
  background: #f8fafc;
}
.rech-setup-guide strong {
  color: #0f172a;
  font-size: 13px;
}
.rech-setup-guide ol {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rech-setup-guide li {
  min-width: 0;
  padding: 8px;
  border: 1px solid #d8e0e7;
  border-radius: 6px;
  background: #ffffff;
}
.rech-setup-guide li.is-ok {
  border-color: #bbd7c0;
  background: #f2fbf4;
}
.rech-setup-guide li.is-warn {
  border-color: #fed7aa;
  background: #fff7ed;
}
.rech-setup-guide li span,
.rech-setup-guide li small {
  display: block;
  overflow-wrap: anywhere;
}
.rech-setup-guide li span {
  color: #17202a;
  font-size: 12px;
  font-weight: 700;
}
.rech-setup-guide li small {
  margin-top: 3px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.35;
}
.rech-live-preview {
  display: grid;
  gap: 0;
  border: 1px solid #cbd5df;
  border-radius: 7px;
  background: #ffffff;
  overflow: hidden;
}
.rech-live-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  color: #17202a;
  background: #eef2f7;
  border-bottom: 1px solid #dbe3ea;
  font-size: 12px;
}
.rech-live-preview-status {
  min-width: 0;
  color: #2563eb;
  font-size: 11px;
  font-weight: 700;
  text-align: right;
}
.rech-live-preview-status.is-error {
  color: #b91c1c;
}
.rech-live-preview-table {
  max-height: 240px;
  overflow: auto;
}
.rech-live-preview-table .rech-table-wrap {
  max-height: none;
  border: 0;
  border-radius: 0;
}
.rech-source-panel {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-height: 180px;
  max-height: 320px;
  border: 1px solid #cbd5df;
  border-radius: 7px;
  background: #ffffff;
  overflow: hidden;
}
.rech-source-panel[hidden] {
  display: none;
}
.rech-source-panel-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  color: #17202a;
  background: #f8fafc;
  border-bottom: 1px solid #dbe3ea;
  font-size: 12px;
}
.rech-source-panel-header span {
  min-width: 0;
  overflow: hidden;
  color: #64748b;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.rech-source-actions {
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.rech-source-actions input {
  width: 150px;
  min-height: 28px;
  padding: 5px 7px;
  border: 1px solid #cbd5df;
  border-radius: 5px;
  font-size: 12px;
}
.rech-source-status {
  padding: 6px 10px 0;
  color: #64748b;
  font-size: 12px;
}
.rech-source-code {
  min-height: 0;
  margin: 0;
  padding: 10px;
  overflow: auto;
  color: #111827;
  background: #ffffff;
  font-family: Consolas, "SFMono-Regular", ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
.rech-source-code mark {
  color: #111827;
  background: #fde68a;
}
.rech-selector-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.rech-auto-split-note,
.rech-room-row-help {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  color: #334155;
  background: #f8fafc;
  border: 1px solid #dbe3ea;
  border-radius: 6px;
}
.rech-auto-split-note {
  grid-template-columns: minmax(0, 1fr);
  font-size: 12px;
  line-height: 1.45;
}
.rech-auto-split-note span {
  color: #64748b;
}
.rech-room-row-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
}
.rech-room-row-copy span {
  color: #64748b;
}
.rech-room-row-examples {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.rech-room-row-examples span {
  padding: 3px 6px;
  color: #475569;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 999px;
  font-size: 11px;
}
.rech-mini-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
.rech-mini-actions .rech-secondary {
  padding: 4px 7px;
  font-size: 11px;
}
.rech-field-map-title {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  gap: 8px;
  padding: 6px 8px;
  color: #17202a;
  background: #eef2f7;
  border: 1px solid #cbd5df;
  border-bottom: 0;
  border-radius: 7px 7px 0 0;
  font-size: 12px;
}
.rech-field-map-title span {
  flex: 1;
  color: #64748b;
  font-size: 10px;
  white-space: nowrap;
}
.rech-field-map tr.is-focus-row {
  outline: 3px solid #f59e0b;
  outline-offset: -3px;
  background: #fffbeb;
}
.rech-compact-control {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  color: #475569;
  font-size: 11px;
}
.rech-compact-control input,
.rech-field-map input,
.rech-field-map select {
  width: 100%;
  min-width: 0;
  height: 26px;
  padding: 3px 6px;
  color: #17202a;
  background: #ffffff;
  border: 1px solid #cbd5df;
  border-radius: 5px;
  font-size: 11px;
}
.rech-field-map select {
  padding-right: 3px;
}
.rech-input-action,
.rech-cell-input-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px;
  align-items: center;
}
.rech-modal .rech-mini-button {
  min-height: 26px;
  padding: 3px 6px;
  font-size: 11px;
  white-space: nowrap;
}
.rech-segmented {
  display: inline-grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 3px;
}
.rech-modal .rech-segmented button {
  min-height: 28px;
  padding: 4px 6px;
  color: #475569;
  background: #ffffff;
  border-color: #cbd5df;
  font-size: 11px;
}
.rech-modal .rech-segmented button.is-active {
  color: #ffffff;
  background: #334155;
  border-color: #334155;
}
.rech-field-map-wrap {
  width: 100%;
  min-width: 320px;
  min-height: 160px;
  max-width: none;
  max-height: 48vh;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 0 0 7px 7px;
  background: #ffffff;
  position: relative;
}
.rech-field-map {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 11px;
}
.rech-field-map th,
.rech-field-map td {
  padding: 3px 4px;
  border: 1px solid #dbe3ea;
  vertical-align: middle;
}
.rech-field-map th:nth-child(1) {
  width: 76px;
}
.rech-field-map th:nth-child(2) {
  width: 76px;
}
.rech-field-map th:nth-child(4) {
  width: 118px;
}
.rech-field-map th:nth-child(5) {
  width: 90px;
}
.rech-field-map th:nth-child(6) {
  width: 180px;
}
.rech-field-map thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  color: #334155;
  background: #e8eef5;
  font-weight: 700;
}
.rech-field-map th:first-child {
  width: 76px;
  color: #334155;
  background: #f8fafc;
  text-align: left;
  font-weight: 700;
  white-space: nowrap;
}
.rech-field-map .regex-col {
  display: none;
}
.rech-listing-editor.show-regex .rech-field-map .regex-col {
  display: table-cell;
}
.rech-advanced-json {
  margin-top: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #fbfcfd;
}
.rech-advanced-json summary {
  padding: 8px 10px;
  cursor: pointer;
  color: #475569;
  font-size: 12px;
  font-weight: 700;
}
.rech-advanced-json .rech-control {
  margin: 0 10px 10px;
}
.rech-inline-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.rech-css-probe {
  display: block;
  color: #526171;
  line-height: 1.4;
}
.rech-field-preview,
.rech-selector-preview {
  display: block;
  max-height: 2.9em;
  margin-top: 3px;
  overflow: hidden;
  color: #2563eb;
  font-size: 10.5px;
  line-height: 1.35;
  word-break: break-all;
}
.rech-selector-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.rech-compact-control > .rech-selector-suggestions {
  grid-column: 2;
}
.rech-selector-suggestions span {
  align-self: center;
  color: #64748b;
  font-size: 11px;
}
.rech-selector-suggestion {
  max-width: 220px;
  min-height: 24px;
  padding: 3px 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
}
.rech-field-preview.is-empty,
.rech-selector-preview.is-empty {
  color: #64748b;
}
.rech-field-preview.is-error,
.rech-selector-preview.is-error {
  color: #b91c1c;
  font-weight: 700;
}
.rech-picker-target {
  outline: 3px solid #f97316 !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
}
.rech-highlight-item {
  outline: 3px solid #2563eb !important;
  outline-offset: 2px !important;
}
.rech-highlight-room {
  outline: 3px solid #f59e0b !important;
  outline-offset: 1px !important;
}
.rech-highlight-value {
  outline: 3px solid #16a34a !important;
  outline-offset: 1px !important;
}
.rech-picker-notice {
  position: fixed;
  left: 50%;
  bottom: 18px;
  z-index: 2147483647;
  max-width: min(720px, calc(100vw - 24px));
  transform: translateX(-50%);
  padding: 9px 12px;
  color: #ffffff;
  background: #1f2937;
  border-radius: 7px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.25);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.45;
  pointer-events: none;
}
.rech-picker-notice[data-type="success"] {
  background: #166534;
}
.rech-picker-notice[data-type="error"] {
  background: #991b1b;
}
.rech-field-editor {
  padding: 0;
  margin-bottom: 8px;
  border: 1px solid #d8e0e7;
  border-radius: 8px;
  background: #fbfcfd;
}
.rech-field-editor > :not(summary) {
  margin-left: 10px;
  margin-right: 10px;
}
.rech-field-editor > :last-child {
  margin-bottom: 10px;
}
.rech-field-editor summary {
  list-style: none;
  cursor: pointer;
}
.rech-field-editor summary::-webkit-details-marker {
  display: none;
}
.rech-field-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
}
.rech-field-summary {
  margin-left: auto;
  color: #64748b;
  font-size: 11px;
}
@media (max-width: 560px) {
  .rech-modal-overlay {
    padding: 6px;
  }
  .rech-modal {
    width: calc(100vw - 12px);
    max-height: calc(100vh - 12px);
    left: 6px !important;
    top: 6px !important;
  }
}
`;
    styleDocument.documentElement.appendChild(style);
  }
})();
