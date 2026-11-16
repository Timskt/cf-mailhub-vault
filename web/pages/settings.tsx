import {
  ActionError,
  BusyButton,
  CopyButton,
  Loading,
  PageHeader,
  SelectField,
  TextField,
} from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AuditSettings,
  OneTimeSecret,
  SecuritySettings,
  useSettingsAction,
  useSettingsUnloadGuard,
} from "@/features/security-settings";
import WebhookSettings from "@/features/webhook-settings";
import BackupSettings from "@/features/backup-settings";
import { api, copy } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { useTheme } from "@/lib/theme";
import type { Settings } from "@/lib/types";
import { ArrowUpRight, Copy, ExternalLink, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
export default function SettingsPage() {
  const w = useWorkspace();
  return (
    <>
      <PageHeader
        title="设置"
        description="管理工作区偏好、登录安全和服务连接。"
      />
      <Tabs
        defaultValue="general"
        activationMode="manual"
        className="min-w-0 gap-6 [&>[data-slot=tabs-content]]:min-w-0"
      >
        <div className="max-w-full overflow-x-auto">
          <TabsList aria-label="设置分类">
            <TabsTrigger value="general">工作区</TabsTrigger>
            <TabsTrigger value="security">凭据与密钥</TabsTrigger>
            <TabsTrigger value="events">事件通知</TabsTrigger>
            <TabsTrigger value="audit">操作记录</TabsTrigger>
            <TabsTrigger value="backups">备份恢复</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="general">
          {w.settings ? <SettingsForm settings={w.settings} /> : <Loading />}
        </TabsContent>
        <TabsContent value="security">
          <SecuritySettings />
        </TabsContent>
        <TabsContent value="events">
          <WebhookSettings />
        </TabsContent>
        <TabsContent value="audit">
          <AuditSettings />
        </TabsContent>
        <TabsContent value="backups">
          <BackupSettings />
        </TabsContent>
      </Tabs>
    </>
  );
}
function SettingsForm({ settings }: { settings: Settings }) {
  const w = useWorkspace();
  const { theme, setTheme } = useTheme();
  const [prefix, setPrefix] = useState(settings.default_prefix);
  const [retention, setRetention] = useState(settings.mail_retention_days);
  const [batch, setBatch] = useState(settings.token_refresh_batch);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [revealedKey, setRevealedKey] = useState("");
  const save = useSettingsAction(),
    secret = useSettingsAction(),
    auth = useSettingsAction();
  useSettingsUnloadGuard(save.busy || auth.busy);
  return (
    <div className="settings-grid min-w-0 [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>工作区偏好</CardTitle>
            <CardDescription>设置邮箱分配与保留规则。</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              id="preferences"
              onSubmit={(e) => {
                e.preventDefault();
                void save.run(async (signal) => {
                  await api(
                    "/api/settings",
                    "PUT",
                    {
                      default_prefix: prefix,
                      mail_retention_days: Number(retention),
                      token_refresh_batch: Number(batch),
                    },
                    signal,
                  );
                  signal.throwIfAborted();
                  toast.success("偏好设置已保存");
                  w.refresh();
                });
              }}
            >
              <fieldset disabled={save.busy} className="min-w-0">
                <FieldGroup>
                  <SelectField
                    label="界面主题"
                    value={theme}
                    onChange={setTheme}
                    options={[
                      ["system", "跟随系统"],
                      ["light", "浅色"],
                      ["dark", "深色"],
                    ]}
                  />
                  <TextField
                    label="默认邮箱前缀"
                    maxLength={30}
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                  />
                  <div className="form-grid">
                    <TextField
                      label="临时邮件保留天数"
                      type="number"
                      required
                      min={1}
                      max={365}
                      value={retention}
                      onChange={(e) => setRetention(e.target.value)}
                      help="置顶、永久邮箱和平台绑定邮件不参与自动清理。"
                    />
                    <TextField
                      label="每轮续期的账号数"
                      type="number"
                      required
                      min={1}
                      max={8}
                      value={batch}
                      onChange={(e) => setBatch(e.target.value)}
                      help="每 15 分钟处理最早到期的账号；成功后约 6 小时再续期。失败自动退避重试，停用或授权被撤销的账号除外。"
                    />
                  </div>
                </FieldGroup>
              </fieldset>
              <ActionError message={save.error} />
            </form>
          </CardContent>
          <CardFooter>
            <BusyButton form="preferences" type="submit" busy={save.busy}>
              保存偏好
            </BusyButton>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>登录安全</CardTitle>
            <CardDescription>
              修改后，其他设备的登录会话会失效。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              id="password"
              onSubmit={(e) => {
                e.preventDefault();
                if (password !== repeat) {
                  toast.error("两次输入的密码不一致");
                  return;
                }
                void auth.run(async (signal) => {
                  await api(
                    "/api/settings/password",
                    "POST",
                    {
                      new_password: password,
                    },
                    signal,
                  );
                  signal.throwIfAborted();
                  setPassword("");
                  setRepeat("");
                  toast.success("登录密码已修改");
                });
              }}
            >
              <fieldset disabled={auth.busy} className="min-w-0">
                <FieldGroup>
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    value="admin"
                    readOnly
                    className="sr-only"
                    tabIndex={-1}
                    aria-label="管理员账号"
                  />
                  <TextField
                    label="新密码"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    maxLength={1000}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    help="至少 10 个字符。"
                  />
                  <TextField
                    label="再次输入新密码"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    maxLength={1000}
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                  />
                </FieldGroup>
              </fieldset>
              <ActionError message={auth.error} />
            </form>
          </CardContent>
          <CardFooter>
            <BusyButton
              form="password"
              type="submit"
              variant="outline"
              busy={auth.busy}
            >
              <KeyRound data-icon="inline-start" />
              修改密码
            </BusyButton>
          </CardFooter>
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Microsoft 连接</CardTitle>
            <CardDescription>使用自己的微软应用连接 Outlook。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Badge
              variant={settings.oauth_configured ? "secondary" : "outline"}
            >
              {settings.oauth_configured
                ? "微软应用已配置"
                : "等待配置微软应用"}
            </Badge>
            <ol className="compact-steps">
              <li>在 Microsoft Entra 注册应用，账号类型支持个人微软账号。</li>
              <li>添加 Web 平台，并填写下面的回调地址。</li>
              <li>
                添加委托权限 User.Read、Mail.ReadWrite 与
                offline_access。需要发信时再添加 Mail.Send，并在 Outlook
                页面点击“授予发信权限”。
              </li>
              <li>
                在 Worker Secrets 中设置 MICROSOFT_CLIENT_ID 和
                MICROSOFT_CLIENT_SECRET，然后返回 Outlook 连接账号。
              </li>
            </ol>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">回调地址</p>
              <div className="flex items-center gap-2 rounded-lg border p-3">
                <code className="min-w-0 flex-1 break-all text-xs">
                  {settings.oauth_redirect_uri}
                </code>
                <CopyButton value={settings.oauth_redirect_uri} />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button variant="outline" asChild>
              <a
                href="https://entra.microsoft.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 Microsoft Entra
                <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>外部 API</CardTitle>
            <CardDescription>
              使用“凭据与密钥”为每个自动化脚本单独授权。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <KeyRound className="size-4 text-muted-foreground" />
              <span className="font-mono">
                {settings.has_api_key
                  ? "••••••••••••••••••••"
                  : "尚未配置 API_KEY"}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              这是兼容旧脚本的主密钥，拥有广泛的业务权限。新脚本建议创建有期限和资源限制的独立密钥。
            </p>
            <ActionError message={secret.error} />
          </CardContent>
          <CardFooter className="flex-wrap gap-2">
            <BusyButton
              variant="outline"
              busy={secret.busy}
              disabled={!settings.has_api_key}
              onClick={() => {
                void secret.run(async (signal) => {
                  const r = await api<{ api_key: string }>(
                    "/api/settings/api-key",
                    "GET",
                    undefined,
                    signal,
                  );
                  signal.throwIfAborted();
                  if (!r.data.api_key)
                    throw new Error("主 API 密钥尚未配置，请刷新后检查");
                  const copied = await copy(r.data.api_key, "API Key");
                  signal.throwIfAborted();
                  if (!copied) setRevealedKey(r.data.api_key);
                });
              }}
            >
              <Copy data-icon="inline-start" />
              复制密钥
            </BusyButton>
            <Button variant="ghost" onClick={() => w.navigate("api")}>
              接入文档
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      </div>
      {revealedKey && (
        <OneTimeSecret
          title="手动复制主 API 密钥"
          value={revealedKey}
          oneTime={false}
          close={() => setRevealedKey("")}
        />
      )}
    </div>
  );
}
