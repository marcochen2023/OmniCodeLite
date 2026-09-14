'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 全域狀態
// ═══════════════════════════════════════════════════════════════
// 無框架、無打包：所有模組共用 window.OC 這個唯一狀態物件。
// 契約見 docs/ARCHITECTURE.md §10.1
// ═══════════════════════════════════════════════════════════════

window.OC = {
    // ─── 設定 / 環境 ───
    cfg: {
        workspace: '',
        permissionMode: 'default',    // plan | default | acceptEdits | full
        transport: 'direct',          // direct | relay
        model: 'claude-sonnet-5',
        imageModel: 'gemini-3.1-flash-image',
        autoCompactAt: 0.75,
        maxTurns: 40,
        // 關閉的能力群組。usertools 出廠關閉：它能用儲存的金鑰對外發出
        // 任意 POST／DELETE，比 web_fetch（只讀）高一階，該由使用者明確打開。
        // 關著時系統提示會留一句說明，模型知道要請使用者跑 /tools usertools on。
        toolGroupsOff: ['usertools'],
        effortLevel: 'high',          // off | low | medium | high | xhigh | max（推理強度，同 Claude Code /effort）
        thinkingLevel: null,          // 舊鍵：只在遷移時讀一次，不要再寫入
        autoVerify: true,             // 改完程式碼自動跑驗證
        theme: 'dark',
        locale: 'en',                   // 介面語系預設英文：en | zh-TW | zh-CN | ja | ko（見 i18n.js）
        mcpServers: {},
        extraApiHosts: [],
        allowRules: [],
        denyRules: [],
        sentinel: true,               // Sentinel 獨立監控總開關（契約 §13.5）
        sentinelNetAsk: true,         // default 模式下對外連線每會話問一次
        scopeRules: {},               // 工具名 => allow|ask|deny（只針對 act 範圍）
        privacyTrain: false,          // 對話是否可用於訓練（預設否；純宣告）
        recentWorkspaces: [],
        modelConfig: null,            // 模型管理面板的使用者設定（見 models.js）
    },
    env: {},                          // {php, os, workspace_exists, workspace_writable}
    ws: '',                           // 工作區絕對路徑（顯示用）
    ready: false,

    // ─── 會話 ───
    session: {
        id: '',
        title: '',
        ws: '',
        model: '',
        created: 0,
        updated: 0,
        messages: [],
        todos: [],
        usage: { in: 0, out: 0, cost: 0 },
        compactions: 0,
        files_touched: [],
    },
    get messages() { return this.session.messages; },
    set messages(v) { this.session.messages = v; },
    get todos() { return this.session.todos; },
    set todos(v) { this.session.todos = v; },
    get usage() { return this.session.usage; },

    // ─── Agent 執行狀態 ───
    running: false,
    abort: null,                      // AbortController
    turn: 0,
    pending: null,                    // 待授權工具呼叫 {toolUse, resolve}
    lastError: null,
    sessionAllow: [],                 // 本會話一律允許的規則（不落盤）

    // ─── 執行中的排隊訊息 ───
    queued: [],                       // [{text, attachments, at}] 下一個回合邊界注入

    // ─── 檢查點（回溯）───
    checkpointId: null,               // 本回合的檢查點 id（第一次寫入時才建立）
    _turnLabel: '',                   // 本回合的標籤（取自使用者訊息開頭）
    _cpWarned: false,                 // 已提醒過「還原點建立失敗」，不重複洗版

    // ─── 工具 ───
    tools: [],                        // 目前送給模型的工具 schema
    mcpTools: [],                     // MCP 動態工具
    skills: [],                       // [{name,description,path,scope}]
    agents: [],                       // 自訂子代理 [{name,description,tools,model,readonly}]
    commands: [],                     // 自訂斜線指令 [{name,description,args,prompt}]

    // ─── 編輯器 ───
    openFiles: [],                    // [{path,content,original,dirty,cm,mode}]
    activeFile: null,

    // ─── 檔案 / 終端機 ───
    readCache: {},                    // path -> {mtime,size,at}（內容有沒有變）
    seenFiles: {},                    // path -> true（模型知不知道內容）
    shells: {},                       // shell_id -> {command,offset,running,poll}
    tree: {},                         // 已展開的目錄快取

    // ─── UI ───
    panel: 'files',
    dock: 'terminal',
    dockOpen: true,
    imageStudio: { images: [], refs: [], current: null },

    // ─── 統計 ───
    stats: { toolCalls: 0, filesEdited: 0, commandsRun: 0, startedAt: Date.now() },
};

// 常用捷徑
window.cfg = () => window.OC.cfg;
window.ws = () => window.OC.ws;

// 權限模式 metadata（permissions.js / UI 共用）
window.PERM_MODES = {
    plan: {
        label: '規劃',
        ccName: 'Plan',
        glyph: '⏸',
        icon: 'schema',
        color: 'var(--info)',
        desc: '只調查不動手：可讀檔、搜尋，不可寫入或執行命令。適合先產出方案。',
    },
    default: {
        label: '手動',
        ccName: 'Manual',
        glyph: '●',
        icon: 'shield_person',
        color: 'var(--accent)',
        desc: '寫入檔案與執行命令前會詢問你。最安全的日常模式。',
    },
    acceptEdits: {
        label: '自動編輯',
        ccName: 'Accept Edits',
        glyph: '⏵',
        icon: 'edit_note',
        color: 'var(--warning)',
        desc: '檔案新增/修改/刪除免詢問；執行命令與網路存取仍會詢問。',
    },
    full: {
        label: '全自動',
        ccName: 'Bypass',
        glyph: '⏵⏵',
        icon: 'bolt',
        color: 'var(--danger)',
        desc: '100% 權限：工作區內所有檔案操作、命令執行、網路存取全部自動放行。',
    },
};

// 工具危險等級 → 中文標籤
window.DANGER_LABEL = {
    none:  { text: '唯讀', color: 'var(--ink-faint)' },
    write: { text: '寫入', color: 'var(--warning)' },
    exec:  { text: '執行', color: 'var(--danger)' },
    net:   { text: '網路', color: 'var(--info)' },
};
