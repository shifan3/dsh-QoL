window.__ModuleLoader__.load({
  id: "dsh-qol",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // =====================================================================
    // Feature 1: Enter inserts a newline; Ctrl/Cmd+Enter keeps sending.
    // =====================================================================

    // DSH 聊天输入框是 InputBar 里的 textarea，带有稳定的 `data-phase` 属性。
    function isComposerTextarea(el) {
      return el instanceof HTMLTextAreaElement && el.hasAttribute("data-phase");
    }

    function isComposing(event) {
      if (event.isComposing) return true;
      if (event.nativeEvent && event.nativeEvent.isComposing) return true;
      // 兼容部分浏览器/输入法：keyCode 229 表示 IME 正在组合。
      if (event.keyCode === 229) return true;
      return false;
    }

    function shouldInterceptEnter(event) {
      const el = event.target;
      if (!isComposerTextarea(el)) return false;
      if (event.key !== "Enter") return false;
      // Ctrl/Cmd+Enter 保持原有“发送/插话”逻辑不变。
      if (event.ctrlKey || event.metaKey) return false;
      // 输入法组合期间的 Enter 用于确认候选词，不拦截。
      if (isComposing(event)) return false;
      // 禁用/只读（忙碌、锁定、workspace 触发器等）交给原有逻辑处理。
      if (el.disabled || el.readOnly) return false;
      // workspace 选择模式（hero 输入框）的 Enter 用于选择 workspace。
      if (el.getAttribute("aria-haspopup") === "menu") return false;
      // 命令/候选菜单打开时，Enter 应交给 DSH 原有逻辑去选择菜单项。
      const card = el.closest ? el.closest("[data-composer-card]") : null;
      if (card && card.querySelector('[role="listbox"], [role="menu"], [aria-expanded="true"]')) return false;
      return true;
    }

    function onKeyDownCapture(event) {
      if (!shouldInterceptEnter(event)) return;
      // 在捕获阶段截停 keydown，使 React 的 onKeyDown 收不到这次 Enter。
      // 不调用 preventDefault，因此浏览器默认行为仍会执行：textarea 原地换行。
      // 随后的原生 input 事件会照常触发 React onChange，把新值写入草稿状态。
      event.stopPropagation();
    }

    // =====================================================================
    // Feature 2: edit a previous user message and re-answer from it.
    // =====================================================================

    const API = "/dsh-qol/rewrite";
    const TAG = "dsh-qol";

    const CSS = `
.dsh-qol-edit{flex:none;}
.dsh-qol-editor{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:8px;margin:6px 0;padding:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);}
.dsh-qol-textarea{box-sizing:border-box;width:100%;min-height:72px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:8px 10px;background:rgba(127,127,127,.06);color:var(--dsw-alias-label-primary,#222);font:inherit;line-height:1.5;}
.dsh-qol-actions{display:flex;align-items:center;gap:8px;}
.dsh-qol-status{flex:1;font-size:12px;color:var(--dsw-alias-label-secondary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-qol-save,.dsh-qol-branch,.dsh-qol-cancel{padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary,#222);cursor:pointer;font-size:12px;}
.dsh-qol-save{background:var(--dsw-alias-button-info-fill,#2d6cdf);border-color:transparent;color:#fff;}
.dsh-qol-branch{border-color:var(--dsw-alias-button-info-fill,#2d6cdf);color:var(--dsw-alias-button-info-fill,#2d6cdf);}
.dsh-qol-save:disabled,.dsh-qol-branch:disabled,.dsh-qol-cancel:disabled{opacity:.55;cursor:default;}
.dsh-qol-fab{position:fixed;left:16px;bottom:16px;z-index:9990;width:38px;height:38px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-button-floating-fill,#2b2b2b);color:var(--dsw-alias-label-primary,#eee);cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:grid;place-items:center;}
.dsh-qol-fab:hover{background:var(--dsw-alias-button-floating-hover,#3a3a3a);}
.dsh-qol-editor-overlay{position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;background:#1e1e1e;color:#d4d4d4;}
.dsh-qol-editor-header{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #333;background:#252526;}
.dsh-qol-editor-title{font-weight:600;font-size:13px;color:#ccc;white-space:nowrap;}
.dsh-qol-editor-path{flex:1;background:#3c3c3c;border:1px solid #555;border-radius:4px;color:#eee;padding:6px 10px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none;}
.dsh-qol-editor-btn{padding:6px 12px;border-radius:4px;border:1px solid #555;background:#3c3c3c;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;}
.dsh-qol-editor-btn:hover{background:#4a4a4a;}
.dsh-qol-editor-btn.primary{background:#0e639c;border-color:#0e639c;color:#fff;}
.dsh-qol-editor-body{flex:1;min-height:0;display:flex;}
.dsh-qol-editor-sidebar{width:260px;min-width:180px;border-right:1px solid #333;background:#252526;overflow-y:auto;display:flex;flex-direction:column;}
.dsh-qol-editor-sidebar-header{padding:8px 10px;font-size:12px;color:#999;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dsh-qol-editor-filelist{flex:1;overflow-y:auto;}
.dsh-qol-editor-file{display:block;width:100%;text-align:left;background:none;border:none;color:#ccc;padding:5px 10px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dsh-qol-editor-file:hover{background:#2a2d2e;}
.dsh-qol-editor-file.dir{color:#75beff;}
.dsh-qol-tree-row{display:flex;align-items:center;gap:4px;padding:4px 8px;cursor:pointer;color:#ccc;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;}
.dsh-qol-tree-row:hover{background:#2a2d2e;}
.dsh-qol-tree-arrow{width:12px;flex:none;text-align:center;color:#888;}
.dsh-qol-tree-icon{flex:none;}
.dsh-qol-tree-label{overflow:hidden;text-overflow:ellipsis;}
.dsh-qol-editor-main{position:relative;flex:1;min-width:0;min-height:0;background:#1e1e1e;}
.dsh-qol-editor-highlight,.dsh-qol-editor-input{position:absolute;inset:0;margin:0;padding:16px;border:0;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Consolas,'Courier New',monospace;font-size:13px;line-height:1.6;tab-size:2;white-space:pre;overflow:auto;}
.dsh-qol-editor-highlight{pointer-events:none;z-index:1;color:#d4d4d4;background:transparent;scrollbar-width:none;}
.dsh-qol-editor-highlight::-webkit-scrollbar{display:none;}
.dsh-qol-editor-input{z-index:2;color:transparent;caret-color:#fff;background:transparent;resize:none;outline:none;}
.dsh-qol-tok-comment{color:#6a9955;font-style:italic;}
.dsh-qol-tok-string{color:#ce9178;}
.dsh-qol-tok-keyword{color:#569cd6;}
.dsh-qol-tok-number{color:#b5cea8;}
.dsh-qol-tok-tag{color:#4ec9b0;}
.dsh-qol-tok-property{color:#9cdcfe;}
.dsh-qol-editor-status{padding:4px 12px;font-size:12px;color:#999;border-top:1px solid #333;background:#252526;min-height:20px;}
.dsh-qol-editor-selbar{position:absolute;top:8px;right:16px;z-index:5;display:none;align-items:center;gap:8px;background:#333;border:1px solid #555;border-radius:8px;padding:6px 10px;font-size:12px;color:#ddd;box-shadow:0 4px 14px rgba(0,0,0,.4);}
.dsh-qol-editor-selbar.visible{display:flex;}
`;

    let styleEl = null;
    let sessions = null;
    let workspaces = null;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin="dsh-qol"]') !== null) return;
      styleEl = document.createElement("style");
      styleEl.dataset.plugin = "dsh-qol";
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    }

    function parseMessageId(wrapper) {
      const key = wrapper.getAttribute("data-chat-anchor-key") || "";
      const match = /^\d+:(input-message)(.*)$/.exec(key);
      return match ? match[2] : null;
    }

    function findBubble(wrapper) {
      return wrapper.querySelector('[class*="bubble"]');
    }

    function findCopyButton(wrapper) {
      const actions = wrapper.querySelector('[class*="actions"]');
      return actions ? actions.querySelector('button[class*="action"]') : null;
    }

    const PENCIL_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487z"/><path d="M14.25 7.5l2.25 2.25"/></svg>';

    function addEditButton(wrapper, messageId, bubble) {
      const copyBtn = findCopyButton(wrapper);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = copyBtn ? copyBtn.className + " dsh-qol-edit" : "dsh-qol-edit";
      btn.setAttribute("aria-label", "编辑这条消息并重新回答");
      btn.innerHTML = PENCIL_SVG;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startEdit(wrapper, bubble, messageId);
      });

      if (copyBtn) {
        copyBtn.insertAdjacentElement("afterend", btn);
      } else {
        wrapper.appendChild(btn);
      }
    }

    function decorate(wrapper) {
      if (!(wrapper instanceof HTMLElement)) return;
      if (wrapper.getAttribute("data-chat-flow-kind") !== "user") return;
      if (wrapper.dataset.dshQolEdit === "1") return;
      const messageId = parseMessageId(wrapper);
      if (!messageId) return;
      const bubble = findBubble(wrapper);
      if (!bubble) return;
      const copyBtn = findCopyButton(wrapper);
      if (!copyBtn) return;
      // v1 仅编辑纯文本消息；含图片的消息不注入编辑按钮。
      if (wrapper.querySelector("img")) return;
      wrapper.dataset.dshQolEdit = "1";
      addEditButton(wrapper, messageId, bubble);
    }

    function startEdit(wrapper, bubble, messageId) {
      const originalText = bubble.innerText || "";
      bubble.style.display = "none";

      const editor = document.createElement("div");
      editor.className = "dsh-qol-editor";

      const textarea = document.createElement("textarea");
      textarea.className = "dsh-qol-textarea";
      textarea.value = originalText;
      textarea.rows = Math.min(12, Math.max(3, originalText.split("\n").length));

      const actions = document.createElement("div");
      actions.className = "dsh-qol-actions";

      const status = document.createElement("span");
      status.className = "dsh-qol-status";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "dsh-qol-cancel";
      cancelBtn.textContent = "取消";

      const branchBtn = document.createElement("button");
      branchBtn.type = "button";
      branchBtn.className = "dsh-qol-branch";
      branchBtn.textContent = "保存并分支";

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "dsh-qol-save";
      saveBtn.textContent = "保存并重新回答";

      actions.appendChild(status);
      actions.appendChild(cancelBtn);
      actions.appendChild(branchBtn);
      actions.appendChild(saveBtn);
      editor.appendChild(textarea);
      editor.appendChild(actions);
      wrapper.insertBefore(editor, bubble.nextSibling);

      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      function cleanup() {
        editor.remove();
        bubble.style.display = "";
      }

      cancelBtn.addEventListener("click", () => cleanup());

      async function waitUntilIdle(sessionId) {
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          const snapshot = sessions.list.getSnapshot();
          const row = snapshot.byId[sessionId];
          if (!row || row.running !== true) return true;
          status.textContent = "等待当前回复完成后再创建分支…";
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
      }

      async function submitEdit(mode) {
        const text = textarea.value;
        if (text.trim() === "") {
          status.textContent = "内容不能为空";
          return;
        }
        const sessionId = sessions && sessions.list ? sessions.list.getSnapshot().current : void 0;
        if (!sessionId) {
          status.textContent = "当前没有打开的会话";
          return;
        }
        saveBtn.disabled = true;
        branchBtn.disabled = true;
        cancelBtn.disabled = true;

        if (mode === "branch") {
          const idle = await waitUntilIdle(sessionId);
          if (!idle) {
            status.textContent = "当前会话仍在运行，分支创建已取消";
            saveBtn.disabled = false;
            branchBtn.disabled = false;
            cancelBtn.disabled = false;
            return;
          }
        }

        status.textContent = mode === "branch" ? "正在创建分支…" : "正在创建新会话…";
        try {
          const res = await fetch(API, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-DSH-QoL": "1"
            },
            body: JSON.stringify({ sessionId, messageId, text, mode })
          });
          let data;
          try {
            data = await res.json();
          } catch {
            data = { ok: false, error: "HTTP " + res.status };
          }
          if (!data.ok) {
            status.textContent = "保存失败：" + (data.error || "未知错误");
            saveBtn.disabled = false;
            branchBtn.disabled = false;
            cancelBtn.disabled = false;
            return;
          }
          status.textContent = "已创建新会话，正在切换…";
          try {
            await sessions.refresh();
            sessions.open(data.childSessionId);
            status.textContent = "已切换";
          } catch (error) {
            status.textContent = "新会话已创建，请从会话列表打开：" + data.childSessionId;
            saveBtn.disabled = false;
            branchBtn.disabled = false;
            cancelBtn.disabled = false;
          }
        } catch (error) {
          status.textContent = "请求失败：" + (error && error.message ? error.message : error);
          saveBtn.disabled = false;
          branchBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      }

      branchBtn.addEventListener("click", () => submitEdit("branch"));
      saveBtn.addEventListener("click", () => submitEdit("rewrite"));
    }

    function scan(root) {
      if (!(root instanceof HTMLElement)) return;
      if (root.matches && root.matches('[data-chat-flow-kind="user"]')) decorate(root);
      if (root.querySelectorAll) {
        const wrappers = root.querySelectorAll('[data-chat-flow-kind="user"]');
        for (const wrapper of wrappers) decorate(wrapper);
      }
    }

    function repair() {
      if (typeof document === "undefined") return;
      const wrappers = document.querySelectorAll('[data-chat-flow-kind="user"]');
      for (const wrapper of wrappers) {
        // Decorate any wrapper the observer missed (e.g. its bubble appeared later).
        if (wrapper.dataset.dshQolEdit !== "1") {
          decorate(wrapper);
          continue;
        }
        // React 重新渲染后可能丢掉我们的按钮，补回来。
        if (wrapper.querySelector(".dsh-qol-edit") === null && wrapper.querySelector(".dsh-qol-editor") === null) {
          const messageId = parseMessageId(wrapper);
          const bubble = findBubble(wrapper);
          const copyBtn = findCopyButton(wrapper);
          if (messageId && bubble && copyBtn && !wrapper.querySelector("img")) addEditButton(wrapper, messageId, bubble);
        }
      }
    }

    // =====================================================================
    // Feature 3: web file editor (open / edit / save with syntax highlight)
    // =====================================================================

    const FS_READ = "/dsh-qol/fs/read";
    const FS_LIST = "/dsh-qol/fs/list";
    const FS_WRITE = "/dsh-qol/fs/write";

    let editorFab = null;
    let editorOverlay = null;
    let editorPathInput = null;
    let editorFileList = null;
    let editorDirLabel = null;
    let editorInput = null;
    let editorHighlight = null;
    let editorStatus = null;
    let editorCurrentFile = null;
    let editorSelBar = null;
    let editorSelLabel = null;
    let editorTreeRoot = null;

    function lineOfOffset(text, offset) {
      return text.slice(0, offset).split("\n").length;
    }

    function selectionContext() {
      if (!editorInput) return null;
      const value = editorInput.value || "";
      const start = editorInput.selectionStart ?? 0;
      const end = editorInput.selectionEnd ?? 0;
      if (start === end) return null;
      const selected = value.slice(start, end);
      if (selected.trim() === "") return null;
      const file = editorCurrentFile || editorPathInput?.value || "(未保存文件)";
      const startLine = lineOfOffset(value, start);
      const endLine = lineOfOffset(value, end);
      const lang = langFromPath(file);
      const snippet = selected.length > 20000 ? selected.slice(0, 20000) + "\n…(已截断)" : selected;
      return {
        text: "\n\n文件: " + file + "\n行号: " + startLine + "-" + endLine + "\n```" + lang + "\n" + snippet + "\n```\n",
        startLine,
        endLine
      };
    }

    function updateSelectionBar() {
      if (!editorSelBar || !editorSelLabel || !editorInput) return;
      const ctx = selectionContext();
      if (!ctx) {
        editorSelBar.classList.remove("visible");
        return;
      }
      editorSelLabel.textContent = "已选中 L" + ctx.startLine + "-L" + ctx.endLine;
      editorSelBar.classList.add("visible");
    }

    function setNativeValue(el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      desc.set.call(el, value);
    }

    async function insertIntoComposerWithRetry(text, attempts, replace) {
      const maxAttempts = attempts || 30;
      for (let i = 0; i < maxAttempts; i += 1) {
        const textarea = document.querySelector('textarea[data-phase]');
        if (textarea && !textarea.disabled && !textarea.readOnly) {
          const current = textarea.value || "";
          setNativeValue(textarea, replace ? text : current ? current + text : text);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.focus();
          const len = textarea.value.length;
          textarea.setSelectionRange(len, len);
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    }

    async function askSelectionInNewSession() {
      const ctx = selectionContext();
      if (!ctx) return;
      closeEditor();
      try {
        const snapshot = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        const current = snapshot ? snapshot.current : undefined;
        const cwd = current && snapshot.byId[current] ? snapshot.byId[current].cwd : undefined;
        const newId = await sessions.create(cwd ? { cwd } : {});
        sessions.open(newId);
        // give React a beat to swap the composer draft to the new session
        await new Promise((resolve) => setTimeout(resolve, 300));
        const ok = await insertIntoComposerWithRetry(ctx.text, 30, true);
        if (!ok) console.warn("[dsh-qol] composer not ready after new session");
      } catch (error) {
        console.error("[dsh-qol] new-session ask failed:", error);
      }
    }

    async function replySelectionInCurrentSession() {
      const ctx = selectionContext();
      if (!ctx) return;
      closeEditor();
      try {
        const snapshot = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        const current = snapshot ? snapshot.current : undefined;
        let replace = false;
        if (!current) {
          const newId = await sessions.create({});
          sessions.open(newId);
          await new Promise((resolve) => setTimeout(resolve, 300));
          replace = true;
        }
        const ok = await insertIntoComposerWithRetry(ctx.text, 30, replace);
        if (!ok) console.warn("[dsh-qol] composer not ready");
      } catch (error) {
        console.error("[dsh-qol] current-session ask failed:", error);
      }
    }

    function langFromPath(path) {
      const ext = (String(path).match(/\.([\w]+)$/) || [])[1] || "";
      const map = {
        js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js",
        json: "js", py: "py", html: "html", htm: "html", xml: "html",
        css: "css", scss: "css", less: "css", sh: "bash", bash: "bash", zsh: "bash",
        md: "md", yml: "yaml", yaml: "yaml", toml: "toml"
      };
      return map[ext] || "";
    }

    function escapeHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function patternsForLang(lang) {
      const KW_JS = "\\b(?:const|let|var|function|return|if|else|for|while|import|export|from|class|new|try|catch|finally|throw|async|await|typeof|instanceof|in|of|switch|case|break|continue|default|extends|super|this|null|undefined|true|false|delete|void|yield|do)\\b";
      const KW_PY = "\\b(?:def|return|if|elif|else|for|while|import|from|as|class|try|except|finally|with|lambda|pass|break|continue|raise|yield|in|not|and|or|is|None|True|False|global|nonlocal|assert|del|async|await)\\b";
      const KW_BASH = "\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|export|local|return|echo|cd|source|alias|set|unset)\\b";
      if (lang === "py") {
        return [
          { type: "comment", re: /#[^\n]*/g },
          { type: "string", re: /('''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g },
          { type: "keyword", re: new RegExp(KW_PY, "g") },
          { type: "number", re: /\b\d+(?:\.\d+)?\b/g }
        ];
      }
      if (lang === "html") {
        return [
          { type: "comment", re: /<!--[\s\S]*?-->/g },
          { type: "string", re: /"[^"]*"|'[^']*'/g },
          { type: "tag", re: /<\/?[a-zA-Z][^>]*>/g }
        ];
      }
      if (lang === "css") {
        return [
          { type: "comment", re: /\/\*[\s\S]*?\*\//g },
          { type: "string", re: /"[^"]*"|'[^']*'/g },
          { type: "property", re: /[a-zA-Z-]+(?=\s*:)/g },
          { type: "number", re: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms)?\b/g }
        ];
      }
      if (lang === "bash") {
        return [
          { type: "comment", re: /#[^\n]*/g },
          { type: "string", re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g },
          { type: "keyword", re: new RegExp(KW_BASH, "g") }
        ];
      }
      if (lang === "md") {
        return [
          { type: "tag", re: /^#{1,6}[^\n]*$/gm },
          { type: "string", re: /`[^`]*`/g },
          { type: "comment", re: /^>\s?[^\n]*$/gm }
        ];
      }
      if (lang === "yaml" || lang === "toml") {
        return [
          { type: "comment", re: /#[^\n]*/g },
          { type: "string", re: /"[^"]*"|'[^']*'/g },
          { type: "keyword", re: /^[a-zA-Z_][\w-]*(?=\s*:)/gm }
        ];
      }
      if (lang === "js" || lang === "json") {
        return [
          { type: "comment", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
          { type: "string", re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g },
          { type: "keyword", re: new RegExp(KW_JS, "g") },
          { type: "number", re: /\b\d+(?:\.\d+)?\b/g }
        ];
      }
      return [];
    }

    function highlightCode(code, lang) {
      const patterns = patternsForLang(lang);
      if (patterns.length === 0) return escapeHtml(code);
      let combined;
      try {
        combined = new RegExp(patterns.map((p) => "(" + p.re.source + ")").join("|"), "gm");
      } catch {
        return escapeHtml(code);
      }
      let html = "";
      let last = 0;
      for (const m of code.matchAll(combined)) {
        html += escapeHtml(code.slice(last, m.index));
        for (let i = 1; i <= patterns.length; i += 1) {
          if (m[i] !== undefined) {
            html += '<span class="dsh-qol-tok-' + patterns[i - 1].type + '">' + escapeHtml(m[0]) + "</span>";
            break;
          }
        }
        last = m.index + m[0].length;
      }
      html += escapeHtml(code.slice(last));
      return html;
    }

    function updateEditorHighlight() {
      if (!editorInput || !editorHighlight) return;
      const codeEl = editorHighlight.querySelector("code") || document.createElement("code");
      codeEl.innerHTML = highlightCode(editorInput.value || "", langFromPath(editorCurrentFile || ""));
      if (!editorHighlight.contains(codeEl)) editorHighlight.appendChild(codeEl);
      editorHighlight.scrollTop = editorInput.scrollTop;
      editorHighlight.scrollLeft = editorInput.scrollLeft;
    }

    function positionEditorFab() {
      if (!editorFab) return;
      // Keep the button just to the right of the left sidebar: the sidebar
      // column is the first child of the shell frame (class contains sidebarCol).
      const sidebarCol = document.querySelector('[class*="sidebarCol"]');
      if (sidebarCol) {
        const rect = sidebarCol.getBoundingClientRect();
        editorFab.style.left = Math.max(16, rect.right + 16) + "px";
      } else {
        editorFab.style.left = "16px";
      }
    }

    function setupEditor() {
      if (typeof document === "undefined" || editorFab !== null) return;

      // floating button
      editorFab = document.createElement("button");
      editorFab.type = "button";
      editorFab.className = "dsh-qol-fab";
      editorFab.setAttribute("aria-label", "打开文件编辑器");
      editorFab.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>';
      editorFab.addEventListener("click", openEditor);
      document.body.appendChild(editorFab);
      positionEditorFab();

      // overlay
      editorOverlay = document.createElement("div");
      editorOverlay.className = "dsh-qol-editor-overlay";
      editorOverlay.style.display = "none";

      const header = document.createElement("div");
      header.className = "dsh-qol-editor-header";

      const title = document.createElement("span");
      title.className = "dsh-qol-editor-title";
      title.textContent = "dsh-QoL 编辑器";

      editorPathInput = document.createElement("input");
      editorPathInput.className = "dsh-qol-editor-path";
      editorPathInput.placeholder = "输入文件或目录路径，例如 /mnt/data5/dsh-plugins/foo.js";
      editorPathInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          const path = editorPathInput.value.trim();
          if (path) navigateTo(path);
        }
      });

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "dsh-qol-editor-btn";
      openBtn.textContent = "打开";
      openBtn.addEventListener("click", () => {
        const path = editorPathInput.value.trim();
        if (path) navigateTo(path);
      });

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "dsh-qol-editor-btn primary";
      saveBtn.textContent = "保存";
      saveBtn.addEventListener("click", saveCurrentFile);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "dsh-qol-editor-btn";
      closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", closeEditor);

      header.appendChild(title);
      header.appendChild(editorPathInput);
      header.appendChild(openBtn);
      header.appendChild(saveBtn);
      header.appendChild(closeBtn);

      const body = document.createElement("div");
      body.className = "dsh-qol-editor-body";

      const sidebar = document.createElement("div");
      sidebar.className = "dsh-qol-editor-sidebar";
      const sidebarHeader = document.createElement("div");
      sidebarHeader.className = "dsh-qol-editor-sidebar-header";
      editorDirLabel = document.createElement("span");
      editorDirLabel.textContent = "文件";
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "dsh-qol-editor-btn";
      upBtn.textContent = "上一级";
      upBtn.addEventListener("click", goParent);
      sidebarHeader.appendChild(editorDirLabel);
      sidebarHeader.appendChild(upBtn);
      editorFileList = document.createElement("div");
      editorFileList.className = "dsh-qol-editor-filelist";
      sidebar.appendChild(sidebarHeader);
      sidebar.appendChild(editorFileList);

      const main = document.createElement("div");
      main.className = "dsh-qol-editor-main";
      editorHighlight = document.createElement("pre");
      editorHighlight.className = "dsh-qol-editor-highlight";
      const codeEl = document.createElement("code");
      editorHighlight.appendChild(codeEl);
      editorInput = document.createElement("textarea");
      editorInput.className = "dsh-qol-editor-input";
      editorInput.spellcheck = false;
      editorInput.setAttribute("wrap", "off");
      editorInput.addEventListener("scroll", () => {
        editorHighlight.scrollTop = editorInput.scrollTop;
        editorHighlight.scrollLeft = editorInput.scrollLeft;
      });
      editorInput.addEventListener("input", updateEditorHighlight);
      editorInput.addEventListener("mouseup", updateSelectionBar);
      editorInput.addEventListener("keyup", updateSelectionBar);
      editorInput.addEventListener("select", updateSelectionBar);
      main.appendChild(editorHighlight);
      main.appendChild(editorInput);

      editorSelBar = document.createElement("div");
      editorSelBar.className = "dsh-qol-editor-selbar";
      editorSelLabel = document.createElement("span");
      editorSelBar.appendChild(editorSelLabel);

      const newSessionBtn = document.createElement("button");
      newSessionBtn.type = "button";
      newSessionBtn.className = "dsh-qol-editor-btn";
      newSessionBtn.textContent = "新会话提问";
      newSessionBtn.addEventListener("click", askSelectionInNewSession);

      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "dsh-qol-editor-btn primary";
      replyBtn.textContent = "回复当前会话";
      replyBtn.addEventListener("click", replySelectionInCurrentSession);

      editorSelBar.appendChild(newSessionBtn);
      editorSelBar.appendChild(replyBtn);
      main.appendChild(editorSelBar);

      body.appendChild(sidebar);
      body.appendChild(main);

      editorStatus = document.createElement("div");
      editorStatus.className = "dsh-qol-editor-status";

      editorOverlay.appendChild(header);
      editorOverlay.appendChild(body);
      editorOverlay.appendChild(editorStatus);
      document.body.appendChild(editorOverlay);
    }

    function currentWorkspaceDir() {
      try {
        if (sessions && sessions.list) {
          const snapshot = sessions.list.getSnapshot();
          const current = snapshot.current;
          if (current && snapshot.byId[current] && snapshot.byId[current].cwd) return snapshot.byId[current].cwd;
          const ids = snapshot.ids || [];
          for (const id of ids) {
            const cwd = snapshot.byId[id] && snapshot.byId[id].cwd;
            if (cwd) return cwd;
          }
        }
        if (workspaces && workspaces.list) {
          const ws = workspaces.list.getSnapshot();
          const target = ws.recentWorkspaceId;
          const item = (target && ws.items.find((candidate) => candidate.workspaceId === target)) || ws.items[0];
          if (item && item.path) return item.path;
        }
      } catch {
        // ignore and fall through
      }
      return "";
    }

    function ensureInitialDir() {
      if (!editorPathInput) return;
      if (editorPathInput.value.trim()) return;
      const dir = currentWorkspaceDir();
      if (dir) {
        editorPathInput.value = dir;
        navigateTo(dir);
      }
    }

    function openEditor() {
      if (!editorOverlay) setupEditor();
      editorOverlay.style.display = "flex";
      ensureInitialDir();
    }

    function closeEditor() {
      if (editorOverlay) editorOverlay.style.display = "none";
    }

    async function navigateTo(path) {
      try {
        const listRes = await fetch(FS_LIST + "?path=" + encodeURIComponent(path), {
          headers: { "X-DSH-QoL": "1" }
        });
        const listData = await listRes.json();
        if (listData.ok) {
          editorCurrentFile = null;
          editorPathInput.value = listData.path;
          editorInput.value = "";
          updateEditorHighlight();
          setTreeRoot(listData.path);
          editorStatus.textContent = "目录已打开";
          return;
        }
        const fileRes = await fetch(FS_READ + "?path=" + encodeURIComponent(path), {
          headers: { "X-DSH-QoL": "1" }
        });
        const fileData = await fileRes.json();
        if (fileData.ok) {
          editorCurrentFile = fileData.path;
          editorPathInput.value = fileData.path;
          editorInput.value = fileData.content;
          updateEditorHighlight();
          const parent = fileData.path.split("/").slice(0, -1).join("/") || "/";
          setTreeRoot(parent);
          editorStatus.textContent = "已打开 " + fileData.path;
          return;
        }
        editorStatus.textContent = (listData.error || fileData.error || "打开失败");
      } catch (error) {
        editorStatus.textContent = "请求失败：" + (error && error.message ? error.message : error);
      }
    }

    function goParent() {
      const current = editorPathInput.value.trim();
      if (!current) return;
      const parent = current.split("/").slice(0, -1).join("/") || "/";
      navigateTo(parent);
    }

    function treeBaseName(path) {
      if (path === "/") return "/";
      const parts = path.split("/").filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : path;
    }

    function setTreeRoot(path) {
      editorTreeRoot = {
        path,
        name: treeBaseName(path),
        type: "directory",
        depth: 0,
        children: [],
        expanded: true,
        loaded: false
      };
      editorDirLabel.textContent = path;
      loadTreeChildren(editorTreeRoot, true);
    }

    async function loadTreeChildren(node, expand) {
      if (node.loaded) {
        if (expand) {
          node.expanded = true;
          renderTree();
        }
        return;
      }
      try {
        const res = await fetch(FS_LIST + "?path=" + encodeURIComponent(node.path), {
          headers: { "X-DSH-QoL": "1" }
        });
        const data = await res.json();
        if (!data.ok) {
          editorStatus.textContent = "目录读取失败：" + (data.error || "");
          return;
        }
        node.children = data.entries.map((entry) => ({
          path: entry.path,
          name: entry.name,
          type: entry.type,
          depth: node.depth + 1,
          children: [],
          expanded: false,
          loaded: false
        }));
        node.loaded = true;
        if (expand) node.expanded = true;
        renderTree();
      } catch (error) {
        editorStatus.textContent = "请求失败：" + (error && error.message ? error.message : error);
      }
    }

    function renderTree() {
      if (!editorFileList) return;
      editorFileList.textContent = "";
      if (!editorTreeRoot) {
        const empty = document.createElement("div");
        empty.className = "dsh-qol-editor-file";
        empty.textContent = "(未打开目录)";
        editorFileList.appendChild(empty);
        return;
      }
      renderTreeNode(editorTreeRoot, editorFileList, 0);
    }

    function renderTreeNode(node, container, depth) {
      const row = document.createElement("div");
      row.className = "dsh-qol-tree-row";
      row.style.paddingLeft = (8 + depth * 14) + "px";

      const arrow = document.createElement("span");
      arrow.className = "dsh-qol-tree-arrow";
      if (node.type === "directory") arrow.textContent = node.expanded ? "▾" : "▸";

      const icon = document.createElement("span");
      icon.className = "dsh-qol-tree-icon";
      icon.textContent = node.type === "directory" ? "📁" : "📄";

      const label = document.createElement("span");
      label.className = "dsh-qol-tree-label";
      label.textContent = node.name;

      row.appendChild(arrow);
      row.appendChild(icon);
      row.appendChild(label);
      row.addEventListener("click", () => onTreeRowClick(node));
      container.appendChild(row);

      if (node.expanded) {
        for (const child of node.children) renderTreeNode(child, container, depth + 1);
      }
    }

    function onTreeRowClick(node) {
      if (node.type === "directory") {
        if (node.expanded) {
          node.expanded = false;
          renderTree();
        } else if (node.loaded) {
          node.expanded = true;
          renderTree();
        } else {
          loadTreeChildren(node, true);
        }
      } else {
        openFileByPath(node.path);
      }
    }

    async function openFileByPath(path) {
      try {
        const res = await fetch(FS_READ + "?path=" + encodeURIComponent(path), {
          headers: { "X-DSH-QoL": "1" }
        });
        const data = await res.json();
        if (!data.ok) {
          editorStatus.textContent = "打开失败：" + (data.error || "");
          return;
        }
        editorCurrentFile = data.path;
        editorPathInput.value = data.path;
        editorInput.value = data.content;
        updateEditorHighlight();
        editorStatus.textContent = "已打开 " + data.path;
      } catch (error) {
        editorStatus.textContent = "请求失败：" + (error && error.message ? error.message : error);
      }
    }

    async function saveCurrentFile() {
      if (!editorCurrentFile) {
        editorStatus.textContent = "请先打开一个文件";
        return;
      }
      try {
        const res = await fetch(FS_WRITE, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-DSH-QoL": "1"
          },
          body: JSON.stringify({ path: editorCurrentFile, content: editorInput.value })
        });
        const data = await res.json();
        if (!data.ok) {
          editorStatus.textContent = "保存失败：" + (data.error || "");
          return;
        }
        editorStatus.textContent = "已保存 " + data.path;
      } catch (error) {
        editorStatus.textContent = "请求失败：" + (error && error.message ? error.message : error);
      }
    }

    // =====================================================================
    // apply
    // =====================================================================

    function apply(ctx) {
      document.addEventListener("keydown", onKeyDownCapture, true);

      ensureStyle();
      sessions = ctx.sessions;
      workspaces = ctx.workspaces;
      setupEditor();

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) scan(node);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      scan(document.body);

      const timer = window.setInterval(() => {
        repair();
        positionEditorFab();
      }, 1000);
      window.addEventListener("resize", positionEditorFab);

      ctx.effect(function () {
        return function () {
          document.removeEventListener("keydown", onKeyDownCapture, true);
          observer.disconnect();
          window.clearInterval(timer);
          window.removeEventListener("resize", positionEditorFab);
          if (styleEl !== null) styleEl.remove();
          if (editorFab !== null) editorFab.remove();
          if (editorOverlay !== null) editorOverlay.remove();
          editorFab = null;
          editorOverlay = null;
          editorPathInput = null;
          editorFileList = null;
          editorDirLabel = null;
          editorInput = null;
          editorHighlight = null;
          editorStatus = null;
          editorCurrentFile = null;
          editorSelBar = null;
          editorSelLabel = null;
          editorTreeRoot = null;
          sessions = null;
          workspaces = null;
        };
      }, TAG + ": cleanup");
    }

    exports.apply = apply;
    exports.inject = ["sessions", "workspaces"];
    return module.exports;
  }
});
