// MailHub & Vault 前端交互脚本 (海量邮箱专属优化版)
(function () {
  'use strict';

  // 状态管理
  const state = {
    currentTab: 'vault',
    vaultAccounts: [],
    platformSummary: [],
    selectedPlatform: '',
    onlyHasCode: false,
    cfMails: [],
    recipients: [],
    selectedRecipient: '',
    outlookAccounts: [],
    systemSettings: {}
  };

  // DOM 元素引用
  const dom = {
    loginOverlay: document.getElementById('loginOverlay'),
    loginForm: document.getElementById('loginForm'),
    loginPasswordInput: document.getElementById('loginPasswordInput'),
    loginErrorMsg: document.getElementById('loginErrorMsg'),
    logoutBtn: document.getElementById('logoutBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),

    // 看板统计
    statTotalVault: document.getElementById('statTotalVault'),
    statActiveVault: document.getElementById('statActiveVault'),
    statCfMails: document.getElementById('statCfMails'),
    statOutlook: document.getElementById('statOutlook'),
    cfMailCountBadge: document.getElementById('cfMailCountBadge'),

    // 平台胶囊与台账
    platformChipsList: document.getElementById('platformChipsList'),
    vaultTableBody: document.getElementById('vaultTableBody'),
    vaultSearchInput: document.getElementById('vaultSearchInput'),
    vaultCategoryFilter: document.getElementById('vaultCategoryFilter'),
    vaultStatusFilter: document.getElementById('vaultStatusFilter'),
    toggleHasCodeBtn: document.getElementById('toggleHasCodeBtn'),
    openNewVaultModalBtn: document.getElementById('openNewVaultModalBtn'),
    exportVaultBtn: document.getElementById('exportVaultBtn'),

    // 全局 Spotlight (Cmd+K)
    globalSpotlightTrigger: document.getElementById('globalSpotlightTrigger'),
    spotlightModal: document.getElementById('spotlightModal'),
    spotlightInput: document.getElementById('spotlightInput'),
    spotlightResults: document.getElementById('spotlightResults'),

    // 模态弹窗
    vaultModal: document.getElementById('vaultModal'),
    vaultModalTitle: document.getElementById('vaultModalTitle'),
    vaultForm: document.getElementById('vaultForm'),
    vaultEditId: document.getElementById('vaultEditId'),
    vaultPlatformInput: document.getElementById('vaultPlatformInput'),
    vaultUrlInput: document.getElementById('vaultUrlInput'),
    vaultEmailInput: document.getElementById('vaultEmailInput'),
    vaultEmailSourceSelect: document.getElementById('vaultEmailSourceSelect'),
    vaultCategorySelect: document.getElementById('vaultCategorySelect'),
    vaultUsernameInput: document.getElementById('vaultUsernameInput'),
    vaultPasswordInput: document.getElementById('vaultPasswordInput'),
    vaultTotpInput: document.getElementById('vaultTotpInput'),
    vaultStatusSelect: document.getElementById('vaultStatusSelect'),
    vaultProxyInput: document.getElementById('vaultProxyInput'),
    vaultRemarkInput: document.getElementById('vaultRemarkInput'),
    autoGenEmailBtn: document.getElementById('autoGenEmailBtn'),

    // 验证码结果模态框
    codeResultModal: document.getElementById('codeResultModal'),
    codeResultContent: document.getElementById('codeResultContent'),

    // 自建收信箱元素
    recipientList: document.getElementById('recipientList'),
    recipientTotalCount: document.getElementById('recipientTotalCount'),
    totalRecipientCount: document.getElementById('totalRecipientCount'),
    recipientSearchInput: document.getElementById('recipientSearchInput'),
    mailSearchInput: document.getElementById('mailSearchInput'),
    currentRecipientDisplay: document.getElementById('currentRecipientDisplay'),
    mailListContainer: document.getElementById('mailListContainer'),
    refreshMailsBtn: document.getElementById('refreshMailsBtn'),
    cleanUnprotectedMailsBtn: document.getElementById('cleanUnprotectedMailsBtn'),
    mailViewModal: document.getElementById('mailViewModal'),
    mailModalSubject: document.getElementById('mailModalSubject'),
    mailModalMeta: document.getElementById('mailModalMeta'),
    mailIframeSandbox: document.getElementById('mailIframeSandbox'),
    mailTextFallback: document.getElementById('mailTextFallback'),

    // Outlook 元素
    outlookTableBody: document.getElementById('outlookTableBody'),
    addOutlookModalBtn: document.getElementById('addOutlookModalBtn'),
    outlookModal: document.getElementById('outlookModal'),
    outlookForm: document.getElementById('outlookForm'),

    // 设置元素
    cfDomainsDisplay: document.getElementById('cfDomainsDisplay'),
    newAdminPasswordInput: document.getElementById('newAdminPasswordInput'),
    saveAdminPasswordBtn: document.getElementById('saveAdminPasswordBtn')
  };

  // 通用 API 请求封装
  async function api(path, options = {}) {
    options.headers = options.headers || {};
    if (options.body && typeof options.body === 'object') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, options);
    if (res.status === 401) {
      showLogin(true);
      throw new Error('UNAUTHORIZED');
    }
    const data = await res.json().catch(() => ({}));
    return data;
  }

  // 复制文本到剪贴板
  function copyText(text, tip = '已复制') {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      showToast(`📋 ${tip}: ${text}`);
    }).catch(() => {
      prompt('请手动复制:', text);
    });
  }

  // 轻提示 Toast
  function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#10b981;color:#fff;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 10px 20px rgba(0,0,0,0.4);';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  function showLogin(visible) {
    dom.loginOverlay.style.display = visible ? 'flex' : 'none';
  }

  function initTheme() {
    const savedTheme = localStorage.getItem('mailhub_theme') || 'dark';
    if (savedTheme === 'light') {
      document.body.classList.add('light-theme');
      document.body.classList.remove('dark-theme');
    } else {
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
    }
  }

  function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    document.body.classList.toggle('dark-theme', !isLight);
    localStorage.setItem('mailhub_theme', isLight ? 'light' : 'dark');
  }

  function switchTab(tabName) {
    state.currentTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-view').forEach(v => v.classList.toggle('active', v.id === `view-${tabName}`));

    if (tabName === 'vault') {
      loadPlatformSummary();
      loadVaultData();
    } else if (tabName === 'cf-mails') {
      loadCfMails();
    } else if (tabName === 'outlook') {
      loadOutlookData();
    } else if (tabName === 'settings') {
      loadSettings();
    }
  }

  // 获取品牌 Avatar 样式类
  function getBrandAvatar(platform) {
    const p = (platform || '').toLowerCase();
    let cls = 'plat-default';
    let char = platform ? platform[0].toUpperCase() : 'P';
    if (p.includes('openai') || p.includes('chatgpt')) { cls = 'plat-openai'; char = '⚡'; }
    else if (p.includes('claude') || p.includes('anthropic')) { cls = 'plat-claude'; char = '🟣'; }
    else if (p.includes('cursor')) { cls = 'plat-cursor'; char = '⚡'; }
    else if (p.includes('github')) { cls = 'plat-github'; char = '🐙'; }
    else if (p.includes('twitter') || p === 'x') { cls = 'plat-twitter'; char = '🐦'; }
    else if (p.includes('google')) { cls = 'plat-google'; char = 'G'; }
    else if (p.includes('discord')) { cls = 'plat-discord'; char = '💬'; }
    return `<div class="platform-avatar ${cls}">${char}</div>`;
  }

  // ==================== 1. 平台台账与胶囊筛选模块 ====================
  async function loadPlatformSummary() {
    try {
      const res = await api('/api/vault/platforms');
      if (res.success && Array.isArray(res.data)) {
        state.platformSummary = res.data;
        renderPlatformChips();
      }
    } catch (e) {}
  }

  function renderPlatformChips() {
    const totalCount = state.platformSummary.reduce((acc, cur) => acc + cur.count, 0);
    const chipsHtml = state.platformSummary.map(p => {
      const isAct = state.selectedPlatform.toLowerCase() === p.platform_name.toLowerCase() ? 'active' : '';
      return `
        <button class="chip-item ${isAct}" onclick="filterByPlatform('${p.platform_name}')">
          <span>${p.platform_name}</span>
          <span style="opacity:0.75;">(${p.count})</span>
        </button>
      `;
    }).join('');

    dom.platformChipsList.innerHTML = `
      <button class="chip-item ${state.selectedPlatform === '' ? 'active' : ''}" onclick="filterByPlatform('')">
        全部平台 (${totalCount})
      </button>
      ${chipsHtml}
    `;
  }

  window.filterByPlatform = function (plat) {
    state.selectedPlatform = plat;
    renderPlatformChips();
    loadVaultData();
  };

  async function loadVaultData() {
    try {
      const q = encodeURIComponent(dom.vaultSearchInput.value);
      const cat = encodeURIComponent(dom.vaultCategoryFilter.value);
      const status = encodeURIComponent(dom.vaultStatusFilter.value);
      const plat = encodeURIComponent(state.selectedPlatform);
      const hasCode = state.onlyHasCode ? 'true' : 'false';

      const res = await api(`/api/vault?q=${q}&category=${cat}&status=${status}&platform=${plat}&has_code=${hasCode}`);
      if (res.success) {
        state.vaultAccounts = res.data || [];
        renderVaultTable();
        loadStats();
      }
    } catch (e) {}
  }

  function renderVaultTable() {
    if (state.vaultAccounts.length === 0) {
      dom.vaultTableBody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">暂无符合条件的平台台账记录，点击右上角【➕ 登记平台账号】添加</td></tr>';
      return;
    }

    dom.vaultTableBody.innerHTML = state.vaultAccounts.map(acc => {
      const statusMap = {
        active: '<span class="tag tag-active">正常</span>',
        pending: '<span class="tag tag-pending">待验证</span>',
        banned: '<span class="tag tag-banned">已封禁</span>',
        deprecated: '<span class="tag tag-category">已废弃</span>'
      };

      const emailSourceMap = {
        cf_domain: '<span class="tag tag-active">自建域名</span>',
        outlook: '<span class="tag tag-pending">Outlook</span>',
        gptmail: '<span class="tag tag-category">临时邮箱</span>',
        external: '<span class="tag tag-category">外部</span>'
      };

      const codeBadgeHtml = acc.last_code
        ? `<div class="code-badge" title="最新接收到的验证码，点击复制">
             <span>${acc.last_code}</span>
             <span class="code-copy-btn" onclick="copyText('${acc.last_code}', '验证码')">📋</span>
           </div>`
        : `<button class="btn-fetch-code" onclick="fetchPlatformCode(${acc.id})">⚡ 查收验证码</button>`;

      const maskedPwd = acc.password ? `•••••••• <button class="btn-link" onclick="copyText('${acc.password}', '密码')">复制</button>` : '<span class="text-muted">-</span>';

      const starIcon = acc.is_pinned ? '⭐' : '☆';
      const starClass = acc.is_pinned ? 'star-btn pinned' : 'star-btn';

      return `
        <tr>
          <td align="center">
            <button class="${starClass}" onclick="togglePinVault(${acc.id})" title="${acc.is_pinned ? '取消置顶' : '置顶此账号'}">${starIcon}</button>
          </td>
          <td>
            <div class="platform-cell">
              ${getBrandAvatar(acc.platform_name)}
              <div>
                <strong>${acc.platform_name}</strong>
                ${acc.platform_url ? `<a href="${acc.platform_url}" target="_blank" style="margin-left:4px;text-decoration:none;font-size:12px;">🔗</a>` : ''}
                ${acc.proxy_node ? `<div style="font-size:11px;color:var(--text-dim);">🌐 ${acc.proxy_node}</div>` : ''}
              </div>
            </div>
          </td>
          <td>
            <div class="email-cell">
              <div class="email-address-wrapper">
                <span class="email-text">${acc.account_email}</span>
                <button class="btn-link" onclick="copyText('${acc.account_email}', '邮箱')">复制</button>
              </div>
              <div>${emailSourceMap[acc.email_source] || ''}</div>
            </div>
          </td>
          <td>
            ${acc.username ? `${acc.username} <button class="btn-link" onclick="copyText('${acc.username}', '用户名')">复制</button>` : '<span class="text-muted">-</span>'}
          </td>
          <td>${maskedPwd}</td>
          <td><span class="tag tag-category">${acc.category || '其他'}</span></td>
          <td>${statusMap[acc.status] || acc.status}</td>
          <td>${codeBadgeHtml}</td>
          <td>
            <div style="display:flex;gap:4px;">
              <button class="btn-sm btn-outline" onclick="editVaultRecord(${acc.id})">编辑</button>
              <button class="btn-sm btn-outline text-danger" onclick="deleteVaultRecord(${acc.id})">删除</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // 置顶切换
  window.togglePinVault = async function (id) {
    const res = await api(`/api/vault/${id}/pin`, { method: 'POST' });
    if (res.success) {
      loadVaultData();
    }
  };

  // 仅看有验证码过滤
  dom.toggleHasCodeBtn.addEventListener('click', () => {
    state.onlyHasCode = !state.onlyHasCode;
    dom.toggleHasCodeBtn.dataset.active = state.onlyHasCode ? 'true' : 'false';
    loadVaultData();
  });

  // 查收某个平台的最新验证码 (核心联动)
  window.fetchPlatformCode = async function (id) {
    dom.codeResultContent.innerHTML = '<div class="loading-spinner">正在联网查询该平台最新收信并提取验证码...</div>';
    dom.codeResultModal.classList.add('show');

    try {
      const res = await api(`/api/vault/${id}/code`);
      if (res.success && res.data) {
        const d = res.data;
        if (d.code) {
          dom.codeResultContent.innerHTML = `
            <div style="font-size:14px;color:var(--text-muted);">已成功从最新邮件中提取验证码：</div>
            <div class="big-code-display">${d.code}</div>
            <div style="margin-bottom:1rem;">
              <button class="btn btn-primary" onclick="copyText('${d.code}', '验证码')">📋 一键复制验证码</button>
            </div>
            ${d.link ? `<div style="margin-bottom:0.75rem;"><a href="${d.link}" target="_blank" class="btn-link">🔗 打开激活/确认链接</a></div>` : ''}
            <div style="text-align:left;font-size:12px;color:var(--text-muted);background:var(--bg-tertiary);padding:10px;border-radius:6px;">
              <div><b>发件人:</b> ${d.sender || '未知'}</div>
              <div><b>主题:</b> ${d.subject || '无主题'}</div>
              <div><b>时间:</b> ${d.received_at || '刚刚'}</div>
            </div>
          `;
          loadVaultData(); // 刷新缓存的代码
        } else {
          dom.codeResultContent.innerHTML = `
            <div style="padding:1.5rem 0;color:var(--text-muted);">
              <div style="font-size:2.5rem;margin-bottom:0.5rem;">📭</div>
              <div>${d.message || '收件箱暂未收到新验证码邮件'}</div>
              <p style="font-size:12px;margin-top:6px;">请在平台点击发送验证码后，再次点击重试。</p>
            </div>
          `;
        }
      } else {
        dom.codeResultContent.innerHTML = `<div class="error-msg">${res.message || '查询失败'}</div>`;
      }
    } catch (e) {
      dom.codeResultContent.innerHTML = '<div class="error-msg">网络请求失败，请稍后重试</div>';
    }
  };

  window.editVaultRecord = function (id) {
    const acc = state.vaultAccounts.find(a => a.id === id);
    if (!acc) return;
    dom.vaultModalTitle.textContent = '编辑平台账号';
    dom.vaultEditId.value = acc.id;
    dom.vaultPlatformInput.value = acc.platform_name;
    dom.vaultUrlInput.value = acc.platform_url || '';
    dom.vaultEmailInput.value = acc.account_email;
    dom.vaultEmailSourceSelect.value = acc.email_source;
    dom.vaultCategorySelect.value = acc.category;
    dom.vaultUsernameInput.value = acc.username || '';
    dom.vaultPasswordInput.value = acc.password || '';
    dom.vaultTotpInput.value = acc.totp_secret || '';
    dom.vaultStatusSelect.value = acc.status;
    dom.vaultProxyInput.value = acc.proxy_node || '';
    dom.vaultRemarkInput.value = acc.remark || '';
    dom.vaultModal.classList.add('show');
  };

  window.deleteVaultRecord = async function (id) {
    if (!confirm('确定要删除该平台记录吗？')) return;
    const res = await api(`/api/vault/${id}`, { method: 'DELETE' });
    if (res.success) {
      showToast('已删除平台记录');
      loadPlatformSummary();
      loadVaultData();
    }
  };

  // 一键生成自建域名临时邮箱
  dom.autoGenEmailBtn.addEventListener('click', () => {
    const domain = '439949.xyz';
    const plat = (dom.vaultPlatformInput.value || 'account').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rand = Math.random().toString(36).substring(2, 8);
    const generated = `${plat}_${rand}@${domain}`;
    dom.vaultEmailInput.value = generated;
    dom.vaultEmailSourceSelect.value = 'cf_domain';
    showToast(`已生成并填入新邮箱: ${generated}`);
  });

  // 保存台账表单
  dom.vaultForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = dom.vaultEditId.value;
    const payload = {
      platform_name: dom.vaultPlatformInput.value.trim(),
      platform_url: dom.vaultUrlInput.value.trim(),
      account_email: dom.vaultEmailInput.value.trim(),
      email_source: dom.vaultEmailSourceSelect.value,
      category: dom.vaultCategorySelect.value,
      username: dom.vaultUsernameInput.value.trim(),
      password: dom.vaultPasswordInput.value.trim(),
      totp_secret: dom.vaultTotpInput.value.trim(),
      status: dom.vaultStatusSelect.value,
      proxy_node: dom.vaultProxyInput.value.trim(),
      remark: dom.vaultRemarkInput.value.trim()
    };

    const method = editId ? 'PUT' : 'POST';
    const path = editId ? `/api/vault/${editId}` : '/api/vault';
    const res = await api(path, { method, body: payload });
    if (res.success) {
      showToast('台账记录已保存');
      dom.vaultModal.classList.remove('show');
      loadPlatformSummary();
      loadVaultData();
    } else {
      alert(res.message || '保存失败');
    }
  });

  // 导出台账 CSV
  dom.exportVaultBtn.addEventListener('click', () => {
    if (state.vaultAccounts.length === 0) return alert('当前没有台账数据可供导出');
    const headers = ['平台', '官网', '邮箱', '来源', '用户名', '密码', '分类', '状态', '代理IP', '备注'];
    const rows = state.vaultAccounts.map(a => [
      `"${a.platform_name}"`,
      `"${a.platform_url || ''}"`,
      `"${a.account_email}"`,
      `"${a.email_source}"`,
      `"${a.username || ''}"`,
      `"${a.password || ''}"`,
      `"${a.category}"`,
      `"${a.status}"`,
      `"${a.proxy_node || ''}"`,
      `"${(a.remark || '').replace(/"/g, '""')}"`
    ]);
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `MailHub_Vault_Backup_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  });

  // ==================== 2. 全局 Spotlight (Cmd+K) 秒搜引擎 ====================
  function openSpotlight() {
    dom.spotlightModal.classList.add('show');
    dom.spotlightInput.value = '';
    dom.spotlightInput.focus();
    renderSpotlightResults('');
  }

  function closeSpotlight() {
    dom.spotlightModal.classList.remove('show');
  }

  dom.globalSpotlightTrigger.addEventListener('click', openSpotlight);

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (dom.spotlightModal.classList.contains('show')) {
        closeSpotlight();
      } else {
        openSpotlight();
      }
    } else if (e.key === 'Escape' && dom.spotlightModal.classList.contains('show')) {
      closeSpotlight();
    }
  });

  dom.spotlightInput.addEventListener('input', (e) => {
    renderSpotlightResults(e.target.value.trim());
  });

  function renderSpotlightResults(keyword) {
    if (!keyword) {
      // 默认展示最近/置顶的账号
      const recents = state.vaultAccounts.slice(0, 8);
      if (recents.length === 0) {
        dom.spotlightResults.innerHTML = '<div class="spotlight-empty">输入平台名（如 openai）、邮箱或验证码即刻秒找...</div>';
        return;
      }
      dom.spotlightResults.innerHTML = `
        <div class="spotlight-group-title">快捷直达 / 常用账号</div>
        ${recents.map(renderSpotlightItem).join('')}
      `;
      return;
    }

    const kw = keyword.toLowerCase();
    const matchedVault = state.vaultAccounts.filter(a =>
      a.platform_name.toLowerCase().includes(kw) ||
      a.account_email.toLowerCase().includes(kw) ||
      (a.username && a.username.toLowerCase().includes(kw)) ||
      (a.remark && a.remark.toLowerCase().includes(kw)) ||
      (a.last_code && a.last_code.includes(kw))
    );

    const matchedMails = state.cfMails.filter(m =>
      (m.recipient && m.recipient.toLowerCase().includes(kw)) ||
      (m.subject && m.subject.toLowerCase().includes(kw)) ||
      (m.verification_code && m.verification_code.includes(kw)) ||
      (m.sender && m.sender.toLowerCase().includes(kw))
    ).slice(0, 5);

    if (matchedVault.length === 0 && matchedMails.length === 0) {
      dom.spotlightResults.innerHTML = `<div class="spotlight-empty">未找到包含 "${keyword}" 的平台账号或收信</div>`;
      return;
    }

    let html = '';
    if (matchedVault.length > 0) {
      html += `<div class="spotlight-group-title">平台账号 (${matchedVault.length})</div>`;
      html += matchedVault.slice(0, 10).map(renderSpotlightItem).join('');
    }

    if (matchedMails.length > 0) {
      html += `<div class="spotlight-group-title">匹配收信 (${matchedMails.length})</div>`;
      html += matchedMails.map(m => `
        <div class="spotlight-item" onclick="closeSpotlight();openMailDetail(${m.id})">
          <div class="spotlight-item-left">
            <span>📬</span>
            <div>
              <div class="spotlight-item-title">${m.subject || '(无主题)'} ${m.verification_code ? `<span class="code-badge">${m.verification_code}</span>` : ''}</div>
              <div class="spotlight-item-sub">至: ${m.recipient} · 来自: ${m.sender}</div>
            </div>
          </div>
          <button class="btn-sm btn-secondary">查看</button>
        </div>
      `).join('');
    }

    dom.spotlightResults.innerHTML = html;
  }

  function renderSpotlightItem(acc) {
    return `
      <div class="spotlight-item" onclick="closeSpotlight();editVaultRecord(${acc.id})">
        <div class="spotlight-item-left">
          ${getBrandAvatar(acc.platform_name)}
          <div>
            <div class="spotlight-item-title">
              ${acc.platform_name}
              ${acc.last_code ? `<span class="code-badge" style="font-size:11px;padding:1px 4px;">${acc.last_code}</span>` : ''}
            </div>
            <div class="spotlight-item-sub">${acc.account_email}</div>
          </div>
        </div>
        <div class="spotlight-item-actions" onclick="event.stopPropagation()">
          <button class="btn-sm btn-secondary" onclick="copyText('${acc.account_email}', '邮箱')">复制邮箱</button>
          ${acc.password ? `<button class="btn-sm btn-secondary" onclick="copyText('${acc.password}', '密码')">复制密码</button>` : ''}
          <button class="btn-sm btn-primary" onclick="closeSpotlight();fetchPlatformCode(${acc.id})">⚡ 提取码</button>
        </div>
      </div>
    `;
  }

  // ==================== 3. 自建域名收信模块 (海量邮箱优化) ====================
  async function loadCfMails() {
    try {
      // 1. 加载收件地址列表
      const searchAddress = dom.recipientSearchInput.value.trim();
      const recRes = await api(`/api/cf-mails/recipients?q=${encodeURIComponent(searchAddress)}`);
      if (recRes.success) {
        state.recipients = recRes.data || [];
        renderRecipients();
      }

      // 2. 加载邮件列表
      const q = encodeURIComponent(dom.mailSearchInput.value);
      const recipient = encodeURIComponent(state.selectedRecipient);
      const res = await api(`/api/cf-mails?recipient=${recipient}&q=${q}`);
      if (res.success) {
        state.cfMails = res.data || [];
        renderMailList();
      }
    } catch (e) {}
  }

  function renderRecipients() {
    let totalCount = 0;
    const itemsHtml = state.recipients.map(r => {
      totalCount += r.mail_count;
      const isAct = state.selectedRecipient === r.recipient ? 'active' : '';
      const unreadBadge = r.unread_count > 0 ? `<span class="recipient-unread-badge">${r.unread_count}</span>` : '';
      return `
        <div class="recipient-item ${isAct}" onclick="filterRecipient('${r.recipient}')">
          <span class="recipient-name" title="${r.recipient}">${r.recipient}</span>
          <div style="display:flex;align-items:center;gap:4px;">
            ${unreadBadge}
            <span class="badge">${r.mail_count}</span>
            <span class="btn-link" onclick="event.stopPropagation();copyText('${r.recipient}', '邮箱')" title="复制此邮箱">📋</span>
          </div>
        </div>
      `;
    }).join('');

    dom.recipientTotalCount.textContent = state.recipients.length;
    dom.totalRecipientCount.textContent = totalCount;
    dom.recipientList.innerHTML = `
      <div class="recipient-item ${state.selectedRecipient === '' ? 'active' : ''}" onclick="filterRecipient('')">
        <span class="recipient-name">全部收件箱</span>
        <span class="badge">${totalCount}</span>
      </div>
      ${itemsHtml}
    `;
  }

  window.filterRecipient = function (email) {
    state.selectedRecipient = email;
    dom.currentRecipientDisplay.textContent = email ? `当前查看: ${email}` : '当前查看: 全部收件箱';
    loadCfMails();
  };

  dom.recipientSearchInput.addEventListener('input', debounce(() => {
    loadCfMails();
  }, 250));

  function renderMailList() {
    if (state.cfMails.length === 0) {
      dom.mailListContainer.innerHTML = '<div class="empty-state py-4 text-center text-muted">当前收件箱为空</div>';
      return;
    }

    dom.mailListContainer.innerHTML = state.cfMails.map(m => {
      const dkimBadge = m.dkim_status === 'pass'
        ? '<span class="tag tag-active" title="DKIM 验证通过，官方真实邮件">🛡️ 已验真</span>'
        : '';

      const codeBadge = m.verification_code
        ? `<div class="code-badge" onclick="event.stopPropagation();copyText('${m.verification_code}', '验证码')">
             <span>${m.verification_code}</span>
             <span class="code-copy-btn">📋</span>
           </div>`
        : '';

      return `
        <div class="mail-item" onclick="openMailDetail(${m.id})">
          <div class="mail-item-left">
            <div class="mail-subject">${m.subject || '(无主题)'} ${dkimBadge}</div>
            <div class="mail-sender">发件人: ${m.sender_name ? `${m.sender_name} &lt;${m.sender}&gt;` : m.sender} ➔ 至: <code>${m.recipient}</code></div>
          </div>
          <div class="mail-item-right">
            ${codeBadge}
            <span class="mail-time">${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  window.openMailDetail = async function (id) {
    const res = await api(`/api/cf-mails/${id}`);
    if (!res.success || !res.data) return;
    const m = res.data;

    dom.mailModalSubject.textContent = m.subject || '(无主题)';
    dom.mailModalMeta.innerHTML = `
      <div style="font-size:13px;color:var(--text-muted);padding:8px 0;border-bottom:1px solid var(--border-color);margin-bottom:12px;">
        <div><b>发件人:</b> ${m.sender_name ? `${m.sender_name} (${m.sender})` : m.sender}</div>
        <div><b>收件人:</b> <code>${m.recipient}</code></div>
        <div><b>接收时间:</b> ${m.created_at}</div>
        ${m.verification_code ? `<div style="margin-top:6px;"><b>智能识别验证码:</b> <span class="code-badge">${m.verification_code}</span> <button class="btn-link" onclick="copyText('${m.verification_code}', '验证码')">一键复制</button></div>` : ''}
      </div>
    `;

    if (m.html_content) {
      dom.mailIframeSandbox.style.display = 'block';
      dom.mailTextFallback.style.display = 'none';
      dom.mailIframeSandbox.srcdoc = m.html_content;
    } else {
      dom.mailIframeSandbox.style.display = 'none';
      dom.mailTextFallback.style.display = 'block';
      dom.mailTextFallback.textContent = m.text_content || '(邮件内容为空)';
    }

    dom.mailViewModal.classList.add('show');
  };

  dom.cleanUnprotectedMailsBtn.addEventListener('click', async () => {
    if (!confirm('确认清理未绑定平台账号的临时测试邮件吗？（已绑定平台的邮件将受保护不被清理）')) return;
    const res = await api('/api/cf-mails/clean', { method: 'POST' });
    if (res.success) {
      showToast(res.message);
      loadCfMails();
      loadStats();
    }
  });

  // ==================== 4. Outlook 矩阵模块 ====================
  async function loadOutlookData() {
    try {
      const res = await api('/api/outlook/accounts');
      if (res.success) {
        state.outlookAccounts = res.data || [];
        renderOutlookTable();
      }
    } catch (e) {}
  }

  function renderOutlookTable() {
    if (state.outlookAccounts.length === 0) {
      dom.outlookTableBody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-muted">暂无 Outlook 账号，点击右上角添加</td></tr>';
      return;
    }

    dom.outlookTableBody.innerHTML = state.outlookAccounts.map(a => `
      <tr>
        <td><strong>${a.email}</strong></td>
        <td><code>${a.client_id.substring(0, 8)}...</code></td>
        <td><span class="tag tag-category">${a.group_name || '默认'}</span></td>
        <td><span class="tag tag-active">${a.status}</span></td>
        <td>${a.remark || '-'}</td>
        <td>${new Date(a.created_at).toLocaleDateString()}</td>
        <td>
          <button class="btn-sm btn-outline text-danger" onclick="deleteOutlookAccount(${a.id})">删除</button>
        </td>
      </tr>
    `).join('');
  }

  window.deleteOutlookAccount = async function (id) {
    if (!confirm('确定删除该 Outlook 账号？')) return;
    const res = await api(`/api/outlook/accounts/${id}`, { method: 'DELETE' });
    if (res.success) {
      showToast('已删除');
      loadOutlookData();
    }
  };

  dom.outlookForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      email: document.getElementById('outlookEmailInput').value.trim(),
      client_id: document.getElementById('outlookClientIdInput').value.trim(),
      refresh_token: document.getElementById('outlookRefreshTokenInput').value.trim(),
      password: document.getElementById('outlookPasswordInput').value.trim(),
      remark: document.getElementById('outlookRemarkInput').value.trim()
    };
    const res = await api('/api/outlook/accounts', { method: 'POST', body: payload });
    if (res.success) {
      showToast('Outlook 账号已添加');
      dom.outlookModal.classList.remove('show');
      loadOutlookData();
    } else {
      alert(res.message || '添加失败');
    }
  });

  // ==================== 5. 设置模块 ====================
  async function loadSettings() {
    try {
      const res = await api('/api/settings');
      if (res.success && res.data) {
        state.systemSettings = res.data;
        dom.cfDomainsDisplay.textContent = res.data.env_cf_domains || '439949.xyz';
      }
    } catch (e) {}
  }

  dom.saveAdminPasswordBtn.addEventListener('click', async () => {
    const pwd = dom.newAdminPasswordInput.value.trim();
    if (!pwd || pwd.length < 6) return alert('密码至少 6 位');
    const res = await api('/api/settings/password', { method: 'POST', body: { new_password: pwd } });
    if (res.success) {
      showToast('密码修改成功');
      dom.newAdminPasswordInput.value = '';
    } else {
      alert(res.message || '修改失败');
    }
  });

  // 加载统计看板
  async function loadStats() {
    try {
      const res = await api('/api/vault/stats');
      if (res.success && res.data) {
        dom.statTotalVault.textContent = res.data.total_vault_accounts || 0;
        dom.statActiveVault.textContent = res.data.active_vault_accounts || 0;
        dom.statCfMails.textContent = res.data.total_cf_mails || 0;
        dom.statOutlook.textContent = res.data.total_outlook_accounts || 0;
        dom.cfMailCountBadge.textContent = res.data.total_cf_mails || 0;
      }
    } catch (e) {}
  }

  // ==================== 全局弹窗与事件绑定 ====================
  document.querySelectorAll('.modal-close, .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('show'));
    });
  });

  dom.openNewVaultModalBtn.addEventListener('click', () => {
    dom.vaultModalTitle.textContent = '登记平台账号';
    dom.vaultForm.reset();
    dom.vaultEditId.value = '';
    dom.vaultModal.classList.add('show');
  });

  dom.addOutlookModalBtn.addEventListener('click', () => {
    dom.outlookForm.reset();
    dom.outlookModal.classList.add('show');
  });

  let debounceTimer;
  function debounce(fn, ms = 300) {
    return (...args) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fn(...args), ms);
    };
  }

  dom.vaultSearchInput.addEventListener('input', debounce(loadVaultData));
  dom.vaultCategoryFilter.addEventListener('change', loadVaultData);
  dom.vaultStatusFilter.addEventListener('change', loadVaultData);
  dom.mailSearchInput.addEventListener('input', debounce(loadCfMails));
  dom.refreshMailsBtn.addEventListener('click', loadCfMails);

  // 登录表单
  dom.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    dom.loginErrorMsg.style.display = 'none';
    const pwd = dom.loginPasswordInput.value;
    const res = await api('/api/auth/login', { method: 'POST', body: { password: pwd } });
    if (res.success) {
      showLogin(false);
      initApp();
    } else {
      dom.loginErrorMsg.textContent = res.message || '密码错误';
      dom.loginErrorMsg.style.display = 'block';
    }
  });

  dom.logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    showLogin(true);
  });

  dom.themeToggleBtn.addEventListener('click', toggleTheme);

  document.querySelectorAll('.nav-tab').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // 启动应用
  async function initApp() {
    initTheme();
    try {
      await loadStats();
      await loadSettings();
      await loadPlatformSummary();
      switchTab('vault');
    } catch (e) {}
  }

  initApp();
})();
