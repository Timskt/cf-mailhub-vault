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
    outlookFilterQuery: '',
    parsedBatchAccounts: [],
    systemSettings: {},

    // 临时邮箱工作台状态
    activeMailbox: null,
    tempMailboxes: [],
    tempMailboxFilter: 'all',
    tempMails: [],
    countdownInterval: null,
    tempPollInterval: null,
    currentViewingMail: null
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

    // 临时邮箱工作台
    activeMailboxBadge: document.getElementById('activeMailboxBadge'),
    activeMailboxAddress: document.getElementById('activeMailboxAddress'),
    activeMailboxExpiresBadge: document.getElementById('activeMailboxExpiresBadge'),
    btnCopyActiveMailbox: document.getElementById('btnCopyActiveMailbox'),
    btnExtendMailbox: document.getElementById('btnExtendMailbox'),
    btnTogglePermanent: document.getElementById('btnTogglePermanent'),
    btnQuickRegisterFromTemp: document.getElementById('btnQuickRegisterFromTemp'),
    btnRegenerateMailbox: document.getElementById('btnRegenerateMailbox'),
    customTempPrefixInput: document.getElementById('customTempPrefixInput'),
    customTempDomainSelect: document.getElementById('customTempDomainSelect'),
    customTempDurationSelect: document.getElementById('customTempDurationSelect'),
    btnCreateCustomTempMailbox: document.getElementById('btnCreateCustomTempMailbox'),
    tempInboxListContainer: document.getElementById('tempInboxListContainer'),
    refreshTempInboxBtn: document.getElementById('refreshTempInboxBtn'),
    tempMailboxFilterTip: document.getElementById('tempMailboxFilterTip'),
    tempMailboxesTableBody: document.getElementById('tempMailboxesTableBody'),
    mbTotalCount: document.getElementById('mbTotalCount'),
    mbActiveCount: document.getElementById('mbActiveCount'),
    mbPermanentCount: document.getElementById('mbPermanentCount'),
    mbExpiredCount: document.getElementById('mbExpiredCount'),

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
    mailIframeContainer: document.getElementById('mailIframeContainer'),
    mailTextFallback: document.getElementById('mailTextFallback'),
    mailRawFallback: document.getElementById('mailRawFallback'),

    // 阅读器新元素
    mailSenderAvatar: document.getElementById('mailSenderAvatar'),
    mailSenderName: document.getElementById('mailSenderName'),
    mailSenderEmail: document.getElementById('mailSenderEmail'),
    mailRecipientAddress: document.getElementById('mailRecipientAddress'),
    mailModalTime: document.getElementById('mailModalTime'),
    mailSecurityBadges: document.getElementById('mailSecurityBadges'),
    mailHeroCodeBanner: document.getElementById('mailHeroCodeBanner'),
    mailHeroCodeVal: document.getElementById('mailHeroCodeVal'),
    copyHeroCodeBtn: document.getElementById('copyHeroCodeBtn'),
    openHeroLinkBtn: document.getElementById('openHeroLinkBtn'),
    mailQuickRegisterBtn: document.getElementById('mailQuickRegisterBtn'),
    mailCopyBodyBtn: document.getElementById('mailCopyBodyBtn'),
    mailDeleteBtn: document.getElementById('mailDeleteBtn'),

    // Outlook 元素
    outlookTableBody: document.getElementById('outlookTableBody'),
    addOutlookModalBtn: document.getElementById('addOutlookModalBtn'),
    batchOutlookModalBtn: document.getElementById('batchOutlookModalBtn'),
    batchOutlookModal: document.getElementById('batchOutlookModal'),
    batchOutlookTextarea: document.getElementById('batchOutlookTextarea'),
    btnFillBatchSample: document.getElementById('btnFillBatchSample'),
    btnClearBatchInput: document.getElementById('btnClearBatchInput'),
    batchLineCountIndicator: document.getElementById('batchLineCountIndicator'),
    batchValidCount: document.getElementById('batchValidCount'),
    batchInvalidCount: document.getElementById('batchInvalidCount'),
    batchSyncVaultCheckbox: document.getElementById('batchSyncVaultCheckbox'),
    batchPreviewCount: document.getElementById('batchPreviewCount'),
    batchPreviewTableBody: document.getElementById('batchPreviewTableBody'),
    btnSubmitBatchImport: document.getElementById('btnSubmitBatchImport'),
    batchSubmitBtnCount: document.getElementById('batchSubmitBtnCount'),
    batchSubmitStatusTip: document.getElementById('batchSubmitStatusTip'),
    outlookSearchInput: document.getElementById('outlookSearchInput'),
    outlookTotalCountBadge: document.getElementById('outlookTotalCountBadge'),
    refreshOutlookBtn: document.getElementById('refreshOutlookBtn'),
    outlookModal: document.getElementById('outlookModal'),
    outlookForm: document.getElementById('outlookForm'),

    // 设置元素
    cfDomainsDisplay: document.getElementById('cfDomainsDisplay'),
    defaultPrefixDisplay: document.getElementById('defaultPrefixDisplay'),
    apiKeyDisplay: document.getElementById('apiKeyDisplay'),
    copyApiKeyBtn: document.getElementById('copyApiKeyBtn'),
    loginSubmitBtn: document.getElementById('loginSubmitBtn'),
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
      if (path === '/api/auth/login') {
        const errData = await res.json().catch(() => ({}));
        return { success: false, message: errData.message || '密码错误，请重新输入（默认: Admin8888Password）' };
      }
      showLogin(true);
      return { success: false, error: 'UNAUTHORIZED' };
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

    if (tabName !== 'temp-mail') {
      if (state.tempPollInterval) clearInterval(state.tempPollInterval);
    }

    if (tabName === 'vault') {
      loadPlatformSummary();
      loadVaultData();
    } else if (tabName === 'temp-mail') {
      loadTempMailPage();
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

  // ==================== 1.5 临时邮箱工作台与生命周期管理 ====================
  async function loadTempMailPage() {
    initTempDomains();
    await loadActiveMailbox();
    await loadTempMailboxesList();
  }

  function initTempDomains() {
    if (!dom.customTempDomainSelect) return;
    const raw = (state.systemSettings.env_cf_domains || '439949.xyz');
    const domains = raw.split(',').map(d => d.trim()).filter(Boolean);
    dom.customTempDomainSelect.innerHTML = domains.map(d => `<option value="${d}">${d}</option>`).join('');
  }

  // 加载当前活跃临时邮箱（优先选择未过期的临时邮箱，若无则自动生成 1 个默认 1 小时的）
  async function loadActiveMailbox() {
    try {
      const res = await api('/api/mailboxes?status=all');
      if (res.success && Array.isArray(res.data) && res.data.length > 0) {
        const found = res.data.find(m => !m.is_expired) || res.data[0];
        setActiveMailbox(found);
      } else {
        await generateNewTempMailbox({ duration_minutes: 60, is_permanent: false });
      }
    } catch (e) {
      console.error(e);
    }
  }

  function setActiveMailbox(mb) {
    state.activeMailbox = mb;
    renderActiveMailbox();
    startCountdown();
    if (mb && mb.address) {
      loadTempMailboxInbox(mb.address);
      startTempInboxPolling(mb.address);
    }
  }

  function renderActiveMailbox() {
    const mb = state.activeMailbox;
    if (!mb) {
      if (dom.activeMailboxAddress) dom.activeMailboxAddress.textContent = '暂无活跃邮箱，请点击生成';
      if (dom.activeMailboxExpiresBadge) dom.activeMailboxExpiresBadge.textContent = '未分配';
      return;
    }

    if (dom.activeMailboxAddress) dom.activeMailboxAddress.textContent = mb.address;
    if (dom.tempMailboxFilterTip) {
      dom.tempMailboxFilterTip.textContent = `收件监听: ${mb.address}`;
    }

    updateExpiresBadge();
  }

  function updateExpiresBadge() {
    const mb = state.activeMailbox;
    if (!mb || !dom.activeMailboxExpiresBadge) return;

    if (mb.is_permanent) {
      dom.activeMailboxExpiresBadge.className = 'expires-countdown-badge permanent';
      dom.activeMailboxExpiresBadge.textContent = '♾️ 永久保留';
      if (dom.btnTogglePermanent) dom.btnTogglePermanent.textContent = '⏱️ 取消永久';
      return;
    }

    if (dom.btnTogglePermanent) dom.btnTogglePermanent.textContent = '♾️ 设为永久';

    if (mb.is_expired || mb.remaining_seconds <= 0) {
      dom.activeMailboxExpiresBadge.className = 'expires-countdown-badge';
      dom.activeMailboxExpiresBadge.style.color = 'var(--apple-red)';
      dom.activeMailboxExpiresBadge.textContent = '⚠️ 已过期 (点击延长)';
    } else {
      dom.activeMailboxExpiresBadge.className = 'expires-countdown-badge';
      dom.activeMailboxExpiresBadge.style.color = '';
      const m = Math.floor(mb.remaining_seconds / 60);
      const s = mb.remaining_seconds % 60;
      dom.activeMailboxExpiresBadge.textContent = `⏱️ 倒计时 ${m}分${s < 10 ? '0' : ''}${s}秒`;
    }
  }

  function startCountdown() {
    if (state.countdownInterval) clearInterval(state.countdownInterval);
    state.countdownInterval = setInterval(() => {
      const mb = state.activeMailbox;
      if (!mb || mb.is_permanent) return;
      if (mb.remaining_seconds > 0) {
        mb.remaining_seconds--;
        updateExpiresBadge();
      } else {
        mb.is_expired = true;
        updateExpiresBadge();
      }
    }, 1000);
  }

  // 专属实时收件箱流
  async function loadTempMailboxInbox(address) {
    if (!address) return;
    try {
      const res = await api(`/api/emails/list?address=${encodeURIComponent(address)}`);
      if (res && Array.isArray(res.emails)) {
        state.tempMails = res.emails;
        renderTempInboxList();
      }
    } catch (e) {}
  }

  function startTempInboxPolling(address) {
    if (state.tempPollInterval) clearInterval(state.tempPollInterval);
    state.tempPollInterval = setInterval(() => {
      if (state.currentTab === 'temp-mail' && state.activeMailbox && state.activeMailbox.address === address) {
        loadTempMailboxInbox(address);
      }
    }, 4000);
  }

  function renderTempInboxList() {
    if (!dom.tempInboxListContainer) return;
    if (state.tempMails.length === 0) {
      dom.tempInboxListContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <div class="empty-title">等待邮件到达中...</div>
          <div class="empty-subtitle">使用上方临时邮箱在平台注册，新邮件将在几秒内自动展示并秒级提取验证码</div>
        </div>
      `;
      return;
    }

    dom.tempInboxListContainer.innerHTML = state.tempMails.map(m => {
      const codeBadge = m.verify_code
        ? `<div class="code-badge" onclick="event.stopPropagation();copyText('${m.verify_code}', '验证码')">
             <span>${m.verify_code}</span>
             <span class="code-copy-btn">📋</span>
           </div>`
        : '';

      const dkimBadge = m.dkim_verified === '通过'
        ? '<span class="tag tag-active">🛡️ 已验真</span>'
        : '';

      return `
        <div class="mail-item" onclick="openMailDetail(${m.id})">
          <div class="mail-item-left">
            <div class="mail-subject">${m.subject || '(无主题)'} ${dkimBadge}</div>
            <div class="mail-sender">来自: <code>${m.from}</code> ➔ 至: <code>${m.to}</code></div>
          </div>
          <div class="mail-item-right">
            ${codeBadge}
            <span class="mail-time">${new Date(m.received_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // 临时邮箱全生命周期台账
  async function loadTempMailboxesList() {
    try {
      const res = await api(`/api/mailboxes?status=${state.tempMailboxFilter}`);
      if (res.success && Array.isArray(res.data)) {
        state.tempMailboxes = res.data;
        renderTempMailboxesTable();

        // 更新计数
        const allRes = await api('/api/mailboxes?status=all');
        if (allRes.success && Array.isArray(allRes.data)) {
          const all = allRes.data;
          if (dom.mbTotalCount) dom.mbTotalCount.textContent = all.length;
          if (dom.mbActiveCount) dom.mbActiveCount.textContent = all.filter(x => !x.is_expired && !x.is_permanent).length;
          if (dom.mbPermanentCount) dom.mbPermanentCount.textContent = all.filter(x => x.is_permanent).length;
          if (dom.mbExpiredCount) dom.mbExpiredCount.textContent = all.filter(x => x.is_expired).length;
        }
      }
    } catch (e) {}
  }

  function renderTempMailboxesTable() {
    if (!dom.tempMailboxesTableBody) return;
    if (state.tempMailboxes.length === 0) {
      dom.tempMailboxesTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">暂无符合条件的临时邮箱记录</td></tr>';
      return;
    }

    dom.tempMailboxesTableBody.innerHTML = state.tempMailboxes.map(mb => {
      let statusHtml = '';
      if (mb.is_permanent) {
        statusHtml = '<span class="mb-status-pill mb-status-permanent">♾️ 永久有效</span>';
      } else if (mb.is_expired) {
        statusHtml = '<span class="mb-status-pill mb-status-expired">⚪ 已过期</span>';
      } else {
        const mins = Math.ceil(mb.remaining_seconds / 60);
        statusHtml = `<span class="mb-status-pill mb-status-active">🟢 剩余 ${mins} 分钟</span>`;
      }

      const platHtml = mb.associated_platform
        ? `<span class="tag tag-category">🏢 ${mb.associated_platform}</span>`
        : `<button class="btn-sm btn-link" onclick="quickRegisterSpecificMailbox('${mb.address}')">➕ 关联平台</button>`;

      return `
        <tr>
          <td>${statusHtml}</td>
          <td>
            <div class="email-address-wrapper">
              <span class="email-text"><b>${mb.address}</b></span>
              <button class="btn-icon btn-sm" title="复制邮箱" onclick="copyText('${mb.address}', '邮箱')">📋</button>
            </div>
          </td>
          <td>${platHtml}</td>
          <td>
            <button class="btn-sm btn-secondary" onclick="switchToMailbox('${mb.address}')">
              📬 ${mb.mail_count || 0} 封
            </button>
          </td>
          <td><span class="text-muted text-sm">${new Date(mb.created_at).toLocaleDateString()}</span></td>
          <td>
            <div style="display:flex;gap:4px;">
              <button class="btn-sm btn-secondary" onclick="extendSpecificMailbox(${mb.id})" title="延长60分钟">⏱️ +1h</button>
              <button class="btn-sm btn-secondary" onclick="togglePermanentSpecificMailbox(${mb.id})">
                ${mb.is_permanent ? '取消永久' : '设为永久'}
              </button>
              <button class="btn-sm btn-outline text-danger" onclick="deleteSpecificMailbox(${mb.id})" title="销毁">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.switchToMailbox = function(address) {
    const found = state.tempMailboxes.find(m => m.address === address);
    if (found) {
      setActiveMailbox(found);
      showToast(`已切换至邮箱: ${address}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  window.extendSpecificMailbox = async function(id) {
    const res = await api(`/api/mailboxes/${id}/extend`, { method: 'POST', body: { minutes: 60 } });
    if (res.success) {
      showToast(res.message);
      await loadActiveMailbox();
      await loadTempMailboxesList();
    }
  };

  window.togglePermanentSpecificMailbox = async function(id) {
    const res = await api(`/api/mailboxes/${id}/toggle-permanent`, { method: 'POST' });
    if (res.success) {
      showToast(res.message);
      await loadActiveMailbox();
      await loadTempMailboxesList();
    }
  };

  window.deleteSpecificMailbox = async function(id) {
    if (!confirm('确认销毁该临时邮箱吗？')) return;
    const res = await api(`/api/mailboxes/${id}`, { method: 'DELETE' });
    if (res.success) {
      showToast('已销毁该邮箱');
      await loadActiveMailbox();
      await loadTempMailboxesList();
    }
  };

  window.quickRegisterSpecificMailbox = function(email) {
    dom.vaultModalTitle.textContent = '登记平台账号';
    dom.vaultForm.reset();
    dom.vaultEditId.value = '';
    dom.vaultEmailInput.value = email;
    dom.vaultEmailSourceSelect.value = 'cf_domain';
    dom.vaultModal.classList.add('show');
  };

  async function generateNewTempMailbox(options = {}) {
    const res = await api('/api/mailboxes/generate', { method: 'POST', body: options });
    if (res.success && res.data) {
      showToast(res.message || '临时邮箱已生成');
      setActiveMailbox(res.data);
      loadTempMailboxesList();
    } else {
      alert(res.message || '生成失败');
    }
  }

  // 临时邮箱工作台按钮事件
  if (dom.btnCopyActiveMailbox) {
    dom.btnCopyActiveMailbox.addEventListener('click', () => {
      if (state.activeMailbox && state.activeMailbox.address) {
        copyText(state.activeMailbox.address, '临时邮箱');
      }
    });
  }

  if (dom.btnExtendMailbox) {
    dom.btnExtendMailbox.addEventListener('click', async () => {
      if (!state.activeMailbox) return;
      await window.extendSpecificMailbox(state.activeMailbox.id);
    });
  }

  if (dom.btnTogglePermanent) {
    dom.btnTogglePermanent.addEventListener('click', async () => {
      if (!state.activeMailbox) return;
      await window.togglePermanentSpecificMailbox(state.activeMailbox.id);
    });
  }

  if (dom.btnRegenerateMailbox) {
    dom.btnRegenerateMailbox.addEventListener('click', async () => {
      await generateNewTempMailbox({ duration_minutes: 60, is_permanent: false });
    });
  }

  if (dom.btnQuickRegisterFromTemp) {
    dom.btnQuickRegisterFromTemp.addEventListener('click', () => {
      if (!state.activeMailbox) return;
      window.quickRegisterSpecificMailbox(state.activeMailbox.address);
    });
  }

  if (dom.btnCreateCustomTempMailbox) {
    dom.btnCreateCustomTempMailbox.addEventListener('click', async () => {
      const prefix = dom.customTempPrefixInput.value.trim();
      const domain = dom.customTempDomainSelect.value;
      const durationVal = parseInt(dom.customTempDurationSelect.value, 10);
      const isPermanent = durationVal <= 0;

      await generateNewTempMailbox({
        prefix,
        domain,
        duration_minutes: isPermanent ? 0 : durationVal,
        is_permanent: isPermanent
      });
      dom.customTempPrefixInput.value = '';
    });
  }

  if (dom.refreshTempInboxBtn) {
    dom.refreshTempInboxBtn.addEventListener('click', () => {
      if (state.activeMailbox) {
        loadTempMailboxInbox(state.activeMailbox.address);
        showToast('已刷新收件箱');
      }
    });
  }

  // 临时邮箱台账过滤切换
  document.querySelectorAll('.mb-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mb-filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tempMailboxFilter = btn.dataset.filter;
      loadTempMailboxesList();
    });
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
    state.currentViewingMail = m;

    dom.mailModalSubject.textContent = m.subject || '(无主题)';

    // 发件人 Avatar 与姓名
    const senderInitial = (m.sender_name || m.sender || 'M')[0].toUpperCase();
    if (dom.mailSenderAvatar) dom.mailSenderAvatar.textContent = senderInitial;
    if (dom.mailSenderName) dom.mailSenderName.textContent = m.sender_name || m.sender.split('@')[0];
    if (dom.mailSenderEmail) dom.mailSenderEmail.textContent = `<${m.sender}>`;
    if (dom.mailRecipientAddress) dom.mailRecipientAddress.textContent = m.recipient;
    if (dom.mailModalTime) dom.mailModalTime.textContent = new Date(m.created_at).toLocaleString();

    // 安全徽章
    if (dom.mailSecurityBadges) {
      let secHtml = '';
      if (m.spf_status === 'pass') {
        secHtml += '<span class="sec-badge sec-pass">🛡️ SPF 通过</span> ';
      }
      if (m.dkim_status === 'pass') {
        secHtml += '<span class="sec-badge sec-pass">🔑 DKIM 已验真</span> ';
      }
      dom.mailSecurityBadges.innerHTML = secHtml || '<span class="sec-badge text-muted">标准邮件</span>';
    }

    // 验证码与激活链接置顶 Hero Banner
    if (dom.mailHeroCodeBanner) {
      if (m.verification_code || m.verification_link) {
        dom.mailHeroCodeBanner.style.display = 'flex';
        if (dom.mailHeroCodeVal) {
          dom.mailHeroCodeVal.textContent = m.verification_code || '已识别到链接';
        }
        if (dom.copyHeroCodeBtn) {
          dom.copyHeroCodeBtn.style.display = m.verification_code ? 'inline-flex' : 'none';
          dom.copyHeroCodeBtn.onclick = () => copyText(m.verification_code, '验证码');
        }
        if (dom.openHeroLinkBtn) {
          if (m.verification_link) {
            dom.openHeroLinkBtn.style.display = 'inline-flex';
            dom.openHeroLinkBtn.href = m.verification_link;
          } else {
            dom.openHeroLinkBtn.style.display = 'none';
          }
        }
      } else {
        dom.mailHeroCodeBanner.style.display = 'none';
      }
    }

    // 正文视图模式切换
    function setViewMode(mode) {
      document.querySelectorAll('.view-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });

      if (mode === 'html' && m.html_content) {
        dom.mailIframeContainer.style.display = 'block';
        dom.mailTextFallback.style.display = 'none';
        if (dom.mailRawFallback) dom.mailRawFallback.style.display = 'none';
      } else if (mode === 'text' || (!m.html_content && mode === 'html')) {
        dom.mailIframeContainer.style.display = 'none';
        dom.mailTextFallback.style.display = 'block';
        if (dom.mailRawFallback) dom.mailRawFallback.style.display = 'none';
        dom.mailTextFallback.textContent = m.text_content || '(无纯文本正文)';
      } else if (mode === 'raw') {
        dom.mailIframeContainer.style.display = 'none';
        dom.mailTextFallback.style.display = 'none';
        if (dom.mailRawFallback) {
          dom.mailRawFallback.style.display = 'block';
          dom.mailRawFallback.querySelector('code').textContent = 
`Message-ID: ${m.message_id}
From: ${m.sender_name} <${m.sender}>
To: ${m.recipient}
Subject: ${m.subject}
Date: ${m.created_at}
SPF: ${m.spf_status}
DKIM: ${m.dkim_status}
Raw Size: ${m.raw_size || 0} bytes
Verification Code: ${m.verification_code || 'none'}
Verification Link: ${m.verification_link || 'none'}`;
        }
      }
    }

    document.querySelectorAll('.view-mode-btn').forEach(b => {
      b.onclick = () => setViewMode(b.dataset.mode);
    });

    // 默认如果含 html 则渲染 html，否则切到 text
    if (m.html_content) {
      dom.mailIframeContainer.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'mail-iframe';
      iframe.sandbox = 'allow-popups';
      iframe.srcdoc = m.html_content;
      dom.mailIframeContainer.appendChild(iframe);
      setViewMode('html');
    } else {
      setViewMode('text');
    }

    // 工具栏操作绑定
    if (dom.mailCopyBodyBtn) {
      dom.mailCopyBodyBtn.onclick = () => {
        copyText(m.text_content || m.html_content, '邮件正文');
      };
    }

    if (dom.mailQuickRegisterBtn) {
      dom.mailQuickRegisterBtn.onclick = () => {
        dom.mailViewModal.classList.remove('show');
        dom.vaultModalTitle.textContent = '从邮件一键登记平台账号';
        dom.vaultForm.reset();
        dom.vaultEditId.value = '';
        dom.vaultEmailInput.value = m.recipient;
        dom.vaultEmailSourceSelect.value = 'cf_domain';
        dom.vaultRemarkInput.value = `由邮件自动转录（发件人: ${m.sender_name || m.sender}）`;
        // 尝试智能推测平台名称
        let inferredPlat = '';
        const s = (m.sender + ' ' + (m.sender_name || '') + ' ' + (m.subject || '')).toLowerCase();
        if (s.includes('openai') || s.includes('chatgpt')) inferredPlat = 'OpenAI';
        else if (s.includes('claude') || s.includes('anthropic')) inferredPlat = 'Claude';
        else if (s.includes('cursor')) inferredPlat = 'Cursor';
        else if (s.includes('github')) inferredPlat = 'GitHub';
        else if (s.includes('google')) inferredPlat = 'Google';
        if (inferredPlat) dom.vaultPlatformInput.value = inferredPlat;

        dom.vaultModal.classList.add('show');
      };
    }

    if (dom.mailDeleteBtn) {
      dom.mailDeleteBtn.onclick = async () => {
        if (!confirm('确认删除这封邮件吗？')) return;
        const delRes = await api(`/api/cf-mails/${m.id}`, { method: 'DELETE' });
        if (delRes.success) {
          showToast('邮件已删除');
          dom.mailViewModal.classList.remove('show');
          if (dom.mailIframeContainer) dom.mailIframeContainer.innerHTML = '';
          loadCfMails();
          if (state.currentTab === 'temp-mail' && state.activeMailbox) {
            loadTempMailboxInbox(state.activeMailbox.address);
          }
        }
      };
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

  // ==================== 4. Outlook 矩阵模块 (含批量导入与快速提取) ====================
  const DEFAULT_MICROSOFT_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
  const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const SAMPLE_OUTLOOK_LINE = 'MichelenaRosich405@outlook.com----GyehZl1D----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.C530_BAY.0.U.MsaArtifacts.-CsTvkNSQyZO15gg3Y9zBaOF7rO6S96UIPtWl!B46NQfLDo21hCgFzoRaBpmlVjQocldM6P3hZ79wI2qTX5d5kudyd0ROJFo3*du9crhF!cWRNMugPMkRxz1jXpllZiaUkMgnHW5tB07Er2Q3XS7AmMBCLcW!bBoykgpTunTuMBZvWg66NmPvFKm37Ho3DUDLqYAIpa6C4vzBPqeJOoEBfu6o6YQNl5t8LtCuKyfc4YuyXgZIvJHhbYZCM55njBMoYDSV*P2*ep*jZaqkZVfYGNvDwsoLAmBKpxc5L2*PRX8lJuSKWLmJBDnIn9*t1YFqUoBxWDiMKSVYqM7Q2fMDiX81s*VxQp9mluljYP*XuIwLUoNtQdP1PNWTxN!LHHOxfmGODkx5EpGMenIqNPQDgIcRqNnPJ6eFm9Osd666repO1yId7nPsu0gg1vVapRrZkTBbpWuW0XtWDwt*iKCuUUQ$';

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 客户端智能解析单行账号格式
  function parseOutlookLineClient(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        const email = (obj.email || obj.username || obj.mail || '').trim().toLowerCase();
        const password = (obj.password || obj.pwd || '').trim();
        const clientId = (obj.client_id || obj.clientId || DEFAULT_MICROSOFT_CLIENT_ID).trim();
        const refreshToken = (obj.refresh_token || obj.refreshToken || obj.token || '').trim();
        const remark = (obj.remark || obj.note || '').trim();
        const valid = Boolean(email && email.includes('@') && refreshToken);
        return {
          email,
          password,
          client_id: clientId || DEFAULT_MICROSOFT_CLIENT_ID,
          refresh_token: refreshToken,
          remark,
          valid,
          error: !valid ? '缺少邮箱或 Refresh Token' : undefined
        };
      } catch (e) {}
    }

    let parts = [];
    if (trimmed.includes('----')) {
      parts = trimmed.split('----').map(s => s.trim());
    } else if (trimmed.includes('---')) {
      parts = trimmed.split('---').map(s => s.trim());
    } else if (trimmed.includes('::')) {
      parts = trimmed.split('::').map(s => s.trim());
    } else if (trimmed.includes('|')) {
      parts = trimmed.split('|').map(s => s.trim());
    } else if (trimmed.includes('\t')) {
      parts = trimmed.split('\t').map(s => s.trim());
    } else if (trimmed.includes(',') && !trimmed.includes(';')) {
      parts = trimmed.split(',').map(s => s.trim());
    } else {
      parts = trimmed.split(/\s+/).map(s => s.trim());
    }

    parts = parts.filter(Boolean);
    if (parts.length === 0) return null;

    let email = '';
    let password = '';
    let clientId = '';
    let refreshToken = '';
    let remark = '';

    const emailIdx = parts.findIndex(p => EMAIL_REGEX.test(p) || p.includes('@'));
    if (emailIdx !== -1) {
      email = parts[emailIdx].toLowerCase();
      parts.splice(emailIdx, 1);
    }

    const uuidIdx = parts.findIndex(p => UUID_REGEX.test(p));
    if (uuidIdx !== -1) {
      clientId = parts[uuidIdx];
      parts.splice(uuidIdx, 1);
    }

    const tokenIdx = parts.findIndex(p => p.length >= 50 || p.startsWith('M.') || p.includes('MsaArtifacts'));
    if (tokenIdx !== -1) {
      refreshToken = parts[tokenIdx];
      parts.splice(tokenIdx, 1);
    } else if (parts.length > 0) {
      let maxIdx = 0;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].length > parts[maxIdx].length) maxIdx = i;
      }
      if (parts[maxIdx].length > 25) {
        refreshToken = parts[maxIdx];
        parts.splice(maxIdx, 1);
      }
    }

    if (!clientId) {
      clientId = DEFAULT_MICROSOFT_CLIENT_ID;
    }

    if (parts.length > 0) {
      password = parts[0];
      parts.splice(0, 1);
    }
    if (parts.length > 0) {
      remark = parts.join(' | ');
    }

    const valid = Boolean(email && email.includes('@') && refreshToken);
    let error;
    if (!email || !email.includes('@')) {
      error = '未识别到有效邮箱';
    } else if (!refreshToken) {
      error = '未识别到 Refresh Token';
    }

    return {
      email,
      password,
      client_id: clientId,
      refresh_token: refreshToken,
      remark,
      valid,
      error
    };
  }

  // 实时更新批量解析预览
  function updateBatchPreview() {
    const rawText = dom.batchOutlookTextarea ? dom.batchOutlookTextarea.value : '';
    const lines = rawText.split('\n');
    const parsedItems = [];
    let validCount = 0;
    let invalidCount = 0;

    if (dom.batchLineCountIndicator) {
      const activeLineCount = lines.filter(l => l.trim()).length;
      dom.batchLineCountIndicator.textContent = `共 ${activeLineCount} 行有效输入`;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const parsed = parseOutlookLineClient(line);
      if (parsed) {
        if (parsed.valid) {
          validCount++;
        } else {
          invalidCount++;
        }
        parsedItems.push({ ...parsed, lineNum: i + 1 });
      }
    }

    state.parsedBatchAccounts = parsedItems.filter(p => p.valid);

    if (dom.batchValidCount) dom.batchValidCount.textContent = validCount;
    if (dom.batchInvalidCount) dom.batchInvalidCount.textContent = invalidCount;
    if (dom.batchPreviewCount) dom.batchPreviewCount.textContent = parsedItems.length;

    if (dom.btnSubmitBatchImport) {
      dom.btnSubmitBatchImport.disabled = validCount === 0;
      if (dom.batchSubmitBtnCount) {
        dom.batchSubmitBtnCount.textContent = validCount > 0 ? `(${validCount} 个账号)` : '';
      }
    }

    if (!dom.batchPreviewTableBody) return;

    if (parsedItems.length === 0) {
      dom.batchPreviewTableBody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-muted">请在上方粘贴数据，将在此实时预览解析结果</td></tr>';
      return;
    }

    dom.batchPreviewTableBody.innerHTML = parsedItems.map(p => `
      <tr>
        <td class="text-muted">${p.lineNum}</td>
        <td><strong>${escapeHtml(p.email || '-')}</strong></td>
        <td><code>${escapeHtml(p.password ? p.password : '(无密码)')}</code></td>
        <td><code>${escapeHtml(p.client_id ? p.client_id.substring(0, 8) + '...' : '-')}</code></td>
        <td><div class="cell-token-preview" title="${escapeHtml(p.refresh_token)}">${escapeHtml(p.refresh_token ? p.refresh_token.substring(0, 24) + '...' : '-')}</div></td>
        <td>${escapeHtml(p.remark || '-')}</td>
        <td>
          ${p.valid
            ? '<span class="tag tag-active" style="font-size:11px;">✅ 有效</span>'
            : `<span class="tag tag-danger" style="font-size:11px;" title="${escapeHtml(p.error || '')}">⚠️ ${escapeHtml(p.error || '异常')}</span>`
          }
        </td>
      </tr>
    `).join('');
  }

  // 加载 Outlook 列表
  async function loadOutlookData() {
    try {
      const q = state.outlookFilterQuery ? `?q=${encodeURIComponent(state.outlookFilterQuery)}` : '';
      const res = await api(`/api/outlook/accounts${q}`);
      if (res.success) {
        state.outlookAccounts = res.data || [];
        renderOutlookTable();
      }
    } catch (e) {
      console.error(e);
    }
  }

  // 渲染 Outlook 表格
  function renderOutlookTable() {
    if (!dom.outlookTableBody) return;

    if (dom.outlookTotalCountBadge) {
      dom.outlookTotalCountBadge.textContent = `${state.outlookAccounts.length} 个账号`;
    }

    if (state.outlookAccounts.length === 0) {
      dom.outlookTableBody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-muted">暂无 Outlook 账号，点击上方「⚡ 批量导入账号」快速导入</td></tr>';
      return;
    }

    dom.outlookTableBody.innerHTML = state.outlookAccounts.map(a => `
      <tr>
        <td>
          <div class="account-email-cell">
            <strong>${escapeHtml(a.email)}</strong>
            <button type="button" class="btn-sm btn-icon" onclick="copyText('${escapeHtml(a.email)}', '邮箱地址')" title="复制邮箱">📋</button>
          </div>
        </td>
        <td>
          <div class="account-password-cell">
            <span class="pwd-text" id="pwd-val-${a.id}">${a.password ? '••••••••' : '<span class="text-muted">(无)</span>'}</span>
            ${a.password ? `
              <button type="button" class="btn-sm btn-icon" onclick="togglePasswordVisibility(${a.id}, '${escapeHtml(a.password)}')" title="查看/隐藏明文">👁️</button>
              <button type="button" class="btn-sm btn-icon" onclick="copyText('${escapeHtml(a.password)}', '登录密码')" title="复制密码">📋</button>
            ` : ''}
          </div>
        </td>
        <td><code>${escapeHtml(a.client_id ? a.client_id.substring(0, 8) + '...' : '-')}</code></td>
        <td><span class="tag tag-category">${escapeHtml(a.group_name || '默认')}</span></td>
        <td><span class="tag tag-active">🟢 正常</span></td>
        <td>${escapeHtml(a.remark || '-')}</td>
        <td>${a.updated_at ? new Date(a.updated_at).toLocaleDateString() : (a.created_at ? new Date(a.created_at).toLocaleDateString() : '-')}</td>
        <td>
          <div class="account-action-buttons">
            <button type="button" class="btn-sm btn-primary" onclick="testOutlookCode(${a.id}, '${escapeHtml(a.email)}')" title="一键读取最新邮件验证码">⚡ 查收验证码</button>
            <button type="button" class="btn-sm btn-secondary" onclick="copyFullOutlookLine(${a.id})" title="复制配置格式">📋 复制</button>
            <button type="button" class="btn-sm btn-outline text-danger" onclick="deleteOutlookAccount(${a.id})" title="删除账号">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  // 查收最新验证码
  window.testOutlookCode = async function (id, email) {
    if (dom.codeResultModal) dom.codeResultModal.classList.add('show');
    if (dom.codeResultContent) {
      dom.codeResultContent.innerHTML = `
        <div class="loading-spinner">
          <div style="font-size:1.8rem;margin-bottom:0.5rem;">⚡</div>
          <div>正在通过微软 Graph API 连接 ${email} 收件箱并提取验证码...</div>
        </div>
      `;
    }

    try {
      const res = await api(`/api/outlook/accounts/${id}/code`);
      if (res.success && res.data) {
        const d = res.data;
        if (d.code) {
          dom.codeResultContent.innerHTML = `
            <div style="font-size:14px;color:var(--text-muted);">已成功从 Outlook 最新邮件中提取验证码：</div>
            <div class="big-code-display">${d.code}</div>
            <div style="margin-bottom:1rem;">
              <button class="btn btn-primary" onclick="copyText('${d.code}', '验证码')">📋 一键复制验证码</button>
            </div>
            ${d.link ? `<div style="margin-bottom:0.75rem;"><a href="${d.link}" target="_blank" class="btn-link">🔗 打开激活/确认链接 ↗</a></div>` : ''}
            <div style="text-align:left;font-size:12px;color:var(--text-muted);background:var(--bg-tertiary);padding:10px;border-radius:6px;">
              <div><b>发件人:</b> ${escapeHtml(d.sender || '未知')}</div>
              <div><b>主题:</b> ${escapeHtml(d.subject || '无主题')}</div>
              <div><b>时间:</b> ${escapeHtml(d.received_at || '刚刚')}</div>
            </div>
          `;
        } else {
          dom.codeResultContent.innerHTML = `
            <div style="padding:1.5rem 0;color:var(--text-muted);">
              <div style="font-size:2.5rem;margin-bottom:0.5rem;">📭</div>
              <div>${escapeHtml(d.message || '收件箱暂未收到新验证码邮件')}</div>
              <p style="font-size:12px;margin-top:6px;">请在平台点击发送验证码后稍候片刻重试。</p>
            </div>
          `;
        }
      } else {
        dom.codeResultContent.innerHTML = `<div class="error-msg">${escapeHtml(res.message || '查询失败')}</div>`;
      }
    } catch (e) {
      if (dom.codeResultContent) {
        dom.codeResultContent.innerHTML = '<div class="error-msg">网络请求失败，请稍后重试</div>';
      }
    }
  };

  // 复制完整配置单行格式
  window.copyFullOutlookLine = function (id) {
    const acc = state.outlookAccounts.find(a => a.id === id);
    if (!acc) return;
    const line = `${acc.email}----${acc.password || ''}----${acc.client_id}----${acc.refresh_token}${acc.remark ? `----${acc.remark}` : ''}`;
    copyText(line, '完整 Outlook 账号格式');
  };

  // 切换密码明文/暗文
  window.togglePasswordVisibility = function (id, pwd) {
    const el = document.getElementById(`pwd-val-${id}`);
    if (!el) return;
    if (el.textContent === '••••••••') {
      el.textContent = pwd;
    } else {
      el.textContent = '••••••••';
    }
  };

  // 删除 Outlook 账号
  window.deleteOutlookAccount = async function (id) {
    if (!confirm('确定删除该 Outlook 账号？')) return;
    const res = await api(`/api/outlook/accounts/${id}`, { method: 'DELETE' });
    if (res.success) {
      showToast('已删除账号');
      loadOutlookData();
    }
  };

  // 搜索框过滤绑定
  if (dom.outlookSearchInput) {
    dom.outlookSearchInput.addEventListener('input', (e) => {
      state.outlookFilterQuery = e.target.value.trim();
      loadOutlookData();
    });
  }

  // 刷新按钮
  if (dom.refreshOutlookBtn) {
    dom.refreshOutlookBtn.addEventListener('click', () => {
      loadOutlookData();
      showToast('已刷新 Outlook 账号列表');
    });
  }

  // 批量导入弹窗控制
  if (dom.batchOutlookModalBtn) {
    dom.batchOutlookModalBtn.addEventListener('click', () => {
      if (dom.batchOutlookModal) {
        dom.batchOutlookModal.classList.add('show');
        updateBatchPreview();
      }
    });
  }

  if (dom.btnFillBatchSample) {
    dom.btnFillBatchSample.addEventListener('click', () => {
      if (dom.batchOutlookTextarea) {
        dom.batchOutlookTextarea.value = SAMPLE_OUTLOOK_LINE;
        updateBatchPreview();
        showToast('已填入标准导入示例');
      }
    });
  }

  if (dom.btnClearBatchInput) {
    dom.btnClearBatchInput.addEventListener('click', () => {
      if (dom.batchOutlookTextarea) {
        dom.batchOutlookTextarea.value = '';
        updateBatchPreview();
      }
    });
  }

  if (dom.batchOutlookTextarea) {
    dom.batchOutlookTextarea.addEventListener('input', () => {
      updateBatchPreview();
    });
  }

  if (dom.btnSubmitBatchImport) {
    dom.btnSubmitBatchImport.addEventListener('click', async () => {
      if (!state.parsedBatchAccounts || state.parsedBatchAccounts.length === 0) return;
      const syncToVault = dom.batchSyncVaultCheckbox ? dom.batchSyncVaultCheckbox.checked : true;

      dom.btnSubmitBatchImport.disabled = true;
      if (dom.batchSubmitStatusTip) dom.batchSubmitStatusTip.textContent = '正在分批导入数据库...';

      try {
        const res = await api('/api/outlook/batch-import', {
          method: 'POST',
          body: {
            raw_text: dom.batchOutlookTextarea.value,
            accounts: state.parsedBatchAccounts,
            sync_to_vault: syncToVault
          }
        });

        if (res.success) {
          showToast(res.message || `成功导入 ${res.count} 个账号`);
          if (dom.batchOutlookModal) dom.batchOutlookModal.classList.remove('show');
          if (dom.batchOutlookTextarea) dom.batchOutlookTextarea.value = '';
          updateBatchPreview();
          loadOutlookData();
          if (syncToVault) {
            loadVaultData();
            loadPlatformSummary();
          }
        } else {
          alert(res.message || '导入失败');
        }
      } catch (err) {
        alert('网络请求失败，请稍后重试');
      } finally {
        if (dom.btnSubmitBatchImport) dom.btnSubmitBatchImport.disabled = false;
        if (dom.batchSubmitStatusTip) dom.batchSubmitStatusTip.textContent = '';
      }
    });
  }

  // 单个添加表单
  if (dom.outlookForm) {
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
        if (dom.outlookModal) dom.outlookModal.classList.remove('show');
        loadOutlookData();
      } else {
        alert(res.message || '添加失败');
      }
    });
  }

  // ==================== 5. 设置模块 ====================
  async function loadSettings() {
    try {
      const res = await api('/api/settings');
      if (res.success && res.data) {
        state.systemSettings = res.data;
        if (dom.cfDomainsDisplay) dom.cfDomainsDisplay.textContent = res.data.env_cf_domains || '439949.xyz';
        if (dom.defaultPrefixDisplay) dom.defaultPrefixDisplay.textContent = res.data.default_prefix || 'tmp';
        if (dom.apiKeyDisplay) dom.apiKeyDisplay.textContent = res.data.api_key || 'cf_mailhub_api_key_8888';
      }
    } catch (e) {}
  }

  if (dom.copyApiKeyBtn) {
    dom.copyApiKeyBtn.addEventListener('click', () => {
      copyText(dom.apiKeyDisplay ? dom.apiKeyDisplay.textContent : 'cf_mailhub_api_key_8888', 'API Key');
    });
  }

  // 复制代码片段按钮
  document.querySelectorAll('.copy-snippet-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const snippetId = btn.dataset.snippet;
      const el = document.getElementById(snippetId);
      if (el) {
        copyText(el.innerText || el.textContent, 'cURL 示例');
      }
    });
  });

  dom.saveAdminPasswordBtn.addEventListener('click', async () => {
    const pwd = dom.newAdminPasswordInput.value.trim();
    if (!pwd || pwd.length < 6) return alert('密码至少 6 位');
    const res = await api('/api/settings/password', { method: 'POST', body: { new_password: pwd } });
    if (res.success) {
      showToast('密码修改成功，下次登录请使用新密码');
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
      if (dom.mailIframeContainer) dom.mailIframeContainer.innerHTML = '';
    });
  });

  window.addEventListener('click', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('modal-backdrop')) {
      e.target.classList.remove('show');
      if (dom.mailIframeContainer) dom.mailIframeContainer.innerHTML = '';
    }
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

  // 登录表单处理
  dom.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (dom.loginErrorMsg) dom.loginErrorMsg.style.display = 'none';
    if (dom.loginSubmitBtn) {
      dom.loginSubmitBtn.disabled = true;
      dom.loginSubmitBtn.textContent = '正在进入...';
    }
    const pwd = dom.loginPasswordInput.value;
    const res = await api('/api/auth/login', { method: 'POST', body: { password: pwd } });
    if (dom.loginSubmitBtn) {
      dom.loginSubmitBtn.disabled = false;
      dom.loginSubmitBtn.textContent = '进入控制台';
    }

    if (res.success) {
      showLogin(false);
      dom.loginPasswordInput.value = '';
      initApp();
    } else {
      if (dom.loginErrorMsg) {
        dom.loginErrorMsg.textContent = res.message || '密码错误，请重新输入（默认: Admin8888Password）';
        dom.loginErrorMsg.style.display = 'block';
      }
      const card = document.querySelector('.login-card');
      if (card) {
        card.style.animation = 'none';
        void card.offsetWidth;
        card.style.animation = 'appleShake 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
      }
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

  // 启动应用：平滑鉴权，未登录直接停在登录界面，不发送 401 失败请求
  async function initApp() {
    initTheme();
    try {
      const meRes = await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}));
      if (!meRes || !meRes.authenticated) {
        showLogin(true);
        return;
      }
      showLogin(false);
      await loadStats();
      await loadSettings();
      await loadPlatformSummary();
      switchTab('vault');
    } catch (e) {
      showLogin(true);
    }
  }

  initApp();
})();
