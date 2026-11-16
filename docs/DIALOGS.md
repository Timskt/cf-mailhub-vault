# 弹窗布局与验收约定

## 2026-11-15 修复依据

浏览器复现显示，Outlook 收件窗口原本声明的 1120px 宽度被 `DialogContent` 的 `sm:max-w-sm` 覆盖，实际宽度只有 384px。固定宽度的邮件列表占用 310px 后，正文栏只剩 42px。`grid`、`gap-4` 和 `p-4` 也覆盖了阅读器在 `@layer components` 中声明的布局。

普通弹窗有相同的宽度、内边距冲突；整个弹窗滚动会把标题和关闭按钮移出视野。表单的 `FieldGroup` 默认 `flex` 覆盖了双列网格；新增数据源的按钮区域引用了没有定义的 `dialog-actions`。

修复使用共享 Dialog 结构和同一层级的 Tailwind 类合并，不使用额外的遮罩 z-index 或 `!important` 覆盖。

再次反馈后确认：容器尺寸正确不代表内容排版正确。已补上错误卡片与列表的内边距、独立重试按钮、表单内联错误及完整提交/重试流程。逐入口操作记录见 [UI-AUDIT.md](UI-AUDIT.md)。

## 组件组合

`DialogContent` 提供有边距的居中容器，普通宽度 512px，最大高度为 `100dvh - 2rem`。`Modal wide` 使用 768px，域名邮件详情使用 896px，Outlook 工作区使用 1120px。屏幕不足时统一保留左右各 16px 的空间。

普通业务弹窗使用 `Modal`、`ModalBody`、`ModalFooter`：

```tsx
<Modal title="编辑记录" description="填写信息后保存。" close={close}>
  <form className="modal-form" onSubmit={save}>
    <ModalBody>
      <FieldGroup>{/* 输入控件 */}</FieldGroup>
    </ModalBody>
    <ModalFooter>
      <Button type="button" variant="outline" onClick={close}>
        取消
      </Button>
      <BusyButton type="submit" busy={busy}>
        保存
      </BusyButton>
    </ModalFooter>
  </form>
</Modal>
```

- 标题与关闭按钮在内容区之外；`ModalFooter` 在滚动区之外。
- 长表单使用 `.modal-form`，设置 `min-height: 0` 并参与容器的 flex 高度分配。
- `ModalBody` 是定位容器，防止 Radix 隐藏的原生 select 控件把溢出传播到弹窗外框。
- 双列表单直接在 `FieldGroup` 上传 `grid grid-cols-1 gap-5 sm:grid-cols-2`，使 `cn` 能移除冲突的默认类。不要通过低优先级 CSS 类覆盖已有组件的布局工具类。
- 普通正文子元素保持自身高度；全局搜索显式允许 Command 收缩，仅由结果列表滚动。
- 文本框限制最大高度；超长文本换行，附件名称截断但保留下载操作。长 DNS 域名放在正文，避免占满固定标题区。
- 表单内的非提交按钮使用 `type="button"`，包含公用 `IconButton`。
- 保留 Radix 的嵌套弹窗、焦点限制与遮罩处理。手机导航初始聚焦导航链接，提供可见关闭按钮。
- 表单使用 `useAction({ inline: true })`，在 `ModalBody` 中放置 `ActionError`。失败后保留输入，错误内容参与正文滚动，不能用浮动提示覆盖操作区。
- `ErrorState` 中错误正文和重试按钮独立排布；阅读器调用处提供面板内边距。长错误使用 `overflow-wrap:anywhere`，不会把列宽撑开。
- 打开弹窗时清理已有通知；弹窗中的复制操作使用 `CopyButton` / `CopyAction` 就地反馈成功或失败。
- 附件先检查请求状态，再下载成功响应；错误留在阅读器内，避免把错误 JSON 当成附件保存。

Outlook 阅读器使用固定标题、可独立滚动的列表与正文。手机上切换列表和正文；返回按钮位于正文滚动区之外，切换邮件重置正文滚动位置。HTML 邮件仍使用原有清理和 sandbox 隔离。

## 检查清单

| 业务区域     | 已覆盖的弹窗与状态                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Outlook 收件 | 列表、正文、空列表、错误、长主题、长发件人、长附件名、移动端返回                               |
| 验证码       | 正常结果、筛选表单、无结果、加载中、错误、长结果、阅读器之上的嵌套窗口                         |
| Outlook 管理 | 手动添加、编辑凭据、长 Token、导入、20 行导入预览、分组、标签编辑、批量移动、批量添加/移除标签 |
| 平台账号     | 登记、编辑、恢复备份、移动端原生必填校验                                                       |
| 域名与邮件   | 添加/编辑域名、接入指引、长 DNS 记录、生成邮箱、邮件详情与邮件头信息                           |
| 数据源       | 添加数据库实例、连接设置                                                                       |
| 共享浮层     | 全局搜索空状态与结果、独立/嵌套删除确认、弹窗内选择器、手机导航抽屉                            |

常规视口：1440×1000、768×1024、375×667、844×390。另检查 320×568 小屏、375×400 表单校验，以及 667×375 导航抽屉。浅色覆盖各业务区域，深色检查邮件阅读器和验证码弹窗，包括原生滚动条配色。

尺寸检查包括容器位于视口内、无横向溢出、正文可滚动、滚动时标题和操作栏位置不变、关闭按钮与底部操作可见。交互检查包括 Tab 焦点限制、Esc 只关闭当前层、返回列表、表单错误字段滚入视野、解除页面锁定和全局搜索单一滚动区。代表性截图经过实际查看。

本地 Playwright CLI 脚本、结果 JSON 和截图在 Git 忽略的 `output/playwright/modal-*`。使用虚构数据及模拟微软响应，浏览器为 Chromium；没有将结果外推为真实手机 Safari/WebKit 或真实微软网络联调结论。
