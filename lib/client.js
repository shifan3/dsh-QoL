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
.dsh-qol-modelInput{flex-direction:column;gap:4px;padding:0 4px;display:flex;}
.dsh-qol-modelInputLabel{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;font-weight:500;line-height:18px;}
.dsh-qol-modelInputRow{align-items:center;gap:8px;display:flex;}
.dsh-qol-modelInputBox{accent-color:var(--dsw-alias-brand-primary,#4b6eaf);cursor:pointer;width:14px;height:14px;margin:0;}
.dsh-qol-modelInputBox:disabled{cursor:default;opacity:.6;}
.dsh-qol-modelInputStatus{color:var(--dsw-alias-label-secondary,#777);font-size:12px;line-height:16px;}
.dsh-qol-modelInputStatus.saved{color:var(--dsw-alias-state-success-primary,#2e9e5b);}
.dsh-qol-modelInputStatus.error{color:var(--dsw-alias-state-error-primary,#e5484d);}
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
.dsh-qol-editor-highlight code{font:inherit;font-family:inherit;}
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
.dsh-qol-selpill{flex:none;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:22px;align-items:center;gap:6px;padding:0 10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,#666);display:inline-flex;font-size:12px;line-height:16px;}
.dsh-qol-selpill::before{content:"";flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#2d6cdf);}
.dsh-qol-selpill:hover{color:var(--dsw-alias-label-primary,#222);}
.dsh-qol-selpop{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:10005;width:min(780px,94vw);box-sizing:border-box;flex-direction:column;gap:10px;padding:12px 14px;background:#252526;border:1px solid #555;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:none;color:#ccc;font-size:13px;}
.dsh-qol-selpop-header{display:flex;align-items:center;gap:10px;min-width:0;}
.dsh-qol-selpop-title{flex:none;font-weight:600;color:#ddd;white-space:nowrap;}
.dsh-qol-selpop-hint{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888;font-size:12px;}
.dsh-qol-selpop-close{flex:none;cursor:pointer;border:none;background:transparent;color:#999;font-size:14px;line-height:1;padding:4px 8px;border-radius:6px;}
.dsh-qol-selpop-close:hover{background:#3a3a3a;color:#eee;}
.dsh-qol-selpop-host{display:flex;flex-direction:column;align-items:center;min-width:0;width:100%;}
.dsh-qol-selpop-host [data-composer-card]{width:100%;}
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
      // 气泡盒是右上角对齐、缩小贴内容的（width:auto + align-items:flex-end）；
      // 若编辑框沿用 CSS 的 width:100%，会撑满整个消息列，短/中消息的文字列
      // 就比原文偏左。开编辑前量气泡的渲染宽度与左右 padding：
      //   - 编辑框与气泡等宽 → 左右边缘与原文完全重合；
      //   - textarea 的 padding 对齐气泡 → 首字符/光标与原文起点一致。
      let bubbleWidth = 0;
      try { bubbleWidth = bubble.getBoundingClientRect().width; } catch { }
      if (!(bubbleWidth > 0)) { try { bubbleWidth = bubble.offsetWidth; } catch { } }
      let bubblePadL = "";
      let bubblePadR = "";
      try {
        const cs = getComputedStyle(bubble);
        bubblePadL = (cs && cs.paddingLeft) || "";
        bubblePadR = (cs && cs.paddingRight) || "";
      } catch { }
      bubble.style.display = "none";

      const editor = document.createElement("div");
      editor.className = "dsh-qol-editor";
      if (bubbleWidth > 0) editor.style.width = Math.round(bubbleWidth) + "px";

      const textarea = document.createElement("textarea");
      textarea.className = "dsh-qol-textarea";
      textarea.value = originalText;
      // 首字符与原文对齐：文字起点偏移 = 编辑框(border+padding) + textarea 自身
      // border；用 padding 把这段固定开销抵掉，使光标/首字与原地时的气泡文本
      // 起点一致（而不是再整体偏右一小段）。
      if (bubblePadL || bubblePadR) {
        const applyPad = (specL, specR) => {
          // spec 可能带 px 单位，也可能被不同来源返回
          const tryExact = () => {
            const numL = parseFloat(specL);
            const numR = parseFloat(specR);
            if (!isFinite(numL) || !isFinite(numR)) return false;
            try {
              const ed = getComputedStyle(editor);
              const ta = getComputedStyle(textarea);
              const costL = (parseFloat(ed.borderLeftWidth) || 0) + (parseFloat(ed.paddingLeft) || 0) + (parseFloat(ta.borderLeftWidth) || 0);
              const costR = (parseFloat(ed.borderRightWidth) || 0) + (parseFloat(ed.paddingRight) || 0) + (parseFloat(ta.borderRightWidth) || 0);
              const wantL = Math.max(0, numL - costL);
              const wantR = Math.max(0, numR - costR);
              textarea.style.paddingLeft = wantL + "px";
              textarea.style.paddingRight = wantR + "px";
              return true;
            } catch { return false; }
          };
          if (tryExact()) return;
          if (specL) textarea.style.paddingLeft = specL;
          if (specR) textarea.style.paddingRight = specR;
        };
        applyPad(bubblePadL, bubblePadR);
      }
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
      // 插入位用「bubble 的实际父节点」，而不是 wrapper：
      // 新版 DSH 消息行结构是 wrapper > userRow > userStack > [gallery, bubble]，
      // bubble 是 userStack 的末子节点（nextSibling 恒为 null），而对
      // wrapper.insertBefore(editor, null) === wrapper.appendChild(editor) ——
      // 编辑器会被整行压到消息下方（"插入到下一行而不是当前行"）。
      // 放进 bubble 的父级、紧跟 bubble 之后，编辑框才落在消息原位。
      const seat = (bubble.parentNode !== null && bubble.parentNode !== undefined) ? bubble.parentNode : wrapper;
      seat.insertBefore(editor, bubble.nextSibling);

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

    // =====================================================================
    // Feature 7: custom LLM image-input declaration (settings page > models)
    // =====================================================================
    // The models settings page edits each provider's `models` array from a
    // React draft that never carries the per-model `input` field, so an
    // ordinary save silently removes a hand-written `input: [text, image]`
    // from settings.yaml. A server-side /api interceptor keeps the
    // declaration alive across those saves; here we surface it as a checkbox
    // per model row. The value round-trips through the plain
    // /dsh-qol/model-input routes.

    const MODEL_INPUT_PATH = "/dsh-qol/model-input";
    let modelView = null;
    let modelViewPromise = null;
    let modelViewAt = 0;

    function invalidateModelView() {
      modelViewAt = 0;
      modelView = null;
    }

    async function fetchModelView(force) {
      if (!force) {
        if (modelView !== null && Date.now() - modelViewAt < 5000) return modelView;
        if (modelViewPromise !== null) return modelViewPromise;
      }
      modelViewPromise = (async () => {
        let data = null;
        try {
          const res = await fetch(MODEL_INPUT_PATH, { headers: { "X-DSH-QoL": "1" } });
          data = await res.json();
          if (data && data.ok) {
            modelView = data;
            modelViewAt = Date.now();
          }
        } catch {
          data = null;
        }
        modelViewPromise = null;
        return data;
      })();
      return modelViewPromise;
    }

    function findModelInView(view, modelId) {
      if (!view || !view.providers) return null;
      for (const route of Object.keys(view.providers)) {
        const profile = view.providers[route];
        if (!profile || !Array.isArray(profile.models)) continue;
        for (const model of profile.models) {
          if (model && model.id === modelId) return { route: route, model: model };
        }
      }
      return null;
    }

    function decorateModelInput(entry) {
      if (!entry || entry.dataset.dshQolMI === "1") return;
      entry.dataset.dshQolMI = "1";

      const field = document.createElement("div");
      field.className = "dsh-qol-modelInput";
      field.setAttribute("data-dsh-qol-field", "1");

      const label = document.createElement("span");
      label.className = "dsh-qol-modelInputLabel";
      label.textContent = "图片输入 (input)";
      label.title = "在 settings.yaml 里为该模型声明 input: [text, image]，让模型接受图片附件（默认仅 text）";

      const row = document.createElement("div");
      row.className = "dsh-qol-modelInputRow";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "dsh-qol-modelInputBox";
      box.disabled = true;
      const status = document.createElement("span");
      status.className = "dsh-qol-modelInputStatus";
      status.textContent = "…";
      row.appendChild(box);
      row.appendChild(status);
      field.appendChild(label);
      field.appendChild(row);

      const modelRow = entry.querySelector(".zGbnIq_modelRow");
      if (modelRow) entry.insertBefore(field, modelRow.nextSibling);
      else entry.appendChild(field);

      const idInput = modelRow ? modelRow.querySelector("input") : null;
      const currentValue = () => {
        if (!idInput || typeof idInput.value !== "string") return "";
        return idInput.value.trim();
      };

      let initialized = false;
      let detached = false;

      const paintIdle = () => {
        if (detached) return;
        status.textContent = "等待模型 id…";
        status.className = "dsh-qol-modelInputStatus";
        box.checked = false;
        box.disabled = false;
      };

      const init = async () => {
        const modelId = currentValue();
        if (!modelId) {
          paintIdle();
          return;
        }
        box.disabled = true;
        status.textContent = "读取声明中…";
        status.className = "dsh-qol-modelInputStatus";
        try {
          const view = await fetchModelView();
          if (detached || currentValue() !== modelId) return;
          const found = view ? findModelInView(view, modelId) : null;
          if (!found) {
            status.textContent = modelId ? "该模型无 input 声明（未找到）" : "";
            status.className = "dsh-qol-modelInputStatus error";
            return;
          }
          const input = found.model.input;
          box.checked = Array.isArray(input) && input.includes("image");
          if (Array.isArray(input) && input.includes("image")) {
            status.textContent = "已声明 · text + image";
            status.className = "dsh-qol-modelInputStatus saved";
          } else if (Array.isArray(input) && input.length > 0) {
            status.textContent = "已声明 · " + input.join(" + ");
            status.className = "dsh-qol-modelInputStatus saved";
          } else {
            status.textContent = "未声明（默认仅 text）";
            status.className = "dsh-qol-modelInputStatus";
          }
        } catch (error) {
          if (detached) return;
          status.textContent = "读取声明失败";
          status.className = "dsh-qol-modelInputStatus error";
        }
        if (!detached) box.disabled = false;
      };

      box.addEventListener("change", () => {
        const modelId = currentValue();
        if (!modelId) return;
        const image = box.checked;
        box.disabled = true;
        status.textContent = image ? "保存中…" : "清除声明中…";
        status.className = "dsh-qol-modelInputStatus";
        const revert = () => {
          box.checked = !image;
          box.disabled = false;
        };
        fetch(MODEL_INPUT_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DSH-QoL": "1" },
          body: JSON.stringify({ modelId: modelId, image: image })
        })
          .then((res) => res.json().then((data) => ({ res: res, data: data })))
          .then(({ res, data }) => {
            if (detached) return;
            if (data && data.ok) {
              invalidateModelView();
              if (image) {
                status.textContent = "已保存 · input: text + image";
              } else {
                status.textContent = "已保存 · 未声明（默认仅 text）";
              }
              status.className = "dsh-qol-modelInputStatus saved";
            } else {
              status.textContent = "保存失败：" + ((data && data.error) || "HTTP " + res.status);
              status.className = "dsh-qol-modelInputStatus error";
              revert();
            }
          })
          .catch((error) => {
            if (detached) return;
            status.textContent = "保存失败：" + (error && error.message ? error.message : String(error));
            status.className = "dsh-qol-modelInputStatus error";
            revert();
          });
      });

      // Re-target when the model id input changes (typing / adopt).
      entry.addEventListener("input", (event) => {
        const target = event && event.target;
        if (target !== idInput || !idInput) return;
        if (initialized) init();
      });

      initialized = true;
      init();
    }

    function detachModelInputs() {
      const fields = document.querySelectorAll('[data-dsh-qol-field="1"]');
      for (const field of fields) {
        if (field.parentNode !== null) field.parentNode.removeChild(field);
      }
      const entries = document.querySelectorAll(".zGbnIq_modelEntry");
      for (const entry of entries) {
        if (entry.dataset !== null && entry.dataset !== undefined) entry.dataset.dshQolMI = "";
      }
      invalidateModelView();
    }

    function paintModelInputs(root) {
      if (!root) return;
      const list = [];
      if (typeof root.matches === "function" && root.matches(".zGbnIq_modelEntry")) list.push(root);
      if (root.querySelectorAll) {
        const found = root.querySelectorAll(".zGbnIq_modelEntry");
        for (const entry of found) list.push(entry);
      }
      for (const entry of list) decorateModelInput(entry);
    }

    function scan(root) {
      if (!(root instanceof HTMLElement)) return;
      if (root.matches && root.matches('[data-chat-flow-kind="user"]')) decorate(root);
      paintModelInputs(root);
      if (root.querySelectorAll) {
        const wrappers = root.querySelectorAll('[data-chat-flow-kind="user"]');
        for (const wrapper of wrappers) decorate(wrapper);
      }
    }

    function repair() {
      if (typeof document === "undefined") return;
      paintModelInputs(document);
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
      const file = editorCurrentFile || (editorPathInput && editorPathInput.value) || "(未保存文件)";
      const startLine = lineOfOffset(value, start);
      const endLine = lineOfOffset(value, end);
      const lang = langFromPath(file);
      const snippet = selected.length > 20000 ? selected.slice(0, 20000) + "\n…(已截断)" : selected;
      return { file, lang, snippet, startLine, endLine };
    }

    // =====================================================================
    // 选区上下文「延迟填塞」(Claude-Code 式)：
    // 点「新会话提问 / 回复当前会话」时不再把文件/行号写进输入框，而是挂起
    // 待发送的上下文，并在输入栏底部、permission 右侧显示 “N lines selected”
    // 徽章。真正提交（发送按钮 / Ctrl|Cmd+Enter）前的一瞬，把上下文自动填
    // 到用户所输文本之前；提交后徽章消失。
    //
    // 注入时机依赖 DSH composer 的两个事实：
    //  - textarea 是受控组件，onChange 直接读 e.target.value 写 draft
    //    （keyboard.setDraft），所以“原生 setter 设值 + 派发 input 事件”可以
    //    在提交动作读到 draft 之前更新它；
    //  - 所有提交路径（发送按钮 onClick=inputActions.submit()、Ctrl/Cmd+
    //    Enter 的 keyboard.submit/steerQueue）都读同一个 store 里的 draft。
    // 因此挂在 document 捕获期的 keydown/click 监听（先于 React 的根容器
    // 委托监听执行）即可完成“提交前填塞”。
    // =====================================================================

    let pendingSelection = null;  // { block, label, title }
    let selectionPill = null;

    function buildSelectionPayload(ctx) {
      const lines = ctx.endLine - ctx.startLine + 1;
      return {
        block: "文件: " + ctx.file +
          "\n行号: L" + ctx.startLine + "-L" + ctx.endLine +
          "\n```" + ctx.lang + "\n" + ctx.snippet + "\n```\n\n",
        label: lines + " lines selected",
        title: ctx.file + " · L" + ctx.startLine + "-" + ctx.endLine + "（点击移除）"
      };
    }

    function setPendingSelection(payload) {
      pendingSelection = payload;
      placeSelectionPill();
    }

    function clearPendingSelection() {
      pendingSelection = null;
      if (selectionPill && selectionPill.parentNode) selectionPill.parentNode.removeChild(selectionPill);
    }

    function ensureSelectionPill() {
      if (selectionPill !== null) return selectionPill;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "dsh-qol-selpill";
      pill.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearPendingSelection();
      });
      return (selectionPill = pill);
    }

    // permission 控件（访问模式按钮）：badge 要显示在它的右侧。
    function findPermissionAnchor() {
      const card = document.querySelector("[data-composer-card]");
      const root = card || document.body;
      if (!root || !root.querySelectorAll) return null;
      const buttons = root.querySelectorAll("button");
      for (const button of buttons) {
        const label = (button.getAttribute("aria-label") || "");
        if (label.indexOf("访问模式") === 0 || label.indexOf("Access mode") === 0) return button;
      }
      return null;
    }

    // 把徽章挂到 composer 底部：permission 按钮之后；找不到则依次退到
    // modes / tools 容器尾部。React 重渲染可能把它挤掉，repair 循环会重挂。
    function placeSelectionPill() {
      if (pendingSelection === null) {
        if (selectionPill && selectionPill.parentNode) selectionPill.parentNode.removeChild(selectionPill);
        return;
      }
      const pill = ensureSelectionPill();
      pill.textContent = pendingSelection.label;
      pill.title = pendingSelection.title;
      pill.setAttribute("aria-label", pendingSelection.title);
      const card = document.querySelector("[data-composer-card]");
      // 整棵子树被 unmount（弹窗开着时并发切会话）时，pill 的 parentNode 仍指向
      // 已离树的子树，=== null 查不出来；真实 DOM 里此时 isConnected 为 false。
      if (card && (pill.parentNode === null || pill.isConnected === false)) {
        const anchor = findPermissionAnchor();
        if (anchor && anchor.parentNode) {
          // 已在锚点右侧则不动
          if (anchor.nextSibling === pill) return;
          anchor.parentNode.insertBefore(pill, anchor.nextSibling);
          return;
        }
        const modes = card.querySelector('[class*="_modes"]');
        if (modes) { if (modes.lastChild === pill) return; modes.appendChild(pill); return; }
        card.appendChild(pill);
      }
    }

    function injectPendingPrefix(textarea) {
      // 无 pending、无输入框、或草稿为空时不动作：空草稿本就不会发送
      // （Enter 进 no-op、发送按钮 disabled），徽章保留等待下一次提交。
      if (pendingSelection === null || !textarea || !textarea.value) return false;
      const block = pendingSelection.block;
      const current = textarea.value || "";
      const cursor = textarea.selectionStart != null ? textarea.selectionStart : current.length;
      setNativeValue(textarea, block + current);
      try {
        // 保留用户原有光标位置（整体右移 block 长度）
        textarea.setSelectionRange(block.length + cursor, block.length + cursor);
      } catch {
        // 某些节点上 setSelectionRange 不可用，忽略
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clearPendingSelection();
      return true;
    }

    const SEND_LABELS = ["发送消息", "Send message"];

    function isComposerSendButton(button) {
      if (!button || !button.closest) return false;
      if (button.closest("[data-composer-card]") === null) return false;
      const label = button.getAttribute("aria-label") || "";
      return SEND_LABELS.indexOf(label) !== -1;
    }

    // Ctrl/Cmd+Enter 提交（发送/插话/排队）前填塞 —— 捕获期执行，早于 React。
    function onSendKeydownCapture(event) {
      const el = event.target;
      if (!isComposerTextarea(el)) return;
      if (event.key !== "Enter") return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (isComposing(event)) return;
      if (el.disabled || el.readOnly) return;
      if (selpopBypass) return; // 重路由的代点击：放行 DSH 原生提交
      if (selpopInPopupSend(el)) {
        // 弹层里的卡是「当前会话」的 composer：截住本次提交，改走
        // "换新会话再发"的 reroutePopupSend。
        event.preventDefault();
        event.stopPropagation();
        reroutePopupSend(el);
        return;
      }
      if (injectPendingPrefix(el)) scheduleSelpopClose();
    }

    // 发送按钮点击前填塞。空草稿时按钮本身是 disabled（原生行为），到不了这里。
    function onSendClickCapture(event) {
      if (selpopBypass) return; // 重路由的代点击：放行 DSH 原生提交
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (!isComposerSendButton(button)) return;
      const card = button.closest("[data-composer-card]");
      const textarea = card ? card.querySelector("textarea[data-phase]") : null;
      if (!textarea || textarea.disabled || textarea.readOnly) return;
      if ((textarea.value || "").trim() === "") return;
      if (selpopOpen && selpopPhase === "idle" && selpopHost && card && selpopHost.contains(card)) {
        event.preventDefault();
        event.stopPropagation();
        reroutePopupSend(textarea);
        return;
      }
      if (injectPendingPrefix(textarea)) scheduleSelpopClose();
    }

    // =====================================================================
    // 功能 4：左侧工作区行「…」菜单追加「在编辑界面打开」
    // 效果：打开文件编辑器，并把该工作区设为 tree view 的 root。
    //
    // 菜单是 dsh primitives 的 Menu（portal=true，渲染到 body 的
    // div[role="menu"]，类名后缀 _portal），items 是别的组件的 React 状态，
    // 插件改不了；因此在菜单出现在 DOM 后注入一个克隆同结构的 menuitem，
    // 点击时从 workspaces store 反查工作区路径（kebab 按钮的 aria-label
    // 是「工作区“{name}”的操作」/「Workspace actions for {name}」，name
    // =title 或 basename(path)），然后 openEditor + navigateTo(path)。
    // =====================================================================

    const WS_MENU_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

    function workspaceNameFromAria(label) {
      let m = /^工作区“(.*)”的操作$/.exec(label);
      if (m) return m[1];
      m = /^Workspace actions for (.*)$/.exec(label);
      if (m) return m[1];
      return null;
    }

    function dirBasename(p) {
      const s = String(p).replace(/[/\\]+$/, "");
      const parts = s.split(/[/\\]/);
      return parts.length > 1 && parts[parts.length - 1] ? parts[parts.length - 1] : s;
    }

    function resolveWorkspacePath(name) {
      if (!name) return null;
      try {
        const ws = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
        if (!ws || !ws.items) return null;
        let item = ws.items.find((candidate) => candidate.title === name);
        if (!item) item = ws.items.find((candidate) => candidate.path && dirBasename(candidate.path) === name);
        return item && item.path ? item.path : null;
      } catch (error) {
        return null;
      }
    }

    // 当前「打开中的工作区菜单」目标：带 menuOpen 类、且含工作区 kebab 按钮的
    // treeitem 行（会话行的 kebab aria 是「会话…」，天然排除）。
    function openWorkspaceMenuTarget() {
      try {
        const rows = document.querySelectorAll('[role="treeitem"]');
        for (const row of rows) {
          if ((((row.getAttribute("class")) || "").indexOf("menuOpen") === -1)) continue;
          const buttons = row.querySelectorAll("button[aria-label]");
          for (const button of buttons) {
            const name = workspaceNameFromAria(button.getAttribute("aria-label") || "");
            if (name !== null) return { name, path: resolveWorkspacePath(name) };
          }
        }
      } catch (error) {
        // 忽略，返回 null
      }
      return null;
    }

    // 打开编辑器并把 tree root 切到该工作区
    function openWorkspaceInEditor(target) {
      openEditor({ skipInitialDir: true });
      if (target && target.path) {
        navigateTo(target.path);
      } else if (editorStatus) {
        editorStatus.textContent = "找不到工作区路径「" + (target ? target.name : "?") + "」，请在路径栏手动打开";
      }
      // 关闭那张菜单：合成一次 document 级 pointerdown（Menu 的外点关闭
      // 逻辑会触发；target 为 document，不在任何菜单内）
      try {
        document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      } catch (error) {
        // 忽略
      }
    }

    function injectOpenWorkspaceEntry(menuEl, target) {
      // 幂等：已注入过则跳过
      if (menuEl.querySelector('[data-qol-open-ws="1"]')) return;
      const viewport = menuEl.querySelector('[role="presentation"]');
      if (!viewport) return;
      const template = viewport.querySelector('button[role="menuitem"]');
      if (!template) return;
      const templateWrap = template.parentElement;
      if (!templateWrap) return;
      const newWrap = document.createElement("div");
      newWrap.className = templateWrap.className || "";
      const button = template.cloneNode(true);
      button.className = String(button.className || "").split(/\s+/).filter((part) => part && !(/(danger|selected)/.test(part))).join(" ");
      button.removeAttribute("aria-haspopup");
      button.removeAttribute("aria-expanded");
      button.setAttribute("data-qol-open-ws", "1");
      const iconSpan = button.querySelector("[class*=\"_itemIcon\"]");
      if (iconSpan) iconSpan.innerHTML = WS_MENU_ICON;
      const labelSpan = button.querySelector("[class*=\"_itemLabel\"]");
      if (labelSpan) labelSpan.textContent = "在编辑界面打开";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openWorkspaceInEditor(target);
      });
      newWrap.appendChild(button);
      viewport.insertBefore(newWrap, viewport.firstChild);
    }

    // MutationObserver 回调里调用：新出现的 portal 菜单且当前有工作区菜单
    // 打开 → 注入。
    function checkWorkspaceMenuPortal(node) {
      if (!(node instanceof Element)) return;
      const candidates = [];
      if (node.getAttribute && node.getAttribute("role") === "menu") candidates.push(node);
      if (node.querySelectorAll) {
        const nested = node.querySelectorAll('div[role="menu"]');
        for (const menu of nested) candidates.push(menu);
      }
      for (const menu of candidates) {
        if ((((menu.getAttribute("class")) || "").indexOf("_portal") === -1)) continue;
        const target = openWorkspaceMenuTarget();
        if (target) injectOpenWorkspaceEntry(menu, target);
      }
    }

    // =====================================================================
    // 功能 5：编辑器内 Ctrl/Cmd+M —— 选中文字弹出「新会话提问」小窗
    //
    // 小窗里放的不是复刻 UI，而是把主页真实 composer 卡片
    // （[data-composer-card]）整节点挪进弹层（appendChild 重挂载）：
    // 输入框草稿、模型选择、permission 选择、附件、「N lines selected」
    // 徽章全都在原生 React 组件里工作，DSH 或别的插件如何修改主输入框，
    // 这个小窗都自动一致（是同一个节点）。
    // React 只按 stateNode 引用打补丁、按 fiber 树插拔，不关心节点当前被挂在
    // 文档哪个位置，所以搬移本身对它透明；会话切换导致卡片 remount 时
    // 轮询会把新卡再挪进来（旧卡被 React 从弹层移除，无副作用）。
    //
    // 流程：Ctrl/Cmd+M（选中若干非空白文字时）→ 生成新会话（沿用当前
    // cwd）→ 卡片挪入弹层 → 挂起选区上下文（N lines selected 徽章出现在
    // 小窗输入框底部）→ 用户输入问题并发送（Ctrl/Cmd+Enter 或发送按钮，
    // 前缀由功能 3 的发送前填塞注入）→ 发送后小窗自动收起，卡片回到主页，
    // 页面显示新会话及其回复。
    // =====================================================================

    let selpopShell = null;      // 弹层壳（含 host 槽位）
    let selpopHost = null;       // 宿主 div：真实 composer 卡片被挪到这里
    let selpopHintRef = null;    // 头部提示节点（兼作卡片计数诊断）
    let selpopOpen = false;
    let selpopPoll = null;       // 卡片追回轮询 timer
    let selpopCreated = false;   // （保留字段）
    let selpopPhase = "idle";    // idle | swapping | rerouted：轮询只在 idle 搬卡
    let selpopBypass = false;    // 重路由提交时放行自身的捕获拦截
    let selpopHintExtra = "";    // 头部提示的动态段
    const selpopCards = new Map(); // card -> {parent, next}：所有被搬过的卡片，关闭时逐一确定性归还
    const SELPOP_CARD_MARK = "data-qol-selpop"; // 我方搬移过的卡片都会打此标记

    // 结算不变量——弹层里永远至多一张真实输入框：
    //  1. 搬新卡前，若弹层已有卡（我方副本仍在，等待 React 解除挂载）→ 只观察、不搬，
    //     杜绝“新卡搬进来、旧卡还留着”造成的纵向堆叠；
    //  2. 轮询里清理任何*无标记*混进弹层的卡片（不属于我、也归 React 处置完毕的
    //     残留副本；标记卡一定在我方 Map 中，绝不误删）；
    //  3. 被 React 摘走(dispose)的旧副本在下次轮询从 Map 中清除，不累加。
    // 头部"输入框:弹层 x / 页面 y"计数是诊断位：y 长期为 2+ 说明 DSH 本身渲染了
    // 多份 composer（多个会话视图并存），届时把计数发我即可定位。

    const SELPOP_HINT_BASE = "发送后在此新会话回答 · Ctrl/⌘+Enter 发送 · Esc 关闭";

    function buildSelectionPopupShell() {
      const shell = document.createElement("div");
      shell.className = "dsh-qol-selpop";

      const header = document.createElement("div");
      header.className = "dsh-qol-selpop-header";
      const title = document.createElement("span");
      title.className = "dsh-qol-selpop-title";
      title.textContent = "新会话提问（编辑器选区）";
      const hint = document.createElement("span");
      hint.className = "dsh-qol-selpop-hint";
      hint.textContent = SELPOP_HINT_BASE;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "dsh-qol-selpop-close";
      close.textContent = "✕";
      close.setAttribute("aria-label", "关闭");
      close.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeSelectionPopup();
      });
      header.appendChild(title);
      header.appendChild(hint);
      header.appendChild(close);

      const host = document.createElement("div");
      host.className = "dsh-qol-selpop-host";

      shell.appendChild(header);
      shell.appendChild(host);
      return { shell, host, hint };
    }

    // 把一张被搬进弹层的卡片归还原位。home 已离树（视图被整体换掉，卡片
    // 的 fiber 多半同时解除挂载）时不归还——避免把孤儿输入箱落到页面深处；
    // DSH 重新渲染视图时会自行挂载新卡。
    function returnOneCard(card, snap) {
      if (!card || !selpopShell || !selpopShell.contains(card)) return;
      const home = snap ? snap.parent : null;
      if (home && home !== document && home.isConnected !== false) {
        const ref = snap && snap.next && snap.next.parentNode === home ? snap.next : null;
        try {
          home.insertBefore(card, ref);
          return;
        } catch (error) {
          // 落空则按 home 离树处理
        }
      }
    }

    function moveComposerIntoHost(card) {
      if (!card || !card.parentNode) return;
      if (selpopShell && selpopShell.contains(card)) return; // 已在弹层
      if (!selpopCards.has(card)) {
        selpopCards.set(card, { parent: card.parentNode, next: card.nextSibling });
      }
      card.setAttribute(SELPOP_CARD_MARK, "1"); // 标记：我方搬移过的卡（用于防误删与清点）
      selpopHost.appendChild(card);
    }

    function pruneStaleShellCards() {
      if (!selpopHost) return;
      let stales = [];
      try { stales = selpopHost.querySelectorAll("[data-composer-card]"); } catch (e) { return; }
      for (const stale of stales) {
        if (stale.getAttribute(SELPOP_CARD_MARK) !== null) continue; // 有标记 = 我方副本，交给 Map 处理
        console.warn("[dsh-qol] selpop: removing unowned composer card from popup", stale);
        try { stale.remove(); } catch (e) { /* 已不在树上 */ }
      }
    }

    function selpopShellHasCard() {
      if (!selpopHost) return false;
      let marked = null;
      try { marked = selpopHost.querySelector("[" + SELPOP_CARD_MARK + "]"); } catch (e) { return false; }
      return marked !== null;
    }

    function updateSelpopHint() {
      if (!selpopHintRef) return;
      let pageCards = 0;
      let shellCards = 0;
      try { pageCards = document.querySelectorAll("[data-composer-card]").length; } catch (e) {}
      if (selpopHost) { try { shellCards = selpopHost.querySelectorAll("[data-composer-card]").length; } catch (e) {} }
      selpopHintRef.textContent = SELPOP_HINT_BASE + selpopHintExtra + " · 输入框: 弹层" + shellCards + " / 页面" + pageCards;
    }

    function setSelpopHintExtra(text) {
      selpopHintExtra = text ? (text + " · ") : "";
      updateSelpopHint();
    }

    function selpopPollTick() {
      if (!selpopOpen) {
        if (selpopPoll !== null) {
          window.clearInterval(selpopPoll);
          selpopPoll = null;
        }
        return;
      }
      if (!selpopHost) return;
      // (1) 清掉已被 React 摘走的旧副本（摘走 → parentNode null；在树上等待解除挂载的
      //     副本继续留在弹层占位、阻止搬新卡，直到 React 摘走它）
      for (const card of selpopCards.keys()) {
        if (!card.parentNode) selpopCards.delete(card);
      }
      // (2) 无主残留卡片清理
      pruneStaleShellCards();
      // (3) 弹层已有卡 → 只观察、不搬（防双卡）
      if (selpopShellHasCard()) {
        updateSelpopHint();
        return;
      }
      // (3b) 重路由（发送→换新会话→搬新卡）期间卡片归流程独占，轮询不参与，
      //      防止 swapping 窗口把 home 上的卡又搬进来造成双卡。
      if (selpopPhase !== "idle") {
        updateSelpopHint();
        return;
      }
      // (4) 把 home 上的卡搬进来（跳过已在我方弹层里的任何实例）
      let card = null;
      let candidates = [];
      try { candidates = document.querySelectorAll("[data-composer-card]"); } catch (e) { return; }
      for (const c of candidates) {
        if (selpopShell && selpopShell.contains(c)) continue;
        card = c;
        break;
      }
      if (!card) {
        updateSelpopHint();
        return;
      }
      if (selpopShell.parentNode !== document.body) document.body.appendChild(selpopShell);
      moveComposerIntoHost(card);
      updateSelpopHint();
    }

    function openSelectionPopup() {
      const ctx = selectionContext();
      if (!ctx) {
        if (editorStatus) editorStatus.textContent = "请先选中一段文字，再按 Ctrl/⌘+M 开新会话提问";
        return;
      }
      const payload = buildSelectionPayload(ctx);
      if (!selpopShell) {
        const built = buildSelectionPopupShell();
        selpopShell = built.shell;
        selpopHost = built.host;
        selpopHintRef = built.hint;
      }
      selpopOpen = true;
      selpopPhase = "idle";
      selpopShell.style.display = "flex";
      document.body.appendChild(selpopShell);

      // 选取上下文保持待命：徽章显示在（被挪进来的）真实 composer 底部。
      // 此时不创建/切换会话 —— 会话切换会抢焦点（编辑器选区高亮丢失）、
      // 并短暂渲染未就绪/hero 形态的卡片（输入不可见、发送失效）。新会话
      // 在真正发送的一瞬创建并由 reroutePopupSend 完成切换。
      setPendingSelection(payload);
      setSelpopHintExtra("");

      if (selpopPoll !== null) window.clearInterval(selpopPoll);
      selpopPoll = window.setInterval(selpopPollTick, 150);
      selpopPollTick(); // 立即尝试一次
    }

    function closeSelectionPopup() {
      if (!selpopOpen) return;
      selpopOpen = false;
      selpopCreated = false;
      selpopPhase = "idle";
      selpopBypass = false;
      setSelpopHintExtra("");
      if (selpopPoll !== null) {
        window.clearInterval(selpopPoll);
        selpopPoll = null;
      }
      // 所有被搬过的卡片逐一归位（通常只有一张）
      for (const [card, snap] of selpopCards) returnOneCard(card, snap);
      selpopCards.clear();
      pruneStaleShellCards();
      // 关闭弹窗 = 取消本次「新会话提问」：挂起的选区上下文必须随之解除，
      // 否则徽章已被 React 重渲染挤掉的情况下，下一次任意 composer 提交仍会
      // “静默”前缀旧的 文件/行号 块（用户看不到的注入）。发送后自动关闭的
      // 路径里 injectPendingPrefix 已先清空，此处为无副作用的 no-op。
      clearPendingSelection();
      if (selpopShell) {
        selpopShell.style.display = "none";
        if (selpopShell.parentNode) selpopShell.parentNode.removeChild(selpopShell);
      }
    }

    // 发送前填塞成功且小窗打开 → 稍后自动收起（让发送/状态先落定）。
    function scheduleSelpopClose() {
      if (!selpopOpen) return;
      window.setTimeout(closeSelectionPopup, 400);
    }

    // ---------------------------------------------------------------------
    // 弹层提交重路由：Ctrl/⌘+M 弹窗只借用「当前会话」的真实 composer 卡
    // （未就绪、无焦点切换、徽章可挂）。真正的提交（发送按钮 / Ctrl⌘Enter）
    // 被截获后：先归还卡片 → 创建新会话（跟随当前工作区，见
    // sessionCreateOptions）并 open → 等 DSH 重挂载 home 卡至就绪（非
    // hero/只读）→ 搬入弹层 → 注入合成文本（选区前缀 + 用户输入）→ 代发一次
    // 原生点击完成发送 → 弹层自动收起，主页显示新会话与回复。
    // ---------------------------------------------------------------------

    function selpopInPopupSend(el) {
      return selpopOpen && selpopPhase === "idle" && !!selpopHost && !!el && selpopHost.contains(el);
    }

    function reroutePopupSend(textarea) {
      const value = textarea.value || "";
      if (value.trim() === "") return; // 空草稿与原生行为一致：什么都不做
      const composite = (pendingSelection ? pendingSelection.block : "") + value;
      clearPendingSelection();
      // 弹层卡回到 home（selpopPhase=swapping 后轮询/守门不再搬卡）
      for (const [card, snap] of selpopCards) returnOneCard(card, snap);
      selpopCards.clear();
      pruneStaleShellCards();
      selpopPhase = "swapping";
      setSelpopHintExtra("正在创建新会话…");
      (async () => {
        try {
          const newId = await sessions.create(sessionCreateOptions());
          sessions.open(newId);
        } catch (error) {
          console.error("[dsh-qol] selpop reroute: new session failed:", error);
          selpopPhase = "idle";
          setSelpopHintExtra("新会话创建失败，点发送重试");
          window.setTimeout(closeSelectionPopup, 1500);
          return;
        }
        rerouteRetry(composite, 0);
      })();
    }

    function rerouteRetry(composite, attempt) {
      if (!selpopOpen) return; // 切换期间弹窗被关：放弃重路由（草稿已回到 home 卡上）
      if (attempt >= 15) {
        selpopPhase = "idle";
        setSelpopHintExtra("新会话未就绪，请重新点发送");
        window.setTimeout(closeSelectionPopup, 1500);
        return;
      }
      // home 上（弹层外）重挂载的卡，且其 textarea 已就绪（hero/未加载态为
      // readOnly/disabled，不可提交）
      let fresh = null;
      let candidates = [];
      try { candidates = document.querySelectorAll("[data-composer-card]"); } catch (e) {}
      for (const c of candidates) {
        if (selpopShell && selpopShell.contains(c)) continue;
        fresh = c;
        break;
      }
      let ta = null;
      if (fresh) { try { ta = fresh.querySelector("textarea[data-phase]"); } catch (e) { ta = null; } }
      const ready = !!ta && !ta.disabled && !ta.readOnly;
      if (!ready) {
        window.setTimeout(() => rerouteRetry(composite, attempt + 1), 100);
        return;
      }
      moveComposerIntoHost(fresh);
      selpopPhase = "rerouted";
      setNativeValue(ta, composite);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      // 代发 DSH 原生提交：此刻 draft store（新会话）已含合成文本；
      // selpopBypass 让自身的两个捕获拦截放行这次点击。
      let sendBtn = null;
      let buttons = [];
      try { buttons = fresh.querySelectorAll("button"); } catch (e) {}
      for (const b of buttons) {
        const label = b.getAttribute("aria-label") || "";
        if (SEND_LABELS.indexOf(label) !== -1) { sendBtn = b; break; }
      }
      setSelpopHintExtra("");
      if (sendBtn) {
        selpopBypass = true;
        try { sendBtn.click(); } catch (e) {}
        window.setTimeout(() => { selpopBypass = false; }, 400);
      }
      window.setTimeout(closeSelectionPopup, 600);
    }

    // Ctrl/⌘+M 在编辑器文本区按下 → 开新会话提问小窗
    function onEditorSelectionKeydown(event) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key !== "m" && event.key !== "M") return;
      event.preventDefault();
      event.stopPropagation();
      openSelectionPopup();
    }

    // Esc 关闭小窗（捕获期，先于 DSH 自己的 Esc 语义）
    function onPopupKeydownCapture(event) {
      if (!selpopOpen) return;
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeSelectionPopup();
    }

    // 点到小窗之外 → 关闭；但点在 portal 化的菜单/气泡/对话框里不关
    // （permission 下拉、tooltip 等落在 body 上，属于正常交互）
    function onPopupPointerCapture(event) {
      if (!selpopOpen || !selpopShell) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (selpopShell.contains(target)) return;
      if (target.closest && target.closest('[role="menu"],[role="tooltip"],[role="dialog"]')) return;
      closeSelectionPopup();
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

    // session.create 只接受 workspaceId / cwd 之一。目标：新会话自动归属
    // 「当前工作区」。判定顺序（见 workspaces.list 快照）：
    //   1. 当前会话在某个工作区的 sessionIds 里 → 那个工作区；
    //   2. 否则当前 cwd 恰好等于/位于某个工作区路径之下 → 最深的那个；
    //   3. 都没有 → 回落 {cwd}（老行为）。
    function findCurrentWorkspaceId() {
      const sSnap = sessions && sessions.list ? sessions.list.getSnapshot() : null;
      const current = sSnap ? sSnap.current : undefined;
      const cwd = current && sSnap.byId && sSnap.byId[current] ? sSnap.byId[current].cwd : undefined;
      const wSnap = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
      if (!wSnap || !Array.isArray(wSnap.items) || wSnap.items.length === 0) return undefined;
      if (current) {
        for (const item of wSnap.items) {
          if (item && Array.isArray(item.sessionIds) &&
              item.sessionIds.indexOf(current) !== -1 && item.workspaceId) {
            return item.workspaceId;
          }
        }
      }
      if (typeof cwd === "string" && cwd.length > 0) {
        let best = undefined;
        for (const item of wSnap.items) {
          if (!item || !item.path || !item.workspaceId) continue;
          const match = cwd === item.path || cwd.indexOf(item.path.endsWith("/") ? item.path : item.path + "/") === 0;
          if (match && (!best || item.path.length > best.path.length)) best = item;
        }
        if (best) return best.workspaceId;
      }
      return undefined;
    }

    function sessionCreateOptions() {
      try {
        const workspaceId = findCurrentWorkspaceId();
        if (workspaceId) return { workspaceId: workspaceId };
        const sSnap = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        const current = sSnap ? sSnap.current : undefined;
        const cwd = current && sSnap.byId && sSnap.byId[current] ? sSnap.byId[current].cwd : undefined;
        return cwd ? { cwd } : {};
      } catch (error) {
        return {};
      }
    }

    async function askSelectionInNewSession() {
      const ctx = selectionContext();
      if (!ctx) return;
      const payload = buildSelectionPayload(ctx);
      closeEditor();
      try {
        const newId = await sessions.create(sessionCreateOptions());
        sessions.open(newId);
        // 挂起选区上下文，徽章显示在新会话输入栏底部（permission 右侧）
        setPendingSelection(payload);
        // give React a beat to mount the new composer, then (re)place the pill
        await new Promise((resolve) => setTimeout(resolve, 350));
        placeSelectionPill();
      } catch (error) {
        console.error("[dsh-qol] new-session ask failed:", error);
      }
    }

    async function replySelectionInCurrentSession() {
      const ctx = selectionContext();
      if (!ctx) return;
      const payload = buildSelectionPayload(ctx);
      closeEditor();
      try {
        const snapshot = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        const current = snapshot ? snapshot.current : undefined;
        if (!current) {
          const newId = await sessions.create(sessionCreateOptions());
          sessions.open(newId);
        }
        // 挂起选区上下文，徽章显示在当前输入栏底部
        setPendingSelection(payload);
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
      editorInput.addEventListener("keydown", onEditorSelectionKeydown);
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

    function normalizeAbsolutePath(input) {
      const parts = [];
      for (const segment of input.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") parts.pop();
        else parts.push(segment);
      }
      return "/" + parts.join("/");
    }

    function resolvePathForFile(path) {
      if (path.startsWith("/")) return normalizeAbsolutePath(path);
      const base = currentWorkspaceDir();
      if (!base) return path;
      return normalizeAbsolutePath(base.replace(/\/+$/, "") + "/" + path);
    }

    // =====================================================================
    // 聊天历史里的「带下划线的文件」，共三种 DOM 结构，全部要拦截并转
    // 到本插件的编辑器去打开（原生 openFile 在纯 web 里是静默 no-op）：
    //
    // 结构 1（MarkdownText 行内 code token 的 file mention）：
    //   <code><button title="整路径" aria-label="...">token</button></code>
    // token 可能只是文件名 basename（resolver 按“唯一 basename”匹配，例如
    // `client.js`），整路径始终在 button 的 title 上（producedFileMentions
    // 契约）。只认与路径同构的 title，无 title 时退回“含 / 的文字”旧形态。
    //
    // 结构 2（回合尾部「产物」chips，非 code 内）：
    //   [data-produced-files-row] 内的 <button title="整路径">basename</button>
    // 只认 title，避开没有 title 的“在文件夹中显示”按钮。
    //
    // 结构 3（工具行的文件路径，即 “Read/Edit · 路径” 那行里带下划线的文字）：
    //   [data-tool][data-state] … <button class="…fileLink">相对/整路径</button>
    // （dsh-client-ui-tool 的 ToolRow 收起态摘要；fileLink 类名是 CSS module
    // 哈希，但后缀恒为本地名 fileLink，与插件既有的 [class*="bubble"] 等
    // 做法一致。）该按钮没有 title，整路径只存在于 React 闭包里，DOM 上能
    // 拿到的只是“把 cwd 前缀剥掉后的显示文本”；用当前会话 cwd 重新拼接，
    // 与 UI 自身 openPath 的解析语义（resolveWorkspacePath）等价。
    // =====================================================================

    function isTitlePathLike(text) {
      if (!text) return false;
      if (text !== text.trim()) return false;
      if (text.includes("\n") || text.includes("\r")) return false;
      if (text.includes("://")) return false;
      if (/^(file|data|mailto):/i.test(text)) return false;
      return true;
    }

    function isPathToken(text) {
      // 单行、无空白、非 URL 的路径 token（允许只是文件名，如 client.js）。
      if (!text || text !== text.trim()) return false;
      if (text.includes(" ") || text.includes("\t") || text.includes("\n") || text.includes("\r")) return false;
      if (text.includes("://")) return false;
      if (/^(file|data|mailto):/i.test(text)) return false;
      return true;
    }

    function isLegacyPathText(text) {
      // 无 title 的旧形态：token 本身就是含 "/" 的相对/绝对路径。
      return isPathToken(text) && text.includes("/");
    }

    // 工具行（Read/Edit/Write 卡片）收起态里的文件路径按钮。
    function isToolRowFileLink(button) {
      const cls = button.getAttribute ? (button.getAttribute("class") || "") : (button.className || "");
      if (!cls || cls.indexOf("fileLink") === -1) return false;
      if (!button.closest) return false;
      return button.closest("[data-tool]") !== null;
    }

    // 判定依据：该按钮是其 <code> 的唯一元素子节点（mention 结构里 <code>
    // 子节点只有这个按钮）；shiki/围栏代码、Terminal/Read/Diff 卡片里的按钮
    // 位置不同，不会被误判。
    function isMentionCodeButton(button) {
      const code = button.closest ? button.closest("code") : null;
      if (!code || !code.children) return false;
      for (const child of code.children) {
        if (child !== button) return false;
      }
      return true;
    }

    function fileMentionPath(button) {
      const title = (button.getAttribute ? (button.getAttribute("title") || "") : "").trim();
      if (isTitlePathLike(title)) return title;
      const text = (button.textContent || "").trim();
      if (isLegacyPathText(text)) return text;
      return null;
    }

    function onDocumentClickCapture(event) {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (!button) return;

      let filePath = null;
      if (isMentionCodeButton(button)) {
        filePath = fileMentionPath(button);
      } else if (button.closest && button.closest("[data-produced-files-row]")) {
        // 产物 chip 只认 title；没有 title 的按钮（“在文件夹中显示”）交给原生逻辑。
        const title = (button.getAttribute("title") || "").trim();
        if (isTitlePathLike(title)) filePath = title;
      } else if (isToolRowFileLink(button)) {
        // 工具行文件路径（Read/Edit · 下划线文本）：无 title，取显示文本并用
        // 当前会话 cwd 重新解析（与 resolveWorkspacePath 语义一致）。
        const text = (button.textContent || "").trim();
        if (isPathToken(text)) filePath = text;
      }
      if (filePath === null) return;

      event.preventDefault();
      event.stopPropagation();
      openEditor({ skipInitialDir: true });
      navigateTo(resolvePathForFile(filePath));
    }

    function openEditor(opts) {
      if (!editorOverlay) setupEditor();
      editorOverlay.style.display = "flex";
      if (!opts || opts.skipInitialDir !== true) ensureInitialDir();
    }

    function closeEditor() {
      if (selpopOpen) closeSelectionPopup();
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
      // 双击目录 = 把 tree root 切换到该目录（重新列目录、刷新表头）
      row.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onTreeRowDblClick(node);
      });
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

    // 双击目录：将 tree view 的 root 切换到该目录。setTreeRoot 会重新拉取
    // 该目录列表并更新表头；不影响当前已打开的文件/编辑缓冲。
    // （双击前必然先触发两次 click：展开→收起，最终状态以 re-root 为准。
    //  顶部路径栏同步为新 root，保证「上一级」按新 root 的父目录导航。）
    function onTreeRowDblClick(node) {
      if (node.type !== "directory") return;
      if (editorPathInput) editorPathInput.value = node.path;
      setTreeRoot(node.path);
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
      document.addEventListener("click", onDocumentClickCapture, true);

      ensureStyle();
      sessions = ctx.sessions;
      workspaces = ctx.workspaces;
      // 发送前填塞：捕获期监听，先于 React 根容器委托触发
      document.addEventListener("keydown", onSendKeydownCapture, true);
      document.addEventListener("click", onSendClickCapture, true);
      // 新会话提问小窗：Esc 关闭 + 外点关闭
      document.addEventListener("keydown", onPopupKeydownCapture, true);
      document.addEventListener("pointerdown", onPopupPointerCapture, true);
      setupEditor();

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            scan(node);
            checkWorkspaceMenuPortal(node);
            paintModelInputs(node);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      scan(document.body);

      const timer = window.setInterval(() => {
        repair();
        positionEditorFab();
        placeSelectionPill();
      }, 1000);
      window.addEventListener("resize", positionEditorFab);

      ctx.effect(function () {
        return function () {
          document.removeEventListener("keydown", onKeyDownCapture, true);
          document.removeEventListener("keydown", onSendKeydownCapture, true);
          document.removeEventListener("click", onDocumentClickCapture, true);
          document.removeEventListener("click", onSendClickCapture, true);
          document.removeEventListener("keydown", onPopupKeydownCapture, true);
          document.removeEventListener("pointerdown", onPopupPointerCapture, true);
          observer.disconnect();
          window.clearInterval(timer);
          window.removeEventListener("resize", positionEditorFab);
          closeSelectionPopup();
          selpopShell = null;
          selpopHost = null;
          try {
            detachModelInputs();
          } catch {
            /* ignore */
          }
          modelView = null;
          modelViewPromise = null;
          modelViewAt = 0;
          if (styleEl !== null) styleEl.remove();
          if (editorFab !== null) editorFab.remove();
          if (editorOverlay !== null) editorOverlay.remove();
          clearPendingSelection();
          selectionPill = null;
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
