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
`;

    let styleEl = null;
    let sessions = null;

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
    // apply
    // =====================================================================

    function apply(ctx) {
      document.addEventListener("keydown", onKeyDownCapture, true);

      ensureStyle();
      sessions = ctx.sessions;

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) scan(node);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      scan(document.body);

      const timer = window.setInterval(repair, 1000);

      ctx.effect(function () {
        return function () {
          document.removeEventListener("keydown", onKeyDownCapture, true);
          observer.disconnect();
          window.clearInterval(timer);
          if (styleEl !== null) styleEl.remove();
          sessions = null;
        };
      }, TAG + ": cleanup");
    }

    exports.apply = apply;
    exports.inject = ["sessions"];
    return module.exports;
  }
});
